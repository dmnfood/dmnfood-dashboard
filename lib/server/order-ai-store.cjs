'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { encodeFields, decodeFields } = require('./mail-integration-store.cjs');
const PROJECT = 'dmnfood-haccp';
const CONFIRMED_PAGE_SIZE = 25;
const confirmedTimestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
function createOrderAiStore({ token, fetchImpl = globalThis.fetch, now = Date.now,
    documentName = `projects/${PROJECT}/databases/(default)/documents`, documentRoot = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents` } = {}) {
    const part = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw failure(400, 'ai_intake_invalid', '메일을 다시 선택해 주세요.'); return value; };
    async function request(path, options = {}) {
        let response;
        try { response = await fetchImpl(`${documentRoot}${path}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(12000) }); }
        catch { throw failure(503, 'ai_store_unavailable', '분석 저장소에 연결하지 못했습니다.'); }
        if (response.status === 404 && options.allowMissing) return null;
        const result = await response.json();
        if (!response.ok) {
            const conflict = response.status === 409 || ['ABORTED', 'FAILED_PRECONDITION', 'ALREADY_EXISTS'].includes(result?.error?.status);
            throw failure(conflict ? 409 : response.status === 403 ? 403 : 503, conflict ? 'ai_revision_conflict' : 'ai_store_unavailable', conflict ? '다른 담당자가 먼저 변경했습니다. 최신 분석을 불러와 주세요.' : '분석 저장소 권한 또는 연결을 확인해 주세요.');
        }
        return result;
    }
    async function read(path) {
        const result = await request(`/${path}`, { allowMissing: true });
        return result ? { data: decodeFields(result.fields || {}), fields: result.fields || {}, version: result.updateTime } : null;
    }
    const get = intakeId => read(`orderAiAnalyses/${part(intakeId)}`);
    async function listConfirmed({ cursor = null } = {}) {
        let position = null;
        if (cursor !== null) {
            try {
                if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw new Error('cursor');
                position = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
                if (!position || Object.keys(position).length !== 2 || !confirmedTimestamp(position.confirmedAt) || !/^[a-f0-9]{64}$/.test(position.intakeId || '')) throw new Error('cursor');
            } catch { throw failure(400, 'ai_list_cursor_invalid', '저장된 발주 목록을 새로 불러와 주세요.'); }
        }
        // Every draft has confirmedAt:null. Descending timestamp order places
        // immutable confirmations first, without a composite status/time index.
        const structuredQuery = { from: [{ collectionId: 'orderAiAnalyses' }],
            select: { fields: ['intakeId', 'sourceHash', 'revision', 'status', 'confirmedRevision', 'confirmedAt', 'confirmedByUid', 'analysis.customer', 'analysis.groups', 'analysis.sources'].map(fieldPath => ({ fieldPath })) },
            orderBy: [{ field: { fieldPath: 'confirmedAt' }, direction: 'DESCENDING' }, { field: { fieldPath: '__name__' }, direction: 'DESCENDING' }], limit: CONFIRMED_PAGE_SIZE + 1,
            ...(position ? { startAt: { before: false, values: [{ timestampValue: position.confirmedAt }, { referenceValue: `${documentName}/orderAiAnalyses/${position.intakeId}` }] } } : {}) };
        const result = await request(':runQuery', { method: 'POST', body: JSON.stringify({ structuredQuery }) });
        if (!Array.isArray(result)) throw failure(503, 'ai_list_invalid', '저장된 발주 목록을 확인하지 못했습니다.');
        const records = [];
        for (const item of result) {
            if (!item.document) continue;
            const document = item.document, data = decodeFields(document.fields || {}), intakeId = document.name?.split('/').pop();
            if (!/^[a-f0-9]{64}$/.test(intakeId || '') || data.intakeId !== intakeId) throw failure(503, 'ai_list_invalid', '저장된 발주 목록의 식별 정보를 확인해 주세요.');
            if (data.status === 'needs_review' && data.confirmedAt === null) continue;
            if (data.status !== 'confirmed' || !confirmedTimestamp(data.confirmedAt)) throw failure(503, 'ai_list_invalid', '저장된 발주의 확정 기록을 확인해 주세요.');
            records.push({ data, version: document.updateTime });
        }
        const page = records.slice(0, CONFIRMED_PAGE_SIZE), last = page.at(-1)?.data;
        return { records: page, nextCursor: records.length > CONFIRMED_PAGE_SIZE ? Buffer.from(JSON.stringify({ confirmedAt: last.confirmedAt, intakeId: last.intakeId })).toString('base64url') : null };
    }
    const textSource = async intakeId => {
        try { return (await read(`orderTextSources/${part(intakeId)}`))?.data || null; }
        catch (error) { if (error.status === 403) throw failure(403, 'text_source_unavailable', '발주 원문의 보관 기간이 끝났거나 열람 권한이 없습니다.'); throw error; }
    };
    async function customers({ legacyErp = false } = {}) {
        if (!legacyErp) {
            const document = await read('settings/schoolMealCompanies');
            if (!document) return [];
            const data = document.data;
            if (data.schemaVersion !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 1 || !Array.isArray(data.companies) || data.companies.length > 200) throw failure(503, 'ai_customer_catalog_invalid', '학교급식 업체 목록을 확인해야 합니다.');
            const seen = new Set();
            return data.companies.map(company => {
                const name = typeof company?.name === 'string' ? company.name.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
                const id = `school-${createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 24)}`;
                const duplicateKey = name.toLowerCase().replace(/\s+/g, '');
                if (!name || name.length > 200 || /[\x00-\x1f\x7f]/.test(name) || company.name !== name || company.id !== id || seen.has(duplicateKey)
                    || Object.keys(company).some(key => !['id', 'name'].includes(key))) throw failure(503, 'ai_customer_catalog_invalid', '학교급식 업체 목록이 올바르지 않습니다. 목록을 다시 저장해 주세요.');
                seen.add(duplicateKey); return { id, name, revision: data.revision, source: 'school_meal', erpCode: null };
            });
        }
        // Historical ERP-backed analyses retain their original identity and are
        // revalidated against that master only; new analyses never use this path.
        const result = []; let pageToken = '';
        do {
            const query = new URLSearchParams({ pageSize: '500' }); if (pageToken) query.set('pageToken', pageToken);
            const page = await request(`/erpCustomers?${query}`);
            for (const document of page.documents || []) {
                const data = decodeFields(document.fields || {}), id = decodeURIComponent(document.name.split('/').pop());
                result.push({ id, code: data.code, name: data.name, revision: data.revision });
            }
            pageToken = page.nextPageToken || '';
            if (result.length > 2000) throw failure(413, 'ai_customer_limit', '거래처 목록이 분석 범위를 넘었습니다. 관리자 확인이 필요합니다.');
        } while (pageToken);
        return result;
    }
    async function acquire(intakeId, uid) {
        const path = `orderAiLocks/${part(intakeId)}`, old = await read(path);
        if (old && old.data.expiresAt > now()) throw failure(409, 'ai_analysis_busy', '이미 이 메일을 분석하고 있습니다. 잠시 후 결과를 확인해 주세요.');
        const owner = randomUUID(), data = { intakeId, owner, uid, expiresAt: now() + 240000 };
        await request(':commit', { method: 'POST', body: JSON.stringify({ writes: [{ update: { name: `${documentName}/${path}`, fields: encodeFields(data) }, currentDocument: old ? { updateTime: old.version } : { exists: false } }] }) });
        return { path, owner, uid };
    }
    async function release(lease) {
        const record = await read(lease.path);
        if (!record || record.data.owner !== lease.owner || record.data.uid !== lease.uid) return;
        await request(':commit', { method: 'POST', body: JSON.stringify({ writes: [{ delete: `${documentName}/${lease.path}`, currentDocument: { updateTime: record.version } }] }) });
    }
    async function save(intakeId, data, old) {
        part(intakeId);
        if (Buffer.byteLength(JSON.stringify(data)) > 700000) throw failure(413, 'ai_result_too_large', '분석 결과가 저장 범위를 넘었습니다. 파일을 나누어 주세요.');
        const fields = encodeFields(data);
        delete fields.updatedAt; delete fields.createdAt;
        if (old) fields.createdAt = old.fields.createdAt;
        const writes = [{ update: { name: `${documentName}/orderAiAnalyses/${intakeId}`, fields }, currentDocument: old ? { updateTime: old.version } : { exists: false }, updateTransforms: [
            ...(!old ? [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }] : []), { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
            ...(data.status === 'confirmed' ? [{ fieldPath: 'confirmedAt', setToServerValue: 'REQUEST_TIME' }] : []),
        ] }];
        if (old) writes.push({ update: { name: `${documentName}/orderAiAnalyses/${intakeId}/versions/${old.data.revision}`, fields: { record: { mapValue: { fields: old.fields } }, archivedByUid: { stringValue: data.updatedByUid } } }, currentDocument: { exists: false }, updateTransforms: [{ fieldPath: 'archivedAt', setToServerValue: 'REQUEST_TIME' }] });
        await request(':commit', { method: 'POST', body: JSON.stringify({ writes }) });
        return get(intakeId);
    }
    return { get, listConfirmed, textSource, customers, acquire, release, save };
}
module.exports = { createOrderAiStore };
