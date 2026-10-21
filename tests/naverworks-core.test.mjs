import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createMailService, encryptionKey, sealTokens, openTokens, MAX_DETAILS, MAX_PAGES } from '../lib/server/naverworks-core.cjs';
import { createHandler } from '../lib/server/naverworks-handlers.cjs';

const NOW = Date.parse('2026-10-21T09:00:00+09:00');
const env = { NAVERWORKS_CLIENT_SECRET: 'test-client-secret', MAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), MAIL_COLLECTOR_EMAIL: 'test@example.invalid', MAIL_COLLECTOR_PASSWORD: 'test-password' };
const authorization = `Bearer ${'x'.repeat(80)}`;
const tokenContext = 'naverworks:kaXX9XpQRZ7ohuKFW1TU:official@dmnfood.co.kr';
const json = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const tokenReply = { access_token: 'test-access-token', refresh_token: 'test-refresh-token', expires_in: 3600, token_type: 'Bearer', scope: 'mail.read' };
const folderReply = { mailFolders: [{ folderId: 0, folderName: '받은메일함', folderType: 'S', mailCount: 20 }] };

function memoryStore() {
    let connection = null, revision = 0, syncState = null;
    const states = new Map(), intakes = new Map();
    return {
        states, intakes, calls: [],
        isConfigured: () => true,
        getConnection: async () => connection,
        saveConnection: async (data, { expectedVersion = null } = {}) => {
            if (expectedVersion !== (connection?.version || null)) throw Object.assign(new Error('conflict'), { status: 409 });
            connection = { data, version: String(++revision) }; return connection;
        },
        createOAuthState: async (hash, data) => { states.set(hash, data); },
        consumeOAuthState: async (hash, cookieHash, now) => {
            const value = states.get(hash);
            if (!value || value.cookieHash !== cookieHash || value.expiresAt <= now) return null;
            states.delete(hash); return value;
        },
        withLease: async (name, fn) => fn({ name, expiresAt: NOW + 180000 }),
        createIntake: async data => {
            const id = `${data.account}:${data.mailId}`;
            if (intakes.has(id)) return { id, created: false };
            intakes.set(id, data); return { id, created: true };
        },
        getSyncState: async () => syncState,
        saveSyncRun: async data => { syncState = { data }; },
    };
}
function setup(options = {}) {
    const store = options.store || memoryStore(), calls = [];
    const fetchImpl = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        if (options.fetchImpl) return options.fetchImpl(String(url), init);
        if (url.includes('/token')) return json(tokenReply);
        if (url.endsWith('/mailfolders')) return json(folderReply);
        throw new Error(`Unexpected fake request: ${url}`);
    };
    const service = createMailService({ store, env, now: () => NOW, fetchImpl, authorizeCallback: async () => ({ uid: 'administrator', role: 'admin' }), ...options });
    return { service, store, calls };
}
async function connect(service) {
    const start = await service.start('administrator', authorization);
    const state = new URL(start.authorizationUrl).searchParams.get('state');
    const cookie = start.cookie.split(';')[0].split('=')[1];
    await service.callback({ state, cookie, code: 'test-code' });
    return { state, cookie, start };
}
async function seed(store, overrides = {}) {
    const tokens = { access_token: 'old-access', refresh_token: 'old-refresh', scope: 'mail.read', expiresAt: NOW + 3600000, ...overrides };
    await store.saveConnection({ mailbox: 'official@dmnfood.co.kr', encryptedTokens: sealTokens(tokens, encryptionKey(env.MAIL_TOKEN_ENCRYPTION_KEY), tokenContext), expiresAt: tokens.expiresAt, accessStatus: 'mailbox_access_verified', connectedAt: new Date(NOW).toISOString() });
}
function summary(mailId, receivedTime = new Date(NOW - 3600000).toISOString()) { return { mailId, receivedTime, subject: '발주', status: mailId % 2 ? 'Read' : 'Unread' }; }
function raw(mailId, changes = {}) {
    return { mail: { ...summary(mailId), body: '<script>untrusted()</script>\n원문 상품명 A 10박스', from: { name: '거래처', email: 'customer@example.invalid' }, ...changes }, attachments: [{ attachmentId: 1, filename: '발주.xlsx', contentType: 'application/xlsx', size: 123 }, { attachmentId: -2, filename: 'inline.png', data: 'AA==', cid: 'image' }] };
}

