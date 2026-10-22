'use strict';
const authorize = require('./firebase-authorize.cjs');
const { createMailboxStore } = require('./mail-integration-store.cjs');
const { APP_ORIGIN, createMailService } = require('./naverworks-core.cjs');
const { createOrderAiStore } = require('./order-ai-store.cjs');
const { createOrderAiService } = require('./order-ai-service.cjs');
const { createOrderAiBackgroundStore } = require('./order-ai-background-store.cjs');
const SEVEN_DAYS = 7 * 86400000, ACCOUNT = 'official@dmnfood.co.kr';
const validId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const MESSAGES = Object.freeze({ interrupted: '분석이 중단되었습니다. 원본을 확인한 뒤 직접 다시 시작해 주세요.',
    ai_configuration_required: 'AI 연결 설정이 필요합니다.', ai_analysis_busy: '다른 담당자가 분석 중입니다. 결과를 확인해 주세요.',
    ai_customer_catalog_required: '학교급식 업체 목록을 먼저 연결해 주세요.', ai_provider_timeout: '분석 응답 대기 시간이 지났습니다. 직접 다시 시작해 주세요.',
    ai_provider_connection_failed: 'AI 연결이 끊겼습니다. 직접 다시 시작해 주세요.', ai_provider_unavailable: 'AI 서비스 연결 상태를 확인해 주세요.',
    ai_analysis_invalid: '원본과 연결된 분석을 만들지 못했습니다. 직접 확인해 주세요.', ai_response_invalid: '분석 응답을 확인하지 못했습니다. 직접 다시 시작해 주세요.',
    ai_source_changed: '원본이 변경되었습니다. 직접 확인해 주세요.', analysis_failed: '분석을 완료하지 못했습니다. 원본을 확인한 뒤 직접 다시 시작해 주세요.' });
