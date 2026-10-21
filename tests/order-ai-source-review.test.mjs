import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import * as Selection from '../dashboard/js/mail-workbook-selection.js';

const require = createRequire(import.meta.url), XLSX = require('../dashboard/vendor/sheetjs/xlsx.full.min.js');
const Model = require('../dashboard/js/mail-workbook-model.js');
const previewSource = await readFile(new URL('../dashboard/js/mail-workbook-preview.js', import.meta.url), 'utf8');
function sourceWorkbook() {
  return { SheetNames: ['첫 원본', '다른 원본'], Sheets: {
    '첫 원본': { '!ref': 'C3:Y205', C3: { t: 's', v: '원본' }, F4: { t: 'n', v: 2 }, F6: { t: 'n', v: 3 }, Y205: { t: 'n', v: 7 },
      '!merges': [{ s: { r: 99, c: 3 }, e: { r: 103, c: 4 } }] },
    '다른 원본': { '!ref': 'B5:W350', B5: { t: 's', v: '다른 원본' }, W350: { t: 'n', v: 11 } },
  } };
}
const normalize = value => JSON.parse(JSON.stringify(value));

test('AI evidence retains noncontiguous original rows and quantity cells on non-A1 sheets', () => {
  const metadata = Model.describeWorkbook(sourceWorkbook(), XLSX);
  const evidence = Selection.workbookEvidence({ sheetIndex: 0, rowIndexes: [5, 3], quantityCells: [{ row: 5, column: 5 }, { row: 3, column: 5 }] }, metadata);
  assert.deepEqual(evidence, { sheetIndex: 0, sheetName: '첫 원본', rowIndexes: [3, 5], quantityCells: [{ row: 3, column: 5, address: 'F4' }, { row: 5, column: 5, address: 'F6' }] });
  assert.deepEqual(Selection.evidenceCellState(evidence, { startRow: 4, endRow: 4, startColumn: 5, endColumn: 5 }), { row: false, quantity: false });
  assert.deepEqual(Selection.evidenceCellState(evidence, { startRow: 3, endRow: 3, startColumn: 4, endColumn: 5 }), { row: true, quantity: true });
  assert.deepEqual(Selection.evidencePage({ sheetIndex: 1, rowIndexes: [349], quantityCells: [{ row: 349, column: 22 }] }, metadata), { sheetIndex: 1, rowPage: 3, columnPage: 1 });
  assert.deepEqual(Selection.evidencePage({ sheetIndex: 1, rowIndexes: [349], quantityCells: [{ row: 349, column: 22 }], columnIndex: 1 }, metadata), { sheetIndex: 1, rowPage: 3, columnPage: 0 });
  assert.throws(() => Selection.workbookEvidence({ sheetIndex: 0, rowIndexes: [1] }, metadata));
  assert.throws(() => Selection.workbookEvidence({ sheetIndex: 0, rowIndexes: [3, 3] }, metadata));
  assert.throws(() => Selection.workbookEvidence({ sheetIndex: 0, rowIndexes: [3], quantityCells: [{ row: 4, column: 5 }] }, metadata));
  assert.throws(() => Selection.workbookEvidence({ sheetIndex: 8, rowIndexes: [3] }, metadata));
  assert.throws(() => Selection.workbookEvidence({ sheetIndex: 1, rowIndexes: [349], columnIndex: 23 }, metadata));
});

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.style = {};
    this.className = ''; this.value = ''; this._text = ''; this.scrollTop = 0; this.scrollLeft = 0; this.clientWidth = 500; this.scrollWidth = 500;
    this.classList = { add: (...names) => names.forEach(name => this.classList.toggle(name, true)), contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => { const set = new Set(this.className.split(/\s+/).filter(Boolean)); const enabled = force ?? !set.has(name); if (enabled) set.add(name); else set.delete(name); this.className = [...set].join(' '); return enabled; } };
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  removeEventListener(name) { this.listeners.delete(name); }
  fire(name, detail = {}) { this.listeners.get(name)?.({ target: this, preventDefault() {}, ...detail }); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  matches(selector) {
    const match = /^([a-z]+)?(?:\.([\w-]+))?(?:\[data-([\w-]+)\])?$/.exec(selector);
    if (!match) throw new Error(`Unsupported harness selector ${selector}`);
    return (!match[1] || this.tagName === match[1].toUpperCase()) && (!match[2] || this.classList.contains(match[2]))
      && (!match[3] || Object.hasOwn(this.dataset, match[3].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())));
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  get isConnected() { return Boolean(this.parentNode); }
  scrollIntoView() { this.scrolled = true; }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector); }
  setPointerCapture() {}
  hasPointerCapture() { return false; }
}
async function previewHarness() {
  const workbook = sourceWorkbook(), metadata = Model.describeWorkbook(workbook, XLSX), mount = new Element('div'), calls = [], changes = [];
  const workers = [];
  class Worker {
    constructor() { workers.push(this); }
    postMessage(message) {
      calls.push(normalize({ ...message, bytes: undefined }));
      queueMicrotask(() => {
        if (this.terminated) return;
        try {
          const result = message.type === 'open' ? metadata : message.type === 'page' ? Model.sheetPage(workbook, metadata, message, XLSX) : Model.selectionInfo(workbook, metadata, message, XLSX);
          this.onmessage({ data: { id: message.id, result } });
        } catch (error) { this.onmessage({ data: { id: message.id, error: error.message } }); }
      });
    }
    terminate() { this.terminated = true; }
  }
  const document = { createElement: tag => new Element(tag), head: new Element('head'), querySelector: () => null, addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ ...Selection, document, window: { addEventListener() {}, removeEventListener() {} }, Worker, URL, Uint8Array,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout });
  vm.runInContext(`${previewSource.replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '').replaceAll('import.meta.url', JSON.stringify('https://dashboard.dmnfood.co.kr/dashboard/js/mail-workbook-preview.js'))}\nglobalThis.render = renderMailWorkbook;`, context);
  const controller = await context.render({ mount, bytes: new Uint8Array([1]), fileName: '가상 원본.xlsx', onSelectionChange: value => changes.push(value) });
  return { mount, controller, calls, changes, workers, source: workbook, metadata };
}
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
const cell = (app, row, column) => app.mount.querySelectorAll('td[data-source-row]').find(node => Number(node.dataset.sourceRow) === row && Number(node.dataset.sourceColumn) === column);