test('AES GCM token envelope rejects alteration, wrong context and invalid key', () => {
    const key = encryptionKey(env.MAIL_TOKEN_ENCRYPTION_KEY), plain = { access_token: 'secret-token' };
    const sealed = sealTokens(plain, key, 'account-one');
    assert.equal(sealed.includes('secret-token'), false);
    assert.deepEqual(openTokens(sealed, key, 'account-one'), plain);
    assert.throws(() => openTokens(sealed, key, 'account-two'), { code: 'mail_connection_unavailable' });
    const parsed = JSON.parse(sealed); parsed.ciphertext = Buffer.alloc(32).toString('base64');
    assert.throws(() => openTokens(JSON.stringify(parsed), key, 'account-one'));
    for (const value of ['', '123', Buffer.alloc(16).toString('base64'), `${env.MAIL_TOKEN_ENCRYPTION_KEY}!`]) assert.throws(() => encryptionKey(value));
});

test('missing durable storage or encryption settings blocks OAuth before any provider call', async () => {
    const { service, calls } = setup({ env: {}, store: { isConfigured: () => false } });
    const result = await service.status();
    assert.equal(result.configuration.ready, false);
    assert.equal(result.configuration.storageVerified, false);
    assert.equal(result.connection.connected, false);
    await assert.rejects(service.start('administrator', authorization), { status: 503 });
    assert.equal(calls.length, 0);
});

test('OAuth requests mail.read only, fixed callback and secure browser-bound state', async () => {
    const { service, store } = setup();
    const start = await service.start('administrator', authorization);
    const url = new URL(start.authorizationUrl);
    assert.equal(url.origin, 'https://auth.worksmobile.com');
    assert.equal(url.searchParams.get('scope'), 'mail.read');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://dashboard.dmnfood.co.kr/api/naverworks/callback');
    assert.match(start.cookie, /HttpOnly; Secure; SameSite=Lax; Max-Age=600/);
    const state = url.searchParams.get('state'), record = store.states.get(crypto.createHash('sha256').update(state).digest('hex'));
    assert.equal(record.uid, 'administrator');
    assert.equal(JSON.stringify(record).includes(authorization), false);
    assert.equal(record.expiresAt - record.createdAt, 600000);
});

test('wrong cookie and repeated OAuth callback fail without token exchange', async () => {
    const { service, calls } = setup();
    const { state, cookie } = await connect(service);
    const previousCount = calls.length;
    await assert.rejects(service.callback({ state, cookie: 'z'.repeat(43), code: 'another' }), { code: 'mail_oauth_state_invalid' });
    await assert.rejects(service.callback({ state, cookie, code: 'another' }), { code: 'mail_oauth_state_invalid' });
    assert.equal(calls.length, previousCount);
});

test('callback rechecks active administrator before any provider exchange', async () => {
    const { service, calls } = setup({ authorizeCallback: async () => ({ uid: 'administrator', role: 'manager' }) });
    const start = await service.start('administrator', authorization);
    await assert.rejects(service.callback({ state: new URL(start.authorizationUrl).searchParams.get('state'), cookie: start.cookie.split(';')[0].split('=')[1], code: 'test' }), { status: 403 });
    assert.equal(calls.length, 0);
});

test('callback checks access to exact configured mailbox and persists only encrypted tokens', async () => {
    const { service, store, calls } = setup();
    await connect(service);
    assert.equal(calls[1].url, 'https://www.worksapis.com/v1.0/users/official%40dmnfood.co.kr/mail/mailfolders');
    const saved = await store.getConnection();
    assert.equal(saved.data.accessStatus, 'mailbox_access_verified');
    assert.equal(JSON.stringify(saved).includes(tokenReply.access_token), false);
    assert.equal(JSON.stringify(saved).includes(tokenReply.refresh_token), false);
    const publicStatus = await service.status();
    assert.equal(publicStatus.connection.connected, true);
    assert.equal(JSON.stringify(publicStatus).includes('encryptedTokens'), false);
});

test('wrong-account mailbox denial and widened OAuth scope cannot establish connection', async () => {
    for (const scope of ['mail', 'mail.read user.read', 'mail.read']) {
        const { service, store } = setup({ fetchImpl: async url => url.includes('/token') ? json({ ...tokenReply, scope }) : json({}, 403) });
        await assert.rejects(connect(service));
        assert.equal(await store.getConnection(), null);
    }
});

