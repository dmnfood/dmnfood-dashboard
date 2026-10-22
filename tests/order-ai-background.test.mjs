import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrderAiBackgroundService, createHandler, SEVEN_DAYS } from '../lib/server/order-ai-background-service.cjs';
import { createOrderAiBackgroundStore, JOB_FIELDS } from '../lib/server/order-ai-background-store.cjs';
import { encodeFields, decodeFields } from '../lib/server/mail-integration-store.cjs';

const id = 'a'.repeat(64), hash = 'b'.repeat(64), actor = { uid: 'manager', role: 'manager' }, now = Date.now();
const member = (intakeId = id, extra = {}) => ({ intakeId, id: intakeId, account: 'official@dmnfood.co.kr', folderId: '106', sourceHash: hash, receivedAt: new Date(now - 1000).toISOString(), ...extra });
function fixture(options = {}) {
  let clock = now, analysisCalls = 0, confirms = 0, claims = 0;
  const jobs = new Map(), analyses = new Map(), sources = new Map([[id, member()]]), calls = [], releases = [];
  const store = { get: async key => structuredClone(jobs.get(key) || null), schoolSource: async key => sources.get(key) || null,
    claim: async (key, sourceHash, uid) => { claims++; if (jobs.has(key)) return null; const job = { data: { intakeId: key, sourceHash, state: 'running', createdByUid: uid, leaseExpiresAt: clock + 240000 }, version: '1' }; jobs.set(key, job); if (options.uncertainClaim) throw Object.assign(new Error('uncertain'), { status: 503 }); return structuredClone(job); },
    finish: async (old, data) => { if (options.uncertainFinish) throw new Error('uncertain finish'); const next = { data: { ...old.data, ...data }, version: '2' }; jobs.set(old.data.intakeId, next); return next; } };
  const aiStore = { get: async key => structuredClone(analyses.get(key) || null) };
  const aiService = { analyze: async (input, human) => { analysisCalls++; assert.deepEqual(input, { intakeId: input.intakeId, expectedRevision: 0 }); assert.equal(human.uid, actor.uid);
      if (options.defer) await new Promise(resolve => releases.push(resolve));
      if (options.error) throw options.error;
      const record = { data: { sourceHash: hash, revision: 1, status: 'needs_review' } }; analyses.set(input.intakeId, record); return { ok: true, analysis: { revision: 1 } };
    }, confirm: async () => { confirms++; throw new Error('automatic work must never confirm'); } };
  const mailService = { source: async input => { calls.push(input); if (input.intakeId) { const source = sources.get(input.intakeId); return { mail: { id: input.intakeId, account: source?.account, receivedAt: source?.receivedAt, rawStorage: { sha256: options.changedHash || source?.sourceHash } } }; }
      return { mails: options.page || [...sources.values()].map(({ intakeId, ...source }) => ({ ...source, id: intakeId })), nextCursor: options.nextCursor || null }; },
    sync: async (uid, input) => { calls.push({ uid, input }); return { ok: true, sync: { status: 'complete', folderId: input.folderId, scope: input.scope, continuation: null } }; } };
  const create = () => createOrderAiBackgroundService({ store, aiStore, aiService, mailService, now: () => clock });
  return { service: create(), create, store, aiStore, aiService, mailService, jobs, analyses, sources, calls, releases, advance: value => clock += value,
    get counts() { return { analysisCalls, confirms, claims }; } };
}
const req = (method = 'POST', body = { action: 'analyze', intakeId: id }, extra = {}) => ({ method, url: '/api/order-ai/background', body,
  headers: { origin: 'https://dashboard.dmnfood.co.kr', 'content-type': 'application/json', authorization: 'Bearer fictional-user-token' }, ...extra });
async function invoke(handler, request) { let body; const headers = {}, response = { setHeader: (key, value) => headers[key] = value, end: value => body = JSON.parse(value) }; await handler(request, response); return { status: response.statusCode, body, headers }; }

test('background sync is fixed to the school folder and existing signed continuation without exposing another mail operation', async () => {
  const f = fixture(), handler = createHandler({ authorize: async () => actor, service: f.service });
  const response = await invoke(handler, req('POST', { action: 'sync', continuation: 'fictional.signed-token' }));
  assert.equal(response.status, 200); assert.equal(response.body.sync.folderId, '106');
  assert.deepEqual(f.calls, [{ uid: actor.uid, input: { folderId: '106', scope: 'school', continuation: 'fictional.signed-token' } }]);
  assert.equal(f.counts.analysisCalls, 0);
  for (const body of [{ action: 'sync', folderId: '1' }, { action: 'sync', scope: 'all' }, { action: 'sync', continuation: '' }, { action: 'sync', continuation: 'x'.repeat(20001) }, { action: 'confirm', intakeId: id }]) assert.equal((await invoke(handler, req('POST', body))).status, 400);
});

