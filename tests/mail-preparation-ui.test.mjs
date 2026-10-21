import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../dashboard/js/mail-preparation-ui.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function', 'function');
const confirmed = { fromCache: false, hasPendingWrites: false };
const customer = (code = '0007', name = '가상 급식사', revision = 1) => ({ id: code, code, name, revision, syncState: 'confirmed' });
const mail = (id = 'a'.repeat(64), hash = 'b'.repeat(64)) => ({ id, subject: '가상 급식사 주간 발주', account: 'official@dmnfood.co.kr', rawStorage: { sha256: hash } });
const attachment = (id = '101', sha256 = 'c'.repeat(64)) => ({ id, sha256 });
const range = (startRow = 3, endRow = 5) => ({ sheetIndex: 0, sheetName: '발주 원본', range: `C${startRow + 1}:I${endRow + 1}`, startRow, endRow, startColumn: 2, endColumn: 8 });
const savedRecord = (overrides = {}) => ({ schemaVersion: 1, intakeId: 'a'.repeat(64), attachmentId: '101', account: 'official@dmnfood.co.kr', sourceHash: 'b'.repeat(64), attachmentSha256: 'c'.repeat(64),
  customer: customer(), selection: range(), revision: 1, updatedAtIso: '2026-10-21T04:00:00.000Z', syncState: 'confirmed', ...overrides });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };

class UiNode {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this._text = ''; this.value = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { const items = this.listeners.get(name) || []; items.push(callback); this.listeners.set(name, items); }
  removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== callback)); }
  fire(name, values = {}) { const event = { target: this, preventDefault() {}, ...values }; return Promise.all((this.listeners.get(name) || []).map(callback => callback(event))); }
}
const allNodes = node => [node, ...node.children.flatMap(allNodes)];
function fakeWorkbook({ restoreGate } = {}) {
  let revision = 0;
  return { selected: null, enabled: false, writes: [],
    setSelectionEnabled(value) { this.enabled = value; },
    async setSelection(value) { const token = ++revision; this.writes.push(value); if (value && restoreGate) await restoreGate.promise; if (token !== revision) return null; this.selected = value; return value; },
    getSelection() { return this.selected; },
  };
}
function harness({ saveResult } = {}) {
  const mount = new UiNode('section'), window = new UiNode('window'), navigator = { onLine: true }, subscriptions = [], saveCalls = [], session = { user: { uid: 'fictional-manager' } };
  let catalogNext, catalogError, stoppedCatalog = false, confirms = 0;
  window.confirm = () => { confirms++; return true; };
  const context = { document: { createElement: tag => new UiNode(tag) }, window, navigator,
    subscribeErpCustomers(next, error) { catalogNext = next; catalogError = error; return () => { stoppedCatalog = true; }; },
    subscribeMailPreparation(intakeId, attachmentId, next, error) { const entry = { intakeId, attachmentId, next, error, stopped: false }; subscriptions.push(entry); return () => { entry.stopped = true; }; },
    async saveMailPreparation(input, who) { saveCalls.push({ input, who }); return saveResult ? saveResult(input) : { revision: input.expectedRevision + 1 }; },
  };
  runInNewContext(`${source}\nglobalThis.init = initMailPreparation;`, context);
  const controller = context.init(session, mount);
  const nodes = () => allNodes(mount), picker = () => nodes().find(node => node.tagName === 'SELECT'), save = () => nodes().find(node => node.tagName === 'BUTTON' && node.className.includes('order-primary'));
  const summary = () => nodes().find(node => node.className === 'mail-preparation-summary').textContent, status = () => nodes().find(node => node.className === 'mail-preparation-status');
  function open({ sourceMail = mail(), sourceAttachment = attachment(), workbook = fakeWorkbook() } = {}) { controller.setMail(sourceMail); controller.openWorkbook({ mail: sourceMail, attachment: sourceAttachment, workbook }); return workbook; }
  function choose(id = '0007') { picker().value = id; picker().fire('change'); }
  function select(value = range()) { controller.selectionChanged(value); }
  const record = (value, metadata = confirmed, index = subscriptions.length - 1) => subscriptions[index].next(value, metadata);
  return { mount, window, navigator, controller, subscriptions, saveCalls, session, nodes, picker, save, summary, status, open, choose, select, record,
    catalog: (items = [customer()], metadata = confirmed) => catalogNext(items, metadata), catalogError: error => catalogError(error), get confirms() { return confirms; }, get stoppedCatalog() { return stoppedCatalog; } };
}

