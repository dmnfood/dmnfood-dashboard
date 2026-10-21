import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createMailboxStore, buildIntakeId, encodeFields, decodeFields, MAX_RAW_BYTES, MAX_ATTACHMENT_BYTES } = require('../lib/server/mail-integration-store.cjs');

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function fixture() {
    const docs = new Map(), calls = []; let time = 1792530000000, version = 0, failCommit = false, failMembershipCommit = false;
    const env = { MAIL_COLLECTOR_EMAIL: 'collector@example.invalid', MAIL_COLLECTOR_PASSWORD: 'test-secret' };
    const fetchImpl = async (url, settings = {}) => {
        calls.push({ url, settings });
        if (url.includes('accounts:signInWithPassword')) return response({ idToken: 'collector-id-token', refreshToken: 'collector-refresh-token', localId: 'collector', expiresIn: '3600' });
        if (url.includes('securetoken.googleapis.com')) return response({ id_token: 'renewed-collector-id-token', refresh_token: 'renewed-refresh-token', user_id: 'collector', expires_in: '3600' });
        assert.match(settings.headers.Authorization, /^Bearer (collector-id-token|renewed-collector-id-token)$/);
        if (url.endsWith(':runQuery')) {
            const query = JSON.parse(settings.body).structuredQuery;
            const folder = url.match(/\/mailFolders\/(-?\d+):runQuery$/)?.[1];
            const pattern = folder ? new RegExp(`/mailFolders/${folder}/intakes/[a-f0-9]{64}$`) : /\/mailIntakes\/[a-f0-9]{64}$/;
            const rows = [...docs.values()].filter(doc => pattern.test(doc.name))
                .sort((a, b) => decodeFields(b.fields).receivedAt.localeCompare(decodeFields(a.fields).receivedAt) || b.name.localeCompare(a.name));
            const after = query.startAt?.values;
            const filtered = after ? rows.filter(doc => decodeFields(doc.fields).receivedAt < after[0].stringValue || (decodeFields(doc.fields).receivedAt === after[0].stringValue && doc.name < after[1].referenceValue)) : rows;
            return response(filtered.slice(0, query.limit).map(doc => ({ document: { ...doc, fields: Object.fromEntries(query.select.fields.flatMap(({ fieldPath }) => doc.fields[fieldPath] ? [[fieldPath, doc.fields[fieldPath]]] : [])) } })));
        }
        if (url.endsWith(':commit')) {
            if (failCommit) return response({ error: { status: 'PERMISSION_DENIED', message: 'private upstream detail' } }, 403);
            const writes = JSON.parse(settings.body).writes;
            if (failMembershipCommit && writes.some(write => write.update?.name.includes('/mailFolders/'))) return response({ error: { status: 'PERMISSION_DENIED' } }, 403);
            for (const write of writes) {
                const existing = docs.get(write.update?.name || write.delete), condition = write.currentDocument;
                if ((condition?.exists === false && existing) || (condition?.updateTime && existing?.updateTime !== condition.updateTime)) return response({ error: { status: 'FAILED_PRECONDITION' } }, 400);
            }
            const writeResults = writes.map(write => {
                const updateTime = new Date(time + ++version).toISOString();
                if (write.update) docs.set(write.update.name, { ...write.update, updateTime }); else docs.delete(write.delete);
                return { updateTime };
            });
            return response({ writeResults });
        }
        const name = url.slice(url.indexOf('/projects/') + 1);
        return docs.has(name) ? response(docs.get(name)) : response({ error: { status: 'NOT_FOUND' } }, 404);
    };
    const store = createMailboxStore({ env, fetchImpl, now: () => time });
    return { store, docs, calls, advance: ms => { time += ms; }, get now() { return time; }, set failCommit(value) { failCommit = value; }, set failMembershipCommit(value) { failMembershipCommit = value; } };
}
const rawRecord = (raw = { mail: { body: '원문 상품명 180ml × 12개' }, attachments: [{ fileName: '발주서.xlsx', fileId: 'file-1' }] }) => ({
    account: 'official@dmnfood.co.kr', mailId: 'mail-1', folderId: '0', subject: '발주 요청', from: [{ email: 'customer@example.invalid' }], receivedAt: '2026-10-21T00:00:00Z', raw,
    attachmentStatus: 'metadata_only', processingStatus: 'pending_interpretation', collectedAt: '2026-10-21T01:00:00Z', sourceChannel: 'naverworks_mail',
});