test('preview focuses a different sheet/page, highlights exact rows, and preserves accepted selection without callbacks', async () => {
  const app = await previewHarness();
  try {
    await app.controller.setSelection({ sheetIndex: 0, sheetName: '첫 원본', range: 'C4:H6', startRow: 3, endRow: 5, startColumn: 2, endColumn: 7 });
    const accepted = normalize(app.controller.getSelection());
    await app.controller.focusEvidence({ sheetIndex: 0, rowIndexes: [3, 5], quantityCells: [{ row: 3, column: 5 }, { row: 5, column: 5 }] });
    assert.equal(cell(app, 3, 5).classList.contains('mail-workbook-evidence-quantity'), true);
    assert.equal(cell(app, 5, 5).classList.contains('mail-workbook-evidence-quantity'), true);
    assert.equal(cell(app, 4, 5).classList.contains('mail-workbook-evidence-row'), false);
    assert.equal(cell(app, 4, 5).classList.contains('mail-workbook-selected-cell'), true);
    await app.controller.focusEvidence({ sheetIndex: 1, rowIndexes: [349], quantityCells: [{ row: 349, column: 22 }] });
    const request = app.calls.filter(item => item.type === 'page').at(-1);
    assert.deepEqual({ sheetIndex: request.sheetIndex, page: request.page, columnPage: request.columnPage }, { sheetIndex: 1, page: 3, columnPage: 1 });
    assert.equal(cell(app, 349, 22).classList.contains('mail-workbook-evidence-quantity'), true);
    const alternate = await app.controller.focusEvidence({ sheetIndex: 1, rowIndexes: [349], quantityCells: [{ row: 349, column: 22 }], columnIndex: 1 });
    assert.equal(alternate.columnIndex, 1); assert.equal(app.calls.filter(item => item.type === 'page').at(-1).columnPage, 0);
    assert.equal(cell(app, 349, 1).classList.contains('mail-workbook-evidence-row'), true);
    assert.equal(cell(app, 349, 22), undefined, 'an explicit product column page does not substitute a different quantity cell');
    assert.deepEqual(normalize(app.controller.getSelection()), accepted); assert.deepEqual(app.changes, []);
    assert.equal(app.mount.querySelectorAll('input').every(input => input.disabled), true, 'AI evidence never enables user rectangle selection');
    const evidence = app.controller.getEvidence(); evidence.rowIndexes[0] = 0;
    assert.equal(app.controller.getEvidence().rowIndexes[0], 349, 'caller cannot mutate highlight state');
  } finally { app.controller(); }
});

test('merged evidence uses full original coordinates across a page boundary and clears on manual sheet/range changes', async () => {
  const app = await previewHarness();
  try {
    await app.controller.focusEvidence({ sheetIndex: 0, rowIndexes: [103], quantityCells: [{ row: 103, column: 3 }] });
    const merged = cell(app, 102, 3);
    assert.equal(merged.dataset.mergeStartRow, '99'); assert.equal(merged.classList.contains('mail-workbook-evidence-quantity'), true);
    const picker = app.mount.querySelector('select'); picker.value = '1'; picker.fire('change'); await settle();
    assert.equal(app.controller.getEvidence(), null); assert.equal(app.mount.querySelectorAll('td.mail-workbook-evidence-row').length, 0);
    await app.controller.focusEvidence({ sheetIndex: 0, rowIndexes: [3], quantityCells: [{ row: 3, column: 5 }] });
    app.controller.setSelectionEnabled(true); await settle();
    const inputs = app.mount.querySelectorAll('input'); inputs[0].value = 'C4'; inputs[1].value = 'H6';
    app.mount.querySelectorAll('button').find(button => button.textContent === '범위 표시').fire('click');
    assert.equal(app.controller.getEvidence(), null); assert.equal(app.controller.getSelection().range, 'C4:H6'); assert.equal(app.changes.length, 1);
  } finally { app.controller(); }
});

test('closed sources and superseded focus operations cannot restore stale highlights', async () => {
  const app = await previewHarness();
  const first = app.controller.focusEvidence({ sheetIndex: 0, rowIndexes: [3], quantityCells: [{ row: 3, column: 5 }] });
  const second = app.controller.focusEvidence({ sheetIndex: 1, rowIndexes: [349], quantityCells: [{ row: 349, column: 22 }] });
  assert.equal(await first, null); assert.equal((await second).sheetIndex, 1);
  const pending = app.controller.focusEvidence({ sheetIndex: 0, rowIndexes: [3] }); app.controller();
  assert.equal(await pending, null); assert.equal(app.controller.getEvidence(), null);
  assert.equal(await app.controller.focusEvidence({ sheetIndex: 0, rowIndexes: [3] }), null);
  assert.equal(app.mount.children.length, 0); assert.equal(app.workers[0].terminated, true);
});
