require('dotenv').config();
const express = require('express');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');

// ZUMEN 手機版伺服器。
// ZUMEN 沒有公開 API 金鑰，只能由這台電腦用 Playwright 登入後代理呼叫；
// 手機連到同一個 Wi-Fi，用瀏覽器開這台電腦的 IP:PORT 即可使用。
// API 細節與陷阱沿用電腦版（260704 ZUMEN圖面管理）docs/ZUMEN-API.md 的實測結論。

const PORT = Number(process.env.PORT) || 3457;
const ACCESS_PIN = (process.env.ACCESS_PIN || '').trim();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// 手機拍的檔名都是 IMG_1234.MOV 這種，讓使用者在上傳前自己取名（?name=），
// 副檔名一律沿用原檔，避免手機瀏覽器改了檔名後 ZUMEN 認不出格式
const safeName = s => String(s || '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 120);
const upload = multer({
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const sub = path.join(uploadDir, Date.now() + '-' + Math.random().toString(36).slice(2, 8));
      fs.mkdirSync(sub, { recursive: true });
      cb(null, sub);
    },
    filename: (req, file, cb) => {
      const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const ext = path.extname(original);
      const wanted = safeName(req.query.name);
      cb(null, wanted ? (wanted.toLowerCase().endsWith(ext.toLowerCase()) ? wanted : wanted + ext) : original);
    }
  })
});
function cleanupUpload(file) {
  if (!file?.path) return;
  try { fs.unlinkSync(file.path); fs.rmdirSync(path.dirname(file.path)); } catch (_) {}
}

// ── 通行碼 ────────────────────────────────────────────────
// 伺服器開在區網上，同 Wi-Fi 的人都連得到；設了 ACCESS_PIN 就要先輸入才能用
app.get('/api/auth', (req, res) => {
  res.json({ needPin: !!ACCESS_PIN, ok: !ACCESS_PIN || req.get('x-pin') === ACCESS_PIN });
});
app.use('/api', (req, res, next) => {
  if (!ACCESS_PIN || req.get('x-pin') === ACCESS_PIN) return next();
  res.status(401).json({ error: '通行碼錯誤', needPin: true });
});

// ── ZUMEN 登入與 API ──────────────────────────────────────
let browser = null, browserContext = null, page = null;
let bearerToken = null, companyId = null, isLoggedIn = false;
let loginError = '';

const CREDENTIALS = { email: process.env.ZUMEN_EMAIL || '', password: process.env.ZUMEN_PASSWORD || '' };