test('dedicated collector authentication is required and never uses employee credentials or profile reads', async () => {
    let called = false;
    const missing = createMailboxStore({ env: {}, fetchImpl: async () => { called = true; } });
    assert.equal(missing.isConfigured(), false);
    await assert.rejects(missing.getConnection(), { code: 'MAIL_STORE_NOT_CONFIGURED' }); assert.equal(called, false);
    const state = fixture();
    await Promise.all([state.store.getConnection(), state.store.getSyncState()]);
    assert.equal(state.calls.filter(call => call.url.includes('signInWithPassword')).length, 1);
    assert.ok(state.calls.every(call => !call.url.includes('/users/') && !call.url.includes('accounts:lookup')));
    assert.deepEqual(JSON.parse(state.calls[0].settings.body), { email: 'collector@example.invalid', password: 'test-secret', returnSecureToken: true });
    state.advance(3600000);
    await state.store.getConnection();
    assert.equal(state.calls.filter(call => call.url.includes('securetoken.googleapis.com')).length, 1);
    assert.match(state.calls.find(call => call.url.includes('securetoken.googleapis.com')).settings.body, /grant_type=refresh_token/);
});

test('connections require encrypted tokens and update-time compare-and-swap rejects a stale refresh', async () => {
    const { store } = fixture();
    const record = { encryptedTokens: { ciphertext: 'opaque-envelope' }, mailbox: 'official@dmnfood.co.kr', accountVerified: true, expiresAt: 1792533600000 };
    for (const patch of [{ encryptedTokens: null }, { accessToken: 'plaintext' }, { refresh_token: 'plaintext' }]) await assert.rejects(store.saveConnection({ ...record, ...patch }), { code: 'MAIL_TOKENS_NOT_ENCRYPTED' });
    const first = await store.saveConnection(record);
    assert.deepEqual((await store.getConnection()).data, record);
    const newer = await store.saveConnection({ ...record, expiresAt: 1792540000000 }, { expectedVersion: first.version });
    await assert.rejects(store.saveConnection(record, { expectedVersion: first.version }), { code: 'MAIL_STORE_CONFLICT', status: 409 });
    assert.equal((await store.getConnection()).version, newer.version);
    const summary = await store.getSummary();
    assert.equal(summary.accountVerified, true); assert.ok(!JSON.stringify(summary).includes('opaque-envelope'));
});

test('OAuth state is browser-bound, expires and can be consumed only once under concurrent callbacks', async () => {
    const state = fixture(), hash = 'a'.repeat(64);
    const data = { uid: 'admin', mailbox: 'official@dmnfood.co.kr', cookieHash: 'cookie-hash', encryptedAuthorization: { ciphertext: 'one-time-auth-proof' }, createdAt: state.now, expiresAt: state.now + 600000 };
    await state.store.createOAuthState(hash, data);
    assert.equal(await state.store.consumeOAuthState(hash, 'wrong-cookie'), null);
    const callbacks = await Promise.all([state.store.consumeOAuthState(hash, 'cookie-hash'), state.store.consumeOAuthState(hash, 'cookie-hash')]);
    assert.equal(callbacks.filter(Boolean).length, 1); assert.deepEqual(callbacks.find(Boolean), data);
    assert.equal(await state.store.consumeOAuthState(hash, 'cookie-hash'), null);
    await state.store.createOAuthState(hash, data); state.advance(600001);
    assert.equal(await state.store.consumeOAuthState(hash, 'cookie-hash'), null);
    await assert.rejects(state.store.createOAuthState(hash, data), { code: 'MAIL_INVALID_STATE' });
});