test('matching sender or subject never assigns an ERP customer and cached catalogs cannot enable range selection', () => {
  const app = harness(), workbook = app.open(); app.record(null);
  app.catalog([customer()], { fromCache: true, hasPendingWrites: false });
  assert.equal(app.picker().value, ''); assert.equal(app.picker().disabled, true); assert.equal(workbook.enabled, false);
  app.catalog();
  assert.equal(app.picker().value, ''); assert.equal(app.save().disabled, true); assert.equal(workbook.enabled, false);
  app.choose(); assert.equal(app.picker().value, '0007'); assert.equal(workbook.enabled, true); assert.equal(app.save().disabled, true);
  app.select(); assert.equal(app.save().disabled, false);
  app.controller.destroy();
});

test('range save binds exact mail, attachment hashes, explicit ERP code and original zero-based coordinates', async () => {
  const app = harness(), workbook = app.open(); app.catalog(); app.record(null); app.choose(); app.select();
  await app.save().fire('click');
  assert.equal(app.saveCalls.length, 1);
  const { input, who } = app.saveCalls[0];
  assert.equal(input.intakeId, 'a'.repeat(64)); assert.equal(input.attachmentId, '101'); assert.equal(input.account, 'official@dmnfood.co.kr');
  assert.equal(input.sourceHash, 'b'.repeat(64)); assert.equal(input.attachmentSha256, 'c'.repeat(64)); assert.equal(input.customer.code, '0007'); assert.equal(input.expectedRevision, 0);
  assert.equal(JSON.stringify(input.selection), JSON.stringify(range())); assert.equal(who, app.session);
  assert.equal(Object.hasOwn(input, 'quantity'), false); assert.equal(workbook.enabled, false);
  assert.equal(app.controller.canLeave(), false, 'unconfirmed save must not be left behind as if committed');
  assert.match(app.status().textContent, /확인하고 있습니다/); assert.doesNotMatch(app.status().textContent, /저장 완료/);
  app.record(savedRecord()); await settle();
  assert.match(app.status().textContent, /범위 저장 완료/); assert.equal(app.save().disabled, true); assert.equal(workbook.enabled, true);
  app.controller.destroy();
});

test('pending and cached snapshots never count as saved even after save promise resolves', async () => {
  const app = harness(); app.open(); app.catalog(); app.record(null); app.choose(); app.select();
  await app.save().fire('click');
  app.record(savedRecord({ syncState: 'pending' }), { fromCache: false, hasPendingWrites: true });
  assert.doesNotMatch(app.status().textContent, /저장 완료/); assert.equal(app.save().disabled, true);
  app.record(savedRecord({ syncState: 'cached' }), { fromCache: true, hasPendingWrites: false });
  assert.doesNotMatch(app.status().textContent, /저장 완료/); assert.equal(app.save().disabled, true);
  app.record(savedRecord()); await settle();
  assert.match(app.status().textContent, /저장 완료/);
  app.controller.destroy();
});

test('a newer conflicting confirmed revision during a save stays blocked and reloads the latest record', async () => {
  const gate = deferred(), app = harness({ saveResult: () => gate.promise }); app.open(); app.catalog(); app.record(null); app.choose(); app.select();
  const saving = app.save().fire('click');
  app.record(savedRecord({ revision: 2, selection: range(8, 10), updatedAtIso: '2026-10-21T04:01:00.000Z' }));
  gate.resolve({ revision: 1 }); await saving;
  assert.match(app.status().textContent, /다른 담당자/); assert.equal(app.save().disabled, true);
  const reload = app.nodes().find(node => node.tagName === 'BUTTON' && node.textContent === '저장된 범위 다시 불러오기');
  assert.equal(reload.hidden, false); reload.fire('click'); await settle();
  assert.match(app.summary(), /C9:I11/); assert.match(app.status().textContent, /저장 완료/);
  app.controller.destroy();
});

