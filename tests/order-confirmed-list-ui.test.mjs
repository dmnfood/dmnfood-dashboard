import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../dashboard/js/order-confirmed-list.js', import.meta.url), 'utf8');
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.listeners = new Map(); this.dataset = {}; this.className = ''; this._text = ''; this.value = ''; this.hidden = false; this.disabled = false; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener(key, work) { this.listeners.set(key, work); }
  removeEventListener(key, work) { if (this.listeners.get(key) === work) this.listeners.delete(key); }
  fire(key) { return this.listeners.get(key)?.({ target: this, preventDefault() {} }); }
  click() { if (!this.hidden && !this.disabled) return this.fire('click'); }
}
const descendants = (node, filter) => [...(filter(node) ? [node] : []), ...node.children.flatMap(child => descendants(child, filter))];
const settle = async () => { for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const record = (id = A, extra = {}) => ({ intakeId: id, sourceKind: 'mail', sourceHash: 'f'.repeat(64), revision: 2,
  confirmedAt: '2026-10-21T02:00:00.000Z', customer: { name: '가상 급식 업체', id: 'school-fixture', revision: 1 }, lineCount: 2,
  groups: [{ id: 'group-cn', productId: 'oil-cn-1_8l', label: '중국산 참기름 1.8L', quantity: '3', unit: '병' }], ...extra });
function harness({ request = async () => ({ ok: true, records: [], nextCursor: null }), onOpenSource, onRecords } = {}) {
  const mount = new Node('section'), calls = [], opened = [], published = [];
  const context = vm.createContext({ document: { createElement: tag => new Node(tag) }, AbortController, Intl, Date, encodeURIComponent,
    requestOrderAi: async () => { throw new Error('No real network is allowed in this UI test.'); } });
  vm.runInContext(`${source.replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '')}\nglobalThis.start = initConfirmedOrderList;`, context);
  const app = context.start({ user: { uid: 'fictional-local-manager' } }, mount, { request: async (session, path, options) => { calls.push({ path, ...options }); return request(path, options); },
    onOpenSource: value => { opened.push(value); return onOpenSource?.(value); }, onRecords: values => { published.push(values); return onRecords?.(values); } });
  const nodes = filter => descendants(mount, filter), button = label => nodes(node => node.tagName === 'BUTTON' && node.textContent === label)[0];
  return { app, mount, calls, opened, published, nodes, button, search: () => nodes(node => node.tagName === 'INPUT')[0], cards: () => nodes(node => node.className === 'order-confirmed-item') };
}

test('the controller is lazy and its only network action reads confirmed saved records', async () => {
  const h = harness(); await settle(); assert.equal(h.calls.length, 0); assert.equal(h.cards().length, 0);
  await h.app.refresh(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].path, 'analysis?list=confirmed'); assert.equal(h.calls[0].body, undefined);
  assert.match(h.mount.textContent, /아직 확정한 발주가 없습니다/); assert.equal(h.button('더 보기').hidden, true); h.app.destroy();
});

test('final records show company, Korean time, source and all product totals without UID or filenames', async () => {
  const value = record(A, { confirmedByUid: 'private-uid-do-not-show', fileName: 'private-file.xlsx', groups: [
    { id: 'group-cn', productId: 'oil-cn-1_8l', label: '중국산 참기름 1.8L', quantity: '3', unit: '병' },
    { id: 'group-kr', productId: 'sesame-kr-1kg', label: '국산 볶음통깨 1kg', quantity: '2', unit: '봉' } ] });
  const h = harness({ request: async () => ({ ok: true, records: [value], nextCursor: null }) }); await h.app.refresh();
  assert.match(h.mount.textContent, /가상 급식 업체/); assert.match(h.mount.textContent, /2026\. 10\. 21\./); assert.match(h.mount.textContent, /메일/);
  assert.match(h.mount.textContent, /3 병/); assert.match(h.mount.textContent, /2 봉/); assert.equal(h.nodes(node => node.tagName === 'DETAILS').length, 1);
  assert.doesNotMatch(h.mount.textContent, /private-uid|private-file|수정|삭제|승인/); h.button('원본 대조 화면').click(); await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(h.opened)), [{ intakeId: A, sourceKind: 'mail' }]); h.app.destroy();
});