test('leases use atomic ownership, expired takeover, and release after a failed job', async () => {
    const state = fixture();
    const leases = await Promise.all([state.store.acquireLease('naverworks', 'first', state.now + 60000), state.store.acquireLease('naverworks', 'second', state.now + 60000)]);
    assert.equal(leases.filter(Boolean).length, 1);
    const first = leases.find(Boolean);
    assert.equal(await state.store.releaseLease('naverworks', 'wrong-owner'), false);
    await assert.rejects(state.store.withLease('naverworks', async () => {}), { code: 'MAIL_SYNC_BUSY' });
    state.advance(60001);
    const replacement = await state.store.acquireLease('naverworks', 'replacement', state.now + 60000); assert.ok(replacement);
    assert.equal(await state.store.releaseLease('naverworks', first.owner), false);
    assert.equal(await state.store.releaseLease('naverworks', 'replacement'), true);
    await assert.rejects(state.store.withLease('naverworks', async () => { throw new Error('job failed'); }), /job failed/);
    assert.ok(await state.store.acquireLease('naverworks', 'after-failure', state.now + 60000));
});

test('mail identity deduplicates per mailbox, preserves source exactly and never confirms a collected message', async () => {
    const state = fixture(), record = rawRecord(), id = buildIntakeId(record.account, record.mailId);
    assert.equal(id, buildIntakeId('OFFICIAL@DMNFOOD.CO.KR', record.mailId));
    assert.notEqual(id, buildIntakeId('other@dmnfood.co.kr', record.mailId));
    assert.equal(await state.store.createRawMail(id, record), true);
    assert.equal(await state.store.createRawMail(id, { ...record, subject: '다른 제목' }), false);
    const saved = await state.store.getRawMail(id);
    assert.deepEqual(saved.raw, record.raw); assert.equal(saved.subject, record.subject);
    assert.equal(saved.processingStatus, 'pending_interpretation'); assert.equal(saved.attachmentStatus, 'metadata_only');
    assert.equal(saved.collectionState, 'raw_saved_metadata_only'); assert.equal(saved.collectedByUid, 'collector');
    assert.ok(state.calls.every(call => !call.url.includes('/orderRequests') && !call.url.includes('/documents/haccp')));
    await assert.rejects(state.store.createRawMail('b'.repeat(64), record), { code: 'MAIL_INVALID_ID' });
    await assert.rejects(state.store.createRawMail(id, { ...record, processingStatus: 'approved' }), { code: 'MAIL_INVALID_INTAKE' });
});

test('large Unicode source is atomically chunked and hash-checked; overlimit or failed writes cannot leave partial intake', async () => {
    const state = fixture(), record = rawRecord({ mail: { body: '고객원문🙂'.repeat(25000) }, attachments: [] });
    const { id } = await state.store.createIntake(record);
    const saved = await state.store.getRawMail(id);
    assert.ok(saved.rawStorage.chunkCount > 1); assert.deepEqual(saved.raw, record.raw);
    const parent = [...state.docs.values()].find(doc => doc.name.endsWith(`/mailIntakes/${id}`));
    assert.equal(decodeFields(parent.fields).raw, null);
    const chunk = [...state.docs.values()].find(doc => doc.name.endsWith(`/mailIntakes/${id}/source/0000`));
    chunk.fields.text.stringValue += 'tampered';
    await assert.rejects(state.store.getRawMail(id), { code: 'MAIL_SOURCE_INCOMPLETE' });
    const before = state.docs.size;
    await assert.rejects(state.store.createIntake({ ...record, mailId: 'oversize', raw: { text: 'x'.repeat(MAX_RAW_BYTES) } }), { code: 'MAIL_SOURCE_TOO_LARGE', status: 413 });
    assert.equal(state.docs.size, before);
    state.failCommit = true;
    await assert.rejects(state.store.createIntake({ ...record, mailId: 'cannot-save' }), error => error.code === 'MAIL_STORE_UNAVAILABLE' && !error.message.includes('private upstream'));
    assert.equal(state.docs.size, before);
});