test('background list returns only recent school-mail states in twenty-item pages without source text or attachments', async () => {
  const f = fixture({ page: [member(), member('c'.repeat(64), { receivedAt: new Date(now - SEVEN_DAYS - 1).toISOString() }), member('d'.repeat(64), { folderId: '1' }), member('e'.repeat(64), { receivedAt: new Date(now + 1).toISOString() })], nextCursor: 'remaining' });
  const response = await f.service.list({ cursor: 'start' });
  assert.deepEqual(f.calls, [{ folderId: '106', cursor: 'start' }]); assert.deepEqual(response.items, [{ intakeId: id, state: 'pending' }]); assert.equal(response.nextCursor, null);
  assert.equal(JSON.stringify(response).includes('receivedAt'), false); assert.equal(f.counts.analysisCalls, 0);
});

test('only one of simultaneous staff or tab claims can call AI and it produces a draft without confirmation', async () => {
  const f = fixture({ defer: true }), second = f.create();
  const first = f.service.analyze(id, actor);
  for (let attempt = 0; attempt < 20 && !f.releases.length; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.releases.length, 1);
  assert.equal((await second.analyze(id, { ...actor })).state, 'running');
  assert.equal(f.counts.analysisCalls, 1); f.releases[0]();
  assert.deepEqual(await first, { ok: true, intakeId: id, state: 'ready', revision: 1 });
  assert.equal(f.jobs.get(id).data.state, 'ready'); assert.equal(f.analyses.get(id).data.status, 'needs_review'); assert.equal(f.counts.confirms, 0);
  assert.equal((await second.analyze(id, actor)).state, 'ready'); assert.equal(f.counts.analysisCalls, 1);
});

test('existing draft or confirmed analysis is authoritative and is never regenerated by automatic work', async () => {
  for (const status of ['needs_review', 'confirmed']) {
    const f = fixture(); f.analyses.set(id, { data: { sourceHash: hash, revision: 3, status } });
    const state = status === 'confirmed' ? 'confirmed' : 'ready';
    assert.deepEqual(await f.service.analyze(id, actor), { ok: true, intakeId: id, state, revision: 3 });
    assert.equal((await f.service.list()).items[0].state, state); assert.equal(f.counts.analysisCalls, 0); assert.equal(f.counts.claims, 0);
  }
});

test('only saved final confirmation exposes the confirmed badge and timestamp while changed sources still fail closed', async () => {
  const f = fixture(), confirmedAt = new Date(now).toISOString();
  f.analyses.set(id, { data: { sourceHash: hash, revision: 4, status: 'confirmed', confirmedAt } });
  assert.deepEqual((await f.service.list()).items, [{ intakeId: id, state: 'confirmed', revision: 4, confirmedAt }]);
  f.analyses.get(id).data.sourceHash = 'c'.repeat(64);
  assert.equal((await f.service.list()).items[0].state, 'failed'); assert.equal(f.counts.analysisCalls, 0);
});

test('a manual analysis finishing between the initial lookup and job claim is returned without another model request', async () => {
  const f = fixture(); f.store.claim = async () => { f.analyses.set(id, { data: { sourceHash: hash, revision: 2, status: 'needs_review' } }); throw Object.assign(new Error('late claim denied'), { status: 403 }); };
  assert.deepEqual(await f.service.analyze(id, actor), { ok: true, intakeId: id, state: 'ready', revision: 2 }); assert.equal(f.counts.analysisCalls, 0);
});

test('failed or interrupted automatic work is never charged again and only safe fixed failure messages are persisted', async () => {
  const f = fixture({ error: Object.assign(new Error('fictional secret source body'), { code: 'ai_provider_timeout' }) });
  const first = await f.service.analyze(id, actor); assert.equal(first.state, 'failed'); assert.match(first.message, /대기 시간/);
  assert.equal(JSON.stringify(f.jobs.get(id)).includes('fictional secret'), false);
  await f.service.analyze(id, actor); await f.service.list(); assert.equal(f.counts.analysisCalls, 1);
  const interrupted = fixture(); interrupted.jobs.set(id, { data: { state: 'running', sourceHash: hash, leaseExpiresAt: now + 1 } }); interrupted.advance(2);
  assert.match((await interrupted.service.analyze(id, actor)).message, /중단/); assert.equal(interrupted.counts.analysisCalls, 0); assert.equal(interrupted.counts.claims, 0);
  const unknown = fixture({ error: Object.assign(new Error('untrusted provider payload'), { code: 'sk_fictional_secret' }) });
  assert.equal((await unknown.service.analyze(id, actor)).state, 'failed'); assert.equal(JSON.stringify(unknown.jobs.get(id)).includes('sk_fictional'), false);
});