const failureInfo = error => { const code = Object.hasOwn(MESSAGES, error?.code) ? error.code : 'analysis_failed'; return { failureCode: code, message: MESSAGES[code] }; };
function createOrderAiBackgroundService({ store, aiStore, aiService, mailService, now = Date.now } = {}) {
    function recent(source) { const received = typeof source?.receivedAt === 'string' ? Date.parse(source.receivedAt) : NaN; return Number.isFinite(received) && received >= now() - SEVEN_DAYS && received <= now(); }
    function school(source, id) { return source && source.account === ACCOUNT && source.folderId === '106' && source.intakeId === id && validId(source.sourceHash) && recent(source); }
    async function stateFor(id, sourceHash) {
        const analysis = await aiStore.get(id);
        if (analysis) return analysis.data.sourceHash === sourceHash && Number.isSafeInteger(analysis.data.revision) && analysis.data.revision > 0
            ? { intakeId: id, state: 'ready', revision: analysis.data.revision }
            : { intakeId: id, state: 'failed', message: MESSAGES.ai_source_changed };
        const job = await store.get(id);
        if (!job) return { intakeId: id, state: 'pending' };
        if (job.data.sourceHash !== sourceHash) return { intakeId: id, state: 'failed', message: MESSAGES.ai_source_changed };
        if (job.data.state === 'running') return job.data.leaseExpiresAt > now() ? { intakeId: id, state: 'running' } : { intakeId: id, state: 'failed', message: MESSAGES.interrupted };
        return { intakeId: id, state: 'failed', message: failureInfo({ code: job.data.failureCode }).message };
    }
    async function list({ cursor = null } = {}) {
        const page = await mailService.source({ folderId: '106', cursor });
        if (!Array.isArray(page.mails) || page.mails.length > 20) throw fail(503, 'background_source_invalid', '학교급식 발주 목록을 확인하지 못했습니다.');
        const eligible = page.mails.filter(source => validId(source.id) && school({ ...source, intakeId: source.id }, source.id));
        const items = await Promise.all(eligible.map(source => stateFor(source.id, source.sourceHash)));
        const hasOlder = page.mails.some(source => Number.isFinite(Date.parse(source.receivedAt)) && Date.parse(source.receivedAt) < now() - SEVEN_DAYS);
        return { ok: true, items, nextCursor: hasOlder ? null : page.nextCursor || null };
    }
    async function sync(input, actor) {
        return mailService.sync(actor.uid, { folderId: '106', scope: 'school', ...(input.continuation ? { continuation: input.continuation } : {}) });
    }
    async function analyze(id, actor) {
        if (!validId(id)) throw fail(400, 'background_intake_invalid', '발주 원본을 다시 선택해 주세요.');
        const membership = await store.schoolSource(id);
        if (!school(membership, id)) throw fail(403, 'background_scope_invalid', '최근 7일의 학교급식 발주 메일만 자동 분석할 수 있습니다.');
        const previous = await stateFor(id, membership.sourceHash);
        if (previous.state !== 'pending') return { ok: true, ...previous };
        const { mail } = await mailService.source({ intakeId: id });
        if (mail?.id !== id || mail.account !== ACCOUNT || mail.rawStorage?.sha256 !== membership.sourceHash || mail.receivedAt !== membership.receivedAt) throw fail(409, 'ai_source_changed', MESSAGES.ai_source_changed);
        let job;
        try { job = await store.claim(id, membership.sourceHash, actor.uid); }
        catch (error) {
            // A manual analysis can finish between the initial read and claim.
            // Preserve that result even if rules correctly reject a late job.
            if (await aiStore.get(id).catch(() => null)) return { ok: true, ...await stateFor(id, membership.sourceHash) };
            throw error;
        }
        if (!job) return { ok: true, ...await stateFor(id, membership.sourceHash) };
        try {
            const result = await aiService.analyze({ intakeId: id, expectedRevision: 0 }, actor);
            const revision = result?.analysis?.revision;
            if (!Number.isSafeInteger(revision) || revision < 1) throw fail(503, 'ai_analysis_invalid', MESSAGES.ai_analysis_invalid);
            try { await store.finish(job, { state: 'ready', revision }, actor.uid); } catch { /* Saved analyses are authoritative; a job cannot trigger another model call. */ }
            return { ok: true, intakeId: id, state: 'ready', revision };
        } catch (error) {
            const saved = await aiStore.get(id).catch(() => null);
            if (saved) return { ok: true, ...await stateFor(id, membership.sourceHash) };
            const failure = failureInfo(error);
            try { await store.finish(job, { state: 'failed', ...failure }, actor.uid); } catch { /* An uncertain terminal write remains claimed and is never automatically retried. */ }
            return { ok: true, intakeId: id, state: 'failed', message: failure.message };
        }
    }
    return { list, sync, analyze };
}
function send(response, status, value) { response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.end(JSON.stringify(value)); }
function createHandler(options = {}) {
    return async (request, response) => {
        try {
            if (!['GET', 'POST'].includes(request.method)) { response.setHeader('Allow', 'GET, POST'); throw fail(405, 'method_not_allowed', '지원하지 않는 요청입니다.'); }
            const actor = await (options.authorize || authorize)(request);
            if (!actor?.uid || !['admin', 'manager'].includes(actor.role)) throw fail(403, 'background_forbidden', '승인된 관리자와 매니저만 사용할 수 있습니다.');
            const url = new URL(request.url, APP_ORIGIN);
            const token = request.headers?.authorization?.slice(7);
            const mailService = options.mailService || createMailService({ store: options.mailboxStore || createMailboxStore() });
            const aiStore = options.aiStore || createOrderAiStore({ token });
            const service = options.service || createOrderAiBackgroundService({ store: options.store || createOrderAiBackgroundStore({ token }), aiStore,
                aiService: options.aiService || createOrderAiService({ store: aiStore, mailService }), mailService });
            if (request.method === 'GET') {
                const cursor = url.searchParams.get('cursor');
                if ([...url.searchParams.keys()].some(key => key !== 'cursor') || url.searchParams.getAll('cursor').length > 1 || cursor !== null && (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor))) throw fail(400, 'background_cursor_invalid', '다음 발주 목록을 확인해 주세요.');
                return send(response, 200, await service.list({ cursor }));
            }
            if (url.searchParams.size) throw fail(400, 'background_input_invalid', '자동 분석 요청을 확인해 주세요.');
            if (request.headers?.origin !== APP_ORIGIN) throw fail(403, 'background_origin_invalid', '대시보드에서 다시 시작해 주세요.');
            if (!/^application\/json(?:\s*;|$)/i.test(request.headers?.['content-type'] || '')) throw fail(415, 'json_required', 'JSON 요청만 지원합니다.');
            if (Number(request.headers?.['content-length'] || 0) > 24000 || Buffer.byteLength(typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? null)) > 24000) throw fail(413, 'background_input_too_large', '자동 분석 요청 범위를 넘었습니다.');
            let input = request.body; if (typeof input === 'string') { try { input = JSON.parse(input); } catch { throw fail(400, 'background_input_invalid', '자동 분석 요청을 확인해 주세요.'); } }
            if (input?.action === 'sync' && exact(input, ['action', 'continuation']) && (input.continuation === undefined || typeof input.continuation === 'string' && input.continuation.length > 0 && input.continuation.length <= 20000)) return send(response, 200, await service.sync(input, actor));
            if (input?.action === 'analyze' && exact(input, ['action', 'intakeId']) && Object.keys(input).length === 2 && validId(input.intakeId)) return send(response, 200, await service.analyze(input.intakeId, actor));
            throw fail(400, 'background_input_invalid', '자동 분석 요청을 확인해 주세요.');
        } catch (error) { const safe = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599; return send(response, safe ? error.status : 503, { ok: false, code: safe ? error.code : 'background_unavailable', message: safe ? error.message : '자동 발주 분석에 연결하지 못했습니다.' }); }
    };
}
module.exports = { createHandler, createOrderAiBackgroundService, failureInfo, SEVEN_DAYS };
