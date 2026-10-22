// 在 Excel「表格」（插入 → 表格，例如生產履歷範本的 表格1）最後加一列。
//
// 為什麼直接改 xlsx 裡的 XML，而不是用 exceljs 之類的套件整份讀進來再存：
// 生產履歷是 Excel 表格物件（綠色是表格樣式 TableStyleLight21），exceljs 讀寫會弄壞或丟掉表格，
// 存回去顏色就沒了。這裡只動三個地方——那一列的儲存格、表格範圍 ref、工作表 dimension，
// 其它內容原封不動，格式最保險。
const JSZip = require('jszip');

const xmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const xmlUnesc = s => String(s).replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (m, e) =>
  ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e] ?? String.fromCharCode(+e.slice(1))));
const colNum = letters => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colLetter = n => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
function parseRef(ref) {
  const m = ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!m) throw new Error('看不懂表格範圍 ' + ref);
  return { c1: colNum(m[1]), r1: +m[2], c2: colNum(m[3]), r2: +m[4] };
}
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
// 路徑：Target 可能是相對（worksheets/sheet1.xml、../tables/table1.xml）或絕對（/xl/...）
function resolve(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const p of target.split('/')) { if (p === '..') parts.pop(); else if (p !== '.') parts.push(p); }
  return parts.join('/');
}
const relsPathOf = p => p.replace(/([^/]+)$/, '_rels/$1.rels');

function rowRe(r) { return new RegExp(`<row\\b[^>]*\\br="${r}"[^>]*?(?:\\/>|>[\\s\\S]*?<\\/row>)`); }
function cellsOf(rowXml) {
  const out = [];
  const re = /<c\b[^>]*\br="([A-Z]+)(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
  let m;
  while ((m = re.exec(rowXml || ''))) out.push({ col: colNum(m[1]), xml: m[0] });
  return out;
}
function cellText(cellXml, shared) {
  const t = attr(cellXml.match(/^<c\b[^>]*>/)?.[0] || '', 't');
  if (t === 's') { const v = cellXml.match(/<v>(\d+)<\/v>/); return v ? shared[+v[1]] || '' : ''; }
  if (t === 'inlineStr') return xmlUnesc([...cellXml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''));
  const v = cellXml.match(/<v>([\s\S]*?)<\/v>/);
  return v ? xmlUnesc(v[1]) : '';
}