function apiHeaders() {
  return {
    'Authorization': bearerToken,
    'x-zumen-company-id': companyId,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
}

function extractErrorMessage(e) {
  const data = e.response?.data;
  if (!data) return e.message;
  if (typeof data === 'string') return data.slice(0, 200);
  if (typeof data.message === 'string') return data.message;
  if (typeof data.error === 'string') return data.error;
  if (Array.isArray(data.errors)) return data.errors.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join('；');
  try { return JSON.stringify(data).slice(0, 200); } catch (_) { return e.message; }
}

async function zumeAPI(method, endpoint, body) {
  const call = () => axios({ method, url: 'https://zume-n.com' + endpoint, data: body, headers: apiHeaders(), timeout: 15000 });
  try {
    return { ok: true, data: (await call()).data };
  } catch (e) {
    if (e.response?.status === 401) {
      try {
        await doAutoLogin();
        return { ok: true, data: (await call()).data };
      } catch (e2) {
        return { ok: false, status: e2.response?.status, error: extractErrorMessage(e2) };
      }
    }
    return { ok: false, status: e.response?.status, error: extractErrorMessage(e) };
  }
}

// 登入失敗冷卻 15 分鐘：連續失敗會觸發 Auth0 暴力破解封鎖（電腦版 2026-07-06 實際發生）
let _lastLoginFailAt = 0;
const LOGIN_FAIL_COOLDOWN_MS = 15 * 60 * 1000;
let _loginPromise = null;

async function doAutoLogin() {
  if (_loginPromise) return _loginPromise;   // 同時多個請求遇到 401 只登入一次
  if (Date.now() - _lastLoginFailAt < LOGIN_FAIL_COOLDOWN_MS) {
    const waitMin = Math.ceil((LOGIN_FAIL_COOLDOWN_MS - (Date.now() - _lastLoginFailAt)) / 60000);
    throw new Error(`登入失敗冷卻中，請 ${waitMin} 分鐘後再試`);
  }
  _loginPromise = (async () => {
    try {
      await _doAutoLoginInner();
      _lastLoginFailAt = 0;
      loginError = '';
    } catch (e) {
      _lastLoginFailAt = Date.now();
      loginError = e.message;
      throw e;
    } finally {
      _loginPromise = null;
    }
  })();
  return _loginPromise;
}

// 登入 session 存檔，重啟時直接沿用，不必每次輸入帳密（避免 Auth0 封鎖）。
// 可以直接把電腦版的 .auth-session.json 複製過來，第一次啟動就不用登入。
const SESSION_STATE_FILE = path.join(__dirname, '.auth-session.json');

function findBrowserExecutable() {
  const candidates = [
    process.env.ZUMEN_BROWSER_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  return candidates.find(p => p && fs.existsSync(p)) || null;
}

async function _doAutoLoginInner() {
  if (!browser || !browser.isConnected()) {
    const exePath = findBrowserExecutable();
    browser = exePath
      ? await chromium.launch({ headless: true, executablePath: exePath })
      : await chromium.launch({ headless: true, channel: 'msedge' });
    const ctxOpts = fs.existsSync(SESSION_STATE_FILE) ? { storageState: SESSION_STATE_FILE } : {};
    browserContext = await browser.newContext(ctxOpts);
    page = await browserContext.newPage();
    page.on('request', req => {
      const h = req.headers();
      if (h['authorization']?.startsWith('Bearer ')) bearerToken = h['authorization'];
      if (h['x-zumen-company-id']) companyId = h['x-zumen-company-id'];
    });
  } else if (!page || page.isClosed()) {
    page = await browserContext.newPage();
  }

  await page.goto('https://zume-n.com/drawings');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  if (page.url().includes('login.zume-n.com')) {
    if (!CREDENTIALS.email || !CREDENTIALS.password) {
      throw new Error('登入資訊已過期，且 .env 未設定 ZUMEN_EMAIL / ZUMEN_PASSWORD');
    }
    console.log('   登入 session 無效，改用帳密登入…');
    await page.fill('input[name="username"]', CREDENTIALS.email);
    await page.fill('input[name="password"]', CREDENTIALS.password);
    await page.click('button[type="submit"]');
    try { await page.waitForURL('https://zume-n.com/**', { timeout: 20000 }); } catch (_) {}
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);
  }
  if (page.url().includes('login.zume-n.com')) throw new Error('登入失敗，請確認帳號密碼');

  if (!companyId) companyId = await page.evaluate(() => localStorage.getItem('companyId'));
  isLoggedIn = true;
  try { await browserContext.storageState({ path: SESSION_STATE_FILE }); } catch (_) {}
  console.log('✅ 已登入 ZUMEN | Company:', companyId, '| Token:', bearerToken ? 'OK' : '未取得');
}

// Playwright 只有一個分頁，多支手機同時上傳時必須排隊，不然會互相搶頁面
let _pageQueue = Promise.resolve();
function withPage(fn) {
  const run = _pageQueue.then(fn, fn);
  _pageQueue = run.catch(() => {});
  return run;
}

app.get('/api/status', (req, res) => res.json({
  loggedIn: isLoggedIn, ready: isLoggedIn && !!bearerToken && !!companyId, error: loginError
}));

// ── 圖面清單 / 搜尋 ───────────────────────────────────────
const getBasicOf = (d, key) => (d.drawing_basic_items || []).find(i => i.drawing_basic_item_master_id === key)?.value || d[key] || '';
const getItemOf = (d, key) => (d.drawing_items || []).find(i => i.drawing_item_master_id === key)?.string_value || '';

app.get('/api/drawings', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const pg = Number(req.query.page) || 1;
  // per_page 上限 25，超過 ZUMEN 回 422；搜尋要走 freeword_search 才跟網頁版結果一致
  const endpoint = q
    ? `/api/drawings/freeword_search?query=${encodeURIComponent(q)}&page=${pg}&sort%5Btype%5D=created_at_desc`
    : `/api/drawings?sort%5Btype%5D=updated&sort%5Bis_asc%5D=0&page=${pg}&per_page=25`;
  const result = await zumeAPI('GET', endpoint);
  if (!result.ok) return res.status(502).json({ error: result.error || '載入失敗' });
  const data = result.data;
  const drawings = (data.drawings || []).map(d => ({
    id: d.id,
    drawing_number: getBasicOf(d, 'drawing_number'),
    product_name: getBasicOf(d, 'product_name'),
    thumbnail_url: d.thumbnail_url || '',
    updated_at: d.updated_at || ''
  }));
  res.json({ drawings, total: data.total_count ?? drawings.length, last_page: data.last_page || 1, page: pg });
});