test('sync summaries are durable and Firestore codec preserves false, zero, lists and Unicode', async () => {
    const { store } = fixture();
    const record = { status: 'complete', scanned: 0, fetched: 2, failed: false, folders: ['받은메일함'], cursor: null };
    await store.saveSyncRun(record);
    assert.deepEqual((await store.getSummary()).sync, record);
    assert.deepEqual(decodeFields(encodeFields(record)), record);
    await assert.rejects(store.saveSyncState({ scanned: Infinity }), { code: 'MAIL_INVALID_DATA' });
});

test('an expired or replaced lease cannot publish a sync summary', async () => {
    const state = fixture();
    const lease = await state.store.acquireLease('naverworks', 'first', state.now + 60000);
    await state.store.saveSyncRun({ status: 'partial' }, { lease });
    state.advance(60001);
    await assert.rejects(state.store.saveSyncRun({ status: 'complete' }, { lease }), { code: 'MAIL_SYNC_LEASE_EXPIRED' });
    const replacement = await state.store.acquireLease('naverworks', 'second', state.now + 60000);
    await assert.rejects(state.store.saveSyncRun({ status: 'complete' }, { lease: { ...lease, expiresAt: replacement.expiresAt } }), { code: 'MAIL_STORE_CONFLICT' });
    assert.equal((await state.store.getSyncState()).data.status, 'partial');
});

test('replayed continuation cannot reduce latest progress, remove completion or replace a newer query window', async () => {
    const { store, docs } = fixture();
    const summary = { folderId: '0', from: '2026-10-14T00:00:00.000Z', to: '2026-10-21T00:00:00.000Z', scanned: 10, scanComplete: false, status: 'partial' };
    const record = patch => ({ mailbox: 'official@dmnfood.co.kr', summary: { ...summary, ...patch } });
    await store.saveSyncRun(record());
    const before = docs.size;
    await assert.rejects(store.saveSyncRun(record({ scanned: 5 })), { code: 'MAIL_SYNC_OUTDATED', status: 409 });
    assert.equal(docs.size, before, 'stale replay must not publish any run or state');
    await store.saveSyncRun(record({ scanned: 20, scanComplete: true, status: 'complete' }));
    await assert.rejects(store.saveSyncRun(record({ scanned: 20 })), { code: 'MAIL_SYNC_OUTDATED' });
    await assert.rejects(store.saveSyncRun(record({ scanned: 100, from: '2026-10-13T00:00:00.000Z', to: '2026-10-20T00:00:00.000Z', folderId: '1' })), { code: 'MAIL_SYNC_OUTDATED' });
    assert.equal((await store.getSyncState()).data.summary.scanComplete, true);
    assert.equal((await store.getSyncState()).data.summary.scanned, 20);
    await store.saveSyncRun(record({ scanned: 0, from: '2026-10-14T01:00:00.000Z', to: '2026-10-21T01:00:00.000Z' }));
    assert.equal((await store.getSyncState()).data.summary.scanned, 0, 'a genuinely newer window may start with a new count');
});

test('source list projects minimal summaries and stable cursor continues without duplicate IDs; malformed cursor fails before query', async () => {
    const state = fixture();
    for (let n = 0; n < 5; n++) await state.store.createIntake({ ...rawRecord(), mailId: String(n), receivedAt: new Date(Date.parse('2026-10-21T00:00:00Z') + n * 1000).toISOString() });
    const first = await state.store.listRawMails({ limit: 2 });
    assert.equal(first.mails.length, 2); assert.ok(first.nextCursor);
    assert.ok(first.mails.every(mail => !('raw' in mail) && !('rawStorage' in mail) && !('collectedByUid' in mail)));
    assert.ok(first.mails[0].receivedAt > first.mails[1].receivedAt);
    const second = await state.store.listRawMails({ limit: 2, cursor: first.nextCursor });
    const third = await state.store.listRawMails({ limit: 2, cursor: second.nextCursor });
    assert.equal(third.nextCursor, null);
    assert.equal(new Set([...first.mails, ...second.mails, ...third.mails].map(mail => mail.id)).size, 5);
    const query = JSON.parse(state.calls.find(call => call.url.endsWith(':runQuery')).settings.body).structuredQuery;
    assert.ok(query.select.fields.every(field => !field.fieldPath.startsWith('raw')));
    const before = state.calls.length;
    for (const cursor of ['', 'not-a-cursor', 'x'.repeat(513), Buffer.from(JSON.stringify({ id: '../outside', receivedAt: '2026-10-21' })).toString('base64url')]) await assert.rejects(state.store.listRawMails({ cursor }), { code: 'MAIL_LIST_INVALID' });
    assert.equal(state.calls.length, before);
});

