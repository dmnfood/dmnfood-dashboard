const { createHash, randomUUID } = require('node:crypto');

const PROJECT_ID = 'dmnfood-haccp';
const WEB_API_KEY = 'AIzaSyDrBi1E23fKRmd1EkkCFBLQQdqccjHrwLk';
const MAX_RAW_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 128 * 1024;
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });

function encodeValue(value) {
    if (value === null) return { nullValue: null };
    if (typeof value === 'string') return { stringValue: value };
    if (typeof value === 'boolean') return { booleanValue: value };
    if (typeof value === 'number' && Number.isFinite(value)) return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
    if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return { mapValue: { fields: encodeFields(value) } };
    throw failure(400, 'MAIL_INVALID_DATA', '저장할 메일 정보가 올바르지 않습니다.');
}
function encodeFields(object) {
    return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined).map(([key, value]) => [key, encodeValue(value)]));
}
function decodeValue(value) {
    if ('nullValue' in value) return null;
    if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
    if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
    if ('integerValue' in value) return Number(value.integerValue);
    return value.stringValue ?? value.booleanValue ?? value.doubleValue ?? value.timestampValue;
}
function decodeFields(fields) { return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)])); }
function buildIntakeId(account, mailId) {
    if (typeof account !== 'string' || !account.trim() || !['number', 'string'].includes(typeof mailId) || !String(mailId)) throw failure(400, 'MAIL_INVALID_ID', '메일 식별 정보가 없습니다.');
    return createHash('sha256').update(`${account.trim().toLowerCase()}\n${String(mailId)}`).digest('hex');
}
function chunksOf(text) {
    const chunks = []; let chunk = '', size = 0;
    for (const character of text) {
        const bytes = Buffer.byteLength(character);
        if (size + bytes > CHUNK_BYTES) { chunks.push(chunk); chunk = ''; size = 0; }
        chunk += character; size += bytes;
    }
    if (chunk || !chunks.length) chunks.push(chunk);
    return chunks;
}

