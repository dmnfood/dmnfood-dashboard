import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createMailService, sealTokens, encryptionKey, APP_ORIGIN } from '../lib/server/naverworks-core.cjs';
import { createHandler } from '../lib/server/naverworks-handlers.cjs';
import { buildIntakeId, MAX_ATTACHMENT_BYTES } from '../lib/server/mail-integration-store.cjs';

const now = Date.parse('2026-10-21T03:00:00Z');
const env = { NAVERWORKS_CLIENT_SECRET: 'test-secret', MAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64') };
const account = 'official@dmnfood.co.kr', intakeId = buildIntakeId(account, '1234');
const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function fixture({ bytes = Buffer.from('original spreadsheet bytes'), attachment = {}, provider, expired = false } = {}) {
    const meta = { attachmentId: 2, filename: '원본 발주서.xlsx', size: bytes.length, contentType: mime, bigFileFid: '', bigFileExpireTime: '', ...attachment };
    const record = { account, mailId: '1234', subject: '<script>source remains text</script>', raw: { mail: { mailId: 1234, body: '<p>고객 원문 그대로</p>' }, attachments: [meta] } };
    const archives = new Map(), calls = [], writes = [], events = [];
    let connection = { version: 'v1', data: { mailbox: account, accessStatus: 'mailbox_access_verified', encryptedTokens: sealTokens({ access_token: 'test-access', refresh_token: 'test-refresh', scope: 'mail.read', expiresAt: now + (expired ? -1 : 3600000) }, encryptionKey(env.MAIL_TOKEN_ENCRYPTION_KEY), `naverworks:kaXX9XpQRZ7ohuKFW1TU:${account}`) } };
    const store = {
        isConfigured: () => true, getConnection: async () => connection,
        saveConnection: async data => { events.push('save-token'); connection = { data, version: 'v2' }; },
        withLease: async (name, run) => { events.push(`lease:${name}`); return run({ name }); },
        getRawMail: async id => id === intakeId ? structuredClone(record) : null,
        listRawMails: async ({ cursor, limit, folderId }) => { events.push({ cursor, limit, folderId }); return { mails: [{ id: intakeId, account, subject: record.subject }], nextCursor: null }; },
        getAttachment: async (id, attachmentId) => archives.get(`${id}/${attachmentId}`) || null,
        createAttachment: async (id, attachmentId, metadata, data) => {
            writes.push({ id, attachmentId, metadata, data });
            const result = { ...metadata, byteLength: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), contentBase64: data.toString('base64'), archivedAt: new Date(now).toISOString() };
            archives.set(`${id}/${attachmentId}`, result); return result;
        },
    };
    const service = createMailService({ store, env, now: () => now, fetchImpl: async (url, init) => {
        calls.push({ url, init }); events.push('provider');
        if (String(url).includes('/token')) return new Response(JSON.stringify({ token_type: 'Bearer', access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, scope: 'mail.read' }));
        return provider ? provider(url, init) : new Response(JSON.stringify({ filename: meta.filename, data: bytes.toString('base64') }));
    } });
    return { service, store, record, meta, archives, calls, writes, events };
}
const input = () => ({ intakeId, attachmentId: '2' });

test('stored mail browsing never contacts NAVER and returns immutable source; IDs are mailbox-bound', async () => {
    const f = fixture();
    assert.equal((await f.service.source()).mails[0].id, intakeId);
    const result = await f.service.source({ intakeId });
    assert.equal(result.mail.raw.mail.body, f.record.raw.mail.body);
    assert.equal(result.mail.id, intakeId); assert.equal(f.calls.length, 0);
    await assert.rejects(f.service.source({ intakeId: 'b'.repeat(64) }), { status: 404 });
    await assert.rejects(f.service.source({ intakeId, cursor: 'other' }), { status: 400 });
    f.record.account = 'other@example.invalid';
    await assert.rejects(f.service.source({ intakeId }), { status: 404 });
});

test('source list passes explicit folder scope while original detail remains independent of current folder', async () => {
    const f = fixture(); f.record.folderId = '0';
    const result = await f.service.source({ folderId: '106' });
    assert.equal(result.scope.folderId, '106'); assert.equal(result.schoolScope.automatic, false);
    assert.deepEqual(f.events.at(-1), { cursor: null, limit: 20, folderId: '106' });
    assert.equal((await f.service.source({ intakeId })).mail.folderId, '0');
    await assert.rejects(f.service.source({ intakeId, folderId: '106' }), { status: 400 });
    assert.equal(f.calls.length, 0);
});

