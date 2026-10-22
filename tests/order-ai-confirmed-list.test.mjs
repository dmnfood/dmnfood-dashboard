import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOrderAiStore } from '../lib/server/order-ai-store.cjs';
import { createHandler, createOrderAiService } from '../lib/server/order-ai-service.cjs';
import { encodeFields } from '../lib/server/mail-integration-store.cjs';

const id = value => value.toString(16).padStart(64, '0'), sourceHash = 'b'.repeat(64);
const stamp = '2026-10-22T03:00:00.123456Z';
const root = 'projects/demo-confirmed-orders/databases/(default)/documents';
function record(value = 100, sourceKind = 'mail') {
  return { intakeId: id(value), sourceHash, revision: 2, status: 'confirmed', confirmedRevision: 1, confirmedAt: stamp, confirmedByUid: 'fictional-manager',
    analysis: { customer: { id: 'school-fictional', name: '가상 업체', revision: 1, source: 'school_meal', erpCode: null },
      sources: [{ attachmentId: sourceKind === 'image' ? 'message-image' : sourceKind === 'text' ? 'text' : '12', kind: sourceKind === 'mail' ? 'workbook' : sourceKind, sha256: sourceHash }],
      groups: [{ id: 'group-1', productId: 'oil-cn-1_8l', label: '중국산 참기름 1.8L', quantity: '3', unit: '병', lineIds: ['l1', 'l2'] }] },
    modelOutput: { internal: 'must-not-return' }, conversation: ['must-not-return'] };
}
const document = data => ({ document: { name: `${root}/orderAiAnalyses/${data.intakeId}`, fields: encodeFields(data), updateTime: stamp } });
function storeHarness(pages) {
  const calls = [];
  const store = createOrderAiStore({ token: 'fictional-manager-token', documentName: root, documentRoot: `https://firestore.example.invalid/v1/${root}`,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(pages[calls.length - 1] || [])); } });
  return { store, calls };
}
const serviceWith = store => createOrderAiService({ store, env: {}, mailService: { source: () => { throw new Error('must not read expired originals'); } }, fetchImpl: () => { throw new Error('must not call AI'); } });
async function call(handler, url, role = 'manager') {
  let body; const headers = {}, response = { setHeader: (key, value) => headers[key] = value, end: value => { body = JSON.parse(value); } };
  await handler({ method: 'GET', url, headers: { authorization: 'Bearer fictional-token' } }, response); return { status: response.statusCode, headers, body };
}

test('confirmed summaries are paginated by timestamp and document identity with a bounded source-free projection', async () => {
  const values = Array.from({ length: 26 }, (_, index) => record(100 - index)), h = storeHarness([values.map(document), [document(values[25])]]);
  const first = await h.store.listConfirmed(); assert.equal(first.records.length, 25); assert.ok(first.nextCursor);
  const position = JSON.parse(Buffer.from(first.nextCursor, 'base64url')); assert.deepEqual(position, { confirmedAt: stamp, intakeId: id(76) });
  const query = JSON.parse(h.calls[0].options.body).structuredQuery;
  assert.equal(query.limit, 26); assert.deepEqual(query.orderBy, [{ field: { fieldPath: 'confirmedAt' }, direction: 'DESCENDING' }, { field: { fieldPath: '__name__' }, direction: 'DESCENDING' }]);
  assert.equal(query.where, undefined); assert.equal(h.calls[0].options.headers.Authorization, 'Bearer fictional-manager-token');
  assert.equal(query.select.fields.some(field => /modelOutput|conversation|analysis\.lines/.test(field.fieldPath)), false);
  const second = await h.store.listConfirmed({ cursor: first.nextCursor }); assert.equal(second.records.length, 1); assert.equal(second.nextCursor, null);
  const next = JSON.parse(h.calls[1].options.body).structuredQuery.startAt;
  assert.deepEqual(next, { before: false, values: [{ timestampValue: stamp }, { referenceValue: `${root}/orderAiAnalyses/${id(76)}` }] });
});

