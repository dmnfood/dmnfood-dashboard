'use strict';

const authorize = require('./firebase-authorize.cjs');
const { createMailService, COOKIE_NAME, APP_ORIGIN } = require('./naverworks-core.cjs');
const send = (res, status, payload) => {
    let body = JSON.stringify(payload);
    // Source snapshots can approach 4 MiB; repeated metadata must not exceed the platform cap.
    if (Buffer.byteLength(body) > 4400000) {
        status = 413;
        body = JSON.stringify({ ok: false, code: 'mail_response_too_large', message: '원문이 화면 열람 한도를 초과했습니다. 네이버웍스 원문에서 확인해 주세요.' });
    }
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(body);
};
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });

function createHandler(action, options = {}) {
    return async (req, res) => {
        const method = ['callback', 'status', 'folders', 'source'].includes(action) ? 'GET' : 'POST';
        if (req.method !== method) {
            res.setHeader('Allow', method);
            return send(res, 405, { ok: false, code: 'method_not_allowed', message: `${method} 요청만 지원합니다.` });
        }
        let service;
        try {
            if (action !== 'callback') {
                const session = await (options.authorize || authorize)(req);
                const sourceRead = action === 'source' || action === 'attachment';
                if (sourceRead ? !['admin', 'manager'].includes(session.role) : session.role !== 'admin') throw failure(403, sourceRead ? 'mail_reader_required' : 'mail_admin_required', sourceRead ? '메일 원문은 승인된 관리자와 매니저만 열람할 수 있습니다.' : '메일 연결 설정과 시험 조회는 관리자만 사용할 수 있습니다.');
                req.mailSession = session;
                if (method === 'POST') {
                    if (req.headers?.origin !== APP_ORIGIN) throw failure(403, 'mail_origin_invalid', '대시보드에서 연결 요청을 다시 시작해 주세요.');
                    if (!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) throw failure(415, 'json_required', 'JSON 요청만 지원합니다.');
                }
            }
            const store = options.store || require('./mail-integration-store.cjs').createMailboxStore();
            service = options.service || createMailService({ store, ...options });
            if (action === 'callback') {
                const url = new URL(req.url, APP_ORIGIN);
                const query = name => url.searchParams.getAll(name).length === 1 ? url.searchParams.get(name) : null;
                const cookies = String(req.headers?.cookie || '').split(';').map(item => item.trim().split('='));
                const cookie = cookies.filter(([name]) => name === COOKIE_NAME);
                if (query('error')) throw failure(400, 'mail_oauth_denied', '메일 연결 동의가 완료되지 않았습니다.');
                await service.callback({ state: query('state'), code: query('code'), cookie: cookie.length === 1 ? cookie[0][1] : null });
                res.statusCode = 303;
                res.setHeader('Cache-Control', 'no-store');
                res.setHeader('Referrer-Policy', 'no-referrer');
                res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
                res.setHeader('Location', `${APP_ORIGIN}/orders?mail_connection=connected`);
                return res.end();
            }
            if (action === 'status') return send(res, 200, await service.status());
            if (action === 'folders') return send(res, 200, await service.folders());
            if (action === 'source') {
                const query = new URL(req.url, APP_ORIGIN).searchParams;
                if ([...query.keys()].some(key => !['intakeId', 'cursor', 'folderId'].includes(key)) || query.getAll('intakeId').length > 1 || query.getAll('cursor').length > 1 || query.getAll('folderId').length > 1
                    || (query.has('intakeId') && (query.has('cursor') || query.has('folderId'))) || (query.has('intakeId') && !query.get('intakeId')) || (query.has('cursor') && !query.get('cursor'))
                    || (query.has('folderId') && !/^-?\d{1,12}$/.test(query.get('folderId')))) throw failure(400, 'mail_source_input_invalid', '메일 목록 또는 원문 요청을 확인해 주세요.');
                return send(res, 200, await service.source({ intakeId: query.get('intakeId'), cursor: query.get('cursor'), folderId: query.get('folderId') }));
            }
            if (action === 'start') {
                const result = await service.start(req.mailSession.uid, req.headers.authorization);
                res.setHeader('Set-Cookie', result.cookie);
                return send(res, 200, { ok: true, authorizationUrl: result.authorizationUrl });
            }
            if (action === 'sync') {
                let input = req.body || {};
                if (typeof input === 'string') {
                    if (input.length > 25000) throw failure(413, 'request_too_large', '요청이 너무 큽니다.');
                    try { input = JSON.parse(input); } catch { throw failure(400, 'json_invalid', '조회 요청을 확인하지 못했습니다.'); }
                }
                if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['folderId', 'continuation', 'scope'].includes(key))) throw failure(400, 'mail_sync_input_invalid', '메일함을 선택해 최근 7일 시험 조회를 시작해 주세요.');
                return send(res, 200, await service.sync(req.mailSession.uid, input));
            }
            if (action === 'attachment') {
                let input = req.body;
                if (typeof input === 'string') {
                    if (Buffer.byteLength(input) > 4096) throw failure(413, 'request_too_large', '요청이 너무 큽니다.');
                    try { input = JSON.parse(input); } catch { throw failure(400, 'json_invalid', '첨부 파일 요청을 확인하지 못했습니다.'); }
                }
                if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'attachmentId,intakeId'
                    || typeof input.intakeId !== 'string' || typeof input.attachmentId !== 'string') throw failure(400, 'mail_attachment_input_invalid', '열람할 메일과 첨부 파일을 다시 선택해 주세요.');
                return send(res, 200, await service.attachment(input));
            }
            throw failure(404, 'not_found', '요청을 찾을 수 없습니다.');
        } catch (error) {
            if (action === 'callback') {
                res.statusCode = 303;
                res.setHeader('Cache-Control', 'no-store');
                res.setHeader('Referrer-Policy', 'no-referrer');
                res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
                res.setHeader('Location', `${APP_ORIGIN}/orders?mail_connection=error`);
                return res.end();
            }
            // Upstream errors and secrets are never included in responses or logs.
            const safe = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599;
            return send(res, safe ? error.status : 503, { ok: false, code: error.code || 'mail_service_unavailable', message: safe ? error.message : '메일 연결 서비스를 확인하지 못했습니다. 관리자 설정을 확인해 주세요.' });
        }
    };
}

module.exports = { createHandler };