app.get('/api/drawings/:id', async (req, res) => {
  const result = await zumeAPI('GET', `/api/drawings/${encodeURIComponent(req.params.id)}`);
  if (!result.ok) return res.status(502).json({ error: result.error || '載入失敗' });
  const d = result.data.drawing || result.data;
  // 欄位 ID 與顯示名稱對不上（serial_number=分類、machine=廠商/客戶、subcontractor=投料單號），見電腦版 ZUMEN-API.md
  res.json({
    id: d.id,
    drawing_number: getBasicOf(d, 'drawing_number'),
    product_name: getBasicOf(d, 'product_name'),
    thumbnail_url: d.thumbnail_url || '',
    memo: d.memo || '',
    fields: [
      ['生產線別', getItemOf(d, 'custom_string_item_2')],
      ['生產群組', getItemOf(d, 'jig')],
      ['分類', getItemOf(d, 'serial_number')],
      ['廠商/客戶', getItemOf(d, 'machine')],
      ['加工方式', getItemOf(d, 'processing_method')],
      ['投料單號', getItemOf(d, 'subcontractor')],
    ].filter(([, v]) => v),
    updated_at: d.updated_at || ''
  });
});

// ── 檔案搜尋（ZUMEN 網頁搜尋結果的「檔案」選項）────────────
// 回應的每筆是 { drawing_file: {...} } 或 { document_file: {..., document: { document_type_master_id, drawing }} }；
// 沒有 extension 欄位、name 也不一定帶副檔名，副檔名改由前端從取檔網址判斷（2026-10-22 實測）
app.get('/api/files/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const pg = Number(req.query.page) || 1;
  if (!q) return res.json({ files: [], last_page: 1, page: 1 });
  const result = await zumeAPI('GET', `/api/drawing_and_document_files/freeword_search?query=${encodeURIComponent(q)}&page=${pg}&sort%5Btype%5D=score_desc`);
  if (!result.ok) return res.status(502).json({ error: result.error || '搜尋失敗' });
  const files = (result.data.files || []).map(x => {
    const f = x.drawing_file || x.document_file;
    if (!f) return null;
    const drawing = x.drawing_file ? f.drawing : f.document?.drawing;
    const name = f.name || '';
    const m = name.match(/\.([a-z0-9]{2,5})$/i);
    return {
      id: f.id,
      type: x.drawing_file ? 'drawing' : (f.document?.document_type_master_id || ''),
      name,
      extension: m ? m[1].toLowerCase() : '',
      thumbnail_url: f.thumbnail_url || '',
      created_at: f.created_at || '',
      drawing: drawing ? { id: drawing.id, drawing_number: getBasicOf(drawing, 'drawing_number'), product_name: getBasicOf(drawing, 'product_name') } : null
    };
  }).filter(Boolean);
  res.json({ files, last_page: result.data.total_pages || 1, page: pg });
});

// ── 文件分類 ──────────────────────────────────────────────
let docTypesCache = null;
async function getDocTypes() {
  if (docTypesCache) return docTypesCache;
  const result = await zumeAPI('GET', '/api/document_type_settings?is_visible=1');
  if (!result.ok) throw new Error(result.error || '分類載入失敗');
  // 「共用」「品保」群組加工部用不到（電腦版 2026-07-07 使用者要求隱藏），手機版比照
  const hide = g => { const s = String(g || '').replace(/\s/g, ''); return s.includes('共用') || s.includes('品保'); };
  docTypesCache = [{ id: 'drawing', name: '圖面', group: '基本', writable: true },
    ...(result.data.document_type_settings || [])
      .map(d => ({ id: d.document_type_master_id, name: d.name, group: d.group_name || '', writable: !!d.is_writable }))
      .filter(t => !hide(t.group))];
  return docTypesCache;
}
app.get('/api/doc-types', async (req, res) => {
  try { res.json({ types: await getDocTypes() }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ── 檔案 ──────────────────────────────────────────────────
async function listFilesAPI(drawingId, type) {
  const endpoint = type === 'drawing'
    ? `/api/drawing_files?drawing_id=${drawingId}`
    : `/api/document_files?drawing_id=${drawingId}&document_type_master_id=${encodeURIComponent(type)}`;
  const result = await zumeAPI('GET', endpoint);
  if (!result.ok) throw new Error(result.error || '檔案清單載入失敗');
  return result.data.drawing_files || result.data.document_files || [];
}
const toFile = (f, type) => ({
  id: f.id,
  type,
  name: f.name + (f.extension && !f.name.endsWith('.' + f.extension) ? '.' + f.extension : ''),
  extension: (f.extension || '').toLowerCase(),
  created_at: f.created_at || '',
  account: f.account?.name || ''
});

// 一次撈這張圖面所有分類的檔案：手機上要顯示各分類數量、以及跨分類的「影片」總覽
app.get('/api/drawings/:id/all-files', async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);
    const types = await getDocTypes();
    const lists = await Promise.all(types.map(t =>
      listFilesAPI(id, t.id).then(fs => fs.map(f => toFile(f, t.id))).catch(() => null)));
    const byType = {};
    types.forEach((t, i) => { byType[t.id] = lists[i]; });
    res.json({ byType });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 取簽章網址（效期 1 小時，不可快取重用）。ids 逗號分隔、可一次取多個
app.get('/api/file-urls', async (req, res) => {
  const type = String(req.query.type || 'drawing');
  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s)).slice(0, 50);
  if (!ids.length) return res.json({ urls: [] });
  const kind = type === 'drawing' ? 'drawing_file' : 'document_file';
  const qs = ids.map(i => `${kind}_ids%5B%5D=${i}`).join('&');
  const result = await zumeAPI('GET', `/api/${kind}s/urls?${qs}`);
  if (!result.ok) return res.status(502).json({ error: result.error || '無法取得檔案連結' });
  const items = result.data[`${kind}_urls`] || [];
  const urls = items.map((it, i) => ({
    id: String(it[`${kind}_id`] ?? it.id ?? ids[i]),
    url: it.file_url || it.thumbnail_url || '',
    thumbnail_url: it.thumbnail_url || ''
  }));
  res.json({ urls });
});

// 取檔案內容（手機上預覽 Excel/CSV 用）：GCS 簽章網址沒有 CORS 標頭，
// 手機網頁不能直接 fetch，只好由伺服器代抓再轉給手機
app.get('/api/file-content', async (req, res) => {
  const type = String(req.query.type || 'drawing');
  const id = String(req.query.id || '').replace(/\D/g, '');
  if (!id) return res.status(400).json({ error: '缺少檔案 id' });
  const kind = type === 'drawing' ? 'drawing_file' : 'document_file';
  const result = await zumeAPI('GET', `/api/${kind}s/urls?${kind}_ids%5B%5D=${id}`);
  const fileUrl = result.ok && (result.data[`${kind}_urls`] || [])[0]?.file_url;
  if (!fileUrl) return res.status(502).json({ error: '無法取得檔案連結' });
  try {
    const r = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 30 * 1048576 });
    res.set('Content-Type', 'application/octet-stream');
    res.send(Buffer.from(r.data));
  } catch (e) {
    res.status(502).json({ error: '下載檔案失敗：' + extractErrorMessage(e) });
  }
});

