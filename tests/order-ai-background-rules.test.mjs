import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createOrderAiBackgroundStore } from '../lib/server/order-ai-background-store.cjs';
import { createOrderAiBackgroundService } from '../lib/server/order-ai-background-service.cjs';
import { createOrderAiStore } from '../lib/server/order-ai-store.cjs';
import { createOrderAiService } from '../lib/server/order-ai-service.cjs';
import { encodeFields } from '../lib/server/mail-integration-store.cjs';
const host = process.env.MAIL_FIRESTORE_EMULATOR_HOST || process.env.ORDER_FIRESTORE_EMULATOR_HOST;

test('background job rules bind school sources, employee claims and terminal versions without collector authority or approval', { skip: !host }, async () => {
  assert.match(host, /^(127\.0\.0\.1|localhost):\d+$/);
  const project = 'demo-order-ai-background', documentName = `projects/${project}/databases/(default)/documents`, base = `http://${host}/v1/${documentName}`;
  assert.equal((await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: 'DELETE' })).status, 200);
  const loaded = await fetch(`http://${host}/emulator/v1/projects/${project}:securityRules`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') }] } }) });
  assert.equal(loaded.status, 200, await loaded.text());
  const token = uid => { const now = Math.floor(Date.now() / 1000); return `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: `https://securetoken.google.com/${project}`, aud: project, sub: uid, user_id: uid, iat: now, exp: now + 3600, auth_time: now, firebase: { sign_in_provider: 'custom' } })).toString('base64url')}.`; };
  const headers = uid => ({ 'Content-Type': 'application/json', ...(uid ? { Authorization: `Bearer ${uid === 'owner' ? 'owner' : token(uid)}` } : {}) });
  const put = (path, data, uid = 'owner') => fetch(`${base}/${path}`, { method: 'PATCH', headers: headers(uid), body: JSON.stringify({ fields: encodeFields(data) }) });
  const get = (path, uid = 'manager') => fetch(`${base}/${path}`, { headers: headers(uid) });
  const remove = (path, uid = 'owner') => fetch(`${base}/${path}`, { method: 'DELETE', headers: headers(uid) });
  for (const [uid, role, approvalStatus, isActive] of [['manager', 'manager', 'approved', true], ['admin', 'admin', 'approved', true], ['worker', 'worker', 'approved', true], ['pending', 'manager', 'pending', true], ['inactive', 'manager', 'approved', false]]) await put(`users/${uid}`, { role, approvalStatus, isActive });
  await put('integrationAccess/naverworksMail', { collectorUid: 'collector', enabled: true });
  const id = 'a'.repeat(64), hash = 'b'.repeat(64), sourceDate = new Date(Date.now() - 1000).toISOString();
  async function seed(key, changes = {}) {
    await put(`mailIntakes/${key}`, { account: 'official@dmnfood.co.kr', rawStorage: { sha256: hash }, receivedAt: sourceDate });
    await put(`mailFolders/106/intakes/${key}`, { schemaVersion: 1, intakeId: key, folderId: '106', account: 'official@dmnfood.co.kr', sourceHash: hash, receivedAt: sourceDate, ...changes });
  }
  await seed(id);
  const jobStore = uid => createOrderAiBackgroundStore({ token: token(uid), documentName, documentRoot: base });
  for (const uid of ['collector', 'worker', 'pending', 'inactive']) {
    await assert.rejects(jobStore(uid).claim(id, hash, uid), { status: 403 }); assert.equal((await get(`orderAiJobs/${id}`, uid)).status, 403);
  }
  await assert.rejects(jobStore('manager').claim(id, 'c'.repeat(64), 'manager'), { status: 403 });
  const invalidId = 'd'.repeat(64); await seed(invalidId, { folderId: '1' });
  await assert.rejects(jobStore('manager').claim(invalidId, hash, 'manager'), { status: 403 }, 'jobs cannot bind another folder');
  const missingId = 'e'.repeat(64); await put(`mailIntakes/${missingId}`, { account: 'official@dmnfood.co.kr', rawStorage: { sha256: hash } });
  await assert.rejects(jobStore('manager').claim(missingId, hash, 'manager'), { status: 403 }, 'a school membership is required');
  const store = jobStore('manager'), adminStore = jobStore('admin');
  const claims = await Promise.all([store.claim(id, hash, 'manager'), adminStore.claim(id, hash, 'admin')]);
  assert.equal(claims.filter(Boolean).length, 1, 'an atomic create-only claim has exactly one winner');
  const claim = claims.find(Boolean), winner = claim.data.createdByUid, winnerStore = jobStore(winner);
  assert.equal(claim.data.state, 'running'); assert.equal((await get(`orderAiJobs/${id}`, winner === 'manager' ? 'admin' : 'manager')).status, 200);
  assert.equal(await store.claim(id, hash, 'manager'), null, 'running jobs are never reclaimed');
  assert.equal((await remove(`orderAiJobs/${id}`, winner)).status, 403);
  await assert.rejects(winnerStore.finish(claim, { state: 'ready', revision: 1 }, winner), { status: 403 }, 'ready requires a saved analysis');
  const failed = await winnerStore.finish(claim, { state: 'failed', failureCode: 'ai_provider_timeout', message: '분석 응답 대기 시간이 지났습니다.' }, winner);
  assert.equal(failed.data.state, 'failed'); assert.equal(await store.claim(id, hash, 'manager'), null);
  await assert.rejects(winnerStore.finish(claim, { state: 'failed', failureCode: 'analysis_failed', message: '다시 시도' }, winner), error => [403, 409].includes(error.status), 'terminal updates require the exact original version and cannot rewrite a finished job');
  assert.equal((await put(`orderAiJobs/${id}`, { ...failed.data, state: 'running' }, winner)).status, 403);

  // A real AI service through the background adapter saves only a review draft.
  const actualId = 'f'.repeat(64); await seed(actualId);
  const companyName = '가상 거래처', companyId = `school-${createHash('sha256').update(companyName).digest('hex').slice(0, 24)}`;
  await put('settings/schoolMealCompanies', { schemaVersion: 1, revision: 1, companies: [{ id: companyId, name: companyName }] });
  const aiStore = createOrderAiStore({ token: token('manager'), documentName, documentRoot: base });
  const source = { attachmentId: '12', sha256: 'c'.repeat(64), kind: 'workbook', complete: true, fileName: '가상.csv', sheets: [{ sheetIndex: 0, sheetName: 'Sheet1', rows: [{ rowIndex: 0, cells: [{ columnIndex: 0, value: '국산 참기름 1L' }, { columnIndex: 1, value: 2 }, { columnIndex: 2, value: '병' }] }] }] };
  const candidate = { assistantMessage: '원본을 대조해 주세요.', questions: [], customerId: companyId, rows: [{ r: 0, d: 'included', x: '', l: [{ p: 1, c: [0], q: 1, u: 2, x: [] }] }], excludedRows: [] };
  let providerCalls = 0, finishProvider;
  const mail = { id: actualId, account: 'official@dmnfood.co.kr', receivedAt: sourceDate, rawStorage: { sha256: hash } };
  const mailService = { source: async input => input.intakeId ? { mail } : { mails: [{ id: actualId, intakeId: actualId, account: mail.account, folderId: '106', receivedAt: sourceDate, sourceHash: hash }], nextCursor: null } };
  const aiService = createOrderAiService({ store: aiStore, mailService, env: { OPENAI_API_KEY: 'fictional-rule-test' }, extract: async () => ({ sources: [structuredClone(source)], images: [] }), fetchImpl: async () => {
    providerCalls++; await new Promise(resolve => { finishProvider = resolve; });
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(candidate) }] }] }));
  } });
  const background = createOrderAiBackgroundService({ store, aiStore, aiService, mailService }), actor = { uid: 'manager', role: 'manager' };
  const first = background.analyze(actualId, actor);
  for (let attempt = 0; attempt < 100 && !finishProvider; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(providerCalls, 1); assert.equal((await background.analyze(actualId, actor)).state, 'running');
  finishProvider(); assert.deepEqual(await first, { ok: true, intakeId: actualId, state: 'ready', revision: 1 });
  assert.equal((await aiStore.get(actualId)).data.status, 'needs_review'); assert.equal((await store.get(actualId)).data.state, 'ready');
  assert.equal((await background.analyze(actualId, actor)).state, 'ready'); assert.equal(providerCalls, 1);
  assert.equal((await background.list()).items[0].state, 'ready');
  const jobFields = (await (await get(`orderAiJobs/${actualId}`)).json()).fields;
  for (const key of ['text', 'sourceText', 'raw', 'contentBase64', 'modelOutput', 'analysis', 'authorization']) assert.equal(Object.hasOwn(jobFields, key), false);
  assert.equal((await get('mailIntegrationSecrets/naverworks', 'manager')).status, 403, 'automatic jobs do not grant employee secret access');
});
