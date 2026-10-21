import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const emulatorHost = process.env.ORDER_FIRESTORE_EMULATOR_HOST || process.env.MAIL_FIRESTORE_EMULATOR_HOST;

test('customer master rules enforce staff roles, exact immutable code, revision and server audit fields', { skip: !emulatorHost }, async () => {
    assert.match(emulatorHost, /^(127\.0\.0\.1|localhost):[0-9]+$/);
    const project = 'demo-erp-customers', root = `projects/${project}/databases/(default)/documents`, base = `http://${emulatorHost}/v1/${root}`;
    const loaded = await fetch(`http://${emulatorHost}/emulator/v1/projects/${project}:securityRules`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') }] } }) });
    assert.equal(loaded.status, 200, await loaded.text());
    function value(input) {
        if (input?.timestampValue) return input;
        if (typeof input === 'boolean') return { booleanValue: input };
        if (typeof input === 'number') return { integerValue: String(input) };
        return { stringValue: input };
    }
    const fields = input => Object.fromEntries(Object.entries(input).map(([key, item]) => [key, value(item)]));
    const token = uid => { const now = Math.floor(Date.now() / 1000); return `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: `https://securetoken.google.com/${project}`, aud: project, sub: uid, user_id: uid, iat: now, exp: now + 3600, auth_time: now, firebase: { sign_in_provider: 'custom' } })).toString('base64url')}.`; };
    const headers = uid => ({ 'Content-Type': 'application/json', ...(uid ? { Authorization: `Bearer ${uid === 'owner' ? 'owner' : token(uid)}` } : {}) });
    const get = (code, uid) => fetch(`${base}/erpCustomers/${code}`, { headers: headers(uid) });
    async function commit(code, record, uid, transforms = ['createdAt', 'updatedAt']) {
        const data = { ...record }; for (const key of transforms) delete data[key];
        return fetch(`${base}:commit`, { method: 'POST', headers: headers(uid), body: JSON.stringify({ writes: [{ update: { name: `${root}/erpCustomers/${code}`, fields: fields(data) },
            updateTransforms: transforms.map(fieldPath => ({ fieldPath, setToServerValue: 'REQUEST_TIME' })) }] }) });
    }
    for (const [uid, role, approvalStatus, isActive] of [['manager', 'manager', 'approved', true], ['admin', 'admin', 'approved', true], ['worker', 'worker', 'approved', true], ['pending', 'manager', 'pending', true], ['inactive', 'manager', 'approved', false]]) {
        assert.equal((await fetch(`${base}/users/${uid}`, { method: 'PATCH', headers: headers('owner'), body: JSON.stringify({ fields: fields({ role, approvalStatus, isActive }) }) })).status, 200);
    }
    const suffix = String(Date.now()), code = `000${suffix}`;
    const record = { schemaVersion: 1, code, name: '가상 거래처', revision: 1, createdByUid: 'manager', createdByName: '담당자', updatedByUid: 'manager', updatedByName: '담당자' };
    for (const uid of ['', 'worker', 'pending', 'inactive', 'collector']) {
        const own = `${code}-${uid || 'anon'}`;
        assert.equal((await commit(own, { ...record, code: own, createdByUid: uid, updatedByUid: uid }, uid)).status, 403);
    }
    let created = await commit(code, record, 'manager'); assert.equal(created.status, 200, await created.text());
    for (const uid of ['manager', 'admin']) assert.equal((await get(code, uid)).status, 200);
    for (const uid of ['', 'worker', 'pending', 'inactive', 'collector']) assert.equal((await get(code, uid)).status, 403);
    const saved = (await (await get(code, 'manager')).json()).fields;
    const old = { ...record, createdAt: saved.createdAt, updatedAt: saved.updatedAt };
    for (const patch of [{ code: 'different' }, { revision: 1 }, { revision: 3 }, { createdByUid: 'admin' }, { status: 'approved' }, { updatedByUid: 'manager' }]) {
        const attempted = await commit(code, { ...old, name: '변경 거래처', revision: 2, updatedByUid: 'admin', ...patch }, 'admin', ['updatedAt']);
        assert.equal(attempted.status, 403, `must deny ${JSON.stringify(patch)}`);
    }
    const changed = await commit(code, { ...old, name: '변경 거래처', revision: 2, updatedByUid: 'admin', updatedByName: '관리자' }, 'admin', ['updatedAt']);
    assert.equal(changed.status, 200, await changed.text());
    assert.equal((await fetch(`${base}/erpCustomers/${code}`, { method: 'DELETE', headers: headers('admin') })).status, 403);
    for (const [i, patch] of [{ code: 'has space' }, { code: '__reserved__' }, { name: '  ' }, { code: 123 }].entries()) {
        const id = `${code}-bad${i}`;
        assert.equal((await commit(id, { ...record, code: id, ...patch }, 'manager')).status, 403);
    }
});