test('refresh rotation must be durably saved before any mail API request', async () => {
    const store = memoryStore(); await seed(store, { expiresAt: NOW - 1 });
    const save = store.saveConnection;
    const events = [];
    store.saveConnection = async (...args) => { events.push('save'); return save(...args); };
    const { service } = setup({ store, fetchImpl: async url => {
        if (url.includes('/token')) { events.push('refresh'); return json({ ...tokenReply, refresh_token: 'rotated-refresh' }); }
        events.push('mail'); return json(folderReply);
    } });
    await service.folders();
    assert.deepEqual(events, ['refresh', 'save', 'mail']);
    const decrypted = openTokens((await store.getConnection()).data.encryptedTokens, encryptionKey(env.MAIL_TOKEN_ENCRYPTION_KEY), tokenContext);
    assert.equal(decrypted.refresh_token, 'rotated-refresh');
});

test('failed token save prevents using or exposing refreshed access token', async () => {
    const store = memoryStore(); await seed(store, { expiresAt: NOW - 1 });
    store.saveConnection = async () => { throw Object.assign(new Error('CAS conflict'), { status: 409 }); };
    const calls = [];
    const { service } = setup({ store, fetchImpl: async url => { calls.push(url); return json(tokenReply); } });
    await assert.rejects(service.folders(), { status: 409 });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/token$/);
});

test('last-seven-day sync scans pagination, includes read mail and preserves source/attachments without interpreting', async () => {
    const store = memoryStore(); await seed(store);
    const requests = [];
    const { service } = setup({ store, fetchImpl: async url => {
        requests.push(url);
        if (url.endsWith('/mailfolders')) return json(folderReply);
        if (url.includes('/children')) return json(new URL(url).searchParams.has('cursor')
            ? { mails: [summary(3)], responseMetaData: {} }
            : { mails: [summary(1), summary(2, new Date(NOW - 8 * 86400000).toISOString())], responseMetaData: { nextCursor: 'second-page' } });
        return json(raw(Number(new URL(url).pathname.split('/').at(-1))));
    } });
    const result = await service.sync('administrator', { folderId: '0' });
    assert.equal(result.sync.status, 'complete');
    assert.equal(result.sync.collected, 2);
    assert.equal(result.sync.skipped, 1);
    assert.equal(result.sync.attachmentsComplete, false);
    assert.equal(result.sync.interpretationReady, false);
    assert.equal(Date.parse(result.sync.to) - Date.parse(result.sync.from), 7 * 86400000);
    assert.ok(requests.filter(url => url.includes('/children')).every(url => new URL(url).searchParams.get('isUnread') === 'false'));
    const intake = [...store.intakes.values()][0];
    assert.equal(intake.raw.mail.body, raw(1).mail.body);
    assert.deepEqual(intake.raw.attachments, raw(1).attachments);
    assert.equal(intake.interpretationState, 'awaiting_interpretation');
    assert.equal(intake.attachmentState, 'metadata_only');
    assert.equal(intake.processingStatus, 'pending_interpretation');
    const repeat = await service.sync('administrator', { folderId: '0' });
    assert.equal(repeat.sync.collected, 0);
    assert.equal(repeat.sync.duplicates, 2);
});

test('bounded sync continuation freezes pending IDs despite live-page changes and rejects wrong binding', async () => {
    const store = memoryStore(); await seed(store);
    const rows = Array.from({ length: MAX_DETAILS + 2 }, (_, i) => summary(i + 1));
    let pageReads = 0;
    const { service } = setup({ store, fetchImpl: async url => {
        if (url.endsWith('/mailfolders')) return json(folderReply);
        if (url.includes('/children')) {
            pageReads++;
            // A refetched page would now omit unseen IDs 11/12. The signed queue
            // must retain those IDs and never read this moving page a second time.
            return json({ mails: pageReads === 1 ? rows : rows.slice(2), responseMetaData: {} });
        }
        return json(raw(Number(new URL(url).pathname.split('/').at(-1))));
    } });
    const first = await service.sync('administrator', { folderId: '0' });
    assert.equal(first.sync.status, 'partial');
    assert.equal(first.sync.collected, MAX_DETAILS);
    assert.ok(first.sync.continuation);
    for (const [uid, folderId, continuation] of [['other-user', '0', first.sync.continuation], ['administrator', '1', first.sync.continuation], ['administrator', '0', first.sync.continuation + 'x']]) {
        await assert.rejects(service.sync(uid, { folderId, continuation }), { code: 'mail_continuation_invalid' });
    }
    const last = await service.sync('administrator', { folderId: '0', continuation: first.sync.continuation });
    assert.equal(last.sync.status, 'complete');
    assert.equal(last.sync.collected, MAX_DETAILS + 2);
    assert.equal(store.intakes.size, MAX_DETAILS + 2);
    assert.equal(pageReads, 1);
    assert.ok(store.intakes.has('official@dmnfood.co.kr:11'));
    assert.ok(store.intakes.has('official@dmnfood.co.kr:12'));
});

