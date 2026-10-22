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

// ── 上傳（背景工作 + 輪詢）──────────────────────────────────
// 手機上傳影片到 ZUMEN 可能要好幾分鐘，手機螢幕一關 HTTP 連線就斷；
// 所以檔案收完就先回 jobId，後續由前端輪詢 /api/jobs/:id 看結果
const jobs = new Map();   // jobId -> { state: queued|uploading|done|error, message, drawingId, type, name, createdAt }
setInterval(() => {
  const cutoff = Date.now() - 6 * 3600 * 1000;
  for (const [k, j] of jobs) if (j.createdAt < cutoff) jobs.delete(k);
}, 600000);

async function uploadFileToTab(drawingId, type, filePath, sizeMB) {
  if (!page || page.isClosed()) throw new Error('ZUMEN 尚未登入完成');
  const targetUrl = type === 'drawing'
    ? `https://zume-n.com/drawings/${drawingId}`
    : `https://zume-n.com/drawings/${drawingId}?documentTypeMasterId=${encodeURIComponent(type)}`;
  const before = new Set((await listFilesAPI(drawingId, type)).map(f => f.id));

  await page.goto(targetUrl);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // 直接 setInputFiles 會被 ZUMEN 的 React 忽略：要觸發原生 click 產生 filechooser 再選檔；
  // 文件分頁每個面板都有自己的 input，必須挑可見面板的那一個
  const inputSel = type === 'drawing' ? 'input[type="file"]' : '.chakra-tabs__tab-panel:not([hidden]) input[type="file"]';
  const inputEl = await page.$(inputSel);
  if (!inputEl) throw new Error('ZUMEN 頁面找不到上傳欄位');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10000 }),
    inputEl.evaluate(el => el.click())
  ]);
  await chooser.setFiles(filePath);
  await page.waitForTimeout(1500);

  // 選檔後跳出「N個文件已新增」對話框，一定要按裡面的「儲存」才會真的上傳。
  // 用 data-testid 定位，文字比對會誤中 disabled 的「儲存為組圖」按鈕
  const saveBtn = page.locator('[role="dialog"]:has-text("已新增") button[data-testid="submit-button"], .chakra-modal__content:has-text("已新增") button[data-testid="submit-button"]').first();
  if (await saveBtn.count()) await saveBtn.click();
  else {
    const alt = page.locator('div:has-text("選擇更多檔案") button[data-testid="submit-button"]').last();
    if (await alt.count()) await alt.click();
  }

  // ZUMEN 回應不可信，輪詢檔案清單直到新檔出現才算成功；大影片給比較長的時間
  const deadline = Date.now() + Math.min(20 * 60000, 180000 + sizeMB * 4000);
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    const now = await listFilesAPI(drawingId, type).catch(() => []);
    if (now.some(f => !before.has(f.id))) return true;
  }
  return false;
}

app.post('/api/drawings/:id/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '沒有收到檔案' });
  const drawingId = String(req.params.id).replace(/\D/g, '');
  const type = String(req.query.type || 'drawing');
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = { state: 'queued', message: '排隊中…', drawingId, type, name: path.basename(req.file.path), createdAt: Date.now() };
  jobs.set(jobId, job);
  res.json({ jobId });

  const sizeMB = req.file.size / 1048576;
  withPage(async () => {
    job.state = 'uploading';
    job.message = '正在上傳到 ZUMEN…';
    try {
      const ok = await uploadFileToTab(drawingId, type, req.file.path, sizeMB);
      job.state = ok ? 'done' : 'error';
      job.message = ok ? '上傳完成' : '上傳逾時，請稍後到 ZUMEN 確認檔案是否出現';
    } catch (e) {
      job.state = 'error';
      job.message = e.message.slice(0, 200);
    } finally {
      cleanupUpload(req.file);
      console.log(`[上傳] ${job.name} → drawings/${drawingId} (${type}) ${job.state}`);
    }
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
