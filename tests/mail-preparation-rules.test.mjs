import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const emulatorHost = process.env.MAIL_FIRESTORE_EMULATOR_HOST || process.env.ORDER_FIRESTORE_EMULATOR_HOST;
test('preparation rules require exact original/customer identity and versioned manual saves with no collector access', { skip: !emulatorHost }, async () => {
    assert.match(emulatorHost, /^(127\.0\.0\.1|localhost):[0-9]+$/);
    const project = 'demo-mail-preparation', documentName = `projects/${project}/databases/(default)/documents`, base = `http://${emulatorHost}/v1/${documentName}`;
    const loaded = await fetch(`http://${emulatorHost}/emulator/v1/projects/${project}:securityRules`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') }] } }) });
    assert.equal(loaded.status, 200, await loaded.text());
    const token = uid => {
        const now = Math.floor(Date.now() / 1000);
        return `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: `https://securetoken.google.com/${project}`, aud: project, sub: uid, user_id: uid, iat: now, exp: now + 3600, auth_time: now, firebase: { sign_in_provider: 'custom' } })).toString('base64url')}.`;
    };
    const headers = uid => ({ 'Content-Type': 'application/json', ...(uid ? { Authorization: `Bearer ${uid === 'owner' ? 'owner' : token(uid)}` } : {}) });
    const encode = item => item === null ? { nullValue: null } : item?.$timestamp ? { timestampValue: item.$timestamp }
        : Array.isArray(item) ? { arrayValue: { values: item.map(encode) } }
            : typeof item === 'object' ? { mapValue: { fields: fields(item) } }
                : typeof item === 'boolean' ? { booleanValue: item } : typeof item === 'number' ? { integerValue: String(item) } : { stringValue: item };
    const fields = record => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, encode(value)]));
    const decode = value => 'timestampValue' in value ? { $timestamp: value.timestampValue }
        : 'mapValue' in value ? Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, item]) => [key, decode(item)]))
            : value.stringValue ?? value.booleanValue ?? Number(value.integerValue);
    const put = (path, data, uid = 'owner') => fetch(`${base}/${path}`, { method: 'PATCH', headers: headers(uid), body: JSON.stringify({ fields: fields(data) }) });
    const get = (path, uid = 'manager') => fetch(`${base}/${path}`, { headers: headers(uid) });
    const remove = (path, uid) => fetch(`${base}/${path}`, { method: 'DELETE', headers: headers(uid) });
    const commit = async (path, record, uid = 'manager', previous = null, stampCreated = false, archiveOverride = null) => {
        const data = { ...record }; delete data.updatedAt; if (stampCreated) delete data.createdAt;
        const writes = [{ update: { name: `${documentName}/${path}`, fields: fields(data) }, updateTransforms: [
            ...(stampCreated ? [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }] : []), { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }] }];
        if (previous) writes.push({ update: { name: `${documentName}/${path}/versions/${previous.revision}`, fields: fields({ record: archiveOverride || previous, archivedByUid: uid }) },
            updateTransforms: [{ fieldPath: 'archivedAt', setToServerValue: 'REQUEST_TIME' }] });
        return fetch(`${base}:commit`, { method: 'POST', headers: headers(uid), body: JSON.stringify({ writes }) });
    };
    for (const [uid, role, approvalStatus, isActive] of [['manager', 'manager', 'approved', true], ['admin', 'admin', 'approved', true], ['worker', 'worker', 'approved', true], ['pending', 'manager', 'pending', true], ['inactive', 'manager', 'approved', false]]) {
        assert.equal((await put(`users/${uid}`, { role, approvalStatus, isActive })).status, 200);
    }
    await put('integrationAccess/naverworksMail', { enabled: true, collectorUid: 'collector' });
    const intakeId = 'a'.repeat(64), sourceHash = 'b'.repeat(64), attachmentSha256 = 'c'.repeat(64), attachmentId = '12';
    const path = `mailPreparations/${intakeId}/attachments/${attachmentId}`;
    await remove(`${path}/versions/1`, 'owner'); await remove(`${path}/versions/2`, 'owner'); await remove(path, 'owner');
    await put(`mailIntakes/${intakeId}`, { schemaVersion: 1, account: 'official@dmnfood.co.kr', rawStorage: { sha256: sourceHash }, processingStatus: 'pending_interpretation' });
    await put(`mailIntakes/${intakeId}/attachments/${attachmentId}`, { schemaVersion: 1, intakeId, attachmentId, sha256: attachmentSha256 });
    await put('erpCustomers/0007', { schemaVersion: 1, code: '0007', name: '가상 거래처', revision: 1 });
    const record = { schemaVersion: 1, intakeId, attachmentId, account: 'official@dmnfood.co.kr', sourceHash, attachmentSha256,
        customer: { id: '0007', code: '0007', name: '가상 거래처', revision: 1 },
        selection: { sheetIndex: 0, sheetName: '가상 발주서', range: 'A4:F6', startRow: 3, endRow: 5, startColumn: 0, endColumn: 5 },
        revision: 1, status: 'range_selected', createdByUid: 'manager', updatedByUid: 'manager' };
    for (const uid of ['', 'collector', 'worker', 'pending', 'inactive']) {
        assert.equal((await commit(path, { ...record, createdByUid: uid, updatedByUid: uid }, uid, null, true)).status, 403);
        assert.equal((await get(path, uid)).status, 403);
    }
    for (const changes of [{ sourceHash: 'd'.repeat(64) }, { attachmentSha256: 'd'.repeat(64) }, { account: 'other@example.invalid' },
        { customer: { ...record.customer, name: '변경된 거래처' } }, { customer: { ...record.customer, revision: 2 } }, { customer: { ...record.customer, code: '7' } },
        { selection: { ...record.selection, range: 'A4:F5' } }, { selection: { ...record.selection, sheetIndex: 32 } },
        { selection: { ...record.selection, endColumn: 1024 } }, { selection: { ...record.selection, endRow: 100000 } },
        { status: 'approved' }, { approvedRevision: 1 }, { revision: 2 }]) {
        assert.equal((await commit(path, { ...record, ...changes }, 'manager', null, true)).status, 403);
    }
    const created = await commit(path, record, 'manager', null, true); assert.equal(created.status, 200, await created.text());
    for (const uid of ['manager', 'admin']) assert.equal((await get(path, uid)).status, 200);
    const body = await (await get(path)).json(), previous = Object.fromEntries(Object.entries(body.fields).map(([key, value]) => [key, decode(value)]));
    const updated = { ...previous, selection: { ...previous.selection, range: 'A4:F10', endRow: 9 }, revision: 2 };
    assert.equal((await commit(path, updated)).status, 403, 'updates require exact previous record in the same commit');
    assert.equal((await commit(path, updated, 'manager', previous, false, { ...previous, status: 'approved' })).status, 403);
    const saved = await commit(path, updated, 'manager', previous); assert.equal(saved.status, 200, await saved.text());
    const archived = await get(`${path}/versions/1`); assert.equal(archived.status, 200);
    assert.deepEqual(decode((await archived.json()).fields.record), previous);
    for (const uid of ['manager', 'admin', 'collector']) {
        assert.equal((await remove(path, uid)).status, 403); assert.equal((await remove(`${path}/versions/1`, uid)).status, 403);
        assert.equal((await put(`${path}/versions/1`, { record: previous }, uid)).status, 403);
    }
    assert.equal((await get(`${path}/versions/1`, 'collector')).status, 403);
    const currentBody = await (await get(path)).json(), current = Object.fromEntries(Object.entries(currentBody.fields).map(([key, value]) => [key, decode(value)]));
    await put('erpCustomers/0007', { schemaVersion: 1, code: '0007', name: '가상 거래처 변경', revision: 2 });
    assert.equal((await commit(path, { ...current, revision: 3 }, 'manager', current)).status, 403, 'master changes invalidate stale customer selections');
    assert.equal((await commit(path, { ...current, revision: 3, sourceHash: 'd'.repeat(64) }, 'manager', current)).status, 403);
    assert.equal((await get(`mailIntakes/${intakeId}`)).status, 200);
    assert.equal((await get('erpCustomers/0007', 'collector')).status, 403);
});
