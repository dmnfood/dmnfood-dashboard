'use strict';
const { encodeFields, decodeFields } = require('./mail-integration-store.cjs');
const { buildTextSource, publicTextSource, publicTextSourceSummary, SUMMARY_FIELDS } = require('./order-text-source.cjs');
const PROJECT = 'dmnfood-haccp';
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const part = id => { if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw fail(400, 'text_source_id_invalid', '발주 원문을 다시 선택해 주세요.'); return id; };
function createOrderTextSourceStore({ token, fetchImpl = globalThis.fetch,
    documentName = `projects/${PROJECT}/databases/(default)/documents`, documentRoot = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents` } = {}) {
    async function request(path, options = {}) {
        let response;
        try { response = await fetchImpl(`${documentRoot}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(12000) }); }
        catch { throw fail(503, 'text_source_store_unavailable', '발주 원문 저장소에 연결하지 못했습니다.'); }
        if (response.status === 404 && options.allowMissing) return null;
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            const conflict = response.status === 409 || ['ABORTED', 'FAILED_PRECONDITION', 'ALREADY_EXISTS'].includes(body?.error?.status);
            throw fail(conflict ? 409 : response.status === 403 ? 403 : 503, conflict ? 'text_source_conflict' : 'text_source_store_unavailable', conflict ? '동일한 접수 요청이 이미 저장되었습니다.' : '발주 원문 저장 권한 또는 연결을 확인해 주세요.');
        }
        return body;
    }
    async function get(id) {
        const result = await request(`/orderTextSources/${part(id)}`, { allowMissing: true });
        return result ? publicTextSource(id, decodeFields(result.fields || {})) : null;
    }
    async function list() {
        const result = await request(':runQuery', { method: 'POST', body: JSON.stringify({ structuredQuery: {
            select: { fields: SUMMARY_FIELDS.map(fieldPath => ({ fieldPath })) },
            from: [{ collectionId: 'orderTextSources' }], orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }], limit: 50,
        } }) });
        if (!Array.isArray(result) || result.length > 51) throw fail(503, 'text_source_store_unavailable', '발주 원문 목록을 확인하지 못했습니다.');
        return result.filter(item => item.document).map(item => publicTextSourceSummary(item.document.name.split('/').at(-1), decodeFields(item.document.fields || {})));
    }
    async function create(input, uid) {
        const candidate = buildTextSource(input, uid);
        function same(previous) { return previous && Object.entries(candidate.data).every(([key, value]) => previous[key] === value); }
        let previous = await get(candidate.id);
        if (previous) { if (!same(previous)) throw fail(409, 'text_source_request_reused', '같은 접수 요청의 원문이 달라졌습니다. 새 요청으로 저장해 주세요.'); return { source: previous, created: false }; }
        try {
            await request(':commit', { method: 'POST', body: JSON.stringify({ writes: [{ update: { name: `${documentName}/orderTextSources/${candidate.id}`, fields: encodeFields(candidate.data) },
                currentDocument: { exists: false }, updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }] }] }) });
        } catch (error) {
            if (error.code !== 'text_source_conflict') throw error;
            previous = await get(candidate.id);
            if (!same(previous)) throw fail(409, 'text_source_request_reused', '같은 접수 요청의 원문이 달라졌습니다. 새 요청으로 저장해 주세요.');
            return { source: previous, created: false };
        }
        const source = await get(candidate.id);
        if (!same(source)) throw fail(503, 'text_source_store_unavailable', '저장한 발주 원문을 다시 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.');
        return { source, created: true };
    }
    return { get, list, create };
}
module.exports = { createOrderTextSourceStore };
