import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOrderAiStore } from '../lib/server/order-ai-store.cjs';
import { createOrderAiService } from '../lib/server/order-ai-service.cjs';
import { createHash } from 'node:crypto';
const host = process.env.MAIL_FIRESTORE_EMULATOR_HOST || process.env.ORDER_FIRESTORE_EMULATOR_HOST;
test('AI rules bind source, actor and exact immutable review version; collector never gains analysis access', { skip: !host }, async () => {
    assert.match(host, /^(127\.0\.0\.1|localhost):\d+$/);
    const project = 'demo-order-ai', documentName = `projects/${project}/databases/(default)/documents`, base = `http://${host}/v1/${documentName}`;
    const loaded = await fetch(`http://${host}/emulator/v1/projects/${project}:securityRules`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') }] } }) });
    assert.equal(loaded.status, 200, await loaded.text());
    const token = uid => { const now = Math.floor(Date.now() / 1000); return `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: `https://securetoken.google.com/${project}`, aud: project, sub: uid, user_id: uid, iat: now, exp: now + 3600, auth_time: now, firebase: { sign_in_provider: 'custom' } })).toString('base64url')}.`; };
    const headers = uid => ({ 'Content-Type': 'application/json', ...(uid ? { Authorization: `Bearer ${uid === 'owner' ? 'owner' : token(uid)}` } : {}) });
    const encode = value => value === null ? { nullValue: null } : value?.$timestamp ? { timestampValue: value.$timestamp } : Array.isArray(value) ? { arrayValue: { values: value.map(encode) } } : typeof value === 'object' ? { mapValue: { fields: fields(value) } } : typeof value === 'number' ? { integerValue: String(value) } : typeof value === 'boolean' ? { booleanValue: value } : { stringValue: value };
    const fields = value => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
    const decode = value => 'nullValue' in value ? null : 'timestampValue' in value ? { $timestamp: value.timestampValue } : 'mapValue' in value ? Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, item]) => [key, decode(item)])) : 'arrayValue' in value ? (value.arrayValue.values || []).map(decode) : value.stringValue ?? value.booleanValue ?? Number(value.integerValue);
    const put = (path, data, uid = 'owner') => fetch(`${base}/${path}`, { method: 'PATCH', headers: headers(uid), body: JSON.stringify({ fields: fields(data) }) });
    const get = (path, uid = 'manager') => fetch(`${base}/${path}`, { headers: headers(uid) });
    const remove = (path, uid = 'owner') => fetch(`${base}/${path}`, { method: 'DELETE', headers: headers(uid) });
    const commit = (path, record, uid = 'manager', previous = null, archiveOverride = null) => {
        const data = { ...record }; delete data.updatedAt; if (!previous) delete data.createdAt; if (data.status === 'confirmed') delete data.confirmedAt;
        const writes = [{ update: { name: `${documentName}/${path}`, fields: fields(data) }, updateTransforms: [
            ...(!previous ? [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }] : []), { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }, ...(record.status === 'confirmed' ? [{ fieldPath: 'confirmedAt', setToServerValue: 'REQUEST_TIME' }] : [])] }];
        if (previous) writes.push({ update: { name: `${documentName}/${path}/versions/${previous.revision}`, fields: fields({ record: archiveOverride || previous, archivedByUid: uid }) }, updateTransforms: [{ fieldPath: 'archivedAt', setToServerValue: 'REQUEST_TIME' }] });
        return fetch(`${base}:commit`, { method: 'POST', headers: headers(uid), body: JSON.stringify({ writes }) });
    };
    for (const [uid, role, approvalStatus, isActive] of [['manager', 'manager', 'approved', true], ['admin', 'admin', 'approved', true], ['worker', 'worker', 'approved', true], ['pending', 'manager', 'pending', true], ['inactive', 'manager', 'approved', false]]) await put(`users/${uid}`, { role, approvalStatus, isActive });
    await put('integrationAccess/naverworksMail', { collectorUid: 'collector', enabled: true });
    const intakeId = 'a'.repeat(64), sourceHash = 'b'.repeat(64), path = `orderAiAnalyses/${intakeId}`;
    await remove(path); for (const revision of [1, 2, 3]) await remove(`${path}/versions/${revision}`); await remove(`orderAiLocks/${intakeId}`);
    await put(`mailIntakes/${intakeId}`, { account: 'official@dmnfood.co.kr', rawStorage: { sha256: sourceHash } });
    await put('erpCustomers/0007', { code: '0007', name: '가상 거래처', revision: 1 });
    const record = { schemaVersion: 1, intakeId, sourceHash, revision: 1, status: 'needs_review',
        analysis: { schemaVersion: 1, id: intakeId, intakeId, sourceHash, revision: 1, status: 'needs_review', canConfirm: false, readyForReview: true, blockers: [], exclusions: [{ reason: '헤더' }], groups: [{ id: 'group-test' }], customer: { code: '0007', name: '가상 거래처', revision: 1 } },
        modelOutput: {}, groupIds: ['group-test'], conversation: [{ role: 'user', content: '시작' }, { role: 'assistant', content: '대조해 주세요.' }], createdByUid: 'manager', updatedByUid: 'manager', reviewedGroupIds: [], reviewedExclusions: false, confirmedRevision: null, confirmedAt: null, confirmedByUid: null };
    for (const uid of ['', 'collector', 'worker', 'pending', 'inactive']) { assert.equal((await commit(path, { ...record, createdByUid: uid, updatedByUid: uid }, uid)).status, 403); assert.equal((await get(path, uid)).status, 403); }
    for (const change of [{ sourceHash: 'd'.repeat(64) }, { revision: 2 }, { status: 'confirmed' }, { analysis: { ...record.analysis, canConfirm: true } }, { updatedByUid: 'admin' }]) assert.equal((await commit(path, { ...record, ...change })).status, 403);
    const created = await commit(path, record); assert.equal(created.status, 200, await created.text());
    const decodeRecord = async () => { const result = await (await get(path)).json(); return Object.fromEntries(Object.entries(result.fields).map(([key, value]) => [key, decode(value)])); };
    const previous = await decodeRecord();
    const draft = { ...previous, revision: 2, analysis: { ...previous.analysis, revision: 2 } };
    assert.equal((await commit(path, draft, 'manager', previous, { ...previous, revision: 99 })).status, 403, 'history must exactly preserve old record');
    assert.equal((await commit(path, draft, 'manager', previous)).status, 200);
    const current = await decodeRecord(), confirmed = { ...current, status: 'confirmed', revision: 3, reviewedGroupIds: ['group-test'], reviewedExclusions: true, confirmedRevision: 2, confirmedByUid: 'manager' };
    for (const change of [{ reviewedGroupIds: [] }, { reviewedExclusions: false }, { confirmedRevision: 1 }, { confirmedByUid: 'admin' }, { analysis: { ...current.analysis, groups: [{ id: 'forged' }] } }]) assert.equal((await commit(path, { ...confirmed, ...change }, 'manager', current)).status, 403);
    await put('erpCustomers/0007', { code: '0007', name: '변경된 거래처', revision: 2 }); assert.equal((await commit(path, confirmed, 'manager', current)).status, 403);
    await put('erpCustomers/0007', { code: '0007', name: '가상 거래처', revision: 1 });
    const final = await commit(path, confirmed, 'manager', current); assert.equal(final.status, 200, await final.text());
    const immutable = await decodeRecord(); assert.equal((await commit(path, { ...immutable, revision: 4 }, 'manager', immutable)).status, 403);
    assert.equal((await remove(path, 'manager')).status, 403); assert.equal((await remove(`${path}/versions/2`, 'admin')).status, 403); assert.equal((await get(`${path}/versions/2`, 'collector')).status, 403);
    const lock = { intakeId, owner: 'test-lock', uid: 'manager', expiresAt: Date.now() + 180000 };
    assert.equal((await put(`orderAiLocks/${intakeId}`, lock, 'manager')).status, 200);
    assert.equal((await put(`orderAiLocks/${intakeId}`, { ...lock, owner: 'stolen', uid: 'admin' }, 'admin')).status, 403);
    assert.equal((await remove(`orderAiLocks/${intakeId}`, 'collector')).status, 403); assert.equal((await remove(`orderAiLocks/${intakeId}`, 'admin')).status, 403);
    assert.equal((await remove(`orderAiLocks/${intakeId}`, 'manager')).status, 200);

    const companyName = '가상 거래처', companyId = `school-${createHash('sha256').update(companyName).digest('hex').slice(0, 24)}`;
    const catalogPath = 'settings/schoolMealCompanies'; await remove(catalogPath);
    const saveCatalog = (revision, uid = 'manager', companies = [{ id: companyId, name: companyName }]) => fetch(`${base}:commit`, { method: 'POST', headers: headers(uid), body: JSON.stringify({ writes: [{ update: { name: `${documentName}/${catalogPath}`, fields: fields({ schemaVersion: 1, revision, companies, updatedByUid: uid }) }, updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }] }] }) });
    for (const uid of ['', 'collector', 'pending', 'inactive']) {
        assert.equal((await get(catalogPath, uid)).status, 403); assert.equal((await saveCatalog(1, uid)).status, 403);
    }
    assert.equal((await saveCatalog(1, 'worker')).status, 403);
    const initialized = await saveCatalog(1); assert.equal(initialized.status, 200, await initialized.text());
    assert.equal((await get(catalogPath, 'worker')).status, 200, 'approved staff can read the weekly roster without permission to change it');
    assert.equal((await saveCatalog(1)).status, 403); assert.equal((await saveCatalog(3)).status, 403);
    assert.equal((await saveCatalog(2, 'admin', Array.from({ length: 201 }, () => ({ id: companyId, name: companyName })))).status, 403);
    assert.equal((await remove(catalogPath, 'admin')).status, 403);

    // Exercise the actual REST adapter and service together, including timestamp
    // transforms and a version archive; no provider or production service is used.
    const liveId = 'd'.repeat(64), livePath = `orderAiAnalyses/${liveId}`;
    await remove(livePath); await remove(`${livePath}/versions/1`); await remove(`orderAiLocks/${liveId}`);
    await put(`mailIntakes/${liveId}`, { account: 'official@dmnfood.co.kr', rawStorage: { sha256: sourceHash } });
    const sources = [{ attachmentId: '12', sha256: 'c'.repeat(64), kind: 'workbook', complete: true,
        sheets: [{ sheetIndex: 0, sheetName: '가상', rows: [{ rowIndex: 0, cells: [{ columnIndex: 0, value: '국산 참기름 1L' }, { columnIndex: 1, value: 2 }, { columnIndex: 2, value: '병' }] }] }] }];
    const candidate = { assistantMessage: '원본과 대조해 주세요.', questions: [], customerId: companyId,
        lines: [{ id: 'line-1', productId: 'oil-kr-1l', unit: '병', imageQuantity: null, issues: [], source: { attachmentId: '12', sheetIndex: 0, rowIndex: 0, productCells: ['A1'], quantityCell: 'B1', unitCell: 'C1', bbox: null } }],
        coverage: [{ attachmentId: '12', sheetIndex: 0, rowIndex: 0, disposition: 'included', lineIds: ['line-1'], reason: '' }] };
    let charges = 0;
    const actualStore = createOrderAiStore({ token: token('manager'), documentName, documentRoot: base });
    const actualService = createOrderAiService({ store: actualStore, env: { OPENAI_API_KEY: 'fake-test-only' },
        mailService: { source: async () => ({ mail: { id: liveId, subject: '가상 발주', rawStorage: { sha256: sourceHash } } }) }, extract: async () => ({ sources, images: [] }),
        fetchImpl: async () => { charges++; return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(candidate) }] }] })); } });
    const analyzed = await actualService.analyze({ intakeId: liveId, expectedRevision: 0 }, { uid: 'manager', role: 'manager' });
    assert.equal(analyzed.analysis.groups[0].quantity, '2'); assert.equal(typeof analyzed.analysis.updatedAt, 'string');
    assert.deepEqual(analyzed.analysis.customer, { id: companyId, name: companyName, revision: 1, source: 'school_meal', erpCode: null });
    assert.equal((await saveCatalog(2)).status, 200);
    await assert.rejects(actualService.confirm({ intakeId: liveId, expectedRevision: 1, reviewedGroupIds: analyzed.analysis.groups.map(group => group.id) }, { uid: 'manager', role: 'manager' }), { code: 'ai_confirmation_blocked' });
    await put(catalogPath, { schemaVersion: 1, revision: 1, companies: [{ id: companyId, name: companyName }], updatedByUid: 'owner', updatedAt: { $timestamp: new Date().toISOString() } });
    const completed = await actualService.confirm({ intakeId: liveId, expectedRevision: 1, expectedUpdatedAt: analyzed.analysis.updatedAt, reviewedGroupIds: analyzed.analysis.groups.map(group => group.id) }, { uid: 'manager', role: 'manager' });
    assert.equal(completed.analysis.status, 'confirmed'); assert.equal(completed.analysis.revision, 2); assert.equal(charges, 1);
    const actualArchive = await (await get(`${livePath}/versions/1`)).json();
    assert.equal(actualArchive.fields.record.mapValue.fields.status.stringValue, 'needs_review');
    assert.ok(actualArchive.fields.record.mapValue.fields.createdAt.timestampValue, 'history retains Firestore timestamp type');
});
