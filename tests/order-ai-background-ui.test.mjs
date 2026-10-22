import test from 'node:test';
import assert from 'node:assert/strict';
import { initOrderBackground } from '../dashboard/js/order-ai-background.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function harness(respond, extra = {}) {
  const calls = [], states = [], ready = [], synced = [], statuses = [], timers = new Map(), listeners = new Map();
  let count = 0, connected = true;
  const app = initOrderBackground({ user: { uid: 'fictional-manager' } }, {
    request: async (session, path, options = {}) => {
      const call = { path, ...options }; calls.push(call);
      const result = await respond?.(call); if (result !== undefined) return result;
      if (options.body?.action === 'sync') return { ok: true, sync: { status: 'complete', collected: 0, continuation: null } };
      if (options.body?.action === 'analyze') return { ok: true, intakeId: options.body.intakeId, state: 'ready', revision: 1 };
      return { ok: true, items: [], nextCursor: null };
    },
    onStates: items => states.push(...items), onReady: item => ready.push(item), onMailSynced: sync => synced.push(sync), onStatus: value => statuses.push(value),
    isOnline: () => connected,
    schedule: (fn, delay) => { const id = ++count; timers.set(id, { fn, delay }); return id; }, unschedule: id => timers.delete(id),
    events: { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) },
    ...extra,
  });
  return { app, calls, states, ready, synced, statuses, timers, listeners,
    async tick() { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); await settle(); },
    online(value) { connected = value; if (value) listeners.get('online')?.(); },
  };
}

test('opening the signed-in inbox collects school mail and analyzes pending items without selecting any mail', async () => {
  const h = harness(call => !call.body ? { ok: true, items: [{ intakeId: A, state: 'pending' }, { intakeId: B, state: 'ready', revision: 3 }, { intakeId: C, state: 'failed', message: '담당자 확인 필요' }], nextCursor: null } : undefined);
  await settle();
  assert.deepEqual(h.calls.filter(call => call.body?.action === 'analyze').map(call => call.body), [{ action: 'analyze', intakeId: A }]);
  assert.equal(h.synced.length, 1); assert.deepEqual(h.ready.map(item => item.intakeId), [B, A]);
  assert.equal(h.calls.some(call => /confirm/.test(call.path)), false);
  assert.equal([...h.timers.values()][0].delay, 120000); h.app.destroy();
});

test('saved and failed analysis is not automatically charged again on later scans', async () => {
  let scans = 0;
  const h = harness(call => {
    if (!call.body) { scans++; return { ok: true, items: [{ intakeId: A, state: scans === 1 ? 'pending' : 'failed', message: '다시 확인 필요' }, { intakeId: B, state: 'ready', revision: 2 }], nextCursor: null }; }
    if (call.body.action === 'analyze') return { ok: true, intakeId: A, state: 'failed', message: '원본 확인 필요' };
  });
  await settle(); await h.tick();
  assert.equal(h.calls.filter(call => call.body?.action === 'analyze').length, 1);
  assert.equal(h.ready.filter(item => item.intakeId === B).length, 1); h.app.destroy();
});

test('mail polling continues while a slow analysis runs, but only one analysis runs per page', async () => {
  const held = deferred(); let scans = 0;
  const h = harness(call => {
    if (!call.body) { scans++; return { ok: true, items: scans === 1 ? [{ intakeId: A, state: 'pending' }] : [{ intakeId: A, state: 'running' }, { intakeId: B, state: 'pending' }], nextCursor: null }; }
    if (call.body.action === 'analyze' && call.body.intakeId === A) return held.promise;
  });
  await settle(); await h.tick();
  assert.equal(scans, 2); assert.equal(h.calls.filter(call => call.body?.action === 'sync').length, 2);
  assert.deepEqual(h.calls.filter(call => call.body?.action === 'analyze').map(call => call.body.intakeId), [A]);
  held.resolve({ ok: true, intakeId: A, state: 'ready', revision: 1 }); await settle();
  assert.deepEqual(h.calls.filter(call => call.body?.action === 'analyze').map(call => call.body.intakeId), [A, B]); h.app.destroy();
});

test('an uncertain response is not retried; the next scan reads the server result', async () => {
  let scan = 0;
  const h = harness(call => {
    if (!call.body) return { ok: true, items: [{ intakeId: A, state: ++scan === 1 ? 'pending' : 'ready', revision: 1 }], nextCursor: null };
    if (call.body.action === 'analyze') throw new Error('연결이 끊겼습니다.');
  });
  await settle(); assert.equal(h.app.stateFor(A).state, 'failed'); await h.tick();
  assert.equal(h.app.stateFor(A).state, 'ready'); assert.equal(h.calls.filter(call => call.body?.action === 'analyze').length, 1); h.app.destroy();
});

test('all source pages are inspected and duplicate pending IDs do not duplicate AI requests', async () => {
  const h = harness(call => {
    if (!call.body) return call.path.includes('cursor=') ? { ok: true, items: [{ intakeId: A, state: 'pending' }, { intakeId: B, state: 'pending' }], nextCursor: null }
      : { ok: true, items: [{ intakeId: A, state: 'pending' }], nextCursor: 'second-page' };
  });
  await settle(); assert.equal(h.calls.filter(call => call.body?.intakeId === A).length, 1); assert.equal(h.calls.filter(call => call.body?.intakeId === B).length, 1);
  assert.equal(h.app.stateFor(A).state, 'ready'); h.app.destroy();
});