// 找出活頁簿裡第一個有「表格」的工作表
async function locate(buf) {
  const zip = await JSZip.loadAsync(buf);
  const read = p => zip.file(p)?.async('string');
  const wbXml = await read('xl/workbook.xml');
  const wbRels = await read('xl/_rels/workbook.xml.rels');
  if (!wbXml || !wbRels) throw new Error('不是有效的 .xlsx 檔');
  const sharedXml = await read('xl/sharedStrings.xml') || '';
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(m => xmlUnesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')));
  for (const s of wbXml.matchAll(/<sheet\b[^>]*\/>/g)) {
    const rid = attr(s[0], 'r:id');
    const rel = wbRels.match(new RegExp(`<Relationship\\b[^>]*\\bId="${rid}"[^>]*>`))?.[0];
    if (!rel) continue;
    const sheetPath = resolve('xl/workbook.xml', attr(rel, 'Target'));
    const sheetRels = await read(relsPathOf(sheetPath));
    const tRel = sheetRels?.match(/<Relationship\b[^>]*\/relationships\/table"[^>]*>/)?.[0]
              || sheetRels?.match(/<Relationship\b[^>]*Type="[^"]*\/table"[^>]*>/)?.[0];
    if (!tRel) continue;
    const tablePath = resolve(sheetPath, attr(tRel, 'Target'));
    return { zip, shared, sheetName: xmlUnesc(attr(s[0], 'name')), sheetPath, tablePath,
             sheetXml: await read(sheetPath), tableXml: await read(tablePath) };
  }
  throw new Error('這個 Excel 裡沒有「表格」，手機無法新增（請在電腦用 Excel 的「插入 → 表格」建立）');
}

function tableInfo(tableXml) {
  const head = tableXml.match(/<table\b[^>]*>/)[0];
  if (attr(head, 'headerRowCount') === '0') throw new Error('表格沒有標題列，無法判斷欄位');
  if (+(attr(head, 'totalsRowCount') || 0) > 0) throw new Error('表格有「合計列」，手機新增暫不支援');
  const columns = [...tableXml.matchAll(/<tableColumn\b[^>]*>/g)].map(m => xmlUnesc(attr(m[0], 'name') || ''));
  return { ref: parseRef(attr(head, 'ref')), refText: attr(head, 'ref'), columns };
}

// 回傳手機表單要的資訊：欄位名稱、目前幾筆
async function describe(buf) {
  const L = await locate(buf);
  const t = tableInfo(L.tableXml);
  let filled = 0;
  for (let r = t.ref.r1 + 1; r <= t.ref.r2; r++) {
    const row = L.sheetXml.match(rowRe(r))?.[0];
    if (cellsOf(row).some(c => c.col >= t.ref.c1 && c.col <= t.ref.c2 && cellText(c.xml, L.shared).trim())) filled++;
  }
  return { sheetName: L.sheetName, columns: t.columns, rows: filled };
}

async function appendRow(buf, values) {
  const L = await locate(buf);
  const t = tableInfo(L.tableXml);
  const { c1, r1, c2, r2 } = t.ref;
  if (values.length !== c2 - c1 + 1) throw new Error('欄位數量不符');
  const rowXmlOf = r => L.sheetXml.match(rowRe(r))?.[0];
  const isEmpty = r => !cellsOf(rowXmlOf(r)).some(c => c.col >= c1 && c.col <= c2 && cellText(c.xml, L.shared).trim());

  // 範本會預留一列空的資料列（例如 A3:C3）：有空的就先填它，沒有才把表格往下延長一列
  let target = null;
  for (let r = r1 + 1; r <= r2; r++) if (isEmpty(r)) { target = r; break; }
  let newR2 = r2;
  if (target === null) {
    target = r2 + 1;
    if (!isEmpty(target)) throw new Error(`表格下方第 ${target} 列已經有其它資料，無法往下新增`);
    newR2 = target;
  }

  // 每一格的樣式（s）：沿用這一列原本的，沒有就沿用上一列資料列的，跟原本格式一致
  const own = cellsOf(rowXmlOf(target));
  const above = target - 1 > r1 ? cellsOf(rowXmlOf(target - 1)) : own;
  const styleOf = col => attr((own.find(c => c.col === col) || above.find(c => c.col === col))?.xml || '', 's');
  const newCells = [];
  for (let col = c1; col <= c2; col++) {
    const s = styleOf(col);
    const v = String(values[col - c1] ?? '');
    newCells.push({ col, xml: v
      ? `<c r="${colLetter(col)}${target}"${s ? ` s="${s}"` : ''} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`
      : `<c r="${colLetter(col)}${target}"${s ? ` s="${s}"` : ''}/>` });
  }
  // 表格範圍以外的儲存格保留不動
  const cells = [...own.filter(c => c.col < c1 || c.col > c2), ...newCells].sort((a, b) => a.col - b.col);

  let sheetXml = L.sheetXml;
  const existing = rowXmlOf(target);
  if (existing) {
    const open = existing.match(/^<row\b[^>]*?(?=\/?>)/)[0];
    sheetXml = sheetXml.replace(existing, `${open}>${cells.map(c => c.xml).join('')}</row>`);
  } else {
    // 新列：沿用上一列的列高等屬性
    const prevOpen = rowXmlOf(target - 1)?.match(/^<row\b[^>]*?(?=\/?>)/)?.[0] || `<row r="${target - 1}"`;
    const open = prevOpen.replace(/\br="\d+"/, `r="${target}"`);
    const rowXml = `${open}>${cells.map(c => c.xml).join('')}</row>`;
    const after = [...sheetXml.matchAll(/<row\b[^>]*\br="(\d+)"/g)].find(m => +m[1] > target);
    sheetXml = after ? sheetXml.slice(0, after.index) + rowXml + sheetXml.slice(after.index)
                     : sheetXml.replace('</sheetData>', rowXml + '</sheetData>').replace('<sheetData/>', `<sheetData>${rowXml}</sheetData>`);
  }

  // dimension 與表格範圍延長到新列
  sheetXml = sheetXml.replace(/<dimension ref="([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?"/, (m, a, b, c, d) =>
    (+(d || b) >= target ? m : `<dimension ref="${a}${b}:${c || a}${target}"`));
  L.zip.file(L.sheetPath, sheetXml);
  if (newR2 !== r2) {
    const newRef = `${colLetter(c1)}${r1}:${colLetter(c2)}${newR2}`;
    L.zip.file(L.tablePath, L.tableXml.split(`ref="${t.refText}"`).join(`ref="${newRef}"`));
  }
  const out = await L.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer: out, row: target };
}

// read-back：讀出某一列表格欄位的文字，用來確認真的寫進去了
async function readRow(buf, r) {
  const L = await locate(buf);
  const { c1, c2 } = tableInfo(L.tableXml).ref;
  const cells = cellsOf(L.sheetXml.match(rowRe(r))?.[0]);
  const vals = [];
  for (let col = c1; col <= c2; col++) vals.push(cellText(cells.find(c => c.col === col)?.xml || '', L.shared));
  return vals;
}

module.exports = { describe, appendRow, readRow };
