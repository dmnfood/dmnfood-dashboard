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
  matches(selector) { if (selector === 'td[data-source-row]') return this.tagName === 'TD' && this.dataset.sourceRow !== undefined; const styled = selector.match(/^([a-z]+)\.([a-z-]+)$/); if (styled) return this.tagName === styled[1].toUpperCase() && this.className.split(' ').includes(styled[2]); return this.tagName === selector.toUpperCase(); }
  closest(selector) { for (let current = this; current; current = current.parentNode) if (current.matches(selector)) return current; return null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return this.bounds || { top: 0, left: 0, bottom: 0, right: 0 }; }
  scrollIntoView(options) { this.scrollCalls = [...(this.scrollCalls || []), options]; }
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
  const { fixture = workbook(), width = 0, ...renderOptions } = options;
  const wb = fixture, meta = Model.describeWorkbook(wb, XLSX), document = new UiNode('document'), window = new UiNode('window'), mount = new UiNode('section'), observers = [];
  document.head = new UiNode('head'); document.createElement = tag => { const node = new UiNode(tag); node.clientWidth = width; return node; }; document.querySelector = () => null; document.elementFromPoint = () => document.pointTarget || null;
  class FakeWorker { postMessage(message) { queueMicrotask(() => { const result = message.type === 'open' ? meta : message.type === 'page' ? Model.sheetPage(wb, meta, message, XLSX) : Model.selectionInfo(wb, meta, message, XLSX); this.onmessage?.({ data: { id: message.id, result } }); }); } terminate() {} }
  class FakeResizeObserver { constructor(callback) { this.callback = callback; observers.push(this); } observe(target) { this.target = target; } disconnect() { this.disconnected = true; } }
  const changes = [], context = { ...Selection, document, window, Worker: FakeWorker, ResizeObserver: FakeResizeObserver, URL, Uint8Array, setTimeout, clearTimeout,
    requestAnimationFrame: callback => { queueMicrotask(callback); return 1; }, cancelAnimationFrame() {} };
  runInNewContext(`${source}\nglobalThis.render = renderMailWorkbook;`, context);
  const cleanup = await context.render({ mount, bytes: new Uint8Array([1]), fileName: '가상.xlsx', onSelectionChange: value => changes.push(value), ...renderOptions });
  const nodes = () => [mount, ...allNodes(mount)];
  const cell = (row, column) => nodes().find(node => node.tagName === 'TD' && node.dataset.sourceRow === String(row) && node.dataset.sourceColumn === String(column));
  const region = nodes().find(node => node.className.split(' ').includes('mail-workbook-grid-region'));
  const button = label => nodes().find(node => node.tagName === 'BUTTON' && node.textContent === label);
  return { mount, document, window, cleanup, changes, cell, region, button, nodes, observers };
}
function allNodes(node) { return node.children.flatMap(child => [child, ...allNodes(child)]); }
function pointer(app, phase, cell, values = {}) {
  app.document.pointTarget = cell;
  const target = phase === 'pointerdown' ? app.region : app.document;
  target.fire(phase, { target: cell || app.region, pointerId: 7, pointerType: 'mouse', button: 0, clientX: 20, clientY: 20, ...values });
}

test('compact sheet tabs switch real source sheets and notify only after a user initiated load', async () => {
  const viewed = [], app = await harness({ compact: true, onSheetChange: page => viewed.push(page) });
  const tabs = () => app.nodes().filter(node => node.getAttribute('role') === 'tab');
  assert.equal(app.nodes().find(node => node.className === 'mail-workbook-field' && node.textContent.includes('시트 선택')).hidden, true);
  assert.equal(tabs().length, 2); assert.equal(tabs()[0].getAttribute('aria-selected'), 'true');
  tabs()[1].fire('click'); await settle();
  assert.equal(viewed.length, 1); assert.equal(viewed[0].sheetIndex, 1); assert.equal(viewed[0].sheetName, '둘째 발주');
  assert.equal(app.cell(4, 3).textContent, '4'); assert.equal(tabs()[1].getAttribute('aria-selected'), 'true');
  await app.cleanup.focusEvidence({ sheetIndex: 0, rowIndexes: [3], quantityCells: [] });
  assert.equal(viewed.length, 1, 'programmatic highlighting does not count a sheet as newly reviewed');
  assert.equal(tabs()[0].getAttribute('aria-selected'), 'true');
  await app.cleanup.selectSheet(1);
  assert.equal(viewed.length, 1); assert.equal(app.cleanup.getCurrentPage().sheetIndex, 1);
  app.cleanup();
});