test('drafts at the end of timestamp order never appear as registered orders or create a false next page', async () => {
  const draft = { ...record(50), status: 'needs_review', confirmedAt: null, confirmedRevision: null, confirmedByUid: null };
  const h = storeHarness([[document(record()), document(draft)], [{ readTime: stamp }]]);
  const result = await h.store.listConfirmed(); assert.equal(result.records.length, 1); assert.equal(result.nextCursor, null);
  assert.deepEqual(await h.store.listConfirmed(), { records: [], nextCursor: null });
});

test('malformed paging positions cannot inject a project, collection or query and never reach Firestore', async () => {
  const h = storeHarness([]);
  for (const value of ['', 'not/json', Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ confirmedAt: stamp, intakeId: '../other' })).toString('base64url'),
    Buffer.from(JSON.stringify({ confirmedAt: 'bad', intakeId: id(1) })).toString('base64url'), Buffer.from(JSON.stringify({ confirmedAt: stamp, intakeId: id(1), project: 'other' })).toString('base64url')]) {
    await assert.rejects(h.store.listConfirmed({ cursor: value }), { code: 'ai_list_cursor_invalid', status: 400 });
  }
  assert.equal(h.calls.length, 0);
});

test('corrupt confirmed status, identity and timestamp fail closed rather than silently dropping stored orders', async () => {
  for (const change of [value => { value.confirmedAt = null; }, value => { value.status = 'needs_review'; }, value => { value.confirmedAt = 'bad'; }]) {
    const value = record(); change(value); await assert.rejects(storeHarness([[document(value)]]).store.listConfirmed(), { code: 'ai_list_invalid' });
  }
  const value = document(record()); value.document.name = `${root}/orderAiAnalyses/${id(2)}`;
  await assert.rejects(storeHarness([[value]]).store.listConfirmed(), { code: 'ai_list_invalid' });
});

test('confirmed DTOs retain exact totals and source routing after originals expire without reading raw content or invoking AI', async () => {
  for (const sourceKind of ['mail', 'text', 'image']) {
    const value = record(100, sourceKind), service = serviceWith({ listConfirmed: async () => ({ records: [{ data: value }], nextCursor: null }) });
    const result = await service.listConfirmed(); assert.equal(result.records[0].sourceKind, sourceKind); assert.equal(result.records[0].lineCount, 2);
    assert.equal(result.records[0].confirmedAt, stamp); assert.equal(result.records[0].sourceHash, sourceHash);
    assert.deepEqual(result.records[0].groups[0], { id: 'group-1', productId: 'oil-cn-1_8l', label: '중국산 참기름 1.8L', quantity: '3', unit: '병' });
    assert.doesNotMatch(JSON.stringify(result), /must-not-return|conversation|modelOutput|lineIds|sources/);
  }
});

test('summary validation rejects duplicate quantity evidence and invalid saved values', async () => {
  for (const change of [value => { value.revision = 1; }, value => { value.confirmedRevision = 2; }, value => { value.analysis.groups[0].quantity = '0'; },
    value => { value.analysis.groups[0].lineIds = ['l1', 'l1']; }, value => { value.analysis.groups.push({ ...value.analysis.groups[0], id: 'group-2' }); }, value => { value.status = 'needs_review'; }]) {
    const value = record(); change(value); await assert.rejects(serviceWith({ listConfirmed: async () => ({ records: [{ data: value }], nextCursor: null }) }).listConfirmed(), { code: 'ai_list_invalid' });
  }
});

test('the existing analysis GET routes explicit confirmed lists and rejects ambiguous, duplicate and unknown query inputs', async () => {
  const requests = [], handler = createHandler('analysis', { authorize: async () => ({ uid: 'manager', role: 'manager' }),
    service: { listConfirmed: async value => { requests.push(value); return { ok: true, records: [], nextCursor: null }; }, read: async intakeId => ({ ok: true, analysis: { intakeId } }) } });
  assert.equal((await call(handler, '/api/order-ai/analysis?list=confirmed')).status, 200); assert.deepEqual(requests, [{ cursor: null }]);
  assert.equal((await call(handler, `/api/order-ai/analysis?intakeId=${id(1)}`)).body.analysis.intakeId, id(1));
  for (const query of ['list=all', 'list=confirmed&list=confirmed', `list=confirmed&intakeId=${id(1)}`, 'list=confirmed&cursor=x&cursor=y', 'list=confirmed&unknown=true']) {
    assert.equal((await call(handler, '/api/order-ai/analysis?' + query)).status, 400);
  }
  assert.equal(requests.length, 1);
});

