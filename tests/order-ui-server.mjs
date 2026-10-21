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
    '/dashboard/js/mail-connection.js', '/dashboard/css/mail-connection.css',
    '/dashboard/js/mail-source-viewer.js', '/dashboard/css/mail-source-viewer.css',
    '/dashboard/js/mail-workbook-preview.js', '/dashboard/js/mail-workbook-worker.js',
    '/dashboard/js/mail-workbook-model.js', '/dashboard/css/mail-workbook-preview.css',
    '/dashboard/vendor/sheetjs/xlsx.full.min.js',
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
const mailFixtures = [
    { id: 'fictional-school-mail', subject: '[가상 자료] 학교급식 발주서 열람 시험', from: { name: '가상 급식 거래처', email: 'school@example.test' }, receivedAt: '2026-10-21T01:00:00.000Z', collectedAt: '2026-10-21T01:01:00.000Z', folderId: '42', processingStatus: 'pending_interpretation',
        raw: { mail: { mailId: 'fixture-1', subject: '[가상 자료] 학교급식 발주서 열람 시험', body: '<p>가상 학교급식 발주서입니다.</p><p>첨부 Excel의 상품명·수량·일정을 원문으로 확인해 주세요.</p><table><tr><th>안내</th><th>상태</th></tr><tr><td>실제 발주가 아닙니다</td><td>해석 대기</td></tr></table>', from: { name: '가상 급식 거래처', email: 'school@example.test' } }, attachments: [{ attachmentId: '101', filename: '가상 학교급식 발주서.xls', contentType: 'application/vnd.ms-excel', size: (await readFile(new URL('fixtures/mail-workbooks/sample-school-order.xls', import.meta.url))).length }, { attachmentId: '102', filename: '가상 참고 이미지.png', contentType: 'image/png', size: 100 }, { attachmentId: '103', filename: '가상 대용량 발주서.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 4 * 1024 * 1024 }] } },
    { id: 'fictional-mail-safety', subject: '[가상 자료] 본문 안전 표시 시험', from: { email: 'safety@example.test' }, receivedAt: '2026-10-20T01:00:00.000Z', collectedAt: '2026-10-20T01:01:00.000Z', processingStatus: 'pending_interpretation',
        raw: { mail: { mailId: 'fixture-2', body: '<div onclick="alert(1)" style="background:url(https://example.invalid/mail-css)">안전한 본문 텍스트</div><img src="https://example.invalid/mail-image" onerror="alert(1)" alt="외부 이미지 차단"><script>window.parent.__mailInjected=true</script><iframe src="https://example.invalid/mail-frame"></iframe><form action="https://example.invalid/mail-form"><input value="차단"></form><a href="javascript:alert(1)">외부 링크는 텍스트로 표시</a><svg><a href="https://example.invalid/mail-svg">SVG</a></svg><table><tr><td colspan="2" background="https://example.invalid/mail-bg">보존되는 표</td></tr></table>' }, attachments: [] } },
    { id: 'fictional-mail-title-only', subject: '[가상 자료] 예시 참기름 1.8L 2병', from: 'title@example.test', receivedAt: '2026-10-19T01:00:00.000Z', collectedAt: '2026-10-19T01:01:00.000Z', processingStatus: 'pending_interpretation', raw: { mail: { mailId: 'fixture-3', body: '' }, attachments: [] } },
];
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
        if (url.pathname.startsWith('/api/naverworks/')) {
            if (req.headers.authorization !== 'Bearer fictional-local-token-not-a-firebase-credential') return reply(res, 401, { ok: false });
            const referer = new URL(req.headers.referer || localOrigin);
            if (referer.origin !== localOrigin) return reply(res, 403, { ok: false });
            if (url.pathname.endsWith('/source') && req.method === 'GET') {
                if (referer.searchParams.get('mailSourceScenario') === 'failure') return reply(res, 503, { ok: false });
                const intakeId = url.searchParams.get('intakeId');
                if (intakeId) {
                    const original = mailFixtures.find(record => record.id === intakeId);
                    const mail = original ? structuredClone(original) : null;
                    if (mail && referer.searchParams.get('mailBodyScenario') === 'deep') mail.raw.mail.body = `${'<div>'.repeat(100)}가상 복잡한 본문${'</div>'.repeat(100)}`;
                    if (mail && referer.searchParams.get('mailBodyScenario') === 'large') mail.raw.mail.body = `<p>${'가상 본문 '.repeat(180000)}</p>`;
                    return reply(res, mail ? 200 : 404, mail ? { ok: true, mail } : { ok: false });
                }
                const records = referer.searchParams.get('mailSourceScenario') === 'empty' ? [] : mailFixtures;
                const offset = url.searchParams.get('cursor') === 'fictional-mail-page-2' ? 2 : 0;
                return reply(res, 200, { ok: true, mails: records.slice(offset, offset + 2).map(({ raw, ...summary }) => summary), nextCursor: records.length > offset + 2 ? 'fictional-mail-page-2' : null });
            }
            if (url.pathname.endsWith('/attachment') && req.method === 'POST' && req.headers.origin === localOrigin && req.headers['content-type']?.startsWith('application/json')) {
                const input = await readAction(req);
                if (input.intakeId !== 'fictional-school-mail' || input.attachmentId !== '101') return reply(res, 404, { ok: false });
                const bytes = await readFile(new URL('fixtures/mail-workbooks/sample-school-order.xls', import.meta.url));
                return reply(res, 200, { ok: true, attachment: { id: '101', fileName: '가상 학교급식 발주서.xls', mimeType: 'application/vnd.ms-excel', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: bytes.toString('base64') } });
            }
            if (referer.searchParams.get('verificationRole') !== 'admin') return reply(res, 403, { ok: false });
            const connected = referer.searchParams.get('mailScenario') === 'connected';
            if (url.pathname.endsWith('/status') && req.method === 'GET') return reply(res, 200, {
                ok: true, configuration: { ready: connected, missing: connected ? [] : ['NAVERWORKS_CLIENT_SECRET', 'MAIL_TOKEN_ENCRYPTION_KEY', 'MAIL_COLLECTOR_EMAIL', 'MAIL_COLLECTOR_PASSWORD'] },
                connection: { connected, accessStatus: connected ? 'mailbox_access_verified' : 'not_connected', mailbox: 'official@dmnfood.co.kr' },
            });
            if (url.pathname.endsWith('/folders') && req.method === 'GET') return reply(res, 200, { ok: true, folders: [{ id: '42', name: '가상 발주 시험 메일함' }] });
            if (url.pathname.endsWith('/sync') && req.method === 'POST' && connected && req.headers.origin === localOrigin && req.headers['content-type']?.startsWith('application/json')) {
                const input = await readAction(req);
                if (input.folderId !== '42') return reply(res, 400, { ok: false });
                const complete = input.continuation === 'fictional-local-continuation';
                return reply(res, 200, { ok: true, sync: { status: complete ? 'complete' : 'partial', continuation: complete ? null : 'fictional-local-continuation',
                    scanned: complete ? 20 : 10, collected: complete ? 3 : 2, duplicates: 0, skipped: complete ? 17 : 8,
                    from: new Date(Date.now() - 7 * 86400000).toISOString(), to: new Date().toISOString(), mode: 'fictional_local_only',
                } });
            }
            return reply(res, 503, { ok: false, error: { code: 'configuration_required' } });
        }
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