test('attachment archive is atomic, bounded and immutable; cached bytes are checksum checked and corruption never rewritten', async () => {
    const state = fixture(), { id } = await state.store.createIntake(rawRecord());
    const bytes = Buffer.alloc(MAX_ATTACHMENT_BYTES, 0x5a), metadata = { fileName: '실제 원문.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sourceSize: bytes.length };
    const archived = await state.store.createAttachment(id, '2', metadata, bytes);
    assert.equal(archived.byteLength, MAX_ATTACHMENT_BYTES); assert.equal(archived.chunkCount, 32);
    assert.deepEqual(Buffer.from(archived.contentBase64, 'base64'), bytes);
    const sourceBefore = await state.store.getRawMail(id);
    assert.equal(sourceBefore.attachmentStatus, 'metadata_only', 'original mail snapshot is not mutated when bytes are archived separately');
    assert.deepEqual(await state.store.createAttachment(id, '2', metadata, bytes), archived);
    await assert.rejects(state.store.createAttachment(id, '2', metadata, Buffer.alloc(bytes.length, 0x41)), { code: 'MAIL_ATTACHMENT_CHANGED' });
    assert.deepEqual(await state.store.getAttachment(id, '2'), archived);
    const before = state.docs.size;
    await assert.rejects(state.store.createAttachment(id, '3', { ...metadata, sourceSize: MAX_ATTACHMENT_BYTES + 1 }, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)), { status: 413 });
    assert.equal(state.docs.size, before);
    const chunk = [...state.docs.values()].find(doc => doc.name.endsWith(`/attachments/2/chunks/0001`));
    chunk.fields.contentBase64.stringValue = 'A' + chunk.fields.contentBase64.stringValue.slice(1);
    await assert.rejects(state.store.getAttachment(id, '2'), { code: 'MAIL_ATTACHMENT_INCOMPLETE' });
    await assert.rejects(state.store.createAttachment(id, '2', metadata, bytes), { code: 'MAIL_ATTACHMENT_INCOMPLETE' });
    assert.equal(state.docs.size, before);
    state.failCommit = true;
    await assert.rejects(state.store.createAttachment(id, '4', { ...metadata, sourceSize: 1 }, Buffer.from('x')), { code: 'MAIL_STORE_UNAVAILABLE' });
    assert.equal(state.docs.size, before, 'failed atomic commit leaves no attachment metadata or chunks');
});