test('historical-only pages stop at the page budget and resume at the exact next cursor', async () => {
    const store = memoryStore(); await seed(store);
    const pages = [], pageCount = 17;
    const oldTime = new Date(NOW - 8 * 86400000).toISOString();
    const { service } = setup({ store, fetchImpl: async url => {
        if (url.endsWith('/mailfolders')) return json(folderReply);
        assert.ok(url.includes('/children'), 'out-of-range mail must not trigger a detail read');
        const query = new URL(url).searchParams;
        const page = Number(query.get('cursor') || 1);
        assert.equal(query.get('count'), '30');
        pages.push(page);
        return json({
            mails: Array.from({ length: 30 }, (_, i) => summary((page - 1) * 30 + i + 1, oldTime)),
            responseMetaData: page < pageCount ? { nextCursor: String(page + 1) } : {},
        });
    } });
    const first = await service.sync('administrator', { folderId: '0' });
    assert.equal(MAX_PAGES, 15);
    assert.equal(first.sync.status, 'partial');
    assert.equal(first.sync.scanComplete, false);
    assert.equal(first.sync.scanned, 450);
    assert.equal(first.sync.skipped, 450);
    assert.equal(first.sync.collected, 0);
    assert.equal(pages.length, 15);
    assert.ok(first.sync.continuation);
    const last = await service.sync('administrator', { folderId: '0', continuation: first.sync.continuation });
    assert.equal(last.sync.status, 'complete');
    assert.equal(last.sync.scanComplete, true);
    assert.equal(last.sync.scanned, 510);
    assert.equal(last.sync.skipped, 510);
    assert.equal(last.sync.collected, 0);
    assert.equal(last.sync.continuation, null);
    assert.equal(last.sync.from, first.sync.from);
    assert.equal(last.sync.to, first.sync.to);
    assert.deepEqual(pages, Array.from({ length: pageCount }, (_, i) => i + 1));
    assert.equal(store.intakes.size, 0);
});

test('elapsed-time budget still stops historical scans and preserves a fetched pending page', async () => {
    const store = memoryStore(); await seed(store);
    let time = NOW, slow = true;
    const pages = [], pageCount = 6;
    const oldTime = new Date(NOW - 8 * 86400000).toISOString();
    const { service } = setup({ store, now: () => time, fetchImpl: async url => {
        if (url.endsWith('/mailfolders')) return json(folderReply);
        assert.ok(url.includes('/children'), 'out-of-range mail must not trigger a detail read');
        const page = Number(new URL(url).searchParams.get('cursor') || 1);
        pages.push(page);
        if (slow) time += 5000;
        return json({
            mails: Array.from({ length: 30 }, (_, i) => summary((page - 1) * 30 + i + 1, oldTime)),
            responseMetaData: page < pageCount ? { nextCursor: String(page + 1) } : {},
        });
    } });
    const first = await service.sync('administrator', { folderId: '0' });
    assert.equal(first.sync.status, 'partial');
    assert.equal(first.sync.scanned, 120);
    assert.equal(first.sync.skipped, 120);
    assert.equal(pages.length, 5);
    assert.ok(pages.length < MAX_PAGES, 'elapsed time must stop the scan before its larger page budget');
    slow = false;
    const last = await service.sync('administrator', { folderId: '0', continuation: first.sync.continuation });
    assert.equal(last.sync.status, 'complete');
    assert.equal(last.sync.scanned, 180);
    assert.equal(last.sync.skipped, 180);
    assert.deepEqual(pages, [1, 2, 3, 4, 5, 6]);
    assert.equal(last.sync.from, first.sync.from);
    assert.equal(last.sync.to, first.sync.to);
    assert.equal(store.intakes.size, 0);
});