test('an uncertain claim never invokes AI, while an uncertain terminal update cannot erase a saved analysis or repeat a charge', async () => {
  const uncertain = fixture({ uncertainClaim: true }); await assert.rejects(uncertain.service.analyze(id, actor), { status: 503 });
  assert.equal(uncertain.counts.analysisCalls, 0); assert.equal((await uncertain.service.analyze(id, actor)).state, 'running');
  const saved = fixture({ uncertainFinish: true }); assert.equal((await saved.service.analyze(id, actor)).state, 'ready'); assert.equal((await saved.service.analyze(id, actor)).state, 'ready'); assert.equal(saved.counts.analysisCalls, 1);
});

test('mail outside school membership or the seven-day window and changed canonical hashes cannot be automatically analyzed', async () => {
  for (const change of [{ folderId: '1' }, { account: 'other@example.test' }, { receivedAt: new Date(now - SEVEN_DAYS - 1).toISOString() }, { receivedAt: new Date(now + 1).toISOString() }, { sourceHash: 'invalid' }, { intakeId: 'c'.repeat(64) }]) {
    const f = fixture(); f.sources.set(id, member(id, change)); await assert.rejects(f.service.analyze(id, actor), { code: 'background_scope_invalid' }); assert.equal(f.counts.analysisCalls, 0); assert.equal(f.counts.claims, 0);
  }
  const changed = fixture({ changedHash: 'f'.repeat(64) }); await assert.rejects(changed.service.analyze(id, actor), { code: 'ai_source_changed' }); assert.equal(changed.counts.analysisCalls, 0); assert.equal(changed.counts.claims, 0);
});

test('background handler guards approved roles, same-origin JSON, request fields and cursors before work', async () => {
  for (const [authorize, request, status] of [
    [async () => ({ uid: 'worker', role: 'worker' }), req(), 403], [async () => { throw Object.assign(new Error('login'), { status: 401 }); }, req(), 401],
    [async () => actor, req('DELETE'), 405], [async () => actor, req('POST', {}, { headers: { origin: 'https://evil.invalid', 'content-type': 'application/json' } }), 403],
    [async () => actor, req('POST', {}, { headers: { origin: 'https://dashboard.dmnfood.co.kr', 'content-type': 'text/plain' } }), 415],
    [async () => actor, req('POST', 'x'.repeat(24001)), 413], [async () => actor, req('POST', '{invalid'), 400],
    [async () => actor, req('GET', null, { url: '/api/order-ai/background?folderId=1' }), 400], [async () => actor, req('GET', null, { url: '/api/order-ai/background?cursor=a&cursor=b' }), 400],
    [async () => actor, req('POST', { action: 'analyze', intakeId: id, sourceKind: 'image' }), 400], [async () => actor, req('POST', { action: 'analyze', intakeId: id, expectedRevision: 1 }), 400],
  ]) { const f = fixture(), response = await invoke(createHandler({ authorize, service: f.service }), request); assert.equal(response.status, status); assert.equal(f.calls.length, 0); assert.equal(f.counts.analysisCalls, 0); assert.equal(response.headers['Cache-Control'], 'no-store'); }
});

test('background REST jobs use employee tokens, create-only claims and versioned terminal writes without storing original content', async () => {
  const records = new Map(), writes = [], timestamp = new Date(now).toISOString();
  const store = createOrderAiBackgroundStore({ token: 'fictional-employee-token', now: () => now, fetchImpl: async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer fictional-employee-token');
    if (String(url).endsWith(':commit')) {
      const write = JSON.parse(options.body).writes[0]; writes.push(write); const key = write.update.name.split('/').at(-1);
      if (write.currentDocument.exists === false && records.has(key)) return new Response(JSON.stringify({ error: { status: 'ALREADY_EXISTS' } }), { status: 409 });
      records.set(key, { ...decodeFields(write.update.fields), createdAt: timestamp, updatedAt: timestamp }); return new Response(JSON.stringify({ commitTime: timestamp }));
    }
    const key = String(url).split('/').at(-1); return records.has(key) ? new Response(JSON.stringify({ fields: { ...encodeFields(records.get(key)), createdAt: { timestampValue: timestamp }, updatedAt: { timestampValue: timestamp } }, updateTime: timestamp })) : new Response('{}', { status: 404 });
  } });
  const job = await store.claim(id, hash, actor.uid); assert.equal(job.data.state, 'running'); assert.deepEqual(Object.keys(job.data).sort(), [...JOB_FIELDS].sort());
  assert.equal(await store.claim(id, hash, actor.uid), null); await store.finish(job, { state: 'ready', revision: 1 }, actor.uid);
  assert.deepEqual(writes[0].currentDocument, { exists: false }); assert.deepEqual(writes[2].currentDocument, { updateTime: timestamp }); assert.deepEqual(writes[2].update.fields.createdAt, { timestampValue: timestamp });
  assert.ok(writes.every(write => !Object.hasOwn(write.update.fields, 'text') && !Object.hasOwn(write.update.fields, 'contentBase64') && !Object.hasOwn(write.update.fields, 'modelOutput')));
});