test('an uncertain request is never queued again when the server still reports pending', async () => {
  const h = harness(call => {
    if (!call.body) return { ok: true, items: [{ intakeId: A, state: 'pending' }], nextCursor: null };
    if (call.body.action === 'analyze') throw new Error('응답을 확인하지 못했습니다.');
  });
  await settle(); await h.tick(); await h.tick();
  assert.equal(h.calls.filter(call => call.body?.action === 'analyze').length, 1);
  assert.equal(h.app.stateFor(A).state, 'failed'); h.app.destroy();
});

test('collection continuations run before scans and malformed cursor cycles stop safely', async () => {
  let syncs = 0, pages = 0;
  const h = harness(call => {
    if (call.body?.action === 'sync') return { ok: true, sync: ++syncs === 1 ? { status: 'partial', collected: 1, continuation: 'signed-continuation' } : { status: 'complete', collected: 2, continuation: null } };
    if (!call.body) return { ok: true, items: [], nextCursor: ++pages < 3 ? 'repeated' : null };
  });
  await settle(); assert.equal(syncs, 2); assert.equal(h.calls[1].body.continuation, 'signed-continuation');
  assert.equal(pages, 2); assert.equal(h.statuses.at(-1).state, 'failed'); h.app.destroy();
});

test('collection failure still allows already collected originals to be analyzed', async () => {
  const h = harness(call => {
    if (call.body?.action === 'sync') throw new Error('메일 연결 확인 필요');
    if (!call.body) return { ok: true, items: [{ intakeId: A, state: 'pending' }], nextCursor: null };
  });
  await settle(); assert.equal(h.ready[0].intakeId, A); assert.equal(h.statuses.at(-1).state, 'failed'); h.app.destroy();
});

test('closing the page aborts requests and ignores late responses without starting new work', async () => {
  const held = deferred();
  const h = harness(call => !call.body ? held.promise : undefined); await settle();
  const signal = h.calls.at(-1).signal; h.app.destroy(); assert.equal(signal.aborted, true);
  held.resolve({ ok: true, items: [{ intakeId: A, state: 'pending' }], nextCursor: null }); await settle();
  assert.equal(h.calls.some(call => call.body?.action === 'analyze'), false); assert.equal(h.states.length, 0); assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0);
});

test('offline pages do not start requests and resume checking after connectivity returns', async () => {
  const h = harness(); await settle(); const before = h.calls.length; h.online(false); await h.tick(); assert.equal(h.calls.length, before);
  h.online(true); await settle(); assert.ok(h.calls.length > before); h.app.destroy();
});

test('internal collection events do not recursively restart collection', async () => {
  const h = harness(); await settle(); const before = h.calls.length;
  h.listeners.get('mail-intakes-updated')({ detail: { origin: 'background' } }); await settle(); assert.equal(h.calls.length, before);
  h.listeners.get('mail-intakes-updated')({ detail: {} }); await settle();
  assert.equal(h.calls.filter(call => call.body?.action === 'sync').length, 1); assert.ok(h.calls.length > before); h.app.destroy();
});

test('a successful human confirmation updates immediately and cannot regress when an older scan or worker finishes', async () => {
  const held = deferred(), confirmedAt = '2026-10-22T03:00:00.000Z';
  const h = harness(call => !call.body ? held.promise : undefined); await settle();
  assert.equal(h.app.markConfirmed({ intakeId: A, revision: 4, confirmedAt }), true);
  assert.deepEqual(h.app.stateFor(A), { intakeId: A, state: 'confirmed', revision: 4, confirmedAt });
  held.resolve({ ok: true, items: [{ intakeId: A, state: 'pending' }], nextCursor: null }); await settle();
  assert.equal(h.app.stateFor(A).state, 'confirmed'); assert.equal(h.calls.some(call => call.body?.action === 'analyze'), false);
  assert.equal(h.ready.filter(item => item.state === 'confirmed').length, 1);
  assert.equal(h.app.markConfirmed({ intakeId: A, revision: 2 }), true); assert.equal(h.app.stateFor(A).revision, 4);
  h.app.destroy(); assert.equal(h.app.markConfirmed({ intakeId: A, revision: 5 }), false);
});

test('another staff confirmation found by polling upgrades ready status and refreshes saved analysis without a new AI request', async () => {
  let scans = 0;
  const h = harness(call => !call.body ? { ok: true, items: [{ intakeId: A, state: ++scans === 1 ? 'ready' : scans === 2 ? 'confirmed' : 'ready', revision: scans === 1 ? 1 : scans === 2 ? 2 : 1 }], nextCursor: null } : undefined);
  await settle(); await h.tick(); assert.equal(h.app.stateFor(A).state, 'confirmed'); assert.equal(h.ready.at(-1).state, 'confirmed');
  await h.tick(); assert.equal(h.app.stateFor(A).state, 'confirmed'); assert.equal(h.ready.length, 2); assert.equal(h.calls.some(call => call.body?.action === 'analyze'), false);
  assert.equal(h.app.markConfirmed({ intakeId: '../invalid', revision: 1 }), false); assert.equal(h.app.markConfirmed({ intakeId: A, revision: 0 }), false); h.app.destroy();
});