function createMailboxStore(options = {}) {
    const env = options.env || process.env;
    const fetchImpl = options.fetchImpl || fetch;
    const now = options.now || Date.now;
    // Alternate endpoints are injectable only by local tests, never controlled by request data.
    const documentRoot = options.documentRoot || `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
    const documentName = options.documentName || `projects/${PROJECT_ID}/databases/(default)/documents`;
    const identityRoot = options.identityRoot || 'https://identitytoolkit.googleapis.com/v1';
    const secureTokenRoot = options.secureTokenRoot || 'https://securetoken.googleapis.com/v1';
    let session = null, authentication = null;

    function isConfigured() { return !!(env.MAIL_COLLECTOR_EMAIL && env.MAIL_COLLECTOR_PASSWORD); }
    async function authenticate() {
        if (!isConfigured()) throw failure(503, 'MAIL_STORE_NOT_CONFIGURED', '메일 수집 전용 저장 계정 설정이 필요합니다.');
        if (session && session.expiresAt > now() + 60000) return session;
        if (authentication) return authentication;
        authentication = (async () => {
            const refreshing = !!session?.refreshToken;
            const response = await fetchImpl(refreshing ? `${secureTokenRoot}/token?key=${WEB_API_KEY}` : `${identityRoot}/accounts:signInWithPassword?key=${WEB_API_KEY}`, {
                method: 'POST', headers: { 'Content-Type': refreshing ? 'application/x-www-form-urlencoded' : 'application/json' },
                body: refreshing ? new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken }).toString()
                    : JSON.stringify({ email: env.MAIL_COLLECTOR_EMAIL, password: env.MAIL_COLLECTOR_PASSWORD, returnSecureToken: true }),
                signal: AbortSignal.timeout(6000), redirect: 'error',
            });
            if (!response.ok) { session = null; throw failure(503, 'MAIL_STORE_AUTH_FAILED', '메일 수집 전용 저장 계정을 인증하지 못했습니다.'); }
            const data = await response.json();
            const idToken = data.idToken || data.id_token, refreshToken = data.refreshToken || data.refresh_token, uid = data.localId || data.user_id;
            if (typeof idToken !== 'string' || !idToken || typeof refreshToken !== 'string' || !refreshToken || typeof uid !== 'string' || !uid) throw failure(503, 'MAIL_STORE_AUTH_FAILED', '메일 수집 전용 저장 계정을 인증하지 못했습니다.');
            session = { idToken, refreshToken, uid, expiresAt: now() + Math.min(Number(data.expiresIn || data.expires_in) || 3600, 3600) * 1000 };
            return session;
        })();
        try { return await authentication; } finally { authentication = null; }
    }
    async function request(path, settings = {}) {
        const auth = await authenticate();
        let response;
        try { response = await fetchImpl(`${documentRoot}${path}`, { ...settings, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.idToken}`, ...settings.headers }, signal: AbortSignal.timeout(8000), redirect: 'error' }); }
        catch { throw failure(503, 'MAIL_STORE_UNAVAILABLE', '메일 저장소에 연결하지 못했습니다.'); }
        if (response.status === 404 && settings.allowMissing) return null;
        const data = await response.json();
        if (!response.ok) {
            const conflict = response.status === 409 || data.error?.status === 'FAILED_PRECONDITION' || data.error?.status === 'ALREADY_EXISTS';
            throw failure(conflict ? 409 : 503, conflict ? 'MAIL_STORE_CONFLICT' : 'MAIL_STORE_UNAVAILABLE', conflict ? '다른 요청이 먼저 변경했습니다. 다시 시도해 주세요.' : '메일 저장소 권한 또는 연결을 확인해 주세요.');
        }
        return data;
    }
    function pathPart(value) {
        if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw failure(400, 'MAIL_INVALID_ID', '저장 식별 정보가 올바르지 않습니다.');
        return value;
    }
    async function getDocument(path) {
        const result = await request(`/${path}`, { allowMissing: true });
        return result ? { data: decodeFields(result.fields || {}), version: result.updateTime } : null;
    }
    const write = (path, data, expectedVersion = null) => ({ update: { name: `${documentName}/${path}`, fields: encodeFields(data) }, currentDocument: expectedVersion ? { updateTime: expectedVersion } : { exists: false } });
    async function saveDocument(path, data, expectedVersion = null) {
        const result = await request(':commit', { method: 'POST', body: JSON.stringify({ writes: [write(path, data, expectedVersion)] }) });
        return { data, version: result.writeResults?.[0]?.updateTime || result.commitTime };
    }
    const getConnection = () => getDocument('mailIntegrationSecrets/naverworks');
    async function saveConnection(record, { expectedVersion = null } = {}) {
        // Plain OAuth tokens must never accidentally be persisted alongside the encrypted envelope.
        if (record.access_token || record.refresh_token || record.accessToken || record.refreshToken || !record.encryptedTokens) throw failure(400, 'MAIL_TOKENS_NOT_ENCRYPTED', '메일 인증 정보의 암호화가 필요합니다.');
        return saveDocument('mailIntegrationSecrets/naverworks', record, expectedVersion);
    }
    async function createOAuthState(hash, data) {
        pathPart(hash);
        if (hash.length !== 64 || !Number.isFinite(data.expiresAt) || data.expiresAt <= now() || data.expiresAt > now() + 11 * 60000) throw failure(400, 'MAIL_INVALID_STATE', '연결 요청 시간이 올바르지 않습니다.');
        await saveDocument(`mailIntegrationOAuthStates/${hash}`, data);
    }
    async function consumeOAuthState(hash, cookieHash, currentTime = now()) {
        if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return null;
        const path = `mailIntegrationOAuthStates/${hash}`, entry = await getDocument(path);
        if (!entry || entry.data.expiresAt <= currentTime || entry.data.cookieHash !== cookieHash) return null;
        try { await request(':commit', { method: 'POST', body: JSON.stringify({ writes: [{ delete: `${documentName}/${path}`, currentDocument: { updateTime: entry.version } }] }) }); }
        catch (error) { if (error.code === 'MAIL_STORE_CONFLICT') return null; throw error; }
        return entry.data;
    }
    async function acquireLease(name, owner, expiresAt) {
        pathPart(name); pathPart(owner);
        if (!Number.isFinite(expiresAt) || expiresAt <= now() || expiresAt > now() + 300000) throw failure(400, 'MAIL_INVALID_LEASE', '작업 잠금 시간이 올바르지 않습니다.');
        const path = `mailIntegrationLeases/${name}`, existing = await getDocument(path);
        if (existing && existing.data.expiresAt > now()) return null;
        try { const saved = await saveDocument(path, { owner, expiresAt }, existing?.version); return { name, owner, expiresAt, version: saved.version }; }
        catch (error) { if (error.code === 'MAIL_STORE_CONFLICT') return null; throw error; }
    }
    async function releaseLease(name, owner) {
        pathPart(name); pathPart(owner);
        const path = `mailIntegrationLeases/${name}`, existing = await getDocument(path);
        if (!existing || existing.data.owner !== owner) return false;
        try { await request(':commit', { method: 'POST', body: JSON.stringify({ writes: [{ delete: `${documentName}/${path}`, currentDocument: { updateTime: existing.version } }] }) }); return true; }
        catch (error) { if (error.code === 'MAIL_STORE_CONFLICT') return false; throw error; }
    }
    async function withLease(name, work, { ttlMs = 90000 } = {}) {
        const owner = randomUUID(), lease = await acquireLease(name, owner, now() + ttlMs);
        if (!lease) throw failure(409, 'MAIL_SYNC_BUSY', '이미 메일 연결 또는 수집 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.');
        try { return await work(lease); } finally { await releaseLease(name, owner); }
    }
    const getSyncState = () => getDocument('mailIntegrationState/naverworks');
    const saveSyncState = (record, { expectedVersion = null } = {}) => saveDocument('mailIntegrationState/naverworks', record, expectedVersion);
    async function createRawMail(id, record) {
        pathPart(id);
        if (id !== buildIntakeId(record.account, record.mailId)) throw failure(400, 'MAIL_INVALID_ID', '메일 중복 확인 식별자가 일치하지 않습니다.');
        if (record.processingStatus !== 'pending_interpretation' || record.attachmentStatus !== 'metadata_only' || record.sourceChannel !== 'naverworks_mail' || !record.raw || typeof record.raw !== 'object') throw failure(400, 'MAIL_INVALID_INTAKE', '자동 수집 메일의 원문과 확인 대기 상태가 필요합니다.');
        if (await getDocument(`mailIntakes/${id}`)) return false;
        const rawText = JSON.stringify(record.raw), rawBytes = Buffer.byteLength(rawText);
        if (rawBytes > MAX_RAW_BYTES) throw failure(413, 'MAIL_SOURCE_TOO_LARGE', '메일 원문이 현재 보관 한도를 초과했습니다. 누락 없이 별도 확인이 필요합니다.');
        const chunks = chunksOf(rawText), auth = await authenticate();
        const data = { ...record, raw: rawBytes <= 64 * 1024 ? record.raw : null, schemaVersion: 1, collectedByUid: auth.uid,
            collectionState: 'raw_saved_metadata_only', rawStorage: { chunkCount: chunks.length, byteLength: rawBytes, sha256: createHash('sha256').update(rawText).digest('hex'), encoding: 'utf8-json' } };
        const writes = chunks.map((text, index) => write(`mailIntakes/${id}/source/${String(index).padStart(4, '0')}`, { index, text }));
        writes.push(write(`mailIntakes/${id}`, data));
        try { await request(':commit', { method: 'POST', body: JSON.stringify({ writes }) }); return true; }
        catch (error) { if (error.code === 'MAIL_STORE_CONFLICT' && await getDocument(`mailIntakes/${id}`)) return false; throw error; }
    }
    async function getRawMail(id) {
        pathPart(id);
        const record = await getDocument(`mailIntakes/${id}`);
        if (!record) return null;
        const parts = [];
        for (let index = 0; index < record.data.rawStorage.chunkCount; index++) {
            const chunk = await getDocument(`mailIntakes/${id}/source/${String(index).padStart(4, '0')}`);
            if (!chunk || chunk.data.index !== index) throw failure(503, 'MAIL_SOURCE_INCOMPLETE', '메일 원문 보관 상태를 확인해야 합니다.');
            parts.push(chunk.data.text);
        }
        const text = parts.join('');
        if (Buffer.byteLength(text) !== record.data.rawStorage.byteLength || createHash('sha256').update(text).digest('hex') !== record.data.rawStorage.sha256) throw failure(503, 'MAIL_SOURCE_INCOMPLETE', '메일 원문 보관 상태를 확인해야 합니다.');
        return { ...record.data, raw: JSON.parse(text) };
    }
    async function createIntake(record) { const id = buildIntakeId(record.account, record.mailId); return { id, created: await createRawMail(id, record) }; }
    async function saveSyncRun(record, { lease } = {}) {
        const id = randomUUID();
        const current = await getSyncState();
        const previous = current?.data, previousSummary = previous?.summary, nextSummary = record.summary;
        const account = value => String(value?.mailbox || value?.account || '').trim().toLowerCase();
        if (previousSummary && nextSummary && account(previous) && account(previous) === account(record)) {
            const previousTo = Date.parse(previousSummary.to), nextTo = Date.parse(nextSummary.to);
            const olderWindow = Number.isFinite(previousTo) && Number.isFinite(nextTo) && nextTo < previousTo;
            const sameWindow = nextSummary.from === previousSummary.from && nextSummary.to === previousSummary.to
                && nextSummary.folderId === previousSummary.folderId;
            const lessProgress = Number.isFinite(nextSummary.scanned) && Number.isFinite(previousSummary.scanned) && nextSummary.scanned < previousSummary.scanned;
            const lostCompletion = previousSummary.scanComplete === true && nextSummary.scanComplete !== true;
            if (olderWindow || (sameWindow && (lessProgress || lostCompletion))) {
                throw failure(409, 'MAIL_SYNC_OUTDATED', '더 최신의 메일 조회 결과가 있습니다. 새 조회 결과를 확인해 주세요.');
            }
        }
        const writes = [write(`mailIntegrationRuns/${id}`, record), write('mailIntegrationState/naverworks', record, current?.version)];
        // A paused process cannot publish a result after its lock expires or another owner takes over.
        if (lease) {
            if (lease.expiresAt <= now()) throw failure(409, 'MAIL_SYNC_LEASE_EXPIRED', '메일 조회 작업 시간이 만료되었습니다. 다시 시도해 주세요.');
            writes.push(write(`mailIntegrationLeases/${pathPart(lease.name)}`, { owner: pathPart(lease.owner), expiresAt: lease.expiresAt }, lease.version));
        }
        const result = await request(':commit', { method: 'POST', body: JSON.stringify({ writes }) });
        if (lease) lease.version = result.writeResults?.[2]?.updateTime || result.commitTime;
        return { id, data: record, version: result.writeResults?.[1]?.updateTime || result.commitTime };
    }
    async function getSummary() {
        const [connection, state] = await Promise.all([getConnection(), getSyncState()]);
        const data = connection?.data;
        return { configured: isConfigured(), connected: !!data, mailbox: data?.mailbox || '', connectedAt: data?.connectedAt || null, expiresAt: data?.expiresAt || null, accountVerified: data?.accountVerified === true, scopes: data?.scopes || [], sync: state?.data || null };
    }
    return { isConfigured, getConnection, saveConnection, putConnection: saveConnection, createOAuthState, consumeOAuthState, acquireLease, releaseLease, withLease, getSyncState, saveSyncState, createRawMail, createIntake, getRawMail, saveSyncRun, getSummary };
}

module.exports = { createMailboxStore, createMailIntegrationStore: createMailboxStore, buildIntakeId, encodeFields, decodeFields, MAX_RAW_BYTES };