test('ordinary attachment uses only saved source IDs, fixed official host and no redirects; cached copy needs no OAuth', async () => {
    const f = fixture();
    const first = await f.service.attachment(input());
    assert.equal(first.attachment.id, '2'); assert.equal(first.attachment.fileName, f.meta.filename);
    assert.equal(Buffer.from(first.attachment.contentBase64, 'base64').toString(), 'original spreadsheet bytes');
    assert.equal(f.calls[0].url, 'https://www.worksapis.com/v1.0/users/official%40dmnfood.co.kr/mail/1234/attachments/2');
    assert.equal(f.calls[0].init.redirect, 'error'); assert.equal(f.calls[0].init.headers.Authorization, 'Bearer test-access');
    assert.ok(f.calls[0].init.signal instanceof AbortSignal);
    assert.equal(f.writes.length, 1);
    const original = JSON.stringify(f.record);
    assert.deepEqual(await f.service.attachment(input()), first);
    assert.equal(f.calls.length, 1); assert.equal(JSON.stringify(f.record), original);
    await assert.rejects(f.service.attachment({ ...input(), attachmentId: '99' }), { status: 404 });
    await assert.rejects(f.service.attachment({ ...input(), intakeId: '../secrets' }), { status: 400 });
    assert.equal(f.calls.length, 1);
    f.archives.get(`${intakeId}/2`).fileName = 'different.xlsx';
    await assert.rejects(f.service.attachment(input()), { code: 'mail_attachment_changed' });
    assert.equal(f.calls.length, 1, 'corrupt cache never triggers a replacement download');
});

test('attachment refresh token rotation is saved under the operation lease before download', async () => {
    const f = fixture({ expired: true });
    await f.service.attachment(input());
    assert.deepEqual(f.events, ['lease:naverworks-operation', 'provider', 'save-token', 'provider']);
    assert.equal(f.calls[1].init.headers.Authorization, 'Bearer rotated-access');
});

test('inline, expiring, unsupported, ambiguous or overlimit attachments never reach provider or archive', async () => {
    for (const patch of [{ attachmentId: -1, bigFileFid: 'private-url' }, { attachmentId: -2, contentDisposition: 'inline' }, { contentDisposition: 'inline' }, { bigFileExpireTime: '2030-01-01' }, { filename: 'order.xlsx.exe' }, { filename: 'order.xlsx', contentType: 'text/html' }, { size: MAX_ATTACHMENT_BYTES + 1 }, { size: null }, { filename: 'bad\n.xlsx' }]) {
        const f = fixture({ attachment: patch });
        await assert.rejects(f.service.attachment({ ...input(), attachmentId: String(f.meta.attachmentId) }));
        assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
    }
    const duplicate = fixture(); duplicate.record.raw.attachments.push({ ...duplicate.meta });
    await assert.rejects(duplicate.service.attachment(input()), { status: 404 });
    assert.equal(duplicate.calls.length, 0);
});

test('ordinary PNG and JPEG screenshots keep exact bytes and archive binding with canonical image MIME', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
    // Header/size fixture: the archive gate verifies format; a browser decodes full image data separately.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
    for (const [fileName, mimeType, bytes] of [['발주 캡처.PNG', 'image/png', png], ['발주 캡처.jpeg', 'image/jpeg', jpeg], ['발주 캡처.jpg', 'application/octet-stream', jpeg]]) {
        const f = fixture({ bytes, attachment: { filename: fileName, contentType: mimeType } });
        const result = await f.service.attachment(input());
        assert.equal(result.attachment.mimeType, fileName.endsWith('PNG') ? 'image/png' : 'image/jpeg');
        assert.deepEqual(Buffer.from(result.attachment.contentBase64, 'base64'), bytes);
        assert.equal(result.attachment.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
        assert.deepEqual(await f.service.attachment(input()), result); assert.equal(f.calls.length, 1);
    }
});

test('image MIME, byte signatures and pixel limits cannot be bypassed by a screenshot filename or cached archive', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
    const huge = Buffer.from(png); huge.writeUInt32BE(10000, 16); huge.writeUInt32BE(10000, 20);
    const animationControl = Buffer.alloc(20); animationControl.writeUInt32BE(8, 0); animationControl.write('acTL', 4);
    const animatedPng = Buffer.concat([png.subarray(0, 33), animationControl, png.subarray(33)]);
    for (const bytes of [Buffer.from('<svg><script>alert(1)</script></svg>'), huge, png.subarray(0, -1), animatedPng]) {
        const f = fixture({ bytes, attachment: { filename: '발주.png', contentType: 'image/png' } });
        await assert.rejects(f.service.attachment(input()), { code: 'mail_attachment_format_invalid' }); assert.equal(f.writes.length, 0);
    }
    for (const patch of [{ filename: '발주.png', contentType: 'image/jpeg' }, { filename: '발주.svg', contentType: 'image/svg+xml' }, { filename: '발주.gif', contentType: 'image/gif' }, { filename: '발주.jpg', contentType: 'image/jpeg' }]) {
        const f = fixture({ bytes: png, attachment: patch });
        await assert.rejects(f.service.attachment(input())); assert.equal(f.writes.length, 0);
    }
    const cached = fixture({ bytes: png, attachment: { filename: '발주.png', contentType: 'image/png' } });
    await cached.service.attachment(input());
    const archive = cached.archives.get(`${intakeId}/2`); archive.contentBase64 = Buffer.alloc(png.length, 0x61).toString('base64');
    await assert.rejects(cached.service.attachment(input()), { code: 'mail_attachment_changed' }); assert.equal(cached.calls.length, 1);
});

