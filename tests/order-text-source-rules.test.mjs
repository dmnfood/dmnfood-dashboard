import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createOrderTextSourceStore } from '../lib/server/order-text-source-store.cjs';
import { buildTextSource } from '../lib/server/order-text-source.cjs';
import { createOrderAiStore } from '../lib/server/order-ai-store.cjs';
import { createOrderAiService } from '../lib/server/order-ai-service.cjs';
import { encodeFields } from '../lib/server/mail-integration-store.cjs';
const host = process.env.MAIL_FIRESTORE_EMULATOR_HOST || process.env.ORDER_FIRESTORE_EMULATOR_HOST;
test('pasted original rules preserve manager scope, immutable raw text, actor identity and source-bound AI confirmation', { skip: !host }, async () => {
    assert.match(host, /^(127\.0\.0\.1|localhost):\d+$/);
    const project = 'demo-order-text-sources', documentName = `projects/${project}/databases/(default)/documents`, base = `http://${host}/v1/${documentName}`;
    const reset = await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: 'DELETE' });
    assert.equal(reset.status, 200, await reset.text());
    const loaded = await fetch(`http://${host}/emulator/v1/projects/${project}:securityRules`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') }] } }) });
    assert.equal(loaded.status, 200, await loaded.text());
    const token = uid => { const now = Math.floor(Date.now() / 1000); return `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: `https://securetoken.google.com/${project}`, aud: project, sub: uid, user_id: uid, iat: now, exp: now + 3600, auth_time: now, firebase: { sign_in_provider: 'custom' } })).toString('base64url')}.`; };
    const headers = uid => ({ 'Content-Type': 'application/json', ...(uid ? { Authorization: `Bearer ${uid === 'owner' ? 'owner' : token(uid)}` } : {}) });
    const put = (path, data, uid = 'owner') => fetch(`${base}/${path}`, { method: 'PATCH', headers: headers(uid), body: JSON.stringify({ fields: encodeFields(data) }) });
    const remove = (path, uid = 'owner') => fetch(`${base}/${path}`, { method: 'DELETE', headers: headers(uid) });
    const get = (path, uid = 'manager') => fetch(`${base}/${path}`, { headers: headers(uid) });
    const create = (id, data, uid, transform = true) => fetch(`${base}:commit`, { method: 'POST', headers: headers(uid), body: JSON.stringify({ writes: [{ update: { name: `${documentName}/orderTextSources/${id}`, fields: encodeFields(data) }, currentDocument: { exists: false }, ...(transform ? { updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }] } : {}) }] }) });
    for (const [uid, role, approvalStatus, isActive] of [['manager', 'manager', 'approved', true], ['admin', 'admin', 'approved', true], ['worker', 'worker', 'approved', true], ['pending', 'manager', 'pending', true], ['inactive', 'manager', 'approved', false]]) await put(`users/${uid}`, { role, approvalStatus, isActive });
    await put('integrationAccess/naverworksMail', { collectorUid: 'collector', enabled: true });
    const input = { requestId: '83c16afd-4197-42b0-8321-7c07f75b5f1a', channel: 'sms', text: '가상 급식업체\r\n국산 참기름 1L 2병' };
    const built = buildTextSource(input, 'manager'), id = built.id, path = `orderTextSources/${id}`;
    await remove(path); await remove(`orderAiAnalyses/${id}`); await remove(`orderAiAnalyses/${id}/versions/1`); await remove(`orderAiLocks/${id}`);
    for (const uid of ['', 'collector', 'worker', 'pending', 'inactive']) {
        assert.equal((await get(path, uid)).status, 403);
        assert.equal((await create(id, { ...built.data, createdByUid: uid }, uid)).status, 403);
    }
    for (const change of [{ channel: 'email' }, { scope: 'all' }, { createdByUid: 'admin' }, { sha256: 'invalid' }, { text: 'x'.repeat(20001) }, { title: 'x'.repeat(81) }, { arbitrary: 'extra' }]) assert.equal((await create(id, { ...built.data, ...change }, 'manager')).status, 403);
    assert.equal((await create(id, { ...built.data, createdAt: 'client-clock' }, 'manager', false)).status, 403);
    await put(`mailIntakes/${id}`, { account: 'official@dmnfood.co.kr', rawStorage: { sha256: built.data.sha256 } });
    assert.equal((await create(id, built.data, 'manager')).status, 403, 'a text intake cannot shadow an existing mail intake ID'); await remove(`mailIntakes/${id}`);
    const textStore = createOrderTextSourceStore({ token: token('manager'), documentName, documentRoot: base });
    const first = await textStore.create(input, 'manager'); assert.equal(first.created, true); assert.equal(first.source.text, input.text); assert.equal(typeof first.source.createdAt, 'string');
    for (const uid of ['manager', 'admin']) {
        assert.equal((await get(path, uid)).status, 200);
        assert.equal((await put(path, { ...built.data, text: 'changed' }, uid)).status, 403);
        assert.equal((await remove(path, uid)).status, 403);
    }
    assert.equal((await textStore.create(input, 'manager')).created, false);
    const summaries = await textStore.list(); assert.equal(summaries.length, 1); assert.equal(summaries[0].id, id); assert.equal('text' in summaries[0], false);
    const companyName = '가상 급식업체', companyId = `school-${createHash('sha256').update(companyName).digest('hex').slice(0, 24)}`;
    await put('settings/schoolMealCompanies', { schemaVersion: 1, revision: 1, companies: [{ id: companyId, name: companyName }] });
    const candidate = { assistantMessage: '원문과 대조해 주세요.', questions: [], customerId: companyId,
        rows: [{ r: 1, d: 'included', x: '', l: [{ p: 1, c: [{ s: 0, e: 3 }], q: { s: 4, e: 4 }, u: { s: 5, e: 5 }, x: [] }] }], excludedRows: [{ r: [0], x: '거래처 이름' }] };
    let providerCalls = 0;
    const actualStore = createOrderAiStore({ token: token('manager'), documentName, documentRoot: base });
    const service = createOrderAiService({ store: actualStore, mailService: { source: async () => { throw new Error('text cannot use mail'); } }, env: { OPENAI_API_KEY: 'fictional-rule-test' },
        fetchImpl: async () => { providerCalls++; return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(candidate) }] }] })); } });
    const actor = { uid: 'manager', role: 'manager' }, analyzed = await service.analyze({ intakeId: id, sourceKind: 'text', expectedRevision: 0 }, actor);
    assert.equal(analyzed.analysis.groups[0].quantity, '2'); assert.equal(analyzed.analysis.readyForReview, true); assert.equal(analyzed.analysis.sources[0].kind, 'text');
    const review = { intakeId: id, sourceKind: 'text', expectedRevision: 1, reviewedGroupIds: analyzed.analysis.groups.map(group => group.id), reviewedExclusions: true };
    await assert.rejects(service.confirm({ ...review, reviewedExclusions: false }, actor), { code: 'ai_confirmation_blocked' });
    const confirmed = await service.confirm(review, actor); assert.equal(confirmed.analysis.status, 'confirmed'); assert.equal(providerCalls, 1);
    const archived = await (await get(`orderAiAnalyses/${id}/versions/1`)).json(); assert.equal(archived.fields.record.mapValue.fields.sourceHash.stringValue, first.source.sha256);
    assert.equal((await get(`orderAiAnalyses/${id}`, 'collector')).status, 403);
    assert.equal((await get(`orderAiAnalyses/${id}`, 'worker')).status, 403);

    // The same employee scope also accepts immutable PNG/JPEG originals without
    // granting either the collector or the model any new approval authority.
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1EAAAAASUVORK5CYII=';
    const imageInput = { requestId: '83c16afd-4197-42b0-8321-7c07f75b5f1b', channel: 'kakao', image: { fileName: '가상 발주.png', mimeType: 'image/png', contentBase64: pngBase64 } };
    const imageBuilt = buildTextSource(imageInput, 'manager'), imageId = imageBuilt.id, imagePath = `orderTextSources/${imageId}`;
    await remove(imagePath); await remove(`orderAiAnalyses/${imageId}`); await remove(`orderAiAnalyses/${imageId}/versions/1`); await remove(`orderAiLocks/${imageId}`);
    for (const change of [{ byteLength: 614401 }, { contentBase64: '*invalid*' }, { mimeType: 'image/gif' }, { kind: 'text' }, { text: 'mixed original' }, { createdByUid: 'admin' }]) assert.equal((await create(imageId, { ...imageBuilt.data, ...change }, 'manager')).status, 403);
    for (const uid of ['', 'collector', 'worker', 'pending', 'inactive']) assert.equal((await create(imageId, { ...imageBuilt.data, createdByUid: uid }, uid)).status, 403);
    const imageSaved = await textStore.create(imageInput, 'manager'); assert.equal(imageSaved.created, true); assert.equal(imageSaved.source.contentBase64, pngBase64);
    for (const uid of ['manager', 'admin']) {
        assert.equal((await get(imagePath, uid)).status, 200);
        assert.equal((await put(imagePath, { ...imageBuilt.data, byteLength: 1 }, uid)).status, 403);
        assert.equal((await remove(imagePath, uid)).status, 403);
    }
    assert.equal((await textStore.create(imageInput, 'manager')).created, false);
    for (const uid of ['collector', 'worker']) assert.equal((await get(imagePath, uid)).status, 403);
    const mixed = await textStore.list(); assert.equal(mixed.length, 2); assert.ok(mixed.every(item => !('text' in item) && !('contentBase64' in item)));
    let imageProviderCalls = 0;
    const imageCandidate = { assistantMessage: '이미지 원본과 대조해 주세요.', questions: [], customerId: companyId,
        rows: [{ r: 0, d: 'included', x: '', l: [{ p: 4, n: '11', t: '병', b: { x: 0, y: 0, width: 1, height: 1 }, x: [] }] }], excludedRows: [] };
    const imageService = createOrderAiService({ store: actualStore, mailService: { source: async () => { throw new Error('manual image cannot use mail'); } }, env: { OPENAI_API_KEY: 'fictional-rule-test' },
        fetchImpl: async () => { imageProviderCalls++; return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(imageCandidate) }] }] })); } });
    const imageAnalysis = await imageService.analyze({ intakeId: imageId, sourceKind: 'image', expectedRevision: 0 }, actor);
    assert.equal(imageAnalysis.analysis.readyForReview, true); assert.equal(imageAnalysis.analysis.groups[0].quantity, '11'); assert.equal(imageAnalysis.analysis.sources[0].attachmentId, 'message-image');
    const imageReview = { intakeId: imageId, sourceKind: 'image', expectedRevision: 1, reviewedGroupIds: imageAnalysis.analysis.groups.map(group => group.id) };
    await assert.rejects(imageService.confirm({ ...imageReview, reviewedGroupIds: [] }, actor), { code: 'ai_confirmation_blocked' });
    const imageConfirmed = await imageService.confirm(imageReview, actor); assert.equal(imageConfirmed.analysis.status, 'confirmed'); assert.equal(imageProviderCalls, 1);
});
