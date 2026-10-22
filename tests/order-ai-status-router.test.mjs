import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHandler } from '../lib/server/order-ai-status-router.cjs';
import { createHandler as createAiHandler } from '../lib/server/order-ai-service.cjs';
import { createHandler as createTextHandler } from '../lib/server/order-text-source-service.cjs';
import { createHandler as createBackgroundHandler } from '../lib/server/order-ai-background-service.cjs';
const origin = 'https://dashboard.dmnfood.co.kr', id = 'a'.repeat(64);
const request = (url = '/api/order-ai/status', method = 'GET', body = undefined) => ({ url, method, body, headers: { origin, 'content-type': 'application/json', authorization: 'Bearer fictional-test-token' } });
async function invoke(handler, req) {
    let body; const headers = {}, response = { setHeader: (name, value) => headers[name] = value, end: value => { body = JSON.parse(value); } };
    await handler(req, response); return { status: response.statusCode, body, headers };
}
function routeFixture() {
    const calls = [], stub = route => async (req, res) => { calls.push({ route, req }); res.statusCode = 200; res.end(JSON.stringify({ ok: true, route })); };
    return { calls, handler: createHandler({ statusHandler: stub('status'), textSourceHandler: stub('source'), backgroundHandler: stub('background') }) };
}
test('the existing status route stays unchanged, while intake dispatch removes the private resource marker without mutating the request', async () => {
    const f = routeFixture(), status = request('/api/order-ai/status?other=preserved');
    assert.equal((await invoke(f.handler, status)).body.route, 'status'); assert.equal(f.calls[0].req, status);
    const input = request(`/api/order-ai/status?resource=text-sources&id=${id}`, 'POST', { original: 'preserved' }); input.query = { resource: 'text-sources', id };
    assert.equal((await invoke(f.handler, input)).body.route, 'source');
    const forwarded = f.calls[1].req;
    assert.equal(forwarded.url, '/api/order-ai/status?id=' + id); assert.deepEqual(forwarded.query, { id }); assert.equal(forwarded.body, input.body); assert.equal(forwarded.headers, input.headers);
    assert.match(input.url, /resource=text-sources/); assert.equal(input.query.resource, 'text-sources');
    const framework = request('/api/order-ai/text-sources?id=' + id); framework.query = { resource: 'text-sources', id };
    assert.equal((await invoke(f.handler, framework)).body.route, 'source'); assert.equal(f.calls[2].req.url, '/api/order-ai/text-sources?id=' + id);
    const background = request('/api/order-ai/status?resource=background&cursor=page'); background.query = { resource: 'background', cursor: 'page' };
    assert.equal((await invoke(f.handler, background)).body.route, 'background'); assert.equal(f.calls[3].req.url, '/api/order-ai/status?cursor=page'); assert.deepEqual(f.calls[3].req.query, { cursor: 'page' });
});
test('unknown, duplicate, empty or contradictory dispatch resources cannot reach either handler', async () => {
    for (const req of [request('/api/order-ai/status?resource=unknown'), request('/api/order-ai/status?resource='),
        request('/api/order-ai/status?resource=text-sources&resource=text-sources'),
        { ...request(), query: { resource: ['text-sources', 'text-sources'] } },
        { ...request(), query: { resource: [] } },
        { ...request('/api/order-ai/status?resource=text-sources'), query: { resource: 'unknown' } },
        request('/api/order-ai/status?resource=background&resource=background'),
        { ...request('/api/order-ai/status?resource=background'), query: { resource: 'text-sources' } },
    ]) {
        const f = routeFixture(), response = await invoke(f.handler, req);
        assert.equal(response.status, 400); assert.equal(response.body.code, 'resource_invalid'); assert.equal(f.calls.length, 0); assert.equal(response.headers['Cache-Control'], 'no-store');
    }
});
test('sharing a function entry preserves authorization, method and same-origin guards on both public APIs', async () => {
    const actor = { uid: 'manager', role: 'manager' }; let creates = 0, lists = 0;
    const service = { configuration: () => ({ configured: true, model: 'fictional' }) };
    const store = { list: async () => { lists++; return []; }, create: async () => { creates++; return { source: { id }, created: true }; } };
    const normal = createHandler({ statusHandler: createAiHandler('status', { authorize: async () => actor, service }), textSourceHandler: createTextHandler({ authorize: async () => actor, store }) });
    assert.equal((await invoke(normal, request())).body.configured, true);
    assert.deepEqual((await invoke(normal, request('/api/order-ai/status?resource=text-sources'))).body, { ok: true, sources: [] });
    assert.equal((await invoke(normal, request('/api/order-ai/status', 'POST'))).status, 405);
    assert.equal((await invoke(normal, request('/api/order-ai/status?resource=text-sources', 'DELETE'))).status, 405);
    const evil = request('/api/order-ai/status?resource=text-sources', 'POST', {}); evil.headers.origin = 'https://evil.invalid';
    assert.equal((await invoke(normal, evil)).status, 403); assert.equal(creates, 0);
    const blocked = createHandler({ textSourceHandler: createTextHandler({ authorize: async () => ({ uid: 'worker', role: 'worker' }), store }) });
    assert.equal((await invoke(blocked, request('/api/order-ai/status?resource=text-sources'))).status, 403); assert.equal(lists, 1);
});
test('dispatch preserves IncomingMessage prototype getters for authorization, method and parsed body', async () => {
    const body = { requestId: 'af9a6d7d-5bf4-4b77-8084-a1438cc7ff11', channel: 'sms', text: '국산 참기름 1L 2병' };
    const headers = { origin, 'content-type': 'application/json', authorization: 'Bearer prototype-preserved' };
    const prototype = { get url() { return '/api/order-ai/status?resource=text-sources'; }, get method() { return 'POST'; }, get headers() { return headers; }, get body() { return body; } };
    const incoming = Object.create(prototype); assert.deepEqual(Object.keys(incoming), []);
    const handler = createHandler({ textSourceHandler: createTextHandler({ authorize: async req => { assert.equal(req.headers.authorization, headers.authorization); assert.equal(req.method, 'POST'); return { uid: 'manager', role: 'manager' }; },
        store: { create: async (input, uid) => { assert.equal(input, body); assert.equal(uid, 'manager'); return { source: { id }, created: true }; } } }) });
    const result = await invoke(handler, incoming); assert.equal(result.status, 200); assert.equal(result.body.created, true);
    assert.equal(incoming.url, '/api/order-ai/status?resource=text-sources');
});