test('maximum 3 MiB original fits response budget exactly; one extra byte is refused before download', async () => {
    const bytes = Buffer.alloc(MAX_ATTACHMENT_BYTES, 0x5a), f = fixture({ bytes });
    const result = await f.service.attachment(input());
    assert.equal(result.attachment.byteLength, MAX_ATTACHMENT_BYTES);
    assert.equal(Buffer.byteLength(JSON.stringify(result)) < 4500000, true);
    assert.equal(result.attachment.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    const over = fixture({ bytes: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) });
    await assert.rejects(over.service.attachment(input()), { status: 413 }); assert.equal(over.calls.length, 0);
});

test('filename, source-size and canonical Base64 mismatch, provider redirect/error and truncated streams cannot archive', async () => {
    const providers = [
        () => new Response(JSON.stringify({ filename: 'different.xlsx', data: Buffer.from('original spreadsheet bytes').toString('base64') })),
        () => new Response(JSON.stringify({ filename: '원본 발주서.xlsx', data: Buffer.from('wrong length').toString('base64') })),
        () => new Response(JSON.stringify({ filename: '원본 발주서.xlsx', data: 'b3JpZ2luYWwgc3ByZWFkc2hlZXQgYnl0ZXM=\n' })),
        () => new Response('', { status: 302, headers: { location: 'https://evil.invalid/exfiltrate' } }),
        () => new Response('private upstream detail', { status: 500 }),
        () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([123])); controller.error(new Error('private transport detail')); } })),
        () => new Response('{"data":"truncated'),
    ];
    for (const provider of providers) {
        const f = fixture({ provider });
        await assert.rejects(f.service.attachment(input()), error => error.status >= 400 && !error.message.includes('private'));
        assert.equal(f.writes.length, 0);
    }
});

test('stream byte budget is enforced even without Content-Length and cancels oversized body', async () => {
    let cancelled = false;
    const f = fixture({ provider: () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } })) });
    await assert.rejects(f.service.attachment(input()), { status: 413 });
    assert.equal(cancelled, true); assert.equal(f.writes.length, 0);
});

test('mail source APIs permit approved manager readers while OAuth and sync remain admin-only; input/same-origin restrictions fail before service', async () => {
    let used = 0;
    const service = { source: async data => { used++; return { ok: true, data }; }, attachment: async data => { used++; return { ok: true, data }; }, sync: async () => { used++; return { ok: true }; } };
    const run = async (action, req, role) => {
        const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = JSON.parse(value); } };
        await createHandler(action, { service, store: {}, authorize: async () => ({ uid: role, role }) })(req, res);
        return res;
    };
    const get = { method: 'GET', url: '/api/naverworks/source', headers: {} };
    const post = { method: 'POST', url: '/api/naverworks/attachment', headers: { origin: APP_ORIGIN, 'content-type': 'application/json' }, body: input() };
    for (const role of ['admin', 'manager']) {
        assert.equal((await run('source', get, role)).statusCode, 200);
        assert.equal((await run('attachment', post, role)).statusCode, 200);
    }
    const before = used;
    for (const [action, req, role, status] of [
        ['source', get, 'worker', 403], ['source', get, undefined, 403], ['sync', post, 'manager', 403],
        ['attachment', { ...post, headers: { ...post.headers, origin: 'https://evil.invalid' } }, 'manager', 403],
        ['attachment', { ...post, body: { ...input(), url: 'https://evil.invalid' } }, 'admin', 400],
        ['attachment', { ...post, body: { ...input(), attachmentId: 2 } }, 'admin', 400],
        ['attachment', { ...post, body: 'x'.repeat(4097) }, 'admin', 413],
        ['source', { ...get, url: `${get.url}?cursor=a&cursor=b` }, 'manager', 400],
        ['source', { ...get, url: `${get.url}?intakeId=${intakeId}&cursor=x` }, 'manager', 400],
        ['source', { ...get, url: `${get.url}?url=https://evil.invalid` }, 'manager', 400],
    ]) assert.equal((await run(action, req, role)).statusCode, status);
    assert.equal(used, before);
});

test('source response exceeding the platform budget fails with a small safe response', async () => {
    const service = { source: async () => ({ ok: true, mail: { raw: { body: 'x'.repeat(4400000) } } }) };
    const res = { setHeader() {}, end(value) { this.body = value; } };
    await createHandler('source', { service, store: {}, authorize: async () => ({ uid: 'admin', role: 'admin' }) })({ method: 'GET', url: '/api/naverworks/source', headers: {} }, res);
    assert.equal(res.statusCode, 413);
    assert.equal(JSON.parse(res.body).code, 'mail_response_too_large');
    assert.ok(Buffer.byteLength(res.body) < 1000);
});
