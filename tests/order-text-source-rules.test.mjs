import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createOrderTextSourceStore } from '../lib/server/order-text-source-store.cjs';
import { buildTextSource, SOURCE_RETENTION_MS } from '../lib/server/order-text-source.cjs';
import { createHandler } from '../lib/server/order-text-source-service.cjs';
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
    const timestampFields = data => Object.fromEntries(Object.entries(encodeFields(data)).map(([key, value]) => [key, ['createdAt', 'expiresAt'].includes(key) && typeof data[key] === 'string' && Number.isFinite(Date.parse(data[key])) ? { timestampValue: data[key] } : value]));
    const dated = (data, now = Date.now()) => ({ createdAt: new Date(now).toISOString(), expiresAt: new Date(now + SOURCE_RETENTION_MS).toISOString(), ...data });
    const put = (path, data, uid = 'owner') => fetch(`${base}/${path}`, { method: 'PATCH', headers: headers(uid), body: JSON.stringify({ fields: timestampFields(data) }) });
    const remove = (path, uid = 'owner') => fetch(`${base}/${path}`, { method: 'DELETE', headers: headers(uid) });
    const get = (path, uid = 'manager') => fetch(`${base}/${path}`, { headers: headers(uid) });
    const metadataFor = data => Object.fromEntries(['schemaVersion', 'createdAt', 'expiresAt', 'sha256', 'createdByUid'].map(key => [key, data[key]]));
    const create = (id, data, uid, options = {}) => {
        const source = dated(data), metadata = { ...metadataFor(source), ...options.metadataPatch };
        const writes = [!options.metadataOnly && { update: { name: `${documentName}/orderTextSources/${id}`, fields: timestampFields(source) }, currentDocument: { exists: false } },
            !options.sourceOnly && { update: { name: `${documentName}/orderSourceExpirations/${options.metadataId || id}`, fields: timestampFields(metadata) }, currentDocument: { exists: false } }].filter(Boolean);
        return fetch(`${base}:commit`, { method: 'POST', headers: headers(uid), body: JSON.stringify({ writes }) });
    };
    const pairedDelete = (id, uid) => fetch(`${base}:commit`, { method: 'POST', headers: headers(uid), body: JSON.stringify({ writes: ['orderTextSources', 'orderSourceExpirations'].map(collection => ({ delete: `${documentName}/${collection}/${id}`, currentDocument: { exists: true } })) }) });
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
    assert.equal((await create(id, { ...built.data, createdAt: 'client-clock' }, 'manager')).status, 403);
    for (const offset of [-90000, 90000]) assert.equal((await create(id, dated(built.data, Date.now() + offset), 'manager')).status, 403, 'createdAt outside the server clock tolerance is rejected');
    for (const offset of [-30000, 30000]) {
        const allowed = await create(id, dated(built.data, Date.now() + offset), 'manager'); assert.equal(allowed.status, 200, await allowed.text()); await remove(path); await remove(`orderSourceExpirations/${id}`);
    }
    for (const options of [{ sourceOnly: true }, { metadataOnly: true }, { metadataPatch: { sha256: 'a'.repeat(64) } }, { metadataPatch: { title: 'must not be copied' } }, { metadataId: 'e'.repeat(64) }]) assert.equal((await create(id, built.data, 'manager', options)).status, 403, 'paired originals and metadata must be created atomically with matching identity');
    assert.equal((await create(id, { ...built.data, expiresAt: new Date(Date.now() + SOURCE_RETENTION_MS + 1000).toISOString() }, 'manager')).status, 403, 'retention cannot be extended');
    assert.equal((await create(id, { ...built.data, expiresAt: undefined }, 'manager')).status, 403, 'retention is mandatory');
    await put(`mailIntakes/${id}`, { account: 'official@dmnfood.co.kr', rawStorage: { sha256: built.data.sha256 } });
    assert.equal((await create(id, built.data, 'manager')).status, 403, 'a text intake cannot shadow an existing mail intake ID'); await remove(`mailIntakes/${id}`);
    const textStore = createOrderTextSourceStore({ token: token('manager'), documentName, documentRoot: base });
    const first = await textStore.create(input, 'manager'); assert.equal(first.created, true); assert.equal(first.source.text, input.text); assert.equal(typeof first.source.createdAt, 'string');
    assert.equal(Date.parse(first.source.expiresAt) - Date.parse(first.source.createdAt), SOURCE_RETENTION_MS);
    const originalMetadata = await (await get(`orderSourceExpirations/${id}`)).json();
    assert.deepEqual(Object.keys(originalMetadata.fields).sort(), ['schemaVersion', 'createdAt', 'expiresAt', 'sha256', 'createdByUid'].sort());
    for (const uid of ['worker', 'collector', 'pending', 'inactive']) assert.equal((await get(`orderSourceExpirations/${id}`, uid)).status, 403);
    assert.equal((await put(`orderSourceExpirations/${id}`, metadataFor(first.source), 'manager')).status, 403, 'metadata cannot be updated');
    assert.equal((await remove(`orderSourceExpirations/${id}`, 'manager')).status, 403, 'early metadata deletion is forbidden');
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

    // Simulate originals that have reached 30 days while physical deletion has
    // not happened. Manager reads and AI writes must fail before cleanup runs.
    const expiringInput = { ...input, requestId: '83c16afd-4197-42b0-8321-7c07f75b5f1c' };
    const expiring = await textStore.create(expiringInput, 'manager'), expiringId = expiring.source.id, expiringPath = `orderTextSources/${expiringId}`;
    const pending = await service.analyze({ intakeId: expiringId, sourceKind: 'text', expectedRevision: 0 }, actor);
    const pendingReview = { intakeId: expiringId, sourceKind: 'text', expectedRevision: 1, reviewedGroupIds: pending.analysis.groups.map(group => group.id), reviewedExclusions: true };
    const old = await actualStore.get(expiringId), expiredAt = Date.now() - 2000;
    const { id: ignored, ...expiringRecord } = expiring.source;
    const expiredRecord = { ...expiringRecord, createdAt: new Date(expiredAt - SOURCE_RETENTION_MS).toISOString(), expiresAt: new Date(expiredAt).toISOString() };
    await put(expiringPath, expiredRecord); await put(`orderSourceExpirations/${expiringId}`, metadataFor(expiredRecord));
    assert.equal((await get(expiringPath, 'owner')).status, 200, 'the expired bytes still physically exist until cleanup');
    for (const uid of ['manager', 'admin', 'worker', 'collector']) assert.equal((await get(expiringPath, uid)).status, 403);
    await assert.rejects(textStore.get(expiringId), { status: 403, code: 'text_source_store_unavailable' });
    await assert.rejects(service.analyze({ intakeId: expiringId, sourceKind: 'text', expectedRevision: 1 }, actor), { status: 403, code: 'text_source_unavailable' });
    await assert.rejects(service.confirm(pendingReview, actor), { status: 403, code: 'text_source_unavailable' });
    const confirmData = { ...old.data, revision: 2, status: 'confirmed', updatedByUid: 'manager', reviewedGroupIds: [...old.data.groupIds], reviewedExclusions: true, confirmedRevision: 1, confirmedByUid: 'manager', confirmedAt: null };
    await assert.rejects(actualStore.save(expiringId, confirmData, old), { status: 403, code: 'ai_store_unavailable' }, 'direct writes cannot confirm against expired originals');
    const draftData = { ...old.data, revision: 2, analysis: { ...old.data.analysis, revision: 2 } };
    await assert.rejects(actualStore.save(expiringId, draftData, old), { status: 403, code: 'ai_store_unavailable' }, 'rules recheck expiry after a context-read/save race');
    const missingId = 'f'.repeat(64);
    assert.equal((await get(`orderTextSources/${missingId}`)).status, 404, 'new create can pre-read a missing ID');
    const sourceHandler = createHandler({ authorize: async () => actor, store: textStore });
    async function invoke(request) { let body; const response = { setHeader() {}, end(value) { body = JSON.parse(value); } }; await sourceHandler(request, response); return { status: response.statusCode, body }; }
    const apiGet = await invoke({ method: 'GET', url: `/api/order-ai/text-sources?id=${expiringId}`, headers: { authorization: 'Bearer fictional' } });
    assert.equal(apiGet.status, 403); assert.match(apiGet.body.message, /보관 기간.*열람 권한/); assert.equal('source' in apiGet.body, false);
    assert.equal((await service.read(expiringId)).analysis.revision, 1, 'business history remains readable after original expiry');
    const activeList = await textStore.list(); assert.equal(activeList.length, 2); assert.ok(activeList.every(item => item.id !== expiringId));
    for (const uid of ['worker', 'collector']) assert.equal((await remove(expiringPath, uid)).status, 403);
    for (const uid of ['manager', 'admin']) assert.equal((await remove(path, uid)).status, 403, 'unexpired original cannot be deleted');
    const directList = (limit, collectionId = 'orderTextSources', filter = false, uid = 'manager') => fetch(`${base}:runQuery`, { method: 'POST', headers: headers(uid), body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId }], ...(limit == null ? {} : { limit }),
        ...(filter ? { where: { fieldFilter: { field: { fieldPath: 'expiresAt' }, op: 'LESS_THAN_OR_EQUAL', value: { timestampValue: new Date().toISOString() } } } } : {}),
    } }) });
    for (const limit of [null, 51]) assert.equal((await directList(limit)).status, 403, 'cleanup queries are bounded by rules');
    assert.equal((await directList(50)).status, 403, 'unfiltered raw queries cannot bypass the original retention limit');
    assert.equal((await directList(8, 'orderTextSources', true)).status, 403, 'expired raw queries remain forbidden');
    const expiredMetadata = await directList(8, 'orderSourceExpirations', true); assert.equal(expiredMetadata.status, 200);
    const metadataResults = await expiredMetadata.json(); assert.equal(metadataResults.filter(item => item.document).length, 1);
    assert.ok(metadataResults.filter(item => item.document).every(item => !Object.hasOwn(item.document.fields, 'text') && !Object.hasOwn(item.document.fields, 'contentBase64')));
    assert.equal((await directList(9, 'orderSourceExpirations', true)).status, 403);
    for (const uid of ['worker', 'collector']) assert.equal((await directList(8, 'orderSourceExpirations', true, uid)).status, 403);
    assert.equal((await remove(expiringPath, 'manager')).status, 403, 'an expired original cannot leave its metadata behind');
    assert.equal((await remove(`orderSourceExpirations/${expiringId}`, 'manager')).status, 403, 'metadata cannot be removed while its original exists');
    const cleanup = await invoke({ method: 'POST', url: '/api/order-ai/text-sources', headers: { authorization: 'Bearer fictional', origin: 'https://dashboard.dmnfood.co.kr', 'content-type': 'application/json' }, body: { action: 'cleanupExpired' } });
    assert.equal(cleanup.status, 200); assert.equal(cleanup.body.deletedCount, 1);
    assert.equal((await get(expiringPath, 'owner')).status, 404); assert.equal((await get(path)).status, 200); assert.equal((await get(imagePath)).status, 200);
    assert.equal((await get(`orderSourceExpirations/${expiringId}`, 'owner')).status, 404);
    assert.equal((await get(`orderAiAnalyses/${expiringId}`)).status, 200, 'cleanup never deletes business records');
    assert.equal((await textStore.cleanupExpired()).deletedCount, 0);
    const expiredImageRecord = { ...imageSaved.source, createdAt: new Date(expiredAt - SOURCE_RETENTION_MS).toISOString(), expiresAt: new Date(expiredAt).toISOString() };
    delete expiredImageRecord.id;
    await put(imagePath, expiredImageRecord); await put(`orderSourceExpirations/${imageId}`, metadataFor(expiredImageRecord));
    assert.equal((await get(imagePath)).status, 403); assert.equal((await remove(imagePath, 'admin')).status, 403);
    assert.equal((await pairedDelete(imageId, 'admin')).status, 200, 'admin can delete expired originals and metadata together');
    assert.equal((await get(`orderAiAnalyses/${imageId}`)).status, 200, 'image business records remain intact');

    // Eight paired deletes fit the security-rules document-access budget.
    for (let index = 1; index <= 8; index++) {
        const saved = await textStore.create({ ...input, requestId: `83c16afd-4197-42b0-8321-7c07f75b5f2${index}` }, 'manager');
        const { id: savedId, ...data } = saved.source, expired = { ...data, createdAt: expiredRecord.createdAt, expiresAt: expiredRecord.expiresAt };
        await put(`orderTextSources/${savedId}`, expired); await put(`orderSourceExpirations/${savedId}`, metadataFor(expired));
    }
    assert.equal((await textStore.cleanupExpired()).deletedCount, 8);
    assert.equal((await textStore.cleanupExpired()).deletedCount, 0);

    // The metadata version guards the raw delete even though expired originals
    // cannot be read to obtain their own updateTime.
    const racing = await textStore.create({ ...input, requestId: '83c16afd-4197-42b0-8321-7c07f75b5f3a' }, 'manager');
    const { id: racingId, ...racingData } = racing.source, racingExpired = { ...racingData, createdAt: expiredRecord.createdAt, expiresAt: expiredRecord.expiresAt };
    await put(`orderTextSources/${racingId}`, racingExpired); await put(`orderSourceExpirations/${racingId}`, metadataFor(racingExpired));
    let interrupted = false;
    const racingStore = createOrderTextSourceStore({ token: token('manager'), documentName, documentRoot: base, fetchImpl: async (url, options) => {
        if (String(url).endsWith(':commit') && !interrupted) { interrupted = true; await put(`orderSourceExpirations/${racingId}`, { ...metadataFor(racingExpired), createdAt: new Date(Date.parse(racingExpired.createdAt) - 1).toISOString(), expiresAt: new Date(Date.parse(racingExpired.expiresAt) - 1).toISOString() }); }
        return fetch(url, options);
    } });
    await assert.rejects(racingStore.cleanupExpired(), { status: 409, code: 'text_source_conflict' });
    assert.equal((await get(`orderTextSources/${racingId}`, 'owner')).status, 200, 'a stale metadata version aborts the whole paired delete');
    assert.equal((await get(`orderSourceExpirations/${racingId}`, 'owner')).status, 200);
    assert.equal((await textStore.cleanupExpired()).deletedCount, 1);
});