test('registered AI orders keep the existing manager/admin boundary and expose no unconfirmed data', async () => {
  let reads = 0;
  for (const role of ['worker', 'collector', 'pending', 'inactive']) {
    const handler = createHandler('analysis', { authorize: async () => ({ uid: role, role }), service: { listConfirmed: async () => { reads++; return {}; } } });
    assert.equal((await call(handler, '/api/order-ai/analysis?list=confirmed')).status, 403);
  }
  assert.equal(reads, 0);
});

const emulatorHost = process.env.MAIL_FIRESTORE_EMULATOR_HOST || process.env.ORDER_FIRESTORE_EMULATOR_HOST;
test('actual Firestore query retains all confirmations across timestamp ties, omits drafts and enforces existing read roles', { skip: !emulatorHost }, async () => {
  assert.match(emulatorHost, /^(127\.0\.0\.1|localhost):\d+$/);
  const project = 'demo-order-ai-confirmed-list', documentName = `projects/${project}/databases/(default)/documents`, base = `http://${emulatorHost}/v1/${documentName}`;
  assert.equal((await fetch(`http://${emulatorHost}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: 'DELETE' })).status, 200);
  const loaded = await fetch(`http://${emulatorHost}/emulator/v1/projects/${project}:securityRules`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') }] } }) });
  assert.equal(loaded.status, 200, await loaded.text());
  const token = uid => {
    const now = Math.floor(Date.now() / 1000);
    return `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: `https://securetoken.google.com/${project}`, aud: project,
      sub: uid, user_id: uid, iat: now, exp: now + 3600, auth_time: now, firebase: { sign_in_provider: 'custom' } })).toString('base64url')}.`;
  };
  const saved = Array.from({ length: 31 }, (_, index) => record(100 - index, ['mail', 'text', 'image'][index % 3]));
  saved.at(-1).confirmedAt = '2026-10-22T03:00:00.124Z';
  const drafts = Array.from({ length: 3 }, (_, index) => ({ ...record(500 + index), status: 'needs_review', confirmedAt: null, confirmedRevision: null, confirmedByUid: null }));
  const documents = [...saved, ...drafts].map(value => {
    const fields = encodeFields(value);
    if (value.confirmedAt !== null) fields.confirmedAt = { timestampValue: value.confirmedAt };
    return { update: { name: `${documentName}/orderAiAnalyses/${value.intakeId}`, fields } };
  });
  for (const [uid, role, approvalStatus, isActive] of [['manager', 'manager', 'approved', true], ['admin', 'admin', 'approved', true], ['worker', 'worker', 'approved', true], ['pending', 'manager', 'pending', true], ['inactive', 'manager', 'approved', false]]) {
    documents.push({ update: { name: `${documentName}/users/${uid}`, fields: encodeFields({ role, approvalStatus, isActive }) } });
  }
  const seeded = await fetch(`${base}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify({ writes: documents }) });
  assert.equal(seeded.status, 200, await seeded.text());
  const store = uid => createOrderAiStore({ token: token(uid), documentName, documentRoot: base });
  const service = serviceWith(store('manager'));
  const first = await service.listConfirmed(), second = await service.listConfirmed({ cursor: first.nextCursor });
  assert.equal(first.records.length, 25); assert.equal(second.records.length, 6); assert.equal(second.nextCursor, null);
  const received = [...first.records, ...second.records];
  assert.deepEqual(received.map(value => value.intakeId), [id(70), ...Array.from({ length: 30 }, (_, index) => id(100 - index))]);
  assert.equal(new Set(received.map(value => value.intakeId)).size, saved.length, 'timestamp ties never duplicate or omit a confirmation');
  assert.equal(received.some(value => drafts.some(draft => draft.intakeId === value.intakeId)), false, 'drafts with null timestamps sort after all confirmations');
  assert.doesNotMatch(JSON.stringify(received), /must-not-return|conversation|modelOutput|lineIds|sources/);
  assert.equal((await serviceWith(store('admin')).listConfirmed()).records.length, 25);
  for (const uid of ['collector', 'worker', 'pending', 'inactive']) await assert.rejects(store(uid).listConfirmed(), { status: 403 });
});
