import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { deflateRawSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const XLSX = require('../dashboard/vendor/sheetjs/xlsx.full.min.js');
const Model = require('../dashboard/js/mail-workbook-model.js');
const workerSource = readFileSync(new URL('../dashboard/js/mail-workbook-worker.js', import.meta.url), 'utf8');
const previewSource = readFileSync(new URL('../dashboard/js/mail-workbook-preview.js', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('./fixtures/mail-workbooks/sample-school-order.xls', import.meta.url));
const readOptions = { type: 'buffer', cellNF: true, cellStyles: true, cellFormula: true, cellHTML: false, WTF: true };
function workbook() {
  return { SheetNames: ['주간 발주', '검토 메모'], Sheets: {
    '주간 발주': { '!ref': 'A1:U205', A1: { t: 's', v: '시험 원본' }, A2: { t: 's', v: '<img src=x onerror=alert(1)>' },
      B2: { t: 'n', v: 1234.5, z: '#,##0.00' }, C2: { t: 'n', f: 'SUM(B3:B4)', v: 6, z: '0"병"' },
      D2: { t: 'n', f: 'SUM(B3:B4)' }, E2: { t: 's', v: '링크 문자', l: { Target: 'https://invalid.example/' } },
      A100: { t: 's', v: '구간을 가로지르는 병합' }, U205: { t: 's', v: '마지막 셀' },
      '!merges': [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }, { s: { r: 99, c: 0 }, e: { r: 101, c: 1 } }],
      '!rows': [{}, { hidden: true }], '!cols': [{}, { hidden: true }] },
    '검토 메모': { '!ref': 'C5:C5', C5: { t: 's', v: '숨김 시트 값' } }
  }, Workbook: { Sheets: [{ name: '주간 발주', Hidden: 0 }, { name: '검토 메모', Hidden: 2 }] } };
}
function zip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name), data = Buffer.from(item.data || ''), compressed = item.deflate ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30 + name.length); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(item.deflate ? 8 : 0, 8); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(item.expanded ?? data.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(item.deflate ? 8 : 0, 10); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(item.expanded ?? data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); name.copy(central, 46);
    locals.push(local, compressed); centrals.push(central); offset += local.length + compressed.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const minimumEntries = extra => [{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'xl/workbook.xml', data: '<workbook/>' }, ...extra];

test('official pinned library and synthetic HTML XLS retain original Korean values and merge addresses', () => {
  assert.equal(XLSX.version, '0.20.3');
  const format = Model.sniffFormat(fixture, '발주서.xls'); assert.equal(format.kind, 'html'); assert.equal(format.mismatch, true);
  const wb = XLSX.read(fixture.toString('utf8'), { ...readOptions, type: 'string', raw: true });
  const meta = Model.describeWorkbook(wb, XLSX), page = Model.sheetPage(wb, meta, { sheetIndex: 0 }, XLSX);
  assert.equal(page.rows[2].cells[2].text, '가상 중국산 참기름 1.8L');
  assert.equal(page.rows[4].cells[3].text, '4'); assert.equal(page.rows[8].cells[3].text, '13');
  assert.equal(page.merges[0].address, 'A1:E1'); assert.equal(meta.sheets[0].rows, 9);
});

test('XLSX parser displays saved numbers, formula caches, hidden sheets and source row/column metadata', async () => {
  // Test-only in-memory serialization: no customer workbook is created or changed.
  const bytes = XLSX.write(workbook(), { type: 'buffer', bookType: 'xlsx', compression: true });
  const before = Buffer.from(bytes), entries = Model.inspectZip(bytes);
  await Model.verifyInflatedSize(bytes, entries);
  const wb = XLSX.read(bytes, readOptions), meta = Model.describeWorkbook(wb, XLSX);
  assert.equal(meta.sheets.length, 2); assert.equal(meta.sheets[1].hidden, 2);
  assert.equal(meta.sheets[0].hiddenRows, 1); assert.equal(meta.sheets[0].hiddenColumns, 1);
  const page = Model.sheetPage(wb, meta, { sheetIndex: 0 }, XLSX);
  assert.equal(page.rows[1].cells[1].text, '1,234.50'); assert.equal(page.rows[1].cells[2].text, '6병');
  assert.equal(page.rows[1].cells[2].formula, 'SUM(B3:B4)'); assert.equal(page.rows[1].cells[2].cached, true);
  assert.equal(page.rows[1].cells[3].cached, false); assert.equal(page.rows[1].cells[3].text, '저장된 계산값 없음');
  assert.equal(page.rows[1].hidden, true); assert.equal(page.columns[1].hidden, true); assert.deepEqual(Buffer.from(bytes), before);
});

test('legacy BIFF XLS Korean cells and hidden sheet names survive read-only parse', () => {
  const bytes = XLSX.write(workbook(), { type: 'buffer', bookType: 'biff8' });
  assert.equal(Model.sniffFormat(bytes, '발주.xls').kind, 'xls');
  const wb = XLSX.read(bytes, readOptions), meta = Model.describeWorkbook(wb, XLSX);
  assert.equal(meta.sheets[0].name, '주간 발주'); assert.equal(meta.sheets[1].hidden, 2);
  const last = Model.sheetPage(wb, meta, { sheetIndex: 0, page: 2, columnPage: 1 }, XLSX);
  assert.equal(last.rows.at(-1).cells.at(-1).text, '마지막 셀');
});

test('row and column pages expose every original coordinate and split merges without silent clipping', () => {
  const wb = workbook(), meta = Model.describeWorkbook(wb, XLSX);
  const first = Model.sheetPage(wb, meta, { sheetIndex: 0 }, XLSX);
  assert.equal(first.rows.length, 100); assert.equal(first.columns.length, 20); assert.equal(first.pageCount, 3); assert.equal(first.columnPageCount, 2);
  assert.equal(first.merges[1].clipped, true); assert.equal(first.merges[1].cell.text, '구간을 가로지르는 병합');
  const second = Model.sheetPage(wb, meta, { sheetIndex: 0, page: 1 }, XLSX);
  assert.equal(second.rows[0].label, 101); assert.equal(second.merges[0].address, 'A100:B102'); assert.equal(second.merges[0].clipped, true);
  const last = Model.sheetPage(wb, meta, { sheetIndex: 0, page: 2, columnPage: 1 }, XLSX);
  assert.equal(last.rows.length, 5); assert.equal(last.columns[0].label, 'U'); assert.equal(last.rows.at(-1).cells[0].address, 'U205');
  const hidden = Model.sheetPage(wb, meta, { sheetIndex: 1 }, XLSX);
  assert.equal(hidden.rows[0].label, 5); assert.equal(hidden.columns[0].label, 'C'); assert.equal(hidden.rows[0].cells[0].text, '숨김 시트 값');
});

test('uncached formulas stay explicitly unresolved and HTML or hyperlinks remain inert text', () => {
  const wb = workbook(), meta = Model.describeWorkbook(wb, XLSX), page = Model.sheetPage(wb, meta, { sheetIndex: 0 }, XLSX);
  assert.equal(page.rows[1].cells[3].cached, false); assert.equal(page.rows[1].cells[3].text, '저장된 계산값 없음');
  assert.equal(page.rows[1].cells[0].text, '<img src=x onerror=alert(1)>'); assert.equal(page.rows[1].cells[4].link, true);
  assert.doesNotMatch(previewSource, /innerHTML|insertAdjacentHTML|sheet_to_html|eval\(/);
  assert.match(previewSource, /node\.textContent = String\(text\)/); assert.match(previewSource, /const copy = bytes\.slice\(\)/);
  assert.doesNotMatch(workerSource, /fetch\(|XMLHttpRequest|eval\(/);
});

test('file, sheet, merge and sparse range limits fail clearly instead of dropping content', () => {
  assert.throws(() => Model.inputBytes(new Uint8Array(3 * 1024 * 1024 + 1)), /3 MB/);
  assert.throws(() => Model.sniffFormat(new TextEncoder().encode('plain junk'), 'bad.xls'), /지원하는 Excel/);
  assert.throws(() => Model.sniffFormat(fixture, 'fake.csv'), /CSV 확장자/);
  const wb = workbook(); wb.Sheets['주간 발주']['!ref'] = 'A1:XFD1048576'; assert.throws(() => Model.describeWorkbook(wb, XLSX), /행·열 범위/);
  const merged = workbook(); merged.Sheets['주간 발주']['!merges'].push({ s: { r: 0, c: 1 }, e: { r: 1, c: 2 } }); assert.throws(() => Model.describeWorkbook(merged, XLSX), /겹치는 병합/);
  const missing = workbook(); delete missing.Sheets['검토 메모']; assert.throws(() => Model.describeWorkbook(missing, XLSX), /일부 시트/);
});

test('ZIP structural checks reject traversal, duplicate names and dishonest expanded size before parser', async () => {
  assert.throws(() => Model.inspectZip(zip(minimumEntries([{ name: '../escape.xml' }]))), /압축 경로/);
  assert.throws(() => Model.inspectZip(zip(minimumEntries([{ name: 'xl/workbook.xml' }]))), /압축 경로/);
  assert.throws(() => Model.inspectZip(zip(minimumEntries([{ name: 'xl/sheet.xml', data: 'x', expanded: 49 * 1024 * 1024 }]))), /압축 해제/);
  const dishonest = zip(minimumEntries([{ name: 'xl/sheet.xml', data: 'x'.repeat(1000), deflate: true, expanded: 100 }]));
  await assert.rejects(Model.verifyInflatedSize(dishonest, Model.inspectZip(dishonest)), /실제 압축 해제 크기/);
  const valid = zip(minimumEntries([{ name: 'xl/sheet.xml', data: 'small deflated test', deflate: true }]));
  assert.ok(await Model.verifyInflatedSize(valid, Model.inspectZip(valid)) > 0);
});

test('worker opens one HTML table and raw CSV without executing formula-like strings; multiple tables fail closed', async () => {
  const sent = [], context = { self: { postMessage: data => sent.push(data) }, importScripts() {}, MailWorkbookModel: Model, XLSX,
    TextDecoder, Uint8Array, ArrayBuffer, Blob, DecompressionStream };
  runInNewContext(workerSource, context);
  await context.self.onmessage({ data: { id: 1, type: 'open', bytes: new Uint8Array(fixture), fileName: '시험.xls' } });
  assert.equal(sent[0].result.sheets[0].rows, 9);
  const csvSent = [], csvContext = { ...context, self: { postMessage: data => csvSent.push(data) } }; runInNewContext(workerSource, csvContext);
  await csvContext.self.onmessage({ data: { id: 1, type: 'open', bytes: new TextEncoder().encode('상품,수량\n=HYPERLINK("https://invalid.example"),2'), fileName: '시험.csv' } });
  assert.equal(csvSent[0].result.formulaCount, 0);
  await csvContext.self.onmessage({ data: { id: 2, type: 'page', sheetIndex: 0 } }); assert.match(csvSent[1].result.rows[1].cells[0].text, /^=HYPERLINK/);
  const multiSent = [], multi = { ...context, self: { postMessage: data => multiSent.push(data) } }; runInNewContext(workerSource, multi);
  await multi.self.onmessage({ data: { id: 1, type: 'open', bytes: new TextEncoder().encode('<table><tr><td>A</td></tr></table><table><tr><td>B</td></tr></table>'), fileName: '시험.xls' } });
  assert.match(multiSent[0].error, /표가 여러 개/);
});
