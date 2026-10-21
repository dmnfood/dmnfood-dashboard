import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as Selection from '../dashboard/js/mail-workbook-selection.js';
const require = createRequire(import.meta.url), XLSX = require('../dashboard/vendor/sheetjs/xlsx.full.min.js'), Model = require('../dashboard/js/mail-workbook-model.js');
const source = readFileSync(new URL('../dashboard/js/mail-workbook-preview.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/m, '').replace('export async function', 'async function').replaceAll('import.meta.url', "'file:///test/mail-workbook-preview.js'");

class UiNode {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = new Map(); this.className = ''; this._text = ''; this.value = ''; this.scrollWidth = 0; this.clientWidth = 0; this.captures = new Set();
    this.classList = { add: name => this.classList.toggle(name, true), toggle: (name, active) => { const values = new Set(this.className.split(' ').filter(Boolean)); if (active) values.add(name); else values.delete(name); this.className = [...values].join(' '); } };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this._text = ''; this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(name, callback) { const items = this.listeners.get(name) || []; items.push(callback); this.listeners.set(name, items); }
  removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== callback)); }
  fire(name, values = {}) { const event = { target: this, preventDefault() {}, ...values }; for (const callback of this.listeners.get(name) || []) callback(event); }
  contains(node) { for (let current = node; current; current = current.parentNode) if (current === this) return true; return false; }
  matches(selector) { if (selector === 'td[data-source-row]') return this.tagName === 'TD' && this.dataset.sourceRow !== undefined; return this.tagName === selector.toUpperCase(); }
  closest(selector) { for (let current = this; current; current = current.parentNode) if (current.matches(selector)) return current; return null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  get isConnected() { return true; }
}
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
function workbook() { return { SheetNames: ['첫 발주', '둘째 발주'], Sheets: {
  '첫 발주': { '!ref': 'C3:Y205', C3: { t: 's', v: '가상 발주' }, Y205: { t: 'n', v: 7 }, '!merges': [{ s: { r: 98, c: 18 }, e: { r: 104, c: 22 } }] },
  '둘째 발주': { '!ref': 'C3:D5', C3: { t: 's', v: '두 번째' }, D5: { t: 'n', v: 4 } },
} }; }
async function harness(options = {}) {
  const wb = workbook(), meta = Model.describeWorkbook(wb, XLSX), document = new UiNode('document'), window = new UiNode('window'), mount = new UiNode('section');
  document.head = new UiNode('head'); document.createElement = tag => new UiNode(tag); document.querySelector = () => null; document.elementFromPoint = () => document.pointTarget || null;
  class FakeWorker { postMessage(message) { queueMicrotask(() => { const result = message.type === 'open' ? meta : message.type === 'page' ? Model.sheetPage(wb, meta, message, XLSX) : Model.selectionInfo(wb, meta, message, XLSX); this.onmessage?.({ data: { id: message.id, result } }); }); } terminate() {} }
  const changes = [], context = { ...Selection, document, window, Worker: FakeWorker, URL, Uint8Array, setTimeout, clearTimeout,
    requestAnimationFrame: callback => { queueMicrotask(callback); return 1; }, cancelAnimationFrame() {} };
  runInNewContext(`${source}\nglobalThis.render = renderMailWorkbook;`, context);
  const cleanup = await context.render({ mount, bytes: new Uint8Array([1]), fileName: '가상.xlsx', onSelectionChange: value => changes.push(value), ...options });
  const nodes = () => [mount, ...allNodes(mount)];
  const cell = (row, column) => nodes().find(node => node.tagName === 'TD' && node.dataset.sourceRow === String(row) && node.dataset.sourceColumn === String(column));
  const region = nodes().find(node => node.className.split(' ').includes('mail-workbook-grid-region'));
  const button = label => nodes().find(node => node.tagName === 'BUTTON' && node.textContent === label);
  return { mount, document, window, cleanup, changes, cell, region, button, nodes };
}
function allNodes(node) { return node.children.flatMap(child => [child, ...allNodes(child)]); }
function pointer(app, phase, cell, values = {}) {
  app.document.pointTarget = cell;
  const target = phase === 'pointerdown' ? app.region : app.document;
  target.fire(phase, { target: cell || app.region, pointerId: 7, pointerType: 'mouse', button: 0, clientX: 20, clientY: 20, ...values });
}

test('drag selection is disabled until enabled and commits only once on pointer release outside the grid', async () => {
  const app = await harness();
  pointer(app, 'pointerdown', app.cell(3, 3)); pointer(app, 'pointerup', app.cell(4, 4));
  assert.equal(app.changes.length, 0); assert.equal(app.cleanup.getSelection(), null);
  app.cleanup.setSelectionEnabled(true); await settle();
  pointer(app, 'pointerdown', app.cell(6, 6)); pointer(app, 'pointermove', app.cell(3, 3));
  assert.equal(app.changes.length, 0);
  pointer(app, 'pointerup', null);
  assert.equal(app.changes.length, 1); assert.equal(app.changes[0].range, 'D4:G7');
  assert.equal(app.region.captures.size, 0);
  const snapshot = app.cleanup.getSelection(); snapshot.startRow = 90;
  assert.equal(app.cleanup.getSelection().startRow, 3);
  app.cleanup(); assert.equal(app.document.listeners.get('pointerup').length, 0);
});