test('search is local, pagination preserves search, and duplicate older records never regress a saved result', async () => {
  const h = harness({ request: async path => path.includes('&cursor=') ? { ok: true, records: [record(A, { revision: 1, customer: { name: '오래된 업체명' } }), record(B, { customer: { name: '새 거래처' }, sourceKind: 'image', confirmedAt: '2026-10-22T03:00:00.000Z' })], nextCursor: null }
    : { ok: true, records: [record()], nextCursor: 'page_two' } });
  await h.app.refresh(); h.search().value = '새 거래'; h.search().fire('input'); assert.equal(h.calls.length, 1); assert.equal(h.cards().length, 0);
  h.button('더 보기').click(); await settle(); assert.equal(h.cards().length, 1); assert.match(h.mount.textContent, /카톡·문자 사진/); assert.equal(h.calls[1].path, 'analysis?list=confirmed&cursor=page_two');
  h.search().value = ''; h.search().fire('input'); assert.equal(h.cards().length, 2); assert.equal(h.cards()[0].dataset.intakeId, B); assert.doesNotMatch(h.mount.textContent, /오래된 업체명/);
  assert.equal(h.button('더 보기').hidden, true); assert.equal(h.published.length, 2); h.app.destroy();
});

test('a new refresh aborts an older read and ignores its late records and callbacks', async () => {
  const held = deferred(); let requests = 0;
  const h = harness({ request: async () => ++requests === 1 ? held.promise : { ok: true, records: [record(B)], nextCursor: null } });
  const old = h.app.refresh(); const current = h.app.refresh(); await current; assert.equal(h.calls[0].signal.aborted, true);
  held.resolve({ ok: true, records: [record(A)], nextCursor: 'stale' }); await old;
  assert.equal(h.cards().length, 1); assert.equal(h.cards()[0].dataset.intakeId, B); assert.equal(h.published.length, 1); h.app.destroy();
});

test('malformed source identities, kinds or quantities never render an actionable final record', async () => {
  for (const invalid of [record(A, { sourceKind: 'unknown' }), record(A, { intakeId: '../other' }), record(A, { sourceHash: 'wrong' }), record(A, { groups: [{ id: 'x', productId: 'x', label: 'x', quantity: '-2', unit: '병' }] })]) {
    const h = harness({ request: async () => ({ ok: true, records: [invalid], nextCursor: null }) }); assert.equal(await h.app.refresh(), false);
    assert.equal(h.cards().length, 0); assert.equal(h.button('원본 대조 화면'), undefined); assert.equal(h.published.length, 0); assert.match(h.mount.textContent, /목록을 확인하지 못했습니다/); h.app.destroy();
  }
});

test('an append error preserves loaded history and provides an explicit read retry without mutation', async () => {
  let attempts = 0;
  const h = harness({ request: async path => { if (!path.includes('&cursor=')) return { ok: true, records: [record()], nextCursor: 'next' }; if (++attempts === 1) throw new Error('가상 연결 실패'); return { ok: true, records: [record(B, { sourceKind: 'text' })], nextCursor: null }; } });
  await h.app.refresh(); h.button('더 보기').click(); await settle(); assert.equal(h.cards().length, 1); assert.match(h.mount.textContent, /가상 연결 실패/);
  h.button('더 보기').click(); await settle(); assert.equal(h.cards().length, 2); assert.match(h.mount.textContent, /카톡·문자/); assert.equal(h.calls.some(call => call.body), false); h.app.destroy();
});

test('repeated continuation cursors fail closed and do not duplicate final records', async () => {
  const h = harness({ request: async path => ({ ok: true, records: [record(path.includes('&cursor=') ? B : A)], nextCursor: 'same_page' }) });
  await h.app.refresh(); h.button('더 보기').click(); await settle(); assert.equal(h.cards().length, 1); assert.match(h.mount.textContent, /목록을 확인하지 못했습니다/); assert.equal(h.published.length, 1); h.app.destroy();
});

test('destroy cancels the read and prevents late records, actions and display callbacks', async () => {
  const held = deferred(), h = harness({ request: () => held.promise }); const running = h.app.refresh(); h.app.destroy(); const before = h.mount.textContent;
  held.resolve({ ok: true, records: [record()], nextCursor: null }); await running; assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.mount.textContent, before); assert.equal(h.published.length, 0); assert.equal(h.search().listeners.has('input'), false); await h.app.refresh(); assert.equal(h.calls.length, 1);
});

test('callback failures do not turn a successful immutable list read into a storage error', async () => {
  const h = harness({ request: async () => ({ ok: true, records: [record()], nextCursor: null }), onRecords: async () => { throw new Error('not a storage failure'); }, onOpenSource: async () => { throw new Error('원본 열람 기간을 확인해 주세요.'); } });
  assert.equal(await h.app.refresh(), true); await settle(); assert.equal(h.cards().length, 1); assert.doesNotMatch(h.mount.textContent, /not a storage failure/);
  h.button('원본 대조 화면').click(); await settle(); assert.match(h.mount.textContent, /원본 열람 기간/); assert.equal(h.button('원본 대조 화면').disabled, false); h.app.destroy();
});
