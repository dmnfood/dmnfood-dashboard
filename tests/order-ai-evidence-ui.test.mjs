import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { parseCellAddress } from '../dashboard/js/mail-workbook-selection.js';

const source = await readFile(new URL('../dashboard/js/order-ai-evidence.js', import.meta.url), 'utf8');
class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = {}; this.style = {}; this._text = ''; this.open = false; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, action) { this.listeners.set(name, action); }
  fire(name) { if (!this.disabled) this.listeners.get(name)?.({ target: this, preventDefault() {} }); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { this.parentNode.children = this.parentNode.children.filter(node => node !== this); }
}
const all = (node, predicate) => [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => all(child, predicate))];
const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('UI did not settle'); };
const rawHash = 'b'.repeat(64), digest = bytes => createHash('sha256').update(bytes).digest('hex');
const originalBytes = Buffer.from('fictional workbook bytes'), sha256 = digest(originalBytes);
function analysisValue({ rows = [100, 199], sources = true, mailId = 'a'.repeat(64), sourceHash = rawHash } = {}) {
  const lines = rows.map((rowIndex, index) => ({ id: `line-${index}`, quantity: String(index + 1), unit: '병', source: {
    attachmentId: '2', sheetIndex: 0, rowIndex, productCells: [`C${rowIndex + 1}`], quantityCell: `Y${rowIndex + 1}`, unitCell: `X${rowIndex + 1}`, bbox: null,
  } }));
  return { mail: { id: mailId, rawStorage: { sha256: rawHash } }, analysis: { id: 'test-analysis', intakeId: mailId, sourceHash, revision: 1, status: 'ready',
    sources: sources ? [{ attachmentId: '2', sha256, kind: 'workbook', complete: true }] : [], lines }, group: { id: 'oil', label: '가상 참기름', quantity: '3', unit: '병', lineIds: lines.map(line => line.id) } };
}
function harness({ defer = false, sheetRange = { s: { r: 2, c: 2 }, e: { r: 204, c: 24 } } } = {}) {
  const body = new Node('body'), fetches = [], pending = [], books = [], focuses = [];
  const metadata = { sheets: [{ index: 0, name: '원본', range: sheetRange }] };
  function book() {
    const cleanup = () => { cleanup.closed = true; }; cleanup.getMetadata = () => metadata;
    cleanup.focusEvidence = async value => { if (cleanup.closed) return null; focuses.push(JSON.parse(JSON.stringify(value))); return value; };
    books.push(cleanup); return cleanup;
  }
  const context = vm.createContext({ document: { body, createElement: tag => new Node(tag) }, parseCellAddress, URL, Uint8Array, Blob, atob, crypto: webcrypto, AbortController,
    renderMailWorkbook: () => defer ? new Promise(resolve => pending.push(() => resolve(book()))) : Promise.resolve(book()),
    fetch: async (path, init) => { fetches.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ok: true, attachment: {
      id: '2', fileName: '가상 발주.xlsx', byteLength: originalBytes.length, contentBase64: originalBytes.toString('base64'), sha256,
    } }) }; } });
  vm.runInContext(`${source.replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')}\nglobalThis.init = initOrderAiEvidence;`, context);
  const ui = context.init({ user: { getIdToken: async () => 'fictional-ui-token' } });
  return { ui, body, fetches, pending, books, focuses, complete: () => all(body, node => node.tagName === 'BUTTON' && ['이 상품 원본 대조 완료', '제외한 행 원본 확인 완료'].includes(node.textContent))[0],
    navigation: () => all(body, node => node.className === 'order-ai-evidence-navigation')[0] };
}

test('evidence review requires every referenced row and product/unit/quantity column page on non-A1 sheets', async () => {
  const app = harness(), value = analysisValue(); const review = app.ui.review(value);
  try {
    await until(() => app.focuses.length > 0);
    for (let attempts = 0; attempts < 20 && app.complete().disabled; attempts++) {
      const button = app.navigation().children.find(node => !node.textContent.includes('확인'));
      assert.ok(button, 'an unreviewed original page remains reachable'); button.fire('click'); await until(() => app.focuses.length > attempts + 1 || !app.complete().disabled);
    }
    assert.equal(app.complete().disabled, false);
    const visible = app.focuses.map(focus => {
      const row = focus.quantityCells[0]?.row ?? focus.rowIndexes[0], column = focus.columnIndex ?? focus.quantityCells[0]?.column ?? 2;
      const startRow = 2 + Math.floor((row - 2) / 100) * 100, startColumn = 2 + Math.floor((column - 2) / 20) * 20;
      return { startRow, endRow: startRow + 99, startColumn, endColumn: startColumn + 19 };
    });
    for (const line of value.analysis.lines) for (const address of [...line.source.productCells, line.source.quantityCell, line.source.unitCell]) {
      const { row, column } = parseCellAddress(address);
      assert.equal(visible.some(page => row >= page.startRow && row <= page.endRow && column >= page.startColumn && column <= page.endColumn), true, `${address} must appear on a visited source page`);
    }
    app.complete().fire('click'); assert.equal(await review, true);
  } finally { app.ui.destroy(); }
});