test('moved duplicate receives immutable folder membership using first source without replacing inbox snapshot', async () => {
    const state = fixture(), first = rawRecord({ mail: { body: '최초 원문', folderId: 0 }, attachments: [] });
    const initial = await state.store.createIntake(first), snapshot = await state.store.getRawMail(initial.id);
    assert.equal(initial.membershipCreated, true);
    assert.equal((await state.store.listRawMails({ folderId: '106' })).mails.length, 0);
    const moved = { ...first, folderId: '106', raw: { ...first.raw, mail: { ...first.raw.mail, folderId: 106 } } };
    const duplicated = await state.store.createIntake(moved);
    assert.equal(duplicated.created, false); assert.equal(duplicated.membershipCreated, true);
    assert.deepEqual(await state.store.getRawMail(initial.id), snapshot);
    const school = await state.store.listRawMails({ folderId: '106' });
    assert.equal(school.mails.length, 1); assert.equal(school.mails[0].folderId, '106');
    assert.equal(school.mails[0].originalFolderId, '0'); assert.equal(school.mails[0].sourceHash, snapshot.rawStorage.sha256);
    assert.equal((await state.store.listRawMails({ folderId: '0' })).mails.length, 1);
    const member = [...state.docs.values()].find(doc => doc.name.endsWith(`/mailFolders/106/intakes/${initial.id}`));
    const originalVersion = member.updateTime;
    state.advance(10000);
    assert.equal((await state.store.createIntake(moved)).membershipCreated, false);
    assert.equal(member.updateTime, originalVersion);
    member.fields.sourceHash.stringValue = 'a'.repeat(64);
    await assert.rejects(state.store.createIntake(moved), { code: 'MAIL_FOLDER_MEMBERSHIP_INVALID' });
    assert.deepEqual(await state.store.getRawMail(initial.id), snapshot);
});

test('failed membership cannot be reported as complete; duplicate retry repairs it and folder mismatch is rejected before raw write', async () => {
    const state = fixture(), record = { ...rawRecord({ mail: { folderId: 106, body: '원본 유지' }, attachments: [] }), folderId: '106' };
    state.failMembershipCommit = true;
    await assert.rejects(state.store.createIntake(record), { code: 'MAIL_STORE_UNAVAILABLE' });
    const id = buildIntakeId(record.account, record.mailId), snapshot = await state.store.getRawMail(id);
    assert.ok(snapshot); assert.equal((await state.store.listRawMails({ folderId: '106' })).mails.length, 0);
    state.failMembershipCommit = false;
    const repaired = await state.store.createIntake(record);
    assert.equal(repaired.created, false); assert.equal(repaired.membershipCreated, true);
    assert.deepEqual(await state.store.getRawMail(id), snapshot);
    const before = state.docs.size;
    await assert.rejects(state.store.createIntake({ ...record, mailId: 'moved-during-read', raw: { mail: { folderId: 0 }, attachments: [] } }), { code: 'MAIL_FOLDER_SOURCE_CHANGED' });
    assert.equal(state.docs.size, before);
});

test('folder list cursors bind to folder while ordinary all-mail and other-folder lists remain available', async () => {
    const state = fixture();
    for (let n = 0; n < 3; n++) await state.store.createIntake({ ...rawRecord(), mailId: `school-${n}`, folderId: '106', receivedAt: new Date(Date.parse('2026-10-21T00:00:00Z') + n * 1000).toISOString() });
    await state.store.createIntake({ ...rawRecord(), mailId: 'other', folderId: '0' });
    const first = await state.store.listRawMails({ folderId: '106', limit: 1 });
    assert.ok(first.nextCursor);
    const next = await state.store.listRawMails({ folderId: '106', cursor: first.nextCursor, limit: 1 });
    assert.notEqual(first.mails[0].id, next.mails[0].id);
    await assert.rejects(state.store.listRawMails({ cursor: first.nextCursor }), { code: 'MAIL_LIST_INVALID' });
    await assert.rejects(state.store.listRawMails({ folderId: '0', cursor: first.nextCursor }), { code: 'MAIL_LIST_INVALID' });
    const all = await state.store.listRawMails({ limit: 1 });
    await assert.rejects(state.store.listRawMails({ folderId: '106', cursor: all.nextCursor }), { code: 'MAIL_LIST_INVALID' });
    assert.equal((await state.store.listRawMails()).mails.length, 4);
    assert.equal((await state.store.listRawMails({ folderId: '0' })).mails.length, 1);
    const queryCall = state.calls.find(call => call.url.endsWith('/mailFolders/106:runQuery'));
    const query = JSON.parse(queryCall.settings.body).structuredQuery;
    assert.deepEqual(query.from, [{ collectionId: 'intakes' }]); assert.equal(query.where, undefined);
});
