import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildTextSource, buildTextSourceId, publicTextSource, textSourceMail, MAX_IMAGE_BYTES } from '../lib/server/order-text-source.cjs';
import { createOrderTextSourceStore } from '../lib/server/order-text-source-store.cjs';
import { createHandler } from '../lib/server/order-text-source-service.cjs';
import { createOrderAiService } from '../lib/server/order-ai-service.cjs';
import { encodeFields, decodeFields } from '../lib/server/mail-integration-store.cjs';
import { createOrderAiTextSource } from '../dashboard/js/order-text-source-model.js';

const actor = { uid: 'manager', role: 'manager' }, requestId = '6b8d8c9a-c917-43e4-a514-0af9b3819a6d';
const raw = '  가상 급식업체\r\n국산 참기름 1L 2병\r\n국산 참기름 1L 3병  ';
const input = { requestId, channel: 'kakao', text: raw };
const createdAt = '2026-10-22T00:00:00.123Z';
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1EAAAAASUVORK5CYII=';
// A deterministic 1x1 JPEG fixture; original bytes must never be re-encoded.
const jpegBase64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==';
const imageInput = () => ({ requestId, channel: 'kakao', image: { fileName: '가상 발주.png', mimeType: 'image/png', contentBase64: pngBase64 } });
const full = () => { const built = buildTextSource(input, actor.uid); return { id: built.id, ...built.data, createdAt }; };
const toRecord = source => { const { id, ...data } = source; return data; };
function restFixture(options = {}) {
    const records = new Map(), calls = [];
    const store = createOrderTextSourceStore({ token: 'fictional-user-token', fetchImpl: async (url, init = {}) => {
        calls.push({ url, init });
        if (String(url).endsWith(':runQuery')) {
            const fields = JSON.parse(init.body).structuredQuery.select.fields.map(item => item.fieldPath);
            assert.equal(fields.includes('text'), false); assert.equal(fields.includes('contentBase64'), false);
            return new Response(JSON.stringify([...records].map(([id, data]) => ({ document: { name: `test/orderTextSources/${id}`, fields: encodeFields(Object.fromEntries(Object.entries(data).filter(([name]) => fields.includes(name)))) } }))));
        }
        if (String(url).endsWith(':commit')) {
            const write = JSON.parse(init.body).writes[0], id = write.update.name.split('/').at(-1);
            assert.deepEqual(write.currentDocument, { exists: false });
            assert.deepEqual(write.updateTransforms, [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }]);
            assert.equal('createdAt' in write.update.fields, false);
            if (records.has(id)) return new Response(JSON.stringify({ error: { status: 'ALREADY_EXISTS' } }), { status: 409 });
            records.set(id, { ...decodeFields(write.update.fields), createdAt });
            if (options.loseCommitResponse) { options.loseCommitResponse = false; throw new TypeError('simulated lost response'); }
            if (options.concurrent) return new Response(JSON.stringify({ error: { status: 'ALREADY_EXISTS' } }), { status: 409 });
            return new Response(JSON.stringify({ commitTime: createdAt }));
        }
        const id = String(url).split('/').at(-1), record = records.get(id);
        return record ? new Response(JSON.stringify({ fields: encodeFields(record) })) : new Response('{}', { status: 404 });
    } });
    return { store, calls, records };
}
const req = (method = 'POST', body = input, extra = {}) => ({ method, url: '/api/order-ai/text-sources', headers: { authorization: 'Bearer fictional-test', origin: 'https://dashboard.dmnfood.co.kr', 'content-type': 'application/json' }, body, ...extra });
async function invoke(handler, request) { let value; const headers = {}; const response = { setHeader: (name, item) => headers[name] = item, end: item => value = JSON.parse(item) }; await handler(request, response); return { status: response.statusCode, body: value, headers }; }