test('fitted columns adapt to the available region without truncating source text or changing cell coordinates', async () => {
  const text = '식품설명이 긴 중국산 참기름 발주 원문 '.repeat(8);
  const fixture = { SheetNames: ['주문'], Sheets: { 주문: { '!ref': 'A1:F3', '!cols': Array.from({ length: 6 }, () => ({ wpx: 450 })),
    A1: { t: 's', v: '납품일' }, B1: { t: 's', v: '학교명' }, C1: { t: 's', v: '제품명' }, D1: { t: 's', v: '식품설명' }, E1: { t: 's', v: '수량' }, F1: { t: 's', v: '단위' },
    A2: { t: 's', v: '2026-10-26' }, B2: { t: 's', v: '가상학교' }, C2: { t: 's', v: '참기름' }, D2: { t: 's', v: text }, E2: { t: 'n', v: 11 }, F2: { t: 's', v: '병' },
    D3: { t: 's', v: '다음 설명' }, E3: { t: 'n', v: 2 }, '!merges': [{ s: { r: 1, c: 2 }, e: { r: 2, c: 2 } }],
  } } };
  const app = await harness({ fixture, compact: true, width: 640 }), before = JSON.stringify(fixture);
  const table = app.nodes().find(node => node.tagName === 'TABLE');
  assert.ok(parseFloat(table.style.width) <= 640);
  assert.equal(app.cell(1, 3).textContent, text); assert.equal(app.cell(1, 4).dataset.cell, 'E2');
  assert.equal(app.cell(1, 4).textContent, '11');
  assert.ok(app.cell(1, 3).children[0].children[0].className.includes('mail-workbook-wrap'));
  const wide = parseFloat(table.style.width); app.region.clientWidth = 480; app.observers[0].callback();
  assert.ok(parseFloat(table.style.width) < wide); assert.ok(parseFloat(table.style.width) <= 480);
  assert.equal(app.cell(1, 3).textContent, text); assert.equal(JSON.stringify(fixture), before);
  app.cleanup(); assert.equal(app.observers[0].disconnected, true);
});

test('compact view keeps sheet tabs and page actions in one bar and suppresses only the generic formula notice', async () => {
  const fixture = { SheetNames: ['발주'], Sheets: { 발주: { '!ref': 'A1:B205', A1: { t: 's', v: '원본' }, B2: { t: 'n', f: 'SUM(B3:B4)', v: 3 },
    B3: { t: 'n', f: 'SUM(B5:B6)' }, B205: { t: 'n', v: 1 }, '!rows': [{ hidden: true }] } } };
  const app = await harness({ fixture, compact: true });
  const bar = app.nodes().find(node => node.className === 'mail-workbook-sheet-bar');
  assert.deepEqual(bar.children.map(node => node.className), ['mail-workbook-sheet-tabs', 'mail-workbook-controls']);
  assert.ok(bar.contains(app.button('다음 행'))); assert.equal(app.button('다음 행').disabled, false);
  assert.ok(app.nodes().filter(node => node.className === 'mail-workbook-page').every(node => node.hidden));
  const notices = app.nodes().find(node => node.className === 'mail-workbook-notices');
  assert.match(notices.textContent, /숨김 행 1개/); assert.doesNotMatch(notices.textContent, /수식.*개/);
  assert.match(app.cell(1, 1).textContent, /수식 저장값/); assert.match(app.cell(2, 1).textContent, /계산값 없음/);
  app.button('다음 행').fire('click'); await settle(); assert.equal(app.cleanup.getCurrentPage().page, 1);
  app.cleanup();
  const legacy = await harness({ fixture });
  assert.equal(legacy.nodes().some(node => node.className === 'mail-workbook-sheet-bar'), false);
  assert.match(legacy.nodes().find(node => node.className === 'mail-workbook-notices').textContent, /수식 2개/);
  assert.ok(legacy.nodes().filter(node => node.className === 'mail-workbook-page').every(node => !node.hidden));
  legacy.cleanup();
});

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

