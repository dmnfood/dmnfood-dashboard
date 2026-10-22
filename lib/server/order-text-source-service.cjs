'use strict';
const authorize = require('./firebase-authorize.cjs');
const { APP_ORIGIN } = require('./naverworks-core.cjs');
const { createOrderTextSourceStore } = require('./order-text-source-store.cjs');
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
function send(response, status, value) {
    response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.end(JSON.stringify(value));
}
function createHandler({ authorize: authorizeImpl = authorize, store: fixedStore, createStore = createOrderTextSourceStore } = {}) {
    return async (request, response) => {
        try {
            if (!['GET', 'POST'].includes(request.method)) { response.setHeader('Allow', 'GET, POST'); throw fail(405, 'method_not_allowed', '지원하지 않는 요청입니다.'); }
            const actor = await authorizeImpl(request);
            if (!actor?.uid || !['admin', 'manager'].includes(actor.role)) throw fail(403, 'text_source_forbidden', '발주 확인 권한이 필요합니다.');
            const store = fixedStore || createStore({ token: request.headers.authorization.slice(7) });
            const url = new URL(request.url, APP_ORIGIN);
            if (request.method === 'GET') {
                if ([...url.searchParams.keys()].some(key => key !== 'id') || url.searchParams.getAll('id').length > 1) throw fail(400, 'text_source_id_invalid', '발주 원문 조회 정보를 확인해 주세요.');
                if (!url.searchParams.has('id')) return send(response, 200, { ok: true, sources: await store.list() });
                const source = await store.get(url.searchParams.get('id'));
                if (!source) throw fail(404, 'text_source_missing', '발주 원문이 없거나 30일 보관 기간이 끝났습니다.');
                return send(response, 200, { ok: true, source });
            }
            if (url.searchParams.size) throw fail(400, 'text_source_input_invalid', '발주 접수 요청을 확인해 주세요.');
            if (request.headers?.origin !== APP_ORIGIN) throw fail(403, 'text_source_origin_invalid', '허용된 화면에서 발주를 저장해 주세요.');
            if (!/^application\/json(?:\s*;|$)/i.test(request.headers?.['content-type'] || '')) throw fail(415, 'text_source_content_type', '발주 원문 요청 형식을 확인해 주세요.');
            const length = Number(request.headers?.['content-length'] || 0);
            if (length > 900000 || Buffer.byteLength(typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? null)) > 900000) throw fail(413, 'text_source_request_too_large', '발주 원문이 저장 범위를 넘었습니다.');
            let input = request.body;
            if (typeof input === 'string') { try { input = JSON.parse(input); } catch { throw fail(400, 'text_source_input_invalid', '발주 원문 요청을 확인해 주세요.'); } }
            if (input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 1 && input.action === 'cleanupExpired') return send(response, 200, { ok: true, ...await store.cleanupExpired() });
            return send(response, 200, { ok: true, ...await store.create(input, actor.uid) });
        } catch (error) {
            const safe = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599;
            return send(response, safe ? error.status : 503, { ok: false, code: safe ? error.code : 'text_source_unavailable', message: safe ? error.message : '발주 원문을 처리하지 못했습니다. 잠시 후 다시 확인해 주세요.' });
        }
    };
}
module.exports = { createHandler };