test('missing attachment manifest hashes and changed mail source identities cannot be reviewed', async () => {
  for (const value of [analysisValue({ sources: false }), analysisValue({ sourceHash: 'c'.repeat(64) })]) {
    const app = harness(); const review = app.ui.review(value);
    try { await until(() => app.body.textContent.includes('다릅니다') || app.body.textContent.includes('확인') && app.fetches.length === 0 || app.focuses.length > 0);
      assert.equal(app.complete().disabled, true); assert.equal(app.fetches.length, 0, 'unbound source references fail before archive fetch');
      app.ui.close(); assert.equal(await review, false);
    } finally { app.ui.destroy(); }
  }
});

test('a stale workbook render finishing after a new review cannot close the active source controller', async () => {
  const app = harness({ defer: true }), value = analysisValue({ rows: [3] });
  const oldReview = app.ui.review(value); await until(() => app.pending.length === 1);
  const newReview = app.ui.review(value); assert.equal(await oldReview, false); await until(() => app.pending.length === 2);
  try {
    app.pending[1](); await until(() => app.books.length === 1 && app.focuses.length > 0); const activeBook = app.books[0];
    app.pending[0](); await until(() => app.books.length === 2); await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.books[1].closed, true, 'only the stale source is cleaned up'); assert.notEqual(activeBook.closed, true);
    app.ui.close(); assert.equal(await newReview, false); assert.equal(activeBook.closed, true, 'closing review still cleans the actual active source');
  } finally { app.ui.destroy(); }
});

test('excluded rows require every original column page, including product details far to the right', async () => {
  const sheetRange = { s: { r: 2, c: 2 }, e: { r: 204, c: 63 } };
  const app = harness({ sheetRange }), value = analysisValue({ rows: [100] });
  value.exclusions = true;
  value.group = { id: '__excluded__', label: '제외한 원본', lineIds: [] };
  value.analysis.sources[0].sheets = [{ sheetIndex: 0, sheetName: '원본', range: sheetRange }];
  value.analysis.exclusions = [{ attachmentId: '2', sheetIndex: 0, rowIndex: 100, reason: '가상 제외 행' }];
  const review = app.ui.review(value);
  try {
    await until(() => app.focuses.length === 1);
    assert.equal(app.navigation().children.length, 4, 'C:BL spans four original 20-column pages');
    assert.equal(app.complete().disabled, true, 'the first date/school column page is insufficient');
    for (let seen = 1; seen < 4; seen++) {
      const next = app.navigation().children.find(node => !node.textContent.includes('확인'));
      assert.ok(next); next.fire('click'); await until(() => app.focuses.length === seen + 1);
      if (seen < 3) assert.equal(app.complete().disabled, true);
    }
    assert.deepEqual(app.focuses.map(value => value.columnIndex), [2, 22, 42, 62]);
    assert.equal(app.focuses.every(value => value.rowIndexes.includes(100)), true);
    assert.equal(app.complete().disabled, false); app.complete().fire('click'); assert.equal(await review, true);
  } finally { app.ui.destroy(); }
});

test('excluded row review fails closed when the original sheet bounds are missing', async () => {
  const app = harness(), value = analysisValue({ rows: [100] });
  value.exclusions = true; value.group = { id: '__excluded__', label: '제외한 원본', lineIds: [] };
  value.analysis.exclusions = [{ attachmentId: '2', sheetIndex: 0, rowIndex: 100, reason: '가상 제외 행' }];
  const review = app.ui.review(value);
  try {
    await until(() => app.body.textContent.includes('전체 대조 위치'));
    assert.equal(app.complete().disabled, true); assert.equal(app.fetches.length, 0);
    app.ui.close(); assert.equal(await review, false);
  } finally { app.ui.destroy(); }
});