// ── 上傳（背景工作 + 輪詢）──────────────────────────────────
// 手機上傳影片到 ZUMEN 可能要好幾分鐘，手機螢幕一關 HTTP 連線就斷；
// 所以檔案收完就先回 jobId，後續由前端輪詢 /api/jobs/:id 看結果
const jobs = new Map();   // jobId -> { state: queued|uploading|done|error, message, drawingId, type, name, createdAt }
setInterval(() => {
  const cutoff = Date.now() - 6 * 3600 * 1000;
  for (const [k, j] of jobs) if (j.createdAt < cutoff) jobs.delete(k);
}, 600000);

// ── 影片壓縮 ──────────────────────────────────────────────
// iPhone 1 分鐘 1080p .mov 約 60MB。先在電腦轉成 720p H.264 MP4（約原本 1/4~1/6）：
// ZUMEN 空間省、手機看的時候載入快，而且 Android 也播得了（iPhone 的 HEVC 很多 Android 不支援）。
// （2026-10-22 一度以為公司對外頻寬只有 230KB/s 才導致上傳失敗，後來實測 20MB 4 秒就傳完，
//   真正原因是「儲存」被 ZUMEN 忽略，見 uploadFileToTab）
const { spawn } = require('child_process');
let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch (_) {}
const VIDEO_EXT = ['.mov', '.mp4', '.m4v', '.3gp', '.avi', '.mkv', '.wmv', '.mts', '.webm'];
const COMPRESS_MIN_MB = 8;

function compressVideo(input, onProgress) {
  return new Promise((resolve, reject) => {
    const out = input.replace(/\.[^.\\/]+$/, '') + '.mp4';
    const target = out === input ? input.replace(/\.mp4$/i, '_720p.mp4') : out;
    // 長邊縮到 1280（直式、橫式都適用），CRF 26 對加工影片畫質足夠；faststart 讓手機邊下載邊播
    const args = ['-y', '-i', input,
      '-vf', "scale='if(gte(iw,ih),min(1280,iw),-2)':'if(gte(iw,ih),-2,min(1280,ih))'",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', target];
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    let duration = 0, errTail = '';
    p.stderr.on('data', buf => {
      const s = buf.toString();
      errTail = (errTail + s).slice(-600);
      const d = s.match(/Duration: (\d+):(\d+):([\d.]+)/);
      if (d) duration = (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]);
      const t = s.match(/time=(\d+):(\d+):([\d.]+)/);
      if (t && duration) onProgress(Math.min(99, Math.round(((+t[1]) * 3600 + (+t[2]) * 60 + parseFloat(t[3])) / duration * 100)));
    });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(target) : reject(new Error('影片壓縮失敗：' + errTail.split('\n').filter(Boolean).pop())));
  });
}