test('pasted source preserves every character and hashes exact UTF-8 bytes without normalizing whitespace or line endings', () => {
    const built = buildTextSource(input, actor.uid);
    assert.equal(built.data.text, raw); assert.equal(built.data.sha256, createHash('sha256').update(raw, 'utf8').digest('hex'));
    assert.equal(built.data.title, '가상 급식업체'); assert.equal(built.data.scope, 'school_meal');
    assert.equal(buildTextSourceId(actor.uid, requestId.toUpperCase()), built.id);
    assert.notEqual(buildTextSourceId('another-manager', requestId), built.id);
    assert.notEqual(buildTextSourceId(actor.uid, '6b8d8c9a-c917-43e4-a514-0af9b3819a6e'), built.id);
    assert.notEqual(buildTextSource({ ...input, text: raw.replaceAll('\r\n', '\n') }, actor.uid).data.sha256, built.data.sha256);
    assert.equal(buildTextSource({ ...input, text: '😀'.repeat(100) }, actor.uid).data.title.length, 80);
});
test('invalid raw text, forged identity/hash/title and unsupported channels cannot enter the source store', () => {
    for (const text of ['', ' \r\n\t', 'x'.repeat(20001), 'invalid\u0000text', '\ud800']) assert.throws(() => buildTextSource({ ...input, text }, actor.uid));
    for (const value of [{ ...input, channel: 'email' }, { ...input, requestId: '../request' }, { ...input, sha256: 'a'.repeat(64) }, { ...input, title: 'client title' }, { ...input, scope: 'all' }]) assert.throws(() => buildTextSource(value, actor.uid));
    const source = full();
    assert.equal(publicTextSource(source.id, toRecord(source)).text, raw);
    for (const change of [{ text: raw + ' ' }, { sha256: 'a'.repeat(64) }, { title: 'forged title' }, { scope: 'all' }, { createdAt: 'invalid-date' }, { erpCode: 'invented' }]) assert.throws(() => publicTextSource(source.id, { ...toRecord(source), ...change }));
    const mail = textSourceMail(source); assert.equal(mail.sourceKind, 'text'); assert.equal(mail.rawStorage.sha256, source.sha256); assert.equal(mail.textSource.text, raw);
});
test('REST create uses the employee token and server timestamp; same request is idempotent while changed text conflicts', async () => {
    const f = restFixture(), first = await f.store.create(input, actor.uid);
    assert.equal(first.created, true); assert.deepEqual(first.source, full());
    const second = await f.store.create(input, actor.uid); assert.equal(second.created, false); assert.deepEqual(second.source, first.source);
    await assert.rejects(f.store.create({ ...input, text: raw + '수정' }, actor.uid), { code: 'text_source_request_reused' });
    await assert.rejects(f.store.create({ ...input, channel: 'sms' }, actor.uid), { code: 'text_source_request_reused' });
    assert.equal(f.calls.filter(call => call.url.endsWith(':commit')).length, 1);
    assert.ok(f.calls.every(call => call.init.headers.Authorization === 'Bearer fictional-user-token'));
    const list = await f.store.list(); assert.equal(list[0].id, first.source.id); assert.equal('text' in list[0], false);
    assert.equal((await f.store.get(first.source.id)).text, raw);
});
test('concurrent create and uncertain write outcomes recover the original request without making a second document', async () => {
    const concurrent = restFixture({ concurrent: true }); assert.equal((await concurrent.store.create(input, actor.uid)).created, false); assert.equal(concurrent.records.size, 1);
    const lost = restFixture({ loseCommitResponse: true });
    await assert.rejects(lost.store.create(input, actor.uid), { code: 'text_source_store_unavailable' });
    assert.equal(lost.calls.filter(call => call.url.endsWith(':commit')).length, 1, 'a failed request never automatically repeats a write');
    const recovered = await lost.store.create(input, actor.uid); assert.equal(recovered.created, false); assert.equal(lost.records.size, 1);
    assert.equal(lost.calls.filter(call => call.url.endsWith(':commit')).length, 1);
});
test('API supports authorized save/list/detail and never analyzes or sends the pasted message during storage', async () => {
    const f = restFixture(), handler = createHandler({ authorize: async () => actor, store: f.store });
    const saved = await invoke(handler, req()); assert.equal(saved.status, 200); assert.equal(saved.body.source.text, raw); assert.equal(saved.body.created, true);
    const listed = await invoke(handler, req('GET', undefined)); assert.equal(listed.status, 200); assert.equal(listed.body.sources.length, 1); assert.equal('text' in listed.body.sources[0], false);
    const read = await invoke(handler, req('GET', undefined, { url: `/api/order-ai/text-sources?id=${saved.body.source.id}` })); assert.equal(read.body.source.text, raw);
    assert.equal((await invoke(handler, req('GET', undefined, { url: '/api/order-ai/text-sources?id=invalid' }))).status, 400);
    assert.equal((await invoke(handler, req('GET', undefined, { url: '/api/order-ai/text-sources?id=' + 'a'.repeat(64) }))).status, 404);
    assert.ok(f.calls.every(call => call.url.startsWith('https://firestore.googleapis.com/')));
    assert.equal(saved.headers['Cache-Control'], 'no-store');
});
test('authorization, same-origin JSON, query boundaries and request limits are enforced before any write', async () => {
    for (const [authorize, request, status] of [
        [async () => { throw Object.assign(new Error('로그인 필요'), { status: 401 }); }, req(), 401],
        [async () => ({ uid: 'worker', role: 'worker' }), req(), 403],
        [async () => actor, req('PUT'), 405],
        [async () => actor, req('POST', input, { headers: { origin: 'https://evil.invalid', 'content-type': 'application/json' } }), 403],
        [async () => actor, req('POST', input, { headers: { origin: 'https://dashboard.dmnfood.co.kr', 'content-type': 'text/plain' } }), 415],
        [async () => actor, req('POST', 'x'.repeat(900001)), 413],
        [async () => actor, req('POST', '{invalid'), 400],
        [async () => actor, req('GET', null, { url: '/api/order-ai/text-sources?other=1' }), 400],
        [async () => actor, req('GET', null, { url: '/api/order-ai/text-sources?id=a&id=b' }), 400],
        [async () => actor, req('POST', input, { url: '/api/order-ai/text-sources?id=extra' }), 400],
    ]) {
        const f = restFixture(), response = await invoke(createHandler({ authorize, store: f.store }), request);
        assert.equal(response.status, status); assert.equal(f.records.size, 0); assert.equal(f.calls.length, 0);
    }
});
test('manual image storage preserves original bytes and hash and never exposes blobs in the projected source list', async () => {
    const request = imageInput(), built = buildTextSource(request, actor.uid), bytes = Buffer.from(pngBase64, 'base64');
    assert.equal(built.data.kind, 'image'); assert.equal(built.data.byteLength, bytes.length); assert.equal(built.data.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(built.data.contentBase64, pngBase64); assert.equal('text' in built.data, false);
    const dto = publicTextSource(built.id, { ...built.data, createdAt }); assert.equal(textSourceMail(dto).sourceKind, 'image');
    assert.equal('contentBase64' in publicTextSource(built.id, { ...built.data, createdAt }, { summary: true }), false);
    const f = restFixture(), handler = createHandler({ authorize: async () => actor, store: f.store });
    const saved = await invoke(handler, req('POST', request)); assert.equal(saved.status, 200); assert.equal(saved.body.source.contentBase64, pngBase64);
    const listed = await f.store.list(); assert.equal(listed[0].kind, 'image'); assert.equal(listed[0].byteLength, bytes.length); assert.equal('contentBase64' in listed[0], false);
    assert.equal((await f.store.create(request, actor.uid)).created, false);
    await assert.rejects(f.store.create(input, actor.uid), { code: 'text_source_request_reused' });
    await assert.rejects(f.store.create({ ...request, image: { ...request.image, fileName: 'different.png' } }, actor.uid), { code: 'text_source_request_reused' });
    assert.equal((await f.store.get(built.id)).contentBase64, pngBase64);
    for (const fileName of ['가상 캡처.jpg', '가상 캡처.JPEG']) {
        const jpeg = buildTextSource({ ...request, image: { fileName, mimeType: 'image/jpeg', contentBase64: jpegBase64 } }, actor.uid);
        assert.equal(jpeg.data.contentBase64, jpegBase64); assert.equal(jpeg.data.sha256, createHash('sha256').update(Buffer.from(jpegBase64, 'base64')).digest('hex'));
        assert.equal(publicTextSource(jpeg.id, { ...jpeg.data, createdAt }).mimeType, 'image/jpeg');
    }
});
test('image intake rejects noncanonical base64, mismatched MIME/extension, unsafe names, oversized pixels/bytes and mutated archive metadata', () => {
    const request = imageInput();
    for (const image of [
        { ...request.image, fileName: 'wrong.jpg' }, { ...request.image, mimeType: 'image/gif' }, { ...request.image, fileName: '../source.png' },
        { ...request.image, fileName: 'invalid\u0000.png' }, { ...request.image, contentBase64: pngBase64 + '\n' },
        { ...request.image, contentBase64: pngBase64.replace(/=$/, '') }, { ...request.image, contentBase64: 'data:image/png;base64,' + pngBase64 },
        { ...request.image, contentBase64: Buffer.from('not an image').toString('base64') }, { ...request.image, byteLength: 1 },
    ]) assert.throws(() => buildTextSource({ ...request, image }, actor.uid));
    assert.throws(() => buildTextSource({ ...request, text: 'cannot mix text and image' }, actor.uid));
    const largePixels = Buffer.from(pngBase64, 'base64'); largePixels.writeUInt32BE(20000, 16); largePixels.writeUInt32BE(20000, 20);
    assert.throws(() => buildTextSource({ ...request, image: { ...request.image, contentBase64: largePixels.toString('base64') } }, actor.uid));
    const maximum = Buffer.concat([Buffer.from(pngBase64, 'base64'), Buffer.alloc(MAX_IMAGE_BYTES - Buffer.from(pngBase64, 'base64').length)]);
    assert.equal(buildTextSource({ ...request, image: { ...request.image, contentBase64: maximum.toString('base64') } }, actor.uid).data.byteLength, MAX_IMAGE_BYTES);
    assert.throws(() => buildTextSource({ ...request, image: { ...request.image, contentBase64: Buffer.concat([maximum, Buffer.from([0])]).toString('base64') } }, actor.uid));
    const built = buildTextSource(request, actor.uid);
    for (const change of [{ byteLength: 1 }, { sha256: 'f'.repeat(64) }, { mimeType: 'image/jpeg' }, { contentBase64: pngBase64.slice(0, -4) }, { text: 'extra field' }, { title: 'forged' }]) assert.throws(() => publicTextSource(built.id, { ...built.data, ...change, createdAt }));
});

test('manual image analysis sends original bytes once and preserves image evidence through source-bound human confirmation', async () => {
    const built = buildTextSource(imageInput(), actor.uid); let original = { ...built.data, createdAt }, record = null, providerCalls = 0, mailCalls = 0;
    const customerId = 'school-' + 'c'.repeat(24), customers = [{ id: customerId, name: '가상 급식업체', revision: 1, source: 'school_meal', erpCode: null }];
    const store = { get: async () => structuredClone(record), textSource: async () => structuredClone(original), customers: async () => structuredClone(customers), acquire: async () => ({}), release: async () => {},
        save: async (id, data) => { record = { data: { ...structuredClone(data), createdAt, updatedAt: `${createdAt}:${data.revision}` }, fields: {}, version: 'fake' }; return structuredClone(record); } };
    const candidate = { assistantMessage: '이미지 원본을 대조해 주세요.', customerId, questions: [], rows: [{ r: 0, d: 'included', x: '', l: [{ p: 4, n: '11', t: '병', b: { x: 0, y: 0, width: 1, height: 1 }, x: [] }] }], excludedRows: [] };
    const service = createOrderAiService({ store, mailService: { source: async () => { mailCalls++; throw new Error('image source must not use mail'); } }, env: { OPENAI_API_KEY: 'fictional-only' },
        fetchImpl: async (url, init) => { providerCalls++; const body = JSON.parse(init.body), data = JSON.parse(body.input[0].content[0].text);
            assert.equal(data.sourceContext.kind, 'image'); assert.equal(data.sources[0].attachmentId, 'message-image'); assert.equal(data.sources[0].sha256, built.data.sha256);
            assert.deepEqual(body.input[0].content[1], { type: 'input_image', image_url: 'data:image/png;base64,' + pngBase64, detail: 'high' });
            return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(candidate) }] }] })); } });
    await assert.rejects(service.analyze({ intakeId: built.id, sourceKind: 'text', expectedRevision: 0 }, actor), { code: 'ai_source_changed' });
    const first = await service.analyze({ intakeId: built.id, sourceKind: 'image', expectedRevision: 0 }, actor);
    assert.equal(first.analysis.readyForReview, true); assert.equal(first.analysis.groups[0].quantity, '11'); assert.equal(first.analysis.sources[0].kind, 'image');
    const review = { intakeId: built.id, sourceKind: 'image', expectedRevision: 1, reviewedGroupIds: first.analysis.groups.map(group => group.id) };
    await assert.rejects(service.confirm({ ...review, reviewedGroupIds: [] }, actor), { code: 'ai_confirmation_blocked' });
    await assert.rejects(service.confirm({ ...review, sourceKind: 'text' }, actor), { code: 'ai_source_changed' });
    const same = original; original = { ...original, byteLength: 1 }; await assert.rejects(service.confirm(review, actor), { code: 'text_source_invalid' }); original = same;
    const confirmed = await service.confirm(review, actor); assert.equal(confirmed.analysis.status, 'confirmed'); assert.equal(providerCalls, 1); assert.equal(mailCalls, 0);
});