test('background dispatch keeps its public contract and requires the same approved role and origin as the existing APIs', async () => {
    const calls = [], actor = { uid: 'manager', role: 'manager' }, service = {
        list: async input => { calls.push(['list', input]); return { ok: true, items: [{ intakeId: id, state: 'pending' }], nextCursor: null }; },
        analyze: async (key, human) => { calls.push(['analyze', key, human.uid]); return { ok: true, intakeId: key, state: 'ready', revision: 1 }; },
    };
    const handler = createHandler({ backgroundHandler: createBackgroundHandler({ authorize: async () => actor, service }) });
    const listed = await invoke(handler, request('/api/order-ai/status?resource=background&cursor=page'));
    assert.equal(listed.body.items[0].state, 'pending'); assert.deepEqual(calls[0], ['list', { cursor: 'page' }]);
    const analyzed = await invoke(handler, request('/api/order-ai/status?resource=background', 'POST', { action: 'analyze', intakeId: id }));
    assert.equal(analyzed.body.state, 'ready'); assert.deepEqual(calls[1], ['analyze', id, 'manager']);
    const evil = request('/api/order-ai/status?resource=background', 'POST', { action: 'analyze', intakeId: id }); evil.headers.origin = 'https://evil.invalid';
    assert.equal((await invoke(handler, evil)).status, 403);
    const blocked = createHandler({ backgroundHandler: createBackgroundHandler({ authorize: async () => ({ uid: 'worker', role: 'worker' }), service }) });
    assert.equal((await invoke(blocked, request('/api/order-ai/status?resource=background'))).status, 403); assert.equal(calls.length, 2);
});
test('deployment keeps twelve function entries and rewrites the unchanged public source path into the shared authenticated entry', () => {
    const folder = new URL('../api/', import.meta.url);
    function entries(path) { return readdirSync(path, { withFileTypes: true }).flatMap(item => item.isDirectory() ? entries(new URL(item.name + '/', path)) : item.name.endsWith('.js') ? [item.name] : []); }
    assert.equal(entries(folder).length, 12);
    const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    const rewrites = config.rewrites.filter(rule => rule.source === '/api/order-ai/text-sources');
    assert.deepEqual(rewrites, [{ source: '/api/order-ai/text-sources', destination: '/api/order-ai/status?resource=text-sources' }]);
    assert.deepEqual(config.rewrites.filter(rule => rule.source === '/api/order-ai/background'), [{ source: '/api/order-ai/background', destination: '/api/order-ai/status?resource=background' }]);
    assert.match(readFileSync(new URL('../api/order-ai/status.js', import.meta.url), 'utf8'), /order-ai-status-router/);
});