async function uploadFileToTab(drawingId, type, filePath, sizeMB, log = () => {}) {
  if (!page || page.isClosed()) throw new Error('ZUMEN 尚未登入完成');
  const targetUrl = type === 'drawing'
    ? `https://zume-n.com/drawings/${drawingId}`
    : `https://zume-n.com/drawings/${drawingId}?documentTypeMasterId=${encodeURIComponent(type)}`;
  log('取得現有檔案清單');
  const before = new Set((await listFilesAPI(drawingId, type)).map(f => f.id));

  await page.goto(targetUrl);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  log('ZUMEN 頁面已開啟');

  // 直接 setInputFiles 會被 ZUMEN 的 React 忽略：要觸發原生 click 產生 filechooser 再選檔；
  // 文件分頁每個面板都有自己的 input，必須挑可見面板的那一個
  const inputSel = type === 'drawing' ? 'input[type="file"]' : '.chakra-tabs__tab-panel:not([hidden]) input[type="file"]';
  const inputEl = await page.$(inputSel);
  if (!inputEl) { await dumpDebugState('upload_no_input'); throw new Error('ZUMEN 頁面找不到上傳欄位'); }
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10000 }),
    inputEl.evaluate(el => el.click())
  ]);
  await chooser.setFiles(filePath);
  await page.waitForTimeout(1500);

  // 選檔後跳出「N個文件已新增」對話框，一定要按裡面的「儲存」才會真的上傳。
  // 用 data-testid 定位，文字比對會誤中 disabled 的「儲存為組圖」按鈕
  //
  // 2026-10-22 踩雷：手機傳來的大影片，選檔後 1.5 秒就按「儲存」會被 ZUMEN 無聲忽略
  // （對話框還在處理剛選的檔案），之後沒人再按，就一直等到逾時——除錯截圖裡對話框原封不動。
  // 實測按下有效時：按鈕立刻變轉圈圈（disabled）→ 傳到 GCS → 對話框關閉。
  // 所以改成「按了要確認有被接受」：對話框還在、按鈕又沒在轉，就再按一次。
  // 按鈕轉圈時是 disabled、按不下去，不會重複上傳。
  const dialogSel = '[role="dialog"]:has-text("已新增"), .chakra-modal__content:has-text("已新增")';
  const saveBtn = page.locator(`${dialogSel.split(', ').map(s => s + ' button[data-testid="submit-button"]').join(', ')}`).first();
  if (!(await saveBtn.count())) { await dumpDebugState('upload_no_save_button'); throw new Error('ZUMEN 沒有出現「儲存」按鈕'); }
  const saveDeadline = Date.now() + 5 * 60000;
  let clicks = 0;
  for (;;) {
    const dialogOpen = await page.locator(dialogSel).first().isVisible().catch(() => false);
    if (!dialogOpen) break;
    const busy = await saveBtn.evaluate(b => b.disabled || b.hasAttribute('data-loading')).catch(() => true);
    if (!busy) {
      if (Date.now() > saveDeadline) { await dumpDebugState('upload_save_ignored'); throw new Error(`按了 ${clicks} 次「儲存」ZUMEN 都沒有開始上傳`); }
      await saveBtn.click({ timeout: 5000 }).catch(() => {});
      clicks++;
      log(`按下儲存（第 ${clicks} 次）`);
    }
    await page.waitForTimeout(busy ? 2000 : 4000);
  }
  log('ZUMEN 已接受，對話框關閉');

  // ZUMEN 回應不可信，輪詢檔案清單直到新檔出現才算成功
  const deadline = Date.now() + Math.min(20 * 60000, 120000 + sizeMB * 6000);
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    const now = await listFilesAPI(drawingId, type).catch(() => []);
    const added = now.find(f => !before.has(f.id));
    if (added) { log('ZUMEN 檔案清單已出現新檔'); return added; }
  }
  await dumpDebugState('upload_timeout');
  return false;
}

