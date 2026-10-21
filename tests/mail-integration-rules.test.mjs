import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { createMailboxStore, encodeFields } = createRequire(import.meta.url)('../lib/server/mail-integration-store.cjs');
const emulatorHost = process.env.MAIL_FIRESTORE_EMULATOR_HOST || process.env.ORDER_FIRESTORE_EMULATOR_HOST;

test('mail rules isolate the collector from employee data, secrets from staff and immutable source from confirmation', { skip: !emulatorHost }, async () => {
    assert.match(emulatorHost, /^(127\.0\.0\.1|localhost):[0-9]+$/);
    const project = 'demo-mail-integration', documentName = `projects/${project}/databases/(default)/documents`;
    const documentRoot = `http://${emulatorHost}/v1/${documentName}`;
    const loaded = await fetch(`http://${emulatorHost}/emulator/v1/projects/${project}:securityRules`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') }] } }) });
    assert.equal(loaded.status, 200, await loaded.text());
    const token = uid => {
        const time = Math.floor(Date.now() / 1000);
        return `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: `https://securetoken.google.com/${project}`, aud: project, sub: uid, user_id: uid, iat: time, exp: time + 3600, auth_time: time, firebase: { sign_in_provider: 'custom' } })).toString('base64url')}.`;
    };
    const headers = uid => ({ 'Content-Type': 'application/json', ...(uid ? { Authorization: `Bearer ${uid === 'owner' ? 'owner' : token(uid)}` } : {}) });
    const get = (path, uid) => fetch(`${documentRoot}/${path}`, { headers: headers(uid) });
    const put = (path, data, uid) => fetch(`${documentRoot}/${path}`, { method: 'PATCH', headers: headers(uid), body: JSON.stringify({ fields: encodeFields(data) }) });
    const remove = (path, uid) => fetch(`${documentRoot}/${path}`, { method: 'DELETE', headers: headers(uid) });
    for (const [uid, role, approvalStatus, isActive] of [['manager', 'manager', 'approved', true], ['admin', 'admin', 'approved', true], ['worker', 'worker', 'approved', true], ['pending-manager', 'manager', 'pending', true]]) {
        assert.equal((await put(`users/${uid}`, { role, approvalStatus, isActive }, 'owner')).status, 200);
    }
    // No users/collector profile is created. Console-owned configuration is the only grant.
    const collector = `collector-${Date.now()}`;
    assert.equal((await put('integrationAccess/naverworksMail', { collectorUid: collector, enabled: true }, 'owner')).status, 200);
    for (const uid of [collector, 'admin', 'manager']) assert.equal((await put('integrationAccess/naverworksMail', { collectorUid: uid, enabled: true }, uid)).status, 403);
    assert.equal((await get('integrationAccess/naverworksMail', 'admin')).status, 200);
    assert.equal((await get('integrationAccess/naverworksMail', collector)).status, 403);

    const store = createMailboxStore({ env: { MAIL_COLLECTOR_EMAIL: 'test@example.invalid', MAIL_COLLECTOR_PASSWORD: 'not-a-real-password' }, documentName, documentRoot,
        fetchImpl: async (url, settings) => url.includes('accounts:signInWithPassword') ? { ok: true, json: async () => ({ idToken: token(collector), refreshToken: 'fake-refresh', localId: collector, expiresIn: '3600' }) } : fetch(url, settings) });
    // Use a clean state so re-running this isolated test remains deterministic.
    await remove('mailIntegrationSecrets/naverworks', 'owner');
    await remove('mailIntegrationLeases/naverworks', 'owner');
    await remove('mailIntegrationState/naverworks', 'owner');
    await store.saveConnection({ encryptedTokens: { ciphertext: 'encrypted' }, mailbox: 'official@dmnfood.co.kr' });
    assert.equal((await store.getConnection()).data.mailbox, 'official@dmnfood.co.kr');
    for (const uid of ['', 'manager', 'admin', 'worker', 'unknown-collector']) assert.equal((await get('mailIntegrationSecrets/naverworks', uid)).status, 403);
    assert.equal((await put('mailIntegrationSecrets/naverworks', { encryptedTokens: 'fake', accessToken: 'plaintext' }, collector)).status, 403);
    assert.equal((await remove('mailIntegrationSecrets/naverworks', collector)).status, 403);

    const stateHash = 'c'.repeat(64); await remove(`mailIntegrationOAuthStates/${stateHash}`, 'owner');
    await store.createOAuthState(stateHash, { uid: 'admin', mailbox: 'official@dmnfood.co.kr', cookieHash: 'cookie', encryptedAuthorization: { ciphertext: 'one-time-auth-proof' }, createdAt: Date.now(), expiresAt: Date.now() + 600000 });
    assert.equal((await get(`mailIntegrationOAuthStates/${stateHash}`, 'admin')).status, 403);
    assert.equal((await store.consumeOAuthState(stateHash, 'cookie')).uid, 'admin');
    assert.equal(await store.consumeOAuthState(stateHash, 'cookie'), null);
    await store.withLease('naverworks', async lease => { await store.saveSyncRun({ status: 'completed', imported: 1, finishedAt: new Date().toISOString() }, { lease }); });
    assert.equal((await store.getSyncState()).data.imported, 1);

    const intake = { account: 'official@dmnfood.co.kr', mailId: `mail-${Date.now()}`, folderId: '0', subject: '가상 발주', from: [{ email: 'test@example.invalid' }], receivedAt: new Date().toISOString(),
        raw: { mail: { body: '가상 상품 12개' }, attachments: [] }, attachmentStatus: 'metadata_only', processingStatus: 'pending_interpretation', collectedAt: new Date().toISOString(), sourceChannel: 'naverworks_mail' };
    const { id } = await store.createIntake(intake), path = `mailIntakes/${id}`;
    const immutable = await store.getRawMail(id);
    for (const uid of ['manager', 'admin', collector]) assert.equal((await get(path, uid)).status, 200);
    for (const uid of ['', 'worker', 'pending-manager']) assert.equal((await get(path, uid)).status, 403);
    assert.equal((await get(`${path}/source/0000`, 'manager')).status, 200);
    assert.equal((await put(path, { ...immutable, subject: '원문 변경' }, collector)).status, 403);
    assert.equal((await put(`${path}/source/0000`, { index: 0, text: '원문 변경' }, collector)).status, 403);
    assert.equal((await put(path, { ...immutable, processingStatus: 'approved' }, 'manager')).status, 403);
    assert.equal((await remove(path, collector)).status, 403);
    assert.equal((await put(`mailIntakes/${'d'.repeat(64)}`, { ...immutable, processingStatus: 'approved' }, collector)).status, 403);
    assert.equal((await put(`mailIntakes/${'e'.repeat(64)}`, { ...immutable, account: 'other@example.invalid' }, collector)).status, 403);
    for (const path of ['orderRequests/mail-collector-order', 'haccpProductionRecords/mail-collector-record']) assert.equal((await put(path, { status: 'approved' }, collector)).status, 403);
    assert.equal((await get('users/admin', collector)).status, 403);
    assert.equal((await put('integrationAccess/naverworksMail', { collectorUid: collector, enabled: false }, 'owner')).status, 200);
    assert.equal((await get('mailIntegrationSecrets/naverworks', collector)).status, 403);
    assert.equal((await get(path, collector)).status, 403);
});