test('inline evidence scrolls only the workbook region and keeps an already visible cell stationary', async () => {
  const app = await harness();
  app.region.bounds = { top: 100, left: 50, bottom: 304, right: 354 };
  app.region.clientTop = 2; app.region.clientLeft = 2; app.region.clientHeight = 200; app.region.clientWidth = 300;
  let cellBounds = { top: 400, left: 470, bottom: 430, right: 520 };
  const createElement = app.document.createElement;
  app.document.createElement = tag => { const node = createElement(tag); if (tag === 'td') node.getBoundingClientRect = () => cellBounds; return node; };
  app.mount.scrollTop = 234; app.document.scrollTop = 567; app.window.scrollY = 890;
  const value = { sheetIndex: 0, rowIndexes: [4], quantityCells: [{ row: 4, column: 4 }] };
  const evidence = await app.cleanup.focusEvidence(value, { local: true });
  assert.ok(evidence); assert.equal(app.region.scrollTop, 128); assert.equal(app.region.scrollLeft, 168);
  assert.equal(app.cell(4, 4).scrollCalls, undefined, 'inline focus must not ask the browser to scroll ancestor containers');
  assert.equal(app.mount.scrollTop, 234); assert.equal(app.document.scrollTop, 567); assert.equal(app.window.scrollY, 890);
  cellBounds = { top: 130, left: 80, bottom: 160, right: 140 };
  await app.cleanup.focusEvidence(value, { local: true });
  assert.equal(app.region.scrollTop, 0); assert.equal(app.region.scrollLeft, 0);
  assert.equal(app.cell(4, 4).scrollCalls, undefined);
  assert.equal(app.changes.length, 0, 'source highlighting never claims a user selection');
  app.cleanup();
});

test('standalone evidence retains browser nearest scrolling by default', async () => {
  const app = await harness();
  await app.cleanup.focusEvidence({ sheetIndex: 0, rowIndexes: [4], quantityCells: [{ row: 4, column: 4 }] });
  const calls = app.cell(4, 4).scrollCalls;
  assert.equal(calls.length, 1); assert.equal(calls[0].block, 'nearest'); assert.equal(calls[0].inline, 'nearest');
  assert.equal(app.region.scrollTop, 0); assert.equal(app.region.scrollLeft, 0);
  app.cleanup();
});

test('oversized evidence cells keep their visible start and align to the start only when fully outside the region', async () => {
  const app = await harness();
  app.region.bounds = { top: 100, left: 50, bottom: 304, right: 354 };
  app.region.clientTop = 2; app.region.clientLeft = 2; app.region.clientHeight = 200; app.region.clientWidth = 300;
  let cellBounds;
  const createElement = app.document.createElement;
  app.document.createElement = tag => { const node = createElement(tag); if (tag === 'td') node.getBoundingClientRect = () => cellBounds; return node; };
  const value = { sheetIndex: 0, rowIndexes: [4], quantityCells: [{ row: 4, column: 4 }] };
  for (const visible of [
    { top: 102, left: 52, bottom: 700, right: 900 },
    { top: 120, left: 80, bottom: 700, right: 900 },
    { top: -100, left: -200, bottom: 700, right: 900 },
  ]) {
    cellBounds = visible;
    await app.cleanup.focusEvidence(value, { local: true });
    assert.equal(app.region.scrollTop, 0); assert.equal(app.region.scrollLeft, 0);
    assert.equal(app.cell(4, 4).scrollCalls, undefined);
  }
  cellBounds = { top: 500, left: 600, bottom: 1100, right: 1400 };
  await app.cleanup.focusEvidence(value, { local: true });
  assert.equal(app.region.scrollTop, 398); assert.equal(app.region.scrollLeft, 548);
  assert.equal(app.cell(4, 4).scrollCalls, undefined);
  app.cleanup();
});
