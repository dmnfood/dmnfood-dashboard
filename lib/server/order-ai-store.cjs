'use strict';
const { randomUUID } = require('node:crypto');
const { encodeFields, decodeFields } = require('./mail-integration-store.cjs');
const PROJECT = 'dmnfood-haccp';
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
    async function customers() {
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
    return { get, customers, acquire, release, save };
}
module.exports = { createOrderAiStore };
