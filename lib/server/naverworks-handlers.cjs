'use strict';

const authorize = require('./firebase-authorize.cjs');
const { createMailService, COOKIE_NAME, APP_ORIGIN } = require('./naverworks-core.cjs');
const send = (res, status, payload) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.end(JSON.stringify(payload));
};
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });

function createHandler(action, options = {}) {
    return async (req, res) => {
        const method = action === 'callback' || action === 'status' || action === 'folders' ? 'GET' : 'POST';
        if (req.method !== method) {
            res.setHeader('Allow', method);
            return send(res, 405, { ok: false, code: 'method_not_allowed', message: `${method} 요청만 지원합니다.` });
        }
        let service;
        try {
            if (action !== 'callback') {
                const session = await (options.authorize || authorize)(req);
                if (session.role !== 'admin') throw failure(403, 'mail_admin_required', '메일 연결 설정과 시험 조회는 관리자만 사용할 수 있습니다.');
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
                if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['folderId', 'continuation'].includes(key))) throw failure(400, 'mail_sync_input_invalid', '메일함을 선택해 최근 7일 시험 조회를 시작해 주세요.');
                return send(res, 200, await service.sync(req.mailSession.uid, input));
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
