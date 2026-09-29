import test from 'node:test';
import assert from 'node:assert/strict';
import authorize from '../lib/server/firebase-authorize.cjs';
import handler from '../api/ecount/login.js';

const now = Math.floor(Date.now() / 1000);
function request(overrides = {}) {
    const claims = { sub: 'test-user', aud: 'dmnfood-haccp', iss: 'https://securetoken.google.com/dmnfood-haccp', exp: now + 3600, auth_time: now - 60, ...overrides };
    const token = `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
    return { method: 'POST', headers: { authorization: `Bearer ${token}` } };
}
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const profile = (role = 'manager', approvalStatus = 'approved', active = true) => ({ fields: {
    role: { stringValue: role }, ...(approvalStatus == null ? {} : { approvalStatus: { stringValue: approvalStatus } }), isActive: { booleanValue: active },
} });
function mockFirebase(t, data = profile(), account = {}) {
    return t.mock.method(globalThis, 'fetch', async url => url.includes('accounts:lookup')
        ? response({ users: [{ localId: 'test-user', ...account }] }) : response(data));
}

test('unauthenticated API request stops before Firebase or Ecount calls', async t => {
    const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
    let payload;
    const res = { setHeader() {}, end(body) { payload = JSON.parse(body); } };
    await handler({ method: 'POST', headers: {} }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(payload.ok, false);
    assert.equal(fetch.mock.callCount(), 0);
});

test('Firebase must validate the token before its claims or profile are trusted', async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => response({}, 400));
    await assert.rejects(authorize(request()), { status: 401 });
    assert.equal(fetch.mock.callCount(), 1);
});

test('rejects wrong project, expired, old, revoked and disabled logins', async t => {
    mockFirebase(t);
    for (const claims of [{ aud: 'other-project' }, { exp: now - 1 }, { auth_time: now - 8 * 86400 }, { auth_time: now + 600 }, { sub: 'different-user' }]) {
        await assert.rejects(authorize(request(claims)), { status: 401 });
    }
});

test('revoked or disabled Firebase accounts are blocked', async t => {
    const fetch = mockFirebase(t, profile(), { validSince: String(now) });
    await assert.rejects(authorize(request()), { status: 401 });
    fetch.mock.mockImplementation(async () => response({ users: [{ localId: 'test-user', disabled: true }] }));
    await assert.rejects(authorize(request()), { status: 401 });
});

test('only active approved managers/admins can reach Ecount, including legacy admin', async t => {
    const fetch = mockFirebase(t);
    for (const data of [profile('worker'), profile('manager', 'pending'), profile('admin', 'rejected'), profile('admin', 'approved', false)]) {
        fetch.mock.mockImplementation(async url => url.includes('accounts:lookup') ? response({ users: [{ localId: 'test-user' }] }) : response(data));
        await assert.rejects(authorize(request()), { status: 403 });
    }
    fetch.mock.mockImplementation(async url => url.includes('accounts:lookup') ? response({ users: [{ localId: 'test-user' }] }) : response(profile('admin', null)));
    assert.deepEqual(await authorize(request()), { uid: 'test-user', role: 'admin' });
});

test('verification outage fails closed with 503 and no Ecount call', async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Offline'); });
    const res = { setHeader() {}, end() {} };
    await handler(request(), res);
    assert.equal(res.statusCode, 503);
    assert.equal(fetch.mock.callCount(), 1);
});

test('approved administrator reaches Ecount without returning its session secret', async t => {
    const envKeys = ['ECOUNT_COM_CODE', 'ECOUNT_USER_ID', 'ECOUNT_API_CERT_KEY', 'ECOUNT_ZONE', 'ECOUNT_ENV'];
    const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    t.after(() => { for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
    for (const key of envKeys) process.env[key] = 'test';
    let ecountCalls = 0, payload;
    t.mock.method(globalThis, 'fetch', async url => {
        if (url.includes('accounts:lookup')) return response({ users: [{ localId: 'test-user' }] });
        if (url.includes('firestore.googleapis.com')) return response(profile('admin'));
        ecountCalls++;
        return { ok: true, status: 200, text: async () => JSON.stringify({ Data: { SESSION_ID: 'server-only-secret' } }) };
    });
    const res = { setHeader() {}, end(body) { payload = body; } };
    await handler(request(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(ecountCalls, 1);
    assert.equal(JSON.parse(payload).hasSession, true);
    assert.equal(payload.includes('server-only-secret'), false);
});