test('persisted ranges restore only with matching original and attachment hashes and confirmed catalog', async () => {
  for (const wrong of [{ sourceHash: 'd'.repeat(64) }, { attachmentSha256: 'e'.repeat(64) }]) {
    const app = harness(), workbook = app.open(); app.catalog(); app.record(savedRecord(wrong)); await settle();
    assert.equal(workbook.writes.filter(Boolean).length, 0); assert.match(app.status().textContent, /원본이 다릅니다/); assert.equal(workbook.enabled, false); assert.equal(app.save().disabled, true);
    app.controller.destroy();
  }
  const app = harness(), workbook = app.open(); app.record(savedRecord());
  app.catalog([customer()], { fromCache: true, hasPendingWrites: false }); await settle(); assert.equal(workbook.writes.length, 0);
  app.catalog(); await settle(); assert.equal(workbook.writes[0].range, 'C4:I6'); assert.equal(app.picker().value, '0007');
  app.controller.destroy();
});

test('manual customer changes cancel in-flight saved-range restore and invalidate the old customer selection', async () => {
  const gate = deferred(), app = harness(), workbook = app.open({ workbook: fakeWorkbook({ restoreGate: gate }) });
  app.catalog([customer(), customer('0008', '다른 급식사')]); app.record(savedRecord());
  assert.equal(workbook.writes.length, 1);
  app.choose('0008'); gate.resolve(); await settle();
  assert.equal(app.picker().value, '0008'); assert.match(app.summary(), /원본에서 발주 내용/); assert.equal(workbook.selected, null); assert.equal(app.save().disabled, true);
  app.select(range(6, 8)); await app.save().fire('click'); assert.equal(app.saveCalls[0].input.customer.code, '0008'); assert.equal(app.saveCalls[0].input.selection.range, 'C7:I9');
  app.controller.destroy();
});

test('late restore, subscription and save results from another attachment cannot replace the active source', async () => {
  const gate = deferred(), restoreGate = deferred(), app = harness({ saveResult: () => gate.promise }), oldWorkbook = app.open({ workbook: fakeWorkbook({ restoreGate }) });
  app.catalog(); app.record(savedRecord());
  const newMail = mail('f'.repeat(64), 'd'.repeat(64)), newAttachment = attachment('102', 'e'.repeat(64)), newWorkbook = app.open({ sourceMail: newMail, sourceAttachment: newAttachment });
  app.record(null); app.choose(); app.select(range(7, 9));
  restoreGate.resolve(); app.record(savedRecord(), confirmed, 0); await settle();
  assert.equal(app.subscriptions[0].stopped, true); assert.equal(app.picker().value, '0007'); assert.match(app.summary(), /C8:I10/); assert.equal(newWorkbook.writes.filter(Boolean).length, 0);
  const saving = app.save().fire('click');
  app.controller.setMail(mail('9'.repeat(64), '8'.repeat(64))); gate.resolve({ revision: 1 }); await saving;
  assert.match(app.summary(), /ERP에 등록된 거래처/); assert.equal(app.picker().value, ''); assert.doesNotMatch(app.status().textContent, /저장 완료/);
  assert.equal(oldWorkbook.enabled, false);
  app.controller.destroy();
});

test('catalog changes and offline state prevent saving stale customer identities', async () => {
  const app = harness(), workbook = app.open(); app.catalog(); app.record(null); app.choose(); app.select();
  app.navigator.onLine = false; app.window.fire('offline'); assert.equal(app.save().disabled, true);
  app.navigator.onLine = true; app.window.fire('online'); assert.equal(app.save().disabled, false);
  app.catalog([customer('0007', '이름 수정된 급식사', 2)]);
  assert.equal(app.save().disabled, true); assert.equal(workbook.enabled, false); assert.match(app.summary(), /거래처 정보가 변경/);
  app.choose(); assert.equal(app.save().disabled, true, 'choosing a revised customer requires selecting its range again');
  app.controller.destroy(); assert.equal(app.stoppedCatalog, true); assert.equal(app.subscriptions[0].stopped, true);
});