test('expired OAuth state cannot exchange code and wrong cookie does not consume valid state', async () => {
    let time = NOW;
    const { service, calls } = setup({ now: () => time });
    const start = await service.start('administrator', authorization);
    const state = new URL(start.authorizationUrl).searchParams.get('state');
    const cookie = start.cookie.split(';')[0].split('=')[1];
    await assert.rejects(service.callback({ state, cookie: 'z'.repeat(43), code: 'test' }), { code: 'mail_oauth_state_invalid' });
    await service.callback({ state, cookie, code: 'test' });
    const next = await service.start('administrator', authorization);
    time += 600001;
    const count = calls.length;
    await assert.rejects(service.callback({ state: new URL(next.authorizationUrl).searchParams.get('state'), cookie: next.cookie.split(';')[0].split('=')[1], code: 'test' }), { code: 'mail_oauth_state_invalid' });
    assert.equal(calls.length, count);
});

test('source mismatch or malformed source stops collection without partial source persistence', async () => {
    for (const bad of [raw(999), raw(1, { receivedTime: 'unknown' }), { ...raw(1), attachments: undefined }]) {
        const store = memoryStore(); await seed(store);
        const { service } = setup({ store, fetchImpl: async url => url.endsWith('/mailfolders') ? json(folderReply) : url.includes('/children') ? json({ mails: [summary(1)] }) : json(bad) });
        await assert.rejects(service.sync('administrator', { folderId: '0' }), { code: 'naverworks_invalid_response' });
        assert.equal(store.intakes.size, 0);
    }
});

function response() {
    return { headers: {}, body: null, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = value; } };
}
test('API handlers enforce method, administrator, same-origin and JSON before service calls', async () => {
    let used = 0;
    const service = { start: async () => { used++; return { authorizationUrl: 'https://auth.worksmobile.com/test', cookie: 'secure-cookie' }; } };
    const request = { method: 'POST', headers: { authorization, origin: 'https://dashboard.dmnfood.co.kr', 'content-type': 'application/json' } };
    for (const [req, role, status] of [[{ ...request, method: 'GET' }, 'admin', 405], [request, 'manager', 403], [{ ...request, headers: { ...request.headers, origin: 'https://evil.invalid' } }, 'admin', 403], [{ ...request, headers: { ...request.headers, 'content-type': 'text/plain' } }, 'admin', 415]]) {
        const res = response();
        await createHandler('start', { service, store: {}, authorize: async () => ({ uid: 'administrator', role }) })(req, res);
        assert.equal(res.statusCode, status);
    }
    assert.equal(used, 0);
    const res = response();
    await createHandler('start', { service, store: {}, authorize: async () => ({ uid: 'administrator', role: 'admin' }) })(request, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.body.includes('secure-cookie'), false);
    assert.equal(used, 1);
});

test('callback removes OAuth query and cookie on both success and failure without leaking provider errors', async () => {
    for (const successful of [true, false]) {
        const res = response();
        const service = { callback: async () => { if (!successful) throw new Error('private-code-and-token'); } };
        const handler = createHandler('callback', { service, store: {} });
        await handler({ method: 'GET', url: '/api/naverworks/callback?code=private-code&state=private-state', headers: {} }, res);
        assert.equal(res.statusCode, 303);
        assert.equal(res.headers.Location, `https://dashboard.dmnfood.co.kr/orders?mail_connection=${successful ? 'connected' : 'error'}`);
        assert.match(res.headers['Set-Cookie'], /Max-Age=0/);
        assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
        assert.equal(JSON.stringify(res).includes('private-code'), false);
    }
});