test('restored range validates original bounds, retains cross-page selection, and sheet change invalidates it', async () => {
  const app = await harness({ selectionEnabled: true });
  const chosen = Selection.selectWorkbookRange('T100', app.cleanup.getMetadata().sheets[0], Model.selectionInfo(workbook(), Model.describeWorkbook(workbook(), XLSX), { sheetIndex: 0 }, XLSX));
  await app.cleanup.setSelection(chosen);
  assert.equal(app.changes.length, 0, 'programmatic restore does not claim user confirmation');
  assert.equal(app.cleanup.getSelection().range, 'S99:W105');
  app.button('다음 행').fire('click'); await settle();
  assert.equal(app.cleanup.getSelection().range, 'S99:W105');
  assert.equal(app.cell(102, 18).getAttribute('aria-selected'), 'true');
  app.button('다음 열').fire('click'); await settle();
  assert.equal(app.cell(102, 22).getAttribute('aria-selected'), 'true');
  await assert.rejects(app.cleanup.setSelection({ ...chosen, endRow: 99999 }), /범위/);
  assert.equal(app.cleanup.getSelection().range, 'S99:W105', 'invalid restore never clamps or overwrites accepted selection');
  const picker = app.nodes().find(node => node.tagName === 'SELECT'); picker.value = '1'; picker.fire('change'); await settle();
  assert.equal(app.cleanup.getSelection(), null); assert.deepEqual(app.changes, [null]);
  app.cleanup();
});

test('pointer cancellation restores the prior selection and touch two-corner selection uses original cells', async () => {
  const app = await harness({ selectionEnabled: true });
  pointer(app, 'pointerdown', app.cell(3, 3)); pointer(app, 'pointerup', app.cell(3, 3));
  pointer(app, 'pointerdown', app.cell(6, 6)); pointer(app, 'pointermove', app.cell(8, 8)); app.window.fire('blur');
  assert.equal(app.cleanup.getSelection().range, 'D4:D4'); assert.equal(app.changes.length, 1);
  for (const coordinate of [[4, 4], [7, 6]]) {
    pointer(app, 'pointerdown', app.cell(...coordinate), { pointerType: 'touch' }); pointer(app, 'pointerup', app.cell(...coordinate), { pointerType: 'touch' });
  }
  assert.equal(app.cleanup.getSelection().range, 'E5:G8');
  app.button('선택 해제').fire('click'); assert.equal(app.cleanup.getSelection(), null); assert.equal(app.changes.at(-1), null);
  app.cleanup();
});

test('address fields and Shift+Arrow select explicit bounds without any value calculations', async () => {
  const app = await harness({ selectionEnabled: true });
  const inputs = app.nodes().filter(node => node.tagName === 'INPUT'); inputs[0].value = 'H9'; inputs[1].value = 'D4'; app.button('범위 표시').fire('click');
  assert.equal(app.cleanup.getSelection().range, 'D4:H9');
  inputs[0].value = 'bad'; inputs[0].fire('input');
  assert.equal(app.cleanup.getSelection(), null, 'editing a displayed address invalidates the previous selection until explicitly displayed again');
  assert.equal(inputs[0].value, 'bad'); assert.equal(inputs[1].value, 'H9');
  app.button('범위 표시').fire('click'); assert.equal(app.cleanup.getSelection(), null);
  app.button('선택 해제').fire('click');
  app.cell(3, 3).fire('keydown', { key: 'ArrowRight', shiftKey: true });
  assert.equal(app.cleanup.getSelection().range, 'D4:E4');
  app.cleanup.setSelectionEnabled(false); app.cell(3, 3).fire('keydown', { key: 'ArrowDown', shiftKey: true });
  assert.equal(app.cleanup.getSelection().range, 'D4:E4');
  app.cleanup();
});

test('late programmatic restore cannot overwrite a later drag, clear, address edit or sheet change', async () => {
  const app = await harness({ selectionEnabled: true });
  const saved = Selection.selectWorkbookRange('G7:I9', app.cleanup.getMetadata().sheets[0]);
  let pendingRestore = app.cleanup.setSelection(saved);
  pointer(app, 'pointerdown', app.cell(3, 3)); pointer(app, 'pointerup', app.cell(4, 4));
  assert.equal(await pendingRestore, null); assert.equal(app.cleanup.getSelection().range, 'D4:E5');
  pendingRestore = app.cleanup.setSelection(saved); app.button('선택 해제').fire('click');
  assert.equal(await pendingRestore, null); assert.equal(app.cleanup.getSelection(), null);
  pendingRestore = app.cleanup.setSelection(saved);
  const start = app.nodes().find(node => node.tagName === 'INPUT'); start.value = 'F6'; start.fire('input');
  assert.equal(await pendingRestore, null); assert.equal(app.cleanup.getSelection(), null); assert.equal(start.value, 'F6');
  pendingRestore = app.cleanup.setSelection(saved);
  const picker = app.nodes().find(node => node.tagName === 'SELECT'); picker.value = '1'; picker.fire('change');
  assert.equal(await pendingRestore, null); await settle(); assert.equal(app.cleanup.getSelection(), null);
  app.cleanup();
});
