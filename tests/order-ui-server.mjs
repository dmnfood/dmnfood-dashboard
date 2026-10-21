// LOCAL BROWSER VERIFICATION ONLY. This server deliberately supplies fictional
// auth/data transports, binds loopback, and serves an exact UI-file allowlist.
// Never deploy it or include it in production routing.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import {
    assertOrderRevision, buildOrderReview, emptyReviewChecks, normalizeOrderDraft,
    validateOrderDraft, validateOrderInput,
} from '../dashboard/js/order-request-model.js';

const HOST = '127.0.0.1', PORT = 4175;
const base = new URL('../', import.meta.url);
const orders = new Map(), streams = new Set();
const actor = { uid: 'fictional-local-manager', name: '가상 검증 담당자' };
const uiFiles = new Set([
    '/dashboard/home.html', '/dashboard/orders.html', '/dashboard/js/orders.js',
    '/dashboard/js/order-notifications.js', '/dashboard/js/order-notification-utils.js',
    '/dashboard/js/order-request-model.js', '/dashboard/js/haccp-navigation.js', '/dashboard/style.css',
    '/dashboard/css/user-management.css',
    '/dashboard/css/orders.css', '/dashboard/css/order-notifications.css',
]);
const fixtures = new Map([
    ['/dashboard/js/firebase-client.js', 'order-ui-auth.js'],
    ['/dashboard/js/users.js', 'order-ui-users.js'],
    ['/dashboard/js/order-request-store.js', 'order-ui-store.js'],
    ['/__order_ui/transport.js', 'order-ui-transport.js'],
    ['/__order_ui/firestore.js', 'order-ui-firestore.js'],
]);
const headers = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
};
const timestamp = () => ({ seconds: Date.now() / 1000 });
const state = () => [...orders.values()].sort((a, b) => b.createdAt.seconds - a.createdAt.seconds);
const snapshot = () => `data: ${JSON.stringify(state())}\n\n`;
function broadcast() { for (const stream of streams) stream.write(snapshot()); }
function reply(res, status, value, type = 'application/json; charset=utf-8', additionalHeaders = {}) {
    res.writeHead(status, { ...headers, 'Content-Type': type, ...additionalHeaders });
    res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}
function failIf(errors) { if (errors.length) throw new Error(errors.join('\n')); }
function applyAction(action) {
    if (action.type === 'create') {
        if (action.input?.isTest !== true) throw new Error('로컬 검증에서는 테스트 표시가 있는 가상 발주만 등록할 수 있습니다.');
        const input = action.input;
        const values = { customerName: String(input.customerName || '').trim(), customerGroup: input.customerGroup,
            sourceChannel: input.sourceChannel, sourceText: String(input.sourceText || '').trim(),
            sourceReference: String(input.sourceReference || '').trim(), isTest: true, draft: normalizeOrderDraft(input.draft) };
        failIf(validateOrderInput(values));
        const id = `local-test-${randomUUID()}`, now = timestamp();
        orders.set(id, { schemaVersion: 1, id, ...values, revision: 1, status: 'pending_review',
            createdByUid: actor.uid, createdByName: actor.name, receivedAt: now, createdAt: now, updatedAt: now,
            reviewNotes: '', reviewChecks: emptyReviewChecks(), reviewedByUid: '', reviewedByName: '', reviewedAt: null, approvedRevision: 0 });
        return { id, revision: 1, status: 'pending_review' };
    }
    const existing = orders.get(action.id);
    if (!existing) throw new Error('발주를 찾을 수 없습니다.');
    assertOrderRevision(existing, action.expectedRevision);
    if (action.type === 'update') {
        const draft = normalizeOrderDraft(action.input?.draft || action.input);
        failIf(validateOrderDraft(draft));
        orders.set(action.id, { ...existing, draft, revision: action.expectedRevision + 1, status: 'pending_review',
            updatedAt: timestamp(), reviewNotes: '', reviewChecks: emptyReviewChecks(), reviewedByUid: '', reviewedByName: '', reviewedAt: null, approvedRevision: 0 });
    } else if (action.type === 'review') {
        const review = buildOrderReview(existing, action.expectedRevision, action.decision, actor);
        orders.set(action.id, { ...existing, ...review, reviewedAt: timestamp(), updatedAt: timestamp() });
    } else throw new Error('지원하지 않는 로컬 검증 동작입니다.');
    const updated = orders.get(action.id);
    return { id: action.id, revision: updated.revision, status: updated.status };
}
async function readAction(req) {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 131072) throw new Error('요청 크기가 너무 큽니다.');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (req, res) => {
    const localOrigin = `http://${req.headers.host}`;
    if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)
        || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))
        || (req.headers.origin && req.headers.origin !== localOrigin)) return reply(res, 403, { error: 'Loopback verification only.' });
    const url = new URL(req.url, localOrigin);
    try {
        if (url.pathname === '/__order_ui/events' && req.method === 'GET') {
            res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
            streams.add(res); res.write(snapshot());
            req.on('close', () => streams.delete(res));
            return;
        }
        if (url.pathname === '/__order_ui/state' && req.method === 'GET') return reply(res, 200, state());
        if (url.pathname === '/__order_ui/action' && req.method === 'POST') {
            if (req.headers.origin !== localOrigin || !req.headers['content-type']?.startsWith('application/json')) return reply(res, 403, { error: 'Same-origin JSON requests only.' });
            const result = applyAction(await readAction(req));
            broadcast(); return reply(res, 200, result);
        }
        if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, { error: 'Method not allowed.' });
        if (url.pathname === '/') { res.writeHead(302, { ...headers, Location: '/orders' }); res.end(); return; }
        if (url.pathname === '/favicon.ico') { res.writeHead(204, headers); res.end(); return; }
        if (fixtures.has(url.pathname)) {
            const contents = await readFile(new URL(`fixtures/${fixtures.get(url.pathname)}`, import.meta.url), 'utf8');
            return reply(res, 200, contents, 'text/javascript; charset=utf-8');
        }
        const path = url.pathname === '/home' ? '/dashboard/home.html' : url.pathname === '/orders' ? '/dashboard/orders.html' : url.pathname;
        if (!uiFiles.has(path)) return reply(res, 404, { error: 'This local harness serves only the dashboard home and order UI.' });
        let contents = await readFile(new URL(path.slice(1), base), 'utf8');
        if (path === '/dashboard/js/order-notifications.js') contents = contents.replaceAll('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js', '/__order_ui/firestore.js');
        if (path === '/dashboard/style.css') contents = contents.replace(/^@import[^\r\n]+[\r\n]*/gm, '');
        const pageHeaders = {};
        if (path === '/dashboard/home.html') {
            // Authorize the existing page's exact inline module without allowing
            // arbitrary inline scripts or any remote code in this local harness.
            // HTML parsing normalizes CRLF/CR line endings before CSP hashing.
            const scriptHashes = [...contents.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
                .map(([, script]) => `'sha256-${createHash('sha256').update(script.replace(/\r\n?/g, '\n')).digest('base64')}'`);
            pageHeaders['Content-Security-Policy'] = headers['Content-Security-Policy']
                .replace("script-src 'self';", `script-src 'self' ${scriptHashes.join(' ')};`);
        }
        return reply(res, 200, contents, path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', pageHeaders);
    } catch (error) { reply(res, 400, { error: error.message || 'Local verification failed.' }); }
});
server.listen(PORT, HOST, () => console.info(`LOCAL FICTIONAL DATA ONLY: http://${HOST}:${PORT}/home → /orders (empty in-memory store; no Firebase or credentials)`));
function stop() { for (const stream of streams) stream.end(); server.close(); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