const schoolFolders = { mailFolders: [...folderReply.mailFolders, { folderId: 106, folderName: '학교급식 발주', folderType: 'U', mailCount: 20 }] };
test('school scope metadata is explicit and manual; exact unique school name and ID are required without inbox fallback', async () => {
    const store = memoryStore(); await seed(store);
    let current = schoolFolders;
    const { service, calls } = setup({ store, fetchImpl: async url => {
        if (url.endsWith('/mailfolders')) return json(current);
        if (url.includes('/children')) return json({ mails: [] });
        throw new Error('unexpected detail');
    } });
    const status = await service.status();
    assert.deepEqual(status.schoolScope, { folderId: '106', folderName: '학교급식 발주', available: null, verified: false, collectionMode: 'manual', automatic: false });
    assert.equal(calls.length, 0, 'status does not claim live folder verification');
    assert.equal((await service.folders()).schoolScope.available, true);
    for (const reply of [folderReply, { mailFolders: [...schoolFolders.mailFolders, { folderId: 107, folderName: '학교급식 발주' }] }, { mailFolders: [...schoolFolders.mailFolders, { folderId: 106, folderName: '다른 메일함' }] }, { mailFolders: [{ folderId: 106, folderName: '이름 변경됨' }] }, { mailFolders: [{ folderId: 107, folderName: '학교급식 발주' }] }]) {
        current = reply;
        assert.equal((await service.folders()).schoolScope.available, false);
        await assert.rejects(service.sync('administrator', { folderId: '106', scope: 'school' }), { code: 'school_mail_folder_unavailable' });
    }
    const before = calls.length;
    await assert.rejects(service.sync('administrator', { folderId: '0', scope: 'school' }), { code: 'school_mail_folder_required' });
    assert.equal(calls.length, before, 'wrong school folder fails before any provider call');
    current = folderReply;
    assert.equal((await service.sync('administrator', { folderId: '0' })).sync.status, 'complete', 'generic other-folder collection stays supported');
});

test('school collection requires exact folder on the detail response and never saves moved or missing-folder mail', async () => {
    for (const changes of [{ folderId: 0 }, {}, { folderId: '106' }, { folderId: null }]) {
        const store = memoryStore(); await seed(store);
        const { service } = setup({ store, fetchImpl: async url => url.endsWith('/mailfolders') ? json(schoolFolders)
            : url.includes('/children') ? json({ mails: [summary(1)] }) : json(raw(1, changes)) });
        await assert.rejects(service.sync('administrator', { folderId: '106', scope: 'school' }), { code: 'mail_folder_source_changed' });
        assert.equal(store.intakes.size, 0); assert.equal(await store.getSyncState(), null);
    }
    const store = memoryStore(); await seed(store);
    const { service } = setup({ store, fetchImpl: async url => url.endsWith('/mailfolders') ? json(schoolFolders)
        : url.includes('/children') ? json({ mails: [summary(1)] }) : json(raw(1, { folderId: 106 })) });
    assert.equal((await service.sync('administrator', { folderId: '106', scope: 'school' })).sync.status, 'complete');
    assert.equal([...store.intakes.values()][0].folderId, '106');
    assert.equal([...store.intakes.values()][0].processingStatus, 'pending_interpretation', 'folder does not approve or classify an order');
});

test('school continuation remains scope-bound and membership failure cannot publish a completed run', async () => {
    const store = memoryStore(); await seed(store);
    const { service } = setup({ store, fetchImpl: async url => url.endsWith('/mailfolders') ? json(schoolFolders)
        : url.includes('/children') ? json({ mails: Array.from({ length: MAX_DETAILS + 1 }, (_, i) => summary(i + 1)) }) : json(raw(Number(new URL(url).pathname.split('/').at(-1)), { folderId: 106 })) });
    const first = await service.sync('administrator', { folderId: '106', scope: 'school' });
    assert.equal(first.sync.status, 'partial');
    await assert.rejects(service.sync('administrator', { folderId: '106', continuation: first.sync.continuation }), { code: 'mail_continuation_invalid' });
    const save = store.createIntake;
    store.createIntake = async () => { throw Object.assign(new Error('membership unavailable'), { code: 'MAIL_STORE_UNAVAILABLE', status: 503 }); };
    await assert.rejects(service.sync('administrator', { folderId: '106', scope: 'school', continuation: first.sync.continuation }), { code: 'MAIL_STORE_UNAVAILABLE' });
    assert.equal((await store.getSyncState()).data.summary.status, 'partial');
    store.createIntake = save;
    const last = await service.sync('administrator', { folderId: '106', scope: 'school', continuation: first.sync.continuation });
    assert.equal(last.sync.status, 'complete'); assert.equal(store.intakes.size, MAX_DETAILS + 1);
});
