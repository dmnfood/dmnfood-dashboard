import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { parseCellAddress } from '../dashboard/js/mail-workbook-selection.js';
import { createOrderAiTextSource, getOrderAiTextRows, validOrderAiTextRange } from '../dashboard/js/order-text-source-model.js';
import { normalizeOrderAiQuantity } from '../dashboard/js/order-ai-model.js';

const source = await readFile(new URL('../dashboard/js/order-ai-evidence.js', import.meta.url), 'utf8');
class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = {}; this.style = {}; this._text = ''; this.open = false; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  get isConnected() { return this.tagName === 'BODY' || this.parentNode?.isConnected === true; }
  set textContent(value) { this._text = String(value); for (const child of this.children) child.parentNode = null; this.children = []; }
  append(...nodes) { for (const node of nodes) { if (node.parentNode) node.remove(); node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, action) { this.listeners.set(name, action); }
  fire(name) { if (!this.disabled) this.listeners.get(name)?.({ target: this, preventDefault() {} }); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
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
function harness({ defer = false, textSource, imageSize = { width: 1, height: 1 }, deferImage = false, sheetRange = { s: { r: 2, c: 2 }, e: { r: 204, c: 24 } } } = {}) {
  const body = new Node('body'), fetches = [], pending = [], books = [], focuses = [], focusOptions = [], imageDecodes = [], renderOptions = [];
  const metadata = { sheets: [{ index: 0, name: '원본', range: sheetRange }] };
  function book() {
    const cleanup = () => { cleanup.closed = true; }; cleanup.getMetadata = () => metadata;
    cleanup.focusEvidence = async (value, options) => { if (cleanup.closed) return null; focuses.push(JSON.parse(JSON.stringify(value))); focusOptions.push(options); return value; };
    books.push(cleanup); return cleanup;
  }
  const createElement = tag => { const node = new Node(tag); if (String(tag).toLowerCase() === 'img') { node.naturalWidth = imageSize.width; node.naturalHeight = imageSize.height; node.decode = () => deferImage ? new Promise(resolve => imageDecodes.push(resolve)) : Promise.resolve(); } return node; };
  const context = vm.createContext({ document: { body, createElement }, parseCellAddress, createOrderAiTextSource, getOrderAiTextRows, validOrderAiTextRange, normalizeOrderAiQuantity, TextEncoder, URL, Uint8Array, Blob, atob, crypto: webcrypto, AbortController,
    renderMailWorkbook: options => { renderOptions.push(options); return defer ? new Promise(resolve => pending.push(() => resolve(book()))) : Promise.resolve(book()); },
    fetch: async (path, init) => { fetches.push(init.body ? JSON.parse(init.body) : { path }); if (String(path).includes('/text-sources?')) return { ok: true, json: async () => ({ ok: true, source: textSource }) }; return { ok: true, json: async () => ({ ok: true, attachment: {
      id: '2', fileName: '가상 발주.xlsx', byteLength: originalBytes.length, contentBase64: originalBytes.toString('base64'), sha256,
    } }) }; } });
  vm.runInContext(`${source.replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')}\nglobalThis.init = initOrderAiEvidence;`, context);
  const ui = context.init({ user: { getIdToken: async () => 'fictional-ui-token' } });
  return { ui, body, fetches, pending, books, focuses, focusOptions, imageDecodes, renderOptions, mount: () => { const mount = new Node('div'); body.append(mount); return mount; }, complete: () => all(body, node => node.tagName === 'BUTTON' && ['원본 대조 완료', '이 상품 원본 대조 완료', '제외한 행 원본 확인 완료', '대조 완료'].includes(node.textContent))[0],
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
    assert.equal(app.focusOptions.every(options => options.local === false), true, 'standalone review keeps the workbook default scrolling');
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

function textValue(text) {
  const id = 'a'.repeat(64), sha256 = digest(Buffer.from(text)), file = createOrderAiTextSource({ text, sha256, channel: 'kakao' });
  const lines = file.rows.filter(row => text.slice(row.start, row.end).includes('11병')).map((row, index) => {
    const q = text.indexOf('11병', row.start);
    return { id: `line-${index}`, quantity: '11', unit: '병', source: { attachmentId: 'text', sheetIndex: null, rowIndex: row.rowIndex, productCells: [], quantityCell: null, unitCell: null, bbox: null,
      textRanges: { product: [{ start: row.start, end: q }], quantity: { start: q, end: q + 2 }, unit: { start: q + 2, end: q + 3 } } } };
  });
  const record = { id, sha256, text, channel: 'kakao', title: '가상 원문' };
  return { record, value: { mail: { id, sourceKind: 'text', sourceChannel: 'kakao', rawStorage: { sha256 }, textSource: record },
    analysis: { intakeId: id, sourceHash: sha256, revision: 1, status: 'needs_review', sources: [{ attachmentId: 'text', kind: 'text', sha256, complete: true, rows: file.rows.map(({ rowIndex, start, end }) => ({ rowIndex, start, end })) }], lines },
    group: { id: 'test-oil', label: '중국산 참기름 1.8L', quantity: String(lines.length * 11), unit: '병', lineIds: lines.map(line => line.id) } } };
}
test('pasted-text evidence fetches immutable raw text, highlights exact quantities and requires every referenced text page', async () => {
  const { value, record } = textValue('중국산 참기름 1.8L 11병\n' + '\n'.repeat(41) + '중국산 참기름 1.8L 11병'), app = harness({ textSource: record }), review = app.ui.review(value);
  try {
    await until(() => app.navigation().children.length === 2 && app.body.textContent.includes('합계 22'));
    assert.equal(app.complete().disabled, true); assert.match(app.fetches[0].path, /\/api\/order-ai\/text-sources\?id=/);
    assert.equal(all(app.body, node => node.className === 'order-ai-text-mark-quantity').map(node => node.textContent).join(','), '11');
    app.navigation().children[1].fire('click'); await until(() => app.complete().disabled === false);
    assert.equal(all(app.body, node => node.className === 'order-ai-text-mark-quantity').map(node => node.textContent).join(','), '11');
    app.complete().fire('click'); assert.equal(await review, true);
  } finally { app.ui.destroy(); }
});
test('changed raw pasted text or forged text quantity ranges cannot enable source review completion', async () => {
  for (const change of ['hash', 'range', 'manifest']) {
    const { value, record } = textValue('중국산 참기름 1.8L 11병');
    if (change === 'hash') record.text = record.text.replace('11병', '99병');
    if (change === 'range') value.analysis.lines[0].source.textRanges.quantity.end--;
    if (change === 'manifest') value.analysis.sources[0].rows[0].end--;
    const app = harness({ textSource: record }), review = app.ui.review(value);
    try { await until(() => app.body.textContent.includes('실패') || app.body.textContent.includes('다릅니다')); assert.equal(app.complete().disabled, true); app.ui.close(); assert.equal(await review, false); }
    finally { app.ui.destroy(); }
  }
});
test('pasted-text preview preserves literal hostile text without HTML and has no approval action', async () => {
  const { value, record } = textValue('<img src="https://example.invalid/pixel">\r\n중국산 참기름 1.8L 11병'), app = harness({ textSource: record });
  const preview = app.ui.preview({ mail: value.mail });
  try {
    await until(() => app.body.textContent.includes('<img src='));
    assert.equal(all(app.body, node => node.tagName === 'IMG' || node.tagName === 'SCRIPT').length, 0);
    assert.equal(app.complete().hidden, true); app.ui.close(); assert.equal(await preview, false);
  } finally { app.ui.destroy(); }
});
test('text exclusion review visits every referenced text page and accepts Firestore field reordering', async () => {
  const { value, record } = textValue('가상 안내\n' + '\n'.repeat(40) + '가상 끝 안내'), app = harness({ textSource: record });
  value.exclusions = true; value.group = { id: '__excluded__', label: '제외한 원문', lineIds: [] };
  value.analysis.sources[0].rows = value.analysis.sources[0].rows.map(({ rowIndex, start, end }) => ({ end, start, rowIndex }));
  value.analysis.exclusions = value.analysis.sources[0].rows.map(row => ({ attachmentId: 'text', sheetIndex: null, rowIndex: row.rowIndex, reason: '가상 안내' }));
  const review = app.ui.review(value);
  try { await until(() => app.navigation().children.length === 2 && app.body.textContent.includes('실제 발주가 제외')); assert.equal(app.complete().disabled, true);
    app.navigation().children[1].fire('click'); await until(() => !app.complete().disabled); app.complete().fire('click'); assert.equal(await review, true);
  } finally { app.ui.destroy(); }
});

function imageValue() {
  const id = 'a'.repeat(64), contentBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', bytes = Buffer.from(contentBase64, 'base64'), sha256 = digest(bytes);
  const record = { id, kind: 'image', channel: 'kakao', sha256, fileName: '가상 캡처.png', mimeType: 'image/png', byteLength: bytes.length, contentBase64 };
  return { record, value: { mail: { id, sourceKind: 'image', sourceChannel: 'kakao', rawStorage: { sha256 }, textSource: { id, kind: 'image', sha256 } },
    analysis: { intakeId: id, sourceHash: sha256, revision: 1, status: 'needs_review', sources: [{ attachmentId: 'message-image', kind: 'image', sha256, complete: true, width: 1, height: 1 }],
      lines: [{ id: 'image-line', quantity: '11', unit: '병', source: { attachmentId: 'message-image', sheetIndex: null, rowIndex: null, productCells: [], quantityCell: null, unitCell: null, bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } } }] },
    group: { id: 'image-oil', label: '중국산 참기름 1.8L', quantity: '11', unit: '병', lineIds: ['image-line'] } } };
}
test('pasted-image preview and review fetch original bytes from the manual-source API and retain bbox evidence', async () => {
  const { record, value } = imageValue(), app = harness({ textSource: record }); const review = app.ui.review(value);
  try {
    await until(() => !app.complete().disabled);
    assert.equal(app.fetches.length, 1); assert.match(app.fetches[0].path, /\/api\/order-ai\/text-sources\?id=/);
    assert.equal(all(app.body, node => node.tagName === 'IMG').length, 1);
    const marks = all(app.body, node => node.className === 'order-ai-image-evidence'); assert.equal(marks.length, 1); assert.equal(marks[0].style.left, '10%');
    assert.match(app.body.textContent, /합계 11 병/); app.complete().fire('click'); assert.equal(await review, true);
    const preview = app.ui.preview({ mail: value.mail }); await until(() => all(app.body, node => node.tagName === 'IMG').length === 1);
    assert.equal(app.complete().hidden, true); assert.equal(app.fetches.length, 2, 'readonly preview reads the full immutable source even when the list DTO contains no base64'); app.ui.close(); assert.equal(await preview, false);
  } finally { app.ui.destroy(); }
});
test('pasted-image hash, byte size, source kind, decoded dimensions and invalid boxes all block review completion', async () => {
  for (const change of ['hash', 'size', 'kind', 'pixels', 'box']) {
    const { record, value } = imageValue();
    if (change === 'hash') { const bytes = Buffer.from(record.contentBase64, 'base64'); bytes[bytes.length - 1] ^= 1; record.contentBase64 = bytes.toString('base64'); }
    if (change === 'size') record.byteLength++;
    if (change === 'kind') record.kind = 'text';
    if (change === 'pixels') value.analysis.sources[0].width = 2;
    if (change === 'box') value.analysis.lines[0].source.bbox.width = 2;
    const app = harness({ textSource: record }), review = app.ui.review(value);
    try { await until(() => app.body.textContent.includes('실패') || app.body.textContent.includes('다릅니다') || app.body.textContent.includes('일치') || app.body.textContent.includes('확인하지 못했습니다')); assert.equal(app.complete().disabled, true, change); app.ui.close(); assert.equal(await review, false); }
    finally { app.ui.destroy(); }
  }
});
test('an old pasted-image decode completing after a new review cannot unlock the active source', async () => {
  const { record, value } = imageValue(), app = harness({ textSource: record, deferImage: true });
  const previous = app.ui.review(value); await until(() => app.imageDecodes.length === 1);
  const latest = app.ui.review(value); assert.equal(await previous, false); await until(() => app.imageDecodes.length === 2);
  try {
    app.imageDecodes[0](); await new Promise(resolve => setImmediate(resolve)); assert.equal(app.complete().disabled, true);
    app.imageDecodes[1](); await until(() => !app.complete().disabled); app.ui.close(); assert.equal(await latest, false);
  } finally { app.ui.destroy(); }
});

test('inline image review shows original and product evidence in the supplied card without opening a dialog and retains the completed original', async () => {
  const { record, value } = imageValue(), app = harness({ textSource: record }), mount = app.mount();
  const review = app.ui.review({ ...value, mount });
  try {
    await until(() => app.complete() && !app.complete().disabled);
    assert.equal(all(app.body, node => node.tagName === 'DIALOG' && node.open).length, 0);
    assert.equal(all(mount, node => (node.className || '').includes('order-ai-evidence-inline')).length, 1);
    assert.equal(all(mount, node => node.tagName === 'IMG').length, 1);
    assert.match(mount.textContent, /중국산 참기름 1.8L/); assert.match(mount.textContent, /합계 11 병/);
    assert.equal(all(mount, node => node.className === 'order-ai-image-evidence').length, 1);
    app.complete().fire('click'); assert.equal(await review, true);
    assert.equal(app.complete().textContent, '대조 완료'); assert.equal(app.complete().disabled, true);
    assert.equal(all(mount, node => node.tagName === 'IMG').length, 1, 'the final reviewed original stays visible');
    app.ui.cancel(); assert.equal(mount.children.length, 0);
  } finally { app.ui.destroy(); }
});

test('inline workbook review keeps the full page gate and cleans its workbook when cancelled', async () => {
  const app = harness(), value = analysisValue(), mount = app.mount(), review = app.ui.review({ ...value, mount });
  try {
    await until(() => app.focuses.length > 0);
    assert.equal(app.complete().disabled, true);
    for (let attempts = 0; attempts < 20 && app.complete().disabled; attempts++) {
      const next = app.navigation().children.find(node => !node.textContent.includes('확인'));
      assert.ok(next); next.fire('click'); await until(() => app.focuses.length > attempts + 1 || !app.complete().disabled);
    }
    assert.equal(app.complete().disabled, false);
    assert.equal(app.focusOptions.every(options => options.local === true), true, 'all inline evidence parts stay within the workbook scroll region');
    assert.match(mount.textContent, /원본 근거 \d+\/\d+ 열람/);
    app.ui.cancel(); assert.equal(await review, false); assert.equal(mount.children.length, 0);
    assert.equal(app.books.every(book => book.closed), true);
  } finally { app.ui.destroy(); }
});

test('a detached inline card cannot accept a late workbook result or mark the old source reviewed', async () => {
  const app = harness({ defer: true }), value = analysisValue({ rows: [3] }), mount = app.mount(), review = app.ui.review({ ...value, mount });
  try {
    await until(() => app.pending.length === 1); mount.remove(); app.pending[0]();
    assert.equal(await review, false); assert.equal(app.books[0].closed, true);
    assert.equal(mount.children.length, 0); assert.equal(all(app.body, node => node.tagName === 'DIALOG' && node.open).length, 0);
  } finally { app.ui.destroy(); }
});

test('changing inline source cancels the old promise and late decode cannot unlock the replacement card', async () => {
  const { record, value } = imageValue(), app = harness({ textSource: record, deferImage: true }), mount = app.mount();
  const previous = app.ui.review({ ...value, mount }); await until(() => app.imageDecodes.length === 1);
  const latest = app.ui.review({ ...value, mount }); assert.equal(await previous, false); await until(() => app.imageDecodes.length === 2);
  try {
    app.imageDecodes[0](); await new Promise(resolve => setImmediate(resolve)); assert.equal(app.complete().disabled, true);
    app.imageDecodes[1](); await until(() => !app.complete().disabled);
    app.ui.cancel(); assert.equal(await latest, false); assert.equal(mount.children.length, 0);
  } finally { app.ui.destroy(); }
});

test('inline completion rejects a detached already-loaded mount and confirmed inline history has no approval action', async () => {
  const { record, value } = imageValue(), app = harness({ textSource: record }), mount = app.mount();
  const review = app.ui.review({ ...value, mount });
  try {
    await until(() => app.complete() && !app.complete().disabled);
    const oldButton = app.complete(); mount.remove(); oldButton.fire('click'); assert.equal(await review, false);
    const nextMount = app.mount(), readonly = app.ui.review({ ...value, analysis: { ...value.analysis, status: 'confirmed' }, mount: nextMount });
    await until(() => all(nextMount, node => node.tagName === 'IMG').length === 1 && app.complete().hidden);
    assert.equal(app.complete().disabled, true); app.ui.cancel(); assert.equal(await readonly, false);
    const preview = app.ui.preview({ mail: value.mail }); await until(() => all(app.body, node => node.tagName === 'DIALOG' && node.open).length === 1);
    app.ui.close(); assert.equal(await preview, false, 'standalone archived-source preview remains a popup');
  } finally { app.ui.destroy(); }
});

test('inline integrity failures stay inside the card and never enable a review completion', async () => {
  const { value, record } = textValue('중국산 참기름 1.8L 11병'); record.text = record.text.replace('11병', '99병');
  const app = harness({ textSource: record }), mount = app.mount(), review = app.ui.review({ ...value, mount });
  try {
    await until(() => mount.textContent.includes('실패'));
    assert.equal(app.complete().disabled, true); assert.equal(all(app.body, node => node.tagName === 'DIALOG' && node.open).length, 0);
    app.ui.cancel(); assert.equal(await review, false);
  } finally { app.ui.destroy(); }
});

function batchValue(rows = [3, 4]) {
  const value = analysisValue({ rows });
  value.analysis.sources[0].sheets = [0, 1, 2].map(sheetIndex => ({ sheetIndex, sheetName: `원본${sheetIndex + 1}`, range: { s: { r: 2, c: 2 }, e: { r: 204, c: 24 } } }));
  value.analysis.lines.forEach(line => { line.source.quantityCell = `D${line.source.rowIndex + 1}`; line.source.unitCell = `E${line.source.rowIndex + 1}`; });
  value.analysis.groups = value.analysis.lines.map((line, index) => ({ id: `product-${index}`, label: index ? '국산 참기름 1L' : '중국산 참기름 1.8L', quantity: line.quantity, unit: line.unit, lineIds: [line.id] }));
  value.analysis.exclusions = [{ attachmentId: '2', sheetIndex: 0, rowIndex: 204, reason: '제목이나 안내' }];
  delete value.group;
  return { ...value, reviewAll: true };
}

test('one batch review highlights every included product together and stacks only names and totals without an excluded-row step', async () => {
  const app = harness(), mount = app.mount(), review = app.ui.review({ ...batchValue(), mount });
  try {
    await until(() => app.complete() && !app.complete().disabled);
    assert.deepEqual(app.focuses[0].rowIndexes, [3, 4]);
    assert.deepEqual(app.focuses[0].quantityCells, [{ row: 3, column: 3 }, { row: 4, column: 3 }]);
    assert.equal(app.renderOptions[0].compact, true); assert.equal(app.renderOptions[0].fitWidth, true);
    assert.equal(all(mount, node => node.className === 'order-dialog-header')[0].hidden, true);
    assert.equal(all(mount, node => node.className === 'order-ai-note' && node.textContent.startsWith('가상 발주.xlsx'))[0].hidden, true);
    const results = all(mount, node => node.className === 'order-ai-evidence-result');
    assert.deepEqual(results.map(node => node.textContent), ['중국산 참기름 1.8L1 병', '국산 참기름 1L2 병']);
    assert.equal(results.some(node => /행|셀|대조해/.test(node.textContent)), false);
    assert.equal(app.navigation().children.length, 1, 'excluded rows do not create a separate review page');
    assert.equal(all(mount, node => node.tagName === 'BUTTON' && /제외/.test(node.textContent)).length, 0);
    app.complete().fire('click'); assert.equal(await review, true);
  } finally { app.ui.destroy(); }
});

test('batch completion still requires every included page and sheet, with sheet tabs reopening their combined highlights', async () => {
  const app = harness(), value = batchValue([3, 103, 4]); value.analysis.lines[2].source.sheetIndex = 1;
  const review = app.ui.review({ ...value, mount: app.mount() });
  try {
    await until(() => app.focuses.length === 1);
    assert.equal(app.complete().disabled, true); assert.equal(app.navigation().children.length, 3);
    const before = app.focuses.length; app.renderOptions.at(-1).onSheetChange({ sheetIndex: 2 });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(app.focuses.length, before, 'a sheet without product rows is optional and does not mark required rows reviewed');
    assert.equal(app.complete().disabled, true);
    app.renderOptions.at(-1).onSheetChange({ sheetIndex: 1 }); await until(() => app.focuses.length === before + 1);
    assert.equal(app.focuses.at(-1).sheetIndex, 1); assert.equal(app.complete().disabled, true, 'the other original row page is still required');
    const missing = app.navigation().children.find(node => !node.textContent.includes('확인')); missing.fire('click');
    await until(() => !app.complete().disabled);
    const rendered = app.focuses.length; app.renderOptions.at(-1).onSheetChange({ sheetIndex: 0 });
    await until(() => app.focuses.length === rendered + 1);
    assert.equal(app.focuses.at(-1).sheetIndex, 0, 'returning from optional sheets restores source highlights even for the current required part');
    app.complete().fire('click'); assert.equal(await review, true);
    const completedRenders = app.focuses.length; app.renderOptions.at(-1).onSheetChange({ sheetIndex: 1 });
    await until(() => app.focuses.length === completedRenders + 1);
    assert.equal(app.focuses.at(-1).sheetIndex, 1); assert.equal(app.complete().disabled, true, 'reviewed sheets can still be inspected without another approval action');
  } finally { app.ui.destroy(); }
});

test('batch review fails closed for changed original identities or incomplete and duplicated product evidence', async () => {
  for (const change of ['identity', 'missing', 'duplicate']) {
    const value = batchValue();
    if (change === 'identity') value.analysis.sourceHash = 'c'.repeat(64);
    if (change === 'missing') value.analysis.groups.pop();
    if (change === 'duplicate') value.analysis.groups[1].lineIds = [...value.analysis.groups[0].lineIds];
    const app = harness(), mount = app.mount(), review = app.ui.review({ ...value, mount });
    try {
      await until(() => mount.textContent.includes('다릅니다') || mount.textContent.includes('전체 대조 위치'));
      assert.equal(app.fetches.length, 0); assert.equal(app.complete().disabled, true);
      assert.equal(all(app.body, node => node.tagName === 'DIALOG' && node.open).length, 0);
      app.ui.close(); assert.equal(await review, false);
    } finally { app.ui.destroy(); }
  }
});

test('batch image review retains all product boxes while showing a compact total for each product', async () => {
  const { value, record } = imageValue(), first = value.analysis.lines[0];
  const second = { ...first, id: 'second-image-line', quantity: '2', source: { ...first.source, bbox: { x: 0.2, y: 0.3, width: 0.5, height: 0.2 } } };
  value.analysis.lines.push(second); value.analysis.groups = [value.group, { id: 'sesame', label: '국산 볶음통깨 1kg', quantity: '2', unit: '병', lineIds: [second.id] }];
  delete value.group;
  const app = harness({ textSource: record }), mount = app.mount(), review = app.ui.review({ ...value, reviewAll: true, mount });
  try {
    await until(() => app.complete() && !app.complete().disabled);
    assert.equal(all(mount, node => node.className === 'order-ai-image-evidence').length, 2);
    assert.deepEqual(all(mount, node => node.className === 'order-ai-evidence-result').map(node => node.textContent), ['중국산 참기름 1.8L11 병', '국산 볶음통깨 1kg2 병']);
    app.complete().fire('click'); assert.equal(await review, true);
  } finally { app.ui.destroy(); }
});
