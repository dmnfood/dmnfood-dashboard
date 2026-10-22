'use strict';
const { encodeFields, decodeFields } = require('./mail-integration-store.cjs');
const { buildTextSource, publicTextSource, publicTextSourceSummary, SUMMARY_FIELDS, SOURCE_RETENTION_MS, SOURCE_LIST_MARGIN_MS } = require('./order-text-source.cjs');
const PROJECT = 'dmnfood-haccp';
const CLEANUP_BATCH_LIMIT = 8;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const part = id => { if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw fail(400, 'text_source_id_invalid', '발주 원문을 다시 선택해 주세요.'); return id; };
function createOrderTextSourceStore({ token, fetchImpl = globalThis.fetch, now = Date.now,
    documentName = `projects/${PROJECT}/databases/(default)/documents`, documentRoot = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents` } = {}) {
    async function request(path, options = {}) {
        let response;
        try { response = await fetchImpl(`${documentRoot}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(12000) }); }
        catch { throw fail(503, 'text_source_store_unavailable', '발주 원문 저장소에 연결하지 못했습니다.'); }
        if (response.status === 404 && options.allowMissing) return null;
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            const conflict = response.status === 409 || ['ABORTED', 'FAILED_PRECONDITION', 'ALREADY_EXISTS'].includes(body?.error?.status);
            throw fail(conflict ? 409 : response.status === 403 ? 403 : 503, conflict ? 'text_source_conflict' : 'text_source_store_unavailable', conflict ? '동일한 접수 요청이 이미 저장되었습니다.' : response.status === 403 ? '발주 원문의 보관 기간이 끝났거나 열람 권한이 없습니다.' : '발주 원문 저장소에 연결하지 못했습니다.');
        }
        return body;
    }
    async function get(id) {
        const result = await request(`/orderTextSources/${part(id)}`, { allowMissing: true });
        return result ? publicTextSource(id, decodeFields(result.fields || {}), { now: now() }) : null;
    }
    async function list() {
        const result = await request(':runQuery', { method: 'POST', body: JSON.stringify({ structuredQuery: {
            select: { fields: SUMMARY_FIELDS.map(fieldPath => ({ fieldPath })) },
            from: [{ collectionId: 'orderTextSources' }],
            where: { fieldFilter: { field: { fieldPath: 'expiresAt' }, op: 'GREATER_THAN', value: { timestampValue: new Date(now() + SOURCE_LIST_MARGIN_MS).toISOString() } } },
            orderBy: [{ field: { fieldPath: 'expiresAt' }, direction: 'DESCENDING' }], limit: 50,
        } }) });
        if (!Array.isArray(result) || result.length > 51) throw fail(503, 'text_source_store_unavailable', '발주 원문 목록을 확인하지 못했습니다.');
        return result.filter(item => item.document).map(item => publicTextSourceSummary(item.document.name.split('/').at(-1), decodeFields(item.document.fields || {}), { now: now() }));
    }
    async function create(input, uid) {
        const candidate = buildTextSource(input, uid);
        function same(previous) { return previous && Object.entries(candidate.data).every(([key, value]) => previous[key] === value); }
        let previous = await get(candidate.id);
        if (previous) { if (!same(previous)) throw fail(409, 'text_source_request_reused', '같은 접수 요청의 원문이 달라졌습니다. 새 요청으로 저장해 주세요.'); return { source: previous, created: false }; }
        try {
            const createdMs = now();
            const fields = { ...encodeFields(candidate.data), createdAt: { timestampValue: new Date(createdMs).toISOString() }, expiresAt: { timestampValue: new Date(createdMs + SOURCE_RETENTION_MS).toISOString() } };
            const expiryFields = Object.fromEntries(['schemaVersion', 'createdAt', 'expiresAt', 'sha256', 'createdByUid'].map(key => [key, fields[key]]));
            await request(':commit', { method: 'POST', body: JSON.stringify({ writes: [{ update: { name: `${documentName}/orderTextSources/${candidate.id}`, fields },
                currentDocument: { exists: false } }, { update: { name: `${documentName}/orderSourceExpirations/${candidate.id}`, fields: expiryFields }, currentDocument: { exists: false } }] }) });
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
    async function cleanupExpired() {
        const cutoff = now();
        const result = await request(':runQuery', { method: 'POST', body: JSON.stringify({ structuredQuery: {
            select: { fields: [{ fieldPath: 'expiresAt' }] }, from: [{ collectionId: 'orderSourceExpirations' }],
            where: { fieldFilter: { field: { fieldPath: 'expiresAt' }, op: 'LESS_THAN_OR_EQUAL', value: { timestampValue: new Date(cutoff).toISOString() } } },
            orderBy: [{ field: { fieldPath: 'expiresAt' }, direction: 'ASCENDING' }], limit: CLEANUP_BATCH_LIMIT,
        } }) });
        if (!Array.isArray(result) || result.length > CLEANUP_BATCH_LIMIT + 1) throw fail(503, 'text_source_store_unavailable', '보관 기간이 끝난 원문을 확인하지 못했습니다.');
        const documents = result.filter(item => item.document).map(item => item.document);
        if (documents.length > CLEANUP_BATCH_LIMIT) throw fail(503, 'text_source_store_unavailable', '정리할 원문 범위를 확인하지 못했습니다.');
        const writes = documents.flatMap(document => {
            const prefix = `${documentName}/orderSourceExpirations/`, id = document.name?.startsWith(prefix) ? document.name.slice(prefix.length) : '';
            const expiry = document.fields?.expiresAt?.timestampValue;
            if (!/^[a-f0-9]{64}$/.test(id) || Object.keys(document.fields || {}).length !== 1 || typeof expiry !== 'string'
                || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) > cutoff || typeof document.updateTime !== 'string' || !Number.isFinite(Date.parse(document.updateTime))) throw fail(503, 'text_source_store_unavailable', '정리할 원문의 보관 기간을 확인하지 못했습니다.');
            return [{ delete: `${documentName}/orderTextSources/${id}`, currentDocument: { exists: true } },
                { delete: document.name, currentDocument: { updateTime: document.updateTime } }];
        });
        if (writes.length) await request(':commit', { method: 'POST', body: JSON.stringify({ writes }) });
        return { deletedCount: documents.length };
    }
    return { get, list, create, cleanupExpired };
}
module.exports = { createOrderTextSourceStore };