function aiFixture() {
    let source = full(), record = null, providerCalls = 0, mailCalls = 0, sourceCalls = 0;
    const customerId = 'school-' + 'c'.repeat(24), customers = [{ id: customerId, name: '가상 급식업체', revision: 1, source: 'school_meal', erpCode: null }];
    const original = createOrderAiTextSource({ text: source.text, sha256: source.sha256, channel: source.channel });
    const tokenAt = (row, value) => original.rows[row].tokens.find(token => token.text === value).index;
    const candidate = { assistantMessage: '원문과 대조해 주세요.', customerId, questions: [], rows: [1, 2].map((r, index) => ({ r, d: 'included', x: '', l: [{ p: 1,
        c: [{ s: 0, e: tokenAt(r, 'L') }], q: { s: tokenAt(r, String(index + 2)), e: tokenAt(r, String(index + 2)) }, u: { s: tokenAt(r, '병'), e: tokenAt(r, '병') }, x: [] }] })), excludedRows: [{ r: [0], x: '거래처 이름' }] };
    const store = { get: async () => structuredClone(record), textSource: async () => { sourceCalls++; return toRecord(source); }, customers: async () => structuredClone(customers), acquire: async () => ({}), release: async () => {},
        save: async (id, data) => { record = { data: { ...structuredClone(data), createdAt, updatedAt: `${createdAt}:${data.revision}` }, fields: {}, version: 'fake' }; return structuredClone(record); } };
    const service = createOrderAiService({ store, mailService: { source: async () => { mailCalls++; throw new Error('mail source must not be used'); } }, env: { OPENAI_API_KEY: 'fictional-only' },
        fetchImpl: async (url, init) => { providerCalls++; const request = JSON.parse(init.body), context = JSON.parse(request.input[0].content[0].text);
            assert.equal(context.sourceContext.kind, 'text'); assert.equal(context.sourceContext.channel, 'kakao'); assert.equal(context.sources[0].text, raw);
            return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(candidate) }] }] })); } });
    return { service, source, setSource: value => source = value, mutateRecord: action => action(record), get record() { return record; }, get counts() { return { providerCalls, mailCalls, sourceCalls }; } };
}
test('text analysis reuses original evidence and exact quantities, and human confirmation re-reads the immutable source without AI or mail access', async () => {
    const f = aiFixture(), first = await f.service.analyze({ intakeId: f.source.id, sourceKind: 'text', expectedRevision: 0 }, actor);
    assert.equal(first.analysis.readyForReview, true); assert.equal(first.analysis.groups[0].quantity, '5'); assert.equal(first.analysis.lines.length, 2);
    assert.equal(first.analysis.sources[0].kind, 'text'); assert.equal(first.analysis.exclusions.length, 1);
    assert.equal(f.source.text.slice(first.analysis.lines[0].source.textRanges.quantity.start, first.analysis.lines[0].source.textRanges.quantity.end), '2');
    const review = { intakeId: f.source.id, sourceKind: 'text', expectedRevision: 1, reviewedGroupIds: first.analysis.groups.map(group => group.id) };
    await assert.rejects(f.service.confirm(review, actor), { code: 'ai_confirmation_blocked' });
    const confirmed = await f.service.confirm({ ...review, reviewedExclusions: true }, actor);
    assert.equal(confirmed.analysis.status, 'confirmed'); assert.equal(f.counts.providerCalls, 1); assert.equal(f.counts.mailCalls, 0); assert.equal(f.counts.sourceCalls, 3);
});
test('changed raw text or persisted totals cannot be confirmed, and source-kind changes cannot replace an existing analysis', async () => {
    const f = aiFixture(), first = await f.service.analyze({ intakeId: f.source.id, sourceKind: 'text', expectedRevision: 0 }, actor);
    const review = { intakeId: f.source.id, sourceKind: 'text', expectedRevision: 1, reviewedGroupIds: first.analysis.groups.map(group => group.id), reviewedExclusions: true };
    f.setSource({ ...f.source, text: f.source.text + '수정' }); await assert.rejects(f.service.confirm(review, actor), { code: 'text_source_invalid' });
    f.setSource(f.source); f.mutateRecord(value => value.data.analysis.groups[0].quantity = '999'); await assert.rejects(f.service.confirm(review, actor), { code: 'ai_confirmation_blocked' });
    await assert.rejects(f.service.analyze({ intakeId: f.source.id, expectedRevision: 1 }, actor), { code: 'ai_source_changed' });
    await assert.rejects(f.service.confirm({ ...review, sourceKind: 'mail' }, actor), { code: 'ai_confirmation_invalid' });
    assert.equal(f.counts.providerCalls, 1); assert.equal(f.counts.mailCalls, 0);
});