// 失敗時存下 ZUMEN 頁面截圖，方便查到底卡在哪一步（debug/ 不進 git）
async function dumpDebugState(label) {
  try {
    if (!page || page.isClosed()) return;
    const dir = path.join(__dirname, 'debug');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `${label}_${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await page.screenshot({ path: base + '.png', fullPage: true }).catch(() => {});
    console.log(`[除錯] 已存失敗畫面：${base}.png`);
  } catch (_) {}
}

// 收到完整檔案後的共用流程：（影片）壓縮 → 排隊 → 傳到 ZUMEN。回傳 jobId 給手機輪詢
function startUploadJob({ filePath, size, drawingId, type, cleanup }) {
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = { state: 'queued', message: '排隊中…', drawingId, type, name: path.basename(filePath), createdAt: Date.now() };
  jobs.set(jobId, job);

  const t0 = Date.now();
  const sec = () => Math.round((Date.now() - t0) / 1000);
  const log = step => console.log(`[上傳 ${jobId}] ${sec()}s ${step}`);
  const extra = [];   // 壓縮後產生的檔案，結束時一併清掉
  (async () => {
    let sizeMB = size / 1048576;
    log(`收到 ${job.name}（${sizeMB.toFixed(1)}MB）`);
    // 影片且夠大才壓縮；壓完沒變小（本來就很省）就用原檔
    if (ffmpegPath && VIDEO_EXT.includes(path.extname(filePath).toLowerCase()) && sizeMB >= COMPRESS_MIN_MB) {
      job.state = 'compressing';
      job.message = '壓縮影片中…';
      try {
        const out = await compressVideo(filePath, pct => { job.message = `壓縮影片中 ${pct}%`; });
        extra.push(out);
        const outMB = fs.statSync(out).size / 1048576;
        log(`壓縮完成 ${sizeMB.toFixed(1)}MB → ${outMB.toFixed(1)}MB`);
        if (outMB < sizeMB * 0.9) { filePath = out; sizeMB = outMB; job.name = path.basename(out); }
      } catch (e) {
        log('壓縮失敗，改傳原檔：' + e.message.slice(0, 150));
      }
    }
    job.state = 'queued';
    job.message = '排隊中…';
    await withPage(async () => {
      job.state = 'uploading';
      job.message = `上傳到 ZUMEN 中（${sizeMB.toFixed(1)}MB）…`;
      try {
        const ok = await uploadFileToTab(drawingId, type, filePath, sizeMB, log);
        job.state = ok ? 'done' : 'error';
        job.message = ok ? '上傳完成' : '上傳逾時，請稍後到 ZUMEN 確認檔案是否出現';
      } catch (e) {
        job.state = 'error';
        job.message = e.message.slice(0, 200);
      }
    });
  })().catch(e => { job.state = 'error'; job.message = e.message.slice(0, 200); })
    .finally(() => {
      for (const f of extra) { try { fs.unlinkSync(f); } catch (_) {} }
      cleanup();
      log(`結束：${job.state} ${job.message}`);
    });
  return jobId;
}

// 一次送整個檔案（電腦瀏覽器或舊版手機頁面用）
app.post('/api/drawings/:id/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '沒有收到檔案' });
  res.json({ jobId: startUploadJob({
    filePath: req.file.path, size: req.file.size,
    drawingId: String(req.params.id).replace(/\D/g, ''), type: String(req.query.type || 'drawing'),
    cleanup: () => cleanupUpload(req.file)
  }) });
});

// ── 分段上傳（手機用，可續傳）──────────────────────────────
// iPhone 的 Safari 一切到背景、螢幕一鎖，網頁就被暫停，一次送整支影片的請求會整個斷掉重來。
// 改成每段 2MB 分開送，伺服器記住收到哪裡；手機回到 App、網路恢復、甚至關掉重開，都從斷點接著送。
// 暫存在 uploads/chunk-<id>/：meta.json（目標圖面、分類、檔名、大小）＋檔案本身
// 手機端遇到的錯誤（上傳卡住、失敗的原因）回報到這裡，寫進伺服器 log。
// 手機上看不到 console，沒有這個就只能猜（2026-10-23 傳到 2~4MB 就失敗，電腦端 log 完全看不出原因）
app.post('/api/client-log', (req, res) => {
  const b = req.body || {};
  console.log(`[手機回報] ${String(b.where || '').slice(0, 40)} | ${String(b.name || '').slice(0, 60)} | ${String(b.msg || '').slice(0, 300)} | 已傳 ${b.sent}/${b.size} | ${String(b.ua || '').slice(0, 80)}`);
  res.json({ ok: true });
});
// 分段上傳的每個請求都記一行（method、收到多少、回應狀態），查問題才看得到手機到底送了什麼
app.use('/api/uploads', (req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => console.log(`[分段] ${req.method} ${req.originalUrl.replace('/api/uploads', '') || '/'} 內容${req.headers['content-length'] || 0}B → ${res.statusCode} ${Date.now() - t0}ms`));
  res.on('close', () => { if (!res.writableEnded) console.log(`[分段] ${req.method} ${req.originalUrl.replace('/api/uploads', '') || '/'} 手機中途斷線（已收到 ${req.socket.bytesRead}B）`); });
  next();
});
const chunkDirOf = uid => path.join(uploadDir, 'chunk-' + uid);
function readChunkMeta(uid) {
  if (!/^[a-z0-9]{6,40}$/.test(uid)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(chunkDirOf(uid), 'meta.json'), 'utf8')); } catch (_) { return null; }
}
const writeChunkMeta = (uid, meta) => fs.writeFileSync(path.join(chunkDirOf(uid), 'meta.json'), JSON.stringify(meta));
const receivedOf = meta => { try { return fs.statSync(meta.filePath).size; } catch (_) { return 0; } };

app.post('/api/uploads', (req, res) => {
  const { drawingId, type, name, fileName } = req.body || {};
  const size = Number(req.body?.size);
  const did = String(drawingId || '').replace(/\D/g, '');
  if (!did || !type || !fileName || !(size > 0)) return res.status(400).json({ error: '資料不完整' });
  if (size > 2 * 1024 * 1048576) return res.status(400).json({ error: '檔案超過 2GB' });
  const uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  fs.mkdirSync(chunkDirOf(uid), { recursive: true });
  const ext = path.extname(String(fileName));
  const wanted = safeName(name);
  const finalName = wanted ? (wanted.toLowerCase().endsWith(ext.toLowerCase()) ? wanted : wanted + ext) : (safeName(fileName) || 'upload' + ext);
  const meta = { drawingId: did, type: String(type), filePath: path.join(chunkDirOf(uid), finalName), size, createdAt: Date.now() };
  fs.writeFileSync(meta.filePath, '');
  writeChunkMeta(uid, meta);
  res.json({ uploadId: uid, received: 0 });
});

app.get('/api/uploads/:uid', (req, res) => {
  const meta = readChunkMeta(req.params.uid);
  if (!meta) return res.status(404).json({ error: '找不到這個上傳（可能已過期），請重新上傳' });
  res.json({ received: receivedOf(meta), size: meta.size, jobId: meta.jobId || null });
});

app.put('/api/uploads/:uid', express.raw({ type: () => true, limit: '8mb' }), (req, res) => {
  const meta = readChunkMeta(req.params.uid);
  if (!meta) return res.status(404).json({ error: '找不到這個上傳（可能已過期），請重新上傳' });
  const received = receivedOf(meta);
  // 手機重送了已經收過的段落（例如回應在路上掉了）：告訴它目前收到哪，讓它從那裡接
  if (Number(req.query.offset) !== received) return res.status(409).json({ received });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: '沒有收到資料' });
  if (received + req.body.length > meta.size) return res.status(400).json({ error: '資料超過檔案大小' });
  fs.appendFileSync(meta.filePath, req.body);
  res.json({ received: received + req.body.length });
});

app.post('/api/uploads/:uid/complete', (req, res) => {
  const uid = req.params.uid;
  const meta = readChunkMeta(uid);
  if (!meta) return res.status(404).json({ error: '找不到這個上傳（可能已過期），請重新上傳' });
  if (meta.jobId) return res.json({ jobId: meta.jobId });   // 重送 complete 不會重複上傳
  if (receivedOf(meta) !== meta.size) return res.status(409).json({ error: '檔案還沒傳完', received: receivedOf(meta) });
  meta.jobId = startUploadJob({
    filePath: meta.filePath, size: meta.size, drawingId: meta.drawingId, type: meta.type,
    cleanup: () => fs.rmSync(chunkDirOf(uid), { recursive: true, force: true })
  });
  writeChunkMeta(uid, meta);
  res.json({ jobId: meta.jobId });
});

// 放棄超過 24 小時沒傳完的暫存，避免硬碟被塞滿
setInterval(() => {
  for (const d of fs.readdirSync(uploadDir)) {
    if (!d.startsWith('chunk-')) continue;
    const meta = readChunkMeta(d.slice(6));
    if (!meta || (!meta.jobId && Date.now() - meta.createdAt > 24 * 3600 * 1000)) {
      fs.rmSync(path.join(uploadDir, d), { recursive: true, force: true });
    }
  }
}, 3600 * 1000);


// ── Excel 表格新增一筆（生產履歷等）─────────────────────────
// ZUMEN 沒有「修改檔案」的 API，只能：下載原檔 → 加一列 → 用同檔名上傳成新檔 →
// 下載新檔確認那一列真的在（read-back）→ 才刪掉舊檔。任何一步失敗都不刪舊檔，資料不會不見
const xlsxAppend = require('./xlsx-append');
const SHEET_FORM_EXT = ['xlsx', 'xlsm'];

async function downloadFile(type, id) {
  const kind = type === 'drawing' ? 'drawing_file' : 'document_file';
  const result = await zumeAPI('GET', `/api/${kind}s/urls?${kind}_ids%5B%5D=${id}`);
  const fileUrl = result.ok && (result.data[`${kind}_urls`] || [])[0]?.file_url;
  if (!fileUrl) throw new Error('無法取得檔案連結');
  const r = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 30 * 1048576 });
  return Buffer.from(r.data);
}

app.get('/api/sheet-form', async (req, res) => {
  try {
    const id = String(req.query.id || '').replace(/\D/g, '');
    res.json(await xlsxAppend.describe(await downloadFile(String(req.query.type || 'drawing'), id)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/sheet-append', (req, res) => {
  const { type, drawingId, values } = req.body || {};
  const id = String(req.body?.id || '').replace(/\D/g, '');
  const did = String(drawingId || '').replace(/\D/g, '');
  if (!id || !did || !type || !Array.isArray(values) || !values.some(v => String(v || '').trim())) {
    return res.status(400).json({ error: '資料不完整' });
  }
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = { state: 'queued', message: '排隊中…', drawingId: did, type, name: '', createdAt: Date.now() };
  jobs.set(jobId, job);
  res.json({ jobId });

  const t0 = Date.now();
  const log = step => console.log(`[新增一筆 ${jobId}] ${Math.round((Date.now() - t0) / 1000)}s ${step}`);
  let tmpDir = null;
  // 整段放進 Playwright 佇列：兩個人同時新增同一個檔，第二個會等第一個換完檔，再拿「最新那份」加，不會互蓋
  withPage(async () => {
    job.state = 'uploading';
    job.message = '讀取原本的 Excel…';
    const files = await listFilesAPI(did, type);
    // 原本那份可能剛被別人換掉（id 變了）：同檔名、最新的那份才是目前版本
    let cur = files.find(f => String(f.id) === id);
    const fullName = f => f.name + (f.extension && !f.name.endsWith('.' + f.extension) ? '.' + f.extension : '');
    if (!cur) {
      const want = req.body.name;
      cur = files.filter(f => fullName(f) === want).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0];
      if (!cur) throw new Error('找不到原本的 Excel，可能已被刪除');
      log(`原檔 ${id} 已換成 ${cur.id}，改用最新版本`);
    }
    const name = fullName(cur);
    job.name = name;
    if (!SHEET_FORM_EXT.includes((cur.extension || '').toLowerCase())) throw new Error('只支援 .xlsx 檔');

    const { buffer, row } = await xlsxAppend.appendRow(await downloadFile(type, cur.id), values.map(v => String(v ?? '').trim()));
    log(`已在第 ${row} 列加入資料`);
    tmpDir = path.join(uploadDir, 'append-' + jobId);
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, name);
    fs.writeFileSync(tmpFile, buffer);

    job.message = '存回 ZUMEN 中…';
    const added = await uploadFileToTab(did, type, tmpFile, buffer.length / 1048576, log);
    if (!added) throw new Error('新檔上傳逾時，原本的檔案沒有動到');

    // read-back：從 ZUMEN 下載剛上傳的新檔，確認那一列真的在，才刪舊檔
    job.message = '確認資料…';
    const got = await xlsxAppend.readRow(await downloadFile(type, added.id), row);
    const sent = values.map(v => String(v ?? '').trim());
    if (got.join('\u0001') !== sent.join('\u0001')) {
      throw new Error('新檔內容核對不符，舊檔保留；ZUMEN 上可能會有兩份，請到電腦確認');
    }
    const kind = type === 'drawing' ? 'drawing_files' : 'document_files';
    const del = await zumeAPI('DELETE', `/api/${kind}/${cur.id}`);
    log(`新檔 ${added.id} 核對正確；刪除舊檔 ${cur.id}：${del.ok ? 'OK' : del.error}`);
    job.state = 'done';
    job.message = del.ok ? '已新增並存回 ZUMEN' : '已新增，但舊檔刪除失敗（ZUMEN 上會有兩份）';
    job.newId = added.id;
    job.row = row;
  }).catch(e => {
    job.state = 'error';
    job.message = e.message.slice(0, 200);
  }).finally(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    log(`結束：${job.state} ${job.message}`);
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '找不到這個上傳工作（伺服器可能重啟過）' });
  res.json(job);
});

// ── 啟動 ──────────────────────────────────────────────────
// Tailscale 給每台裝置一個 100.64.0.0/10 的固定位址，手機裝 Tailscale 後在外面也連得到這個位址
const isTailscaleIp = ip => { const [a, b] = ip.split('.').map(Number); return a === 100 && b >= 64 && b <= 127; };
function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    // 169.254.x.x 是網卡沒拿到位址時的自動位址（Tailscale 未登入時也會出現），手機連不到，排除
    .filter(n => n && n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.'))
    .map(n => n.address);
}
app.get('/api/connect-info', (req, res) => {
  const ips = lanAddresses();
  res.json({
    lan: ips.filter(ip => !isTailscaleIp(ip)).map(ip => `http://${ip}:${PORT}`),
    tailscale: ips.filter(isTailscaleIp).map(ip => `http://${ip}:${PORT}`),
    pin: !!ACCESS_PIN
  });
});

process.on('exit', () => { if (browser) browser.close().catch(() => {}); });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`📱 ZUMEN 手機版已啟動`);
  console.log(`   本機：http://localhost:${PORT}`);
  lanAddresses().forEach(ip => console.log(isTailscaleIp(ip)
    ? `   手機（外出，Tailscale）：http://${ip}:${PORT}`
    : `   手機（同一個 Wi-Fi）：http://${ip}:${PORT}`));
  console.log(`   電腦開 http://localhost:${PORT}/connect.html 可顯示 QR Code 給手機掃`);
  console.log('🚀 登入 ZUMEN 中…');
  doAutoLogin().catch(e => console.error('❌ 自動登入失敗:', e.message));
});
