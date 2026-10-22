'use strict';
const { encodeFields, decodeFields } = require('./mail-integration-store.cjs');
const PROJECT = 'dmnfood-haccp', JOB_LEASE_MS = 240000;
const JOB_FIELDS = ['schemaVersion', 'intakeId', 'sourceHash', 'folderId', 'scope', 'state', 'createdByUid', 'updatedByUid', 'createdAt', 'updatedAt', 'leaseExpiresAt', 'revision', 'failureCode', 'message'];
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const part = id => { if (!/^[a-f0-9]{64}$/.test(id || '')) throw fail(400, 'background_intake_invalid', '발주 원본을 다시 선택해 주세요.'); return id; };
function createOrderAiBackgroundStore({ token, fetchImpl = globalThis.fetch, now = Date.now,
    documentName = `projects/${PROJECT}/databases/(default)/documents`, documentRoot = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents` } = {}) {
    async function request(path, options = {}) {
        let response;
        try { response = await fetchImpl(`${documentRoot}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(12000) }); }
        catch { throw fail(503, 'background_store_unavailable', '발주 분석 상태에 연결하지 못했습니다.'); }
        if (response.status === 404 && options.allowMissing) return null;
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            const conflict = response.status === 409 || ['ABORTED', 'FAILED_PRECONDITION', 'ALREADY_EXISTS'].includes(body?.error?.status);
            throw fail(conflict ? 409 : response.status === 403 ? 403 : 503, conflict ? 'background_claim_conflict' : 'background_store_unavailable', conflict ? '다른 담당자가 이 발주를 먼저 처리했습니다.' : '발주 분석 상태의 접근 권한 또는 연결을 확인해 주세요.');
        }
        return body;
    }
    async function read(path) {
        const result = await request(`/${path}`, { allowMissing: true });
        return result ? { data: decodeFields(result.fields || {}), fields: result.fields || {}, version: result.updateTime } : null;
    }
    async function get(id) {
        const job = await read(`orderAiJobs/${part(id)}`); if (!job) return null;
        const data = job.data;
        if (Object.keys(data).length !== JOB_FIELDS.length || JOB_FIELDS.some(key => !Object.hasOwn(data, key))
            || data.schemaVersion !== 1 || data.intakeId !== id || !/^[a-f0-9]{64}$/.test(data.sourceHash || '')
            || data.folderId !== '106' || data.scope !== 'school' || !['running', 'ready', 'failed'].includes(data.state)
            || typeof data.createdByUid !== 'string' || !data.createdByUid || typeof data.updatedByUid !== 'string' || !data.updatedByUid
            || !Number.isSafeInteger(data.leaseExpiresAt) || !Number.isFinite(Date.parse(data.createdAt)) || !Number.isFinite(Date.parse(data.updatedAt))
            || data.state === 'ready' && (!Number.isSafeInteger(data.revision) || data.revision < 1 || data.failureCode !== null || data.message !== null)
            || data.state === 'running' && (data.revision !== null || data.failureCode !== null || data.message !== null)
            || data.state === 'failed' && (data.revision !== null || !/^[a-z0-9_]{1,80}$/.test(data.failureCode || '') || typeof data.message !== 'string' || data.message.length > 200)) throw fail(503, 'background_job_invalid', '발주 분석 상태를 확인하지 못했습니다.');
        return job;
    }
    const schoolSource = async id => (await read(`mailFolders/106/intakes/${part(id)}`))?.data || null;
    async function claim(id, sourceHash, uid) {
        part(id);
        if (!/^[a-f0-9]{64}$/.test(sourceHash || '') || typeof uid !== 'string' || !uid || uid.length > 128) throw fail(400, 'background_claim_invalid', '발주 분석 요청을 확인해 주세요.');
        const data = { schemaVersion: 1, intakeId: id, sourceHash, folderId: '106', scope: 'school', state: 'running', createdByUid: uid, updatedByUid: uid,
            leaseExpiresAt: now() + JOB_LEASE_MS, revision: null, failureCode: null, message: null };
        try { await request(':commit', { method: 'POST', body: JSON.stringify({ writes: [{ update: { name: `${documentName}/orderAiJobs/${id}`, fields: encodeFields(data) }, currentDocument: { exists: false },
            updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }, { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }] }] }) }); }
        catch (error) { if (error.code === 'background_claim_conflict') return null; throw error; }
        const job = await get(id);
        if (!job || job.data.state !== 'running' || job.data.createdByUid !== uid || job.data.sourceHash !== sourceHash) throw fail(503, 'background_job_invalid', '접수한 발주 분석 상태를 확인하지 못했습니다.');
        return job;
    }
    async function finish(job, { state, revision = null, failureCode = null, message = null }, uid) {
        if (!job || job.data.state !== 'running' || !['ready', 'failed'].includes(state)) throw fail(409, 'background_job_changed', '발주 분석 상태가 변경되었습니다.');
        const data = { ...job.data, state, revision, failureCode, message, updatedByUid: uid }, fields = encodeFields(data);
        fields.createdAt = job.fields.createdAt; delete fields.updatedAt;
        await request(':commit', { method: 'POST', body: JSON.stringify({ writes: [{ update: { name: `${documentName}/orderAiJobs/${part(data.intakeId)}`, fields }, currentDocument: { updateTime: job.version }, updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }] }] }) });
        return get(data.intakeId);
    }
    return { get, schoolSource, claim, finish };
}
module.exports = { createOrderAiBackgroundStore, JOB_LEASE_MS, JOB_FIELDS };
