'use strict';

const crypto = require('node:crypto');

const APP_ORIGIN = 'https://dashboard.dmnfood.co.kr';
const CALLBACK_PATH = '/api/naverworks/callback';
const AUTHORIZE_URL = 'https://auth.worksmobile.com/oauth2/v2.0/authorize';
const TOKEN_URL = 'https://auth.worksmobile.com/oauth2/v2.0/token';
const API_ORIGIN = 'https://www.worksapis.com';
const COOKIE_NAME = '__Host-dmn-mail-oauth';
const SEVEN_DAYS = 7 * 86400000;
const STATE_TTL = 600000;
const CONTINUATION_TTL = 3600000;
const MAX_DETAILS = 10;
const MAX_PAGES = 3;

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string'
    && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function encryptionKey(value) {
    const text = String(value || '').trim();
    const key = /^[a-f0-9]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
    if (key.length !== 32 || (!/^[a-f0-9]{64}$/i.test(text) && key.toString('base64') !== text)) {
        throw fail(503, 'mail_configuration_required', '메일 연결의 서버 비밀 설정을 먼저 완료해 주세요.');
    }
    return key;
}

function sealTokens(tokens, key, context) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
}

function openTokens(envelope, key, context) {
    try {
        const data = JSON.parse(envelope);
        if (data.v !== 1) throw new Error('version');
        const iv = Buffer.from(data.iv, 'base64'), tag = Buffer.from(data.tag, 'base64');
        if (iv.length !== 12 || tag.length !== 16) throw new Error('size');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(context));
        decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    } catch {
        throw fail(503, 'mail_connection_unavailable', '저장된 메일 인증 정보를 확인할 수 없습니다. 관리자 설정을 확인해 주세요.');
    }
}

function createMailService({ store, env = process.env, fetchImpl = globalThis.fetch, now = Date.now, randomBytes = crypto.randomBytes, authorizeCallback = require('./firebase-authorize.cjs') } = {}) {
    const clientId = String(env.NAVERWORKS_CLIENT_ID || 'kaXX9XpQRZ7ohuKFW1TU').trim();
    const mailbox = String(env.NAVERWORKS_MAILBOX || 'official@dmnfood.co.kr').trim().toLowerCase();
    const origin = APP_ORIGIN;
    const redirectUri = origin + CALLBACK_PATH;
    const context = `naverworks:${clientId}:${mailbox}`;

    function configuration() {
        const missing = [];
        if (!env.NAVERWORKS_CLIENT_SECRET) missing.push('NAVERWORKS_CLIENT_SECRET');
        if (env.NAVERWORKS_REDIRECT_URI && env.NAVERWORKS_REDIRECT_URI !== redirectUri) missing.push('NAVERWORKS_REDIRECT_URI');
        try { encryptionKey(env.MAIL_TOKEN_ENCRYPTION_KEY); } catch { missing.push('MAIL_TOKEN_ENCRYPTION_KEY'); }
        if (!store?.isConfigured?.()) missing.push('MAIL_COLLECTOR_EMAIL', 'MAIL_COLLECTOR_PASSWORD');
        return { ready: missing.length === 0, missing: [...new Set(missing)], storageVerified: false };
    }
    function ready() {
        if (!configuration().ready) throw fail(503, 'mail_configuration_required', '메일 연결의 서버 비밀 설정과 수집 계정을 먼저 준비해 주세요.');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailbox) || !/^[A-Za-z0-9_-]{3,200}$/.test(clientId)) {
            throw fail(503, 'mail_configuration_required', '메일 연결 설정을 확인해 주세요.');
        }
    }
    async function providerJson(url, options = {}) {
        let response;
        try {
            response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(6000) });
        } catch {
            throw fail(502, 'naverworks_unavailable', '네이버웍스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
        }
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) throw fail(409, 'naverworks_reconnect_required', '지정된 수신 메일함의 읽기 권한을 확인하지 못했습니다. 해당 메일 계정으로 다시 연결해 주세요.');
            if (response.status === 429) throw fail(429, 'naverworks_rate_limited', '네이버웍스 조회 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.');
            throw fail(502, 'naverworks_request_failed', '네이버웍스 요청을 완료하지 못했습니다. 다시 시도해 주세요.');
        }
        if (response.status === 204) return { mails: [] };
        try { return await response.json(); }
        catch { throw fail(502, 'naverworks_invalid_response', '네이버웍스 응답을 확인하지 못했습니다.'); }
    }
    function validateToken(payload, previous = null) {
        const scopes = String(payload.scope || previous?.scope || '').split(/[ ,]+/).filter(Boolean);
        const seconds = Number(payload.expires_in);
        if (payload.token_type?.toLowerCase() !== 'bearer' || typeof payload.access_token !== 'string' || !payload.access_token
            || !scopes.includes('mail.read') || scopes.some(scope => scope !== 'mail.read')
            || !Number.isFinite(seconds) || seconds < 60 || seconds > 86400
            || typeof (payload.refresh_token || previous?.refresh_token) !== 'string') {
            throw fail(502, 'naverworks_invalid_token', '메일 읽기 인증을 확인하지 못했습니다. 앱 권한 설정을 확인해 주세요.');
        }
        return { access_token: payload.access_token, refresh_token: payload.refresh_token || previous.refresh_token, scope: 'mail.read', expiresAt: now() + seconds * 1000 };
    }
    function apiPath(suffix) { return `${API_ORIGIN}/v1.0/users/${encodeURIComponent(mailbox)}/mail${suffix}`; }
    function mailGet(suffix, token) { return providerJson(apiPath(suffix), { headers: { Authorization: `Bearer ${token}` } }); }
    async function fetchFolders(accessToken) {
        const result = await mailGet('/mailfolders', accessToken);
        if (!Array.isArray(result.mailFolders) || result.mailFolders.some(folder => !Number.isSafeInteger(folder.folderId) || typeof folder.folderName !== 'string')) {
            throw fail(502, 'naverworks_invalid_response', '메일함 목록 응답을 확인하지 못했습니다.');
        }
        return result.mailFolders.map(folder => ({ id: String(folder.folderId), name: folder.folderName, type: folder.folderType, mailCount: folder.mailCount ?? 0 }));
    }
    function connectionSummary(record) {
        const data = record?.data;
        const connected = Boolean(data?.encryptedTokens && data.mailbox === mailbox && data.accessStatus === 'mailbox_access_verified');
        return { connected, mailbox, accessStatus: connected ? data.accessStatus : null, connectedAt: connected ? data.connectedAt : null };
    }
    async function status() {
        const config = configuration();
        let connection = null, lastSync = null;
        if (config.ready) {
            connection = await store.getConnection();
            const savedSync = await store.getSyncState();
            lastSync = savedSync?.data?.summary || null;
            config.storageVerified = true;
        }
        return { ok: true, configuration: config, connection: connectionSummary(connection), pilot: { days: 7, mode: 'raw_mail_only', interpretationReady: false }, lastSync };
    }
    async function start(uid, authorization) {
        ready();
        if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_.-]{50,8192}$/.test(authorization)) throw fail(401, 'mail_login_required', '대시보드에 다시 로그인해 주세요.');
        const state = randomBytes(32).toString('base64url');
        const cookie = randomBytes(32).toString('base64url');
        const encryptedAuthorization = sealTokens({ authorization }, encryptionKey(env.MAIL_TOKEN_ENCRYPTION_KEY), `${context}:oauth-state`);
        await store.createOAuthState(hash(state), { uid, mailbox, cookieHash: hash(cookie), encryptedAuthorization, createdAt: now(), expiresAt: now() + STATE_TTL });
        const url = new URL(AUTHORIZE_URL);
        url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope: 'mail.read', response_type: 'code', state }).toString();
        return { authorizationUrl: url.toString(), cookie: `${COOKIE_NAME}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600` };
    }
    async function callback({ state, code, cookie }) {
        ready();
        if (!/^[A-Za-z0-9_-]{43}$/.test(state || '') || !/^[A-Za-z0-9_-]{43}$/.test(cookie || '') || typeof code !== 'string' || !code || code.length > 4096) {
            throw fail(400, 'mail_oauth_state_invalid', '메일 연결 요청이 만료되었거나 일치하지 않습니다. 다시 시작해 주세요.');
        }
        const saved = await store.consumeOAuthState(hash(state), hash(cookie), now());
        if (!saved || saved.mailbox !== mailbox || !saved.uid || saved.expiresAt <= now()) throw fail(400, 'mail_oauth_state_invalid', '메일 연결 요청이 만료되었거나 일치하지 않습니다. 다시 시작해 주세요.');
        const proof = openTokens(saved.encryptedAuthorization, encryptionKey(env.MAIL_TOKEN_ENCRYPTION_KEY), `${context}:oauth-state`);
        const administrator = await authorizeCallback({ headers: { authorization: proof.authorization } });
        if (administrator.role !== 'admin' || administrator.uid !== saved.uid) throw fail(403, 'mail_admin_required', '관리자 권한을 다시 확인한 뒤 연결해 주세요.');
        return store.withLease('naverworks-operation', async () => {
            const current = await store.getConnection();
            const result = await providerJson(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: env.NAVERWORKS_CLIENT_SECRET, redirect_uri: redirectUri }).toString() });
            const tokens = validateToken(result);
            // This checks permission to this exact mailbox; it does not assert an OIDC profile identity.
            await fetchFolders(tokens.access_token);
            await store.saveConnection({ mailbox, encryptedTokens: sealTokens(tokens, encryptionKey(env.MAIL_TOKEN_ENCRYPTION_KEY), context), expiresAt: tokens.expiresAt, scopes: ['mail.read'], accessStatus: 'mailbox_access_verified', connectedAt: new Date(now()).toISOString(), connectedBy: saved.uid }, { expectedVersion: current?.version || null });
            return { connected: true };
        }, { ttlMs: 300000 });
    }
    async function withToken(work) {
        ready();
        return store.withLease('naverworks-operation', async lease => {
            let saved = await store.getConnection();
            if (!connectionSummary(saved).connected) throw fail(409, 'mail_not_connected', '먼저 네이버웍스 수신 메일함을 연결해 주세요.');
            let tokens = openTokens(saved.data.encryptedTokens, encryptionKey(env.MAIL_TOKEN_ENCRYPTION_KEY), context);
            if (typeof tokens.access_token !== 'string' || !tokens.access_token || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token
                || tokens.scope !== 'mail.read' || !Number.isFinite(tokens.expiresAt)) throw fail(409, 'naverworks_reconnect_required', '저장된 메일 인증을 확인하지 못했습니다. 다시 연결해 주세요.');
            if (tokens.expiresAt <= now() + 60000) {
                const result = await providerJson(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId, client_secret: env.NAVERWORKS_CLIENT_SECRET }).toString() });
                tokens = validateToken(result, tokens);
                // Persist a rotated refresh token before making any mail API request.
                saved = await store.saveConnection({ ...saved.data, encryptedTokens: sealTokens(tokens, encryptionKey(env.MAIL_TOKEN_ENCRYPTION_KEY), context), expiresAt: tokens.expiresAt }, { expectedVersion: saved.version });
            }
            return work(tokens.access_token, lease);
        }, { ttlMs: 300000 });
    }
    async function folders() { return withToken(async accessToken => ({ ok: true, folders: await fetchFolders(accessToken) })); }
    function signContinuation(data) {
        const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
        const signature = crypto.createHmac('sha256', encryptionKey(env.MAIL_TOKEN_ENCRYPTION_KEY)).update(`mail-pilot:${payload}`).digest('base64url');
        return `${payload}.${signature}`;
    }
    function readContinuation(value, uid, folderId) {
        try {
            if (typeof value !== 'string' || value.length > 20000) throw new Error('size');
            const [payload, signature, extra] = value.split('.');
            const expected = crypto.createHmac('sha256', encryptionKey(env.MAIL_TOKEN_ENCRYPTION_KEY)).update(`mail-pilot:${payload}`).digest('base64url');
            if (extra || !safeEqual(signature, expected)) throw new Error('signature');
            const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
            if (data.uid !== uid || data.mailbox !== mailbox || data.folderId !== folderId || data.exp <= now()
                || typeof data.cursor !== 'string' || data.cursor.length > 10000
                || typeof data.started !== 'boolean' || !Array.isArray(data.pending) || data.pending.length > 30
                || data.pending.some(item => !Number.isSafeInteger(item.mailId) || typeof item.receivedTime !== 'string' || !Number.isFinite(Date.parse(item.receivedTime)))
                || ['collected', 'duplicates', 'scanned', 'skipped'].some(key => !Number.isSafeInteger(data[key]) || data[key] < 0)
                || !Number.isFinite(data.to) || data.to > now() || data.to - data.from !== SEVEN_DAYS) throw new Error('claims');
            return data;
        } catch { throw fail(400, 'mail_continuation_invalid', '이어서 조회할 요청이 만료되었거나 일치하지 않습니다. 새 조회를 시작해 주세요.'); }
    }
    async function sync(uid, input) {
        const folderId = typeof input.folderId === 'string' ? input.folderId : '';
        if (!/^-?\d{1,12}$/.test(folderId)) throw fail(400, 'mail_folder_required', '시험 조회할 메일함을 선택해 주세요.');
        const started = now();
        const data = input.continuation ? readContinuation(input.continuation, uid, folderId) : { uid, mailbox, folderId, from: started - SEVEN_DAYS, to: started, exp: started + CONTINUATION_TTL, cursor: '', pending: [], started: false, collected: 0, duplicates: 0, scanned: 0, skipped: 0 };
        return withToken(async (accessToken, lease) => {
            const available = await fetchFolders(accessToken);
            if (!available.some(folder => folder.id === folderId)) throw fail(400, 'mail_folder_unavailable', '선택한 메일함을 확인하지 못했습니다. 목록을 다시 불러와 주세요.');
            let details = 0, pages = 0, complete = false;
            const seenCursors = new Set();
            while (details < MAX_DETAILS && now() - started < 25000) {
                if (!data.pending.length) {
                    if (data.started && !data.cursor) { complete = true; break; }
                    if (pages >= MAX_PAGES) break;
                    const pageCursor = data.cursor;
                    if (seenCursors.has(pageCursor)) throw fail(502, 'naverworks_invalid_response', '메일 목록의 다음 페이지를 확인하지 못했습니다.');
                    seenCursors.add(pageCursor);
                    const query = new URLSearchParams({ count: '30', searchFilterType: 'all', isUnread: 'false' });
                    if (pageCursor) query.set('cursor', pageCursor);
                    const page = await mailGet(`/mailfolders/${encodeURIComponent(folderId)}/children?${query}`, accessToken);
                    if (!Array.isArray(page.mails) || page.mails.length > 30 || page.mails.some(item => !Number.isSafeInteger(item.mailId) || typeof item.receivedTime !== 'string' || !Number.isFinite(Date.parse(item.receivedTime)))) {
                        throw fail(502, 'naverworks_invalid_response', '메일의 고유 번호 또는 수신 시간을 확인하지 못했습니다.');
                    }
                    const next = page.responseMetaData?.nextCursor || '';
                    if (typeof next !== 'string' || next.length > 10000 || (next && next === pageCursor)) throw fail(502, 'naverworks_invalid_response', '메일 목록의 다음 페이지를 확인하지 못했습니다.');
                    // Freeze unprocessed IDs before returning a continuation. Never resume by
                    // offset into a refetched live page, where arriving/deleted mail can shift rows.
                    data.pending = page.mails.map(item => ({ mailId: item.mailId, receivedTime: item.receivedTime }));
                    data.cursor = next;
                    data.started = true;
                    pages++;
                    if (!data.pending.length) continue;
                }
                while (data.pending.length && details < MAX_DETAILS && now() - started < 25000) {
                    const summary = data.pending[0];
                    data.scanned++;
                    const received = Date.parse(summary.receivedTime);
                    if (received < data.from || received > data.to) { data.skipped++; data.pending.shift(); continue; }
                    const raw = await mailGet(`/${encodeURIComponent(String(summary.mailId))}?hasThreads=false`, accessToken);
                    if (!raw.mail || raw.mail.mailId !== summary.mailId || typeof raw.mail.body !== 'string' || !Array.isArray(raw.attachments)
                        || !Number.isFinite(Date.parse(raw.mail.receivedTime))) throw fail(502, 'naverworks_invalid_response', '메일 원문 응답을 확인하지 못했습니다.');
                    const exactReceived = Date.parse(raw.mail.receivedTime);
                    if (exactReceived !== received || exactReceived < data.from || exactReceived > data.to) throw fail(409, 'mail_source_changed', '메일 목록과 원문의 수신 시간이 달라 조회를 중단했습니다. 새 조회를 시작해 주세요.');
                    const created = await store.createIntake({ account: mailbox, mailId: String(summary.mailId), folderId, subject: raw.mail.subject || '', from: raw.mail.from || null, receivedAt: raw.mail.receivedTime, raw, collectedAt: new Date(now()).toISOString(), collectedBy: uid, sourceChannel: 'naverworks_mail', processingStatus: 'pending_interpretation', interpretationState: 'awaiting_interpretation', attachmentState: 'metadata_only', attachmentStatus: 'metadata_only' });
                    if (created.created) data.collected++; else data.duplicates++;
                    details++;
                    data.pending.shift();
                }
            }
            if (data.started && !data.pending.length && !data.cursor) complete = true;
            const result = { status: complete ? 'complete' : 'partial', scanComplete: complete, attachmentsComplete: false, collected: data.collected, duplicates: data.duplicates, scanned: data.scanned, skipped: data.skipped, from: new Date(data.from).toISOString(), to: new Date(data.to).toISOString(), folderId, continuation: complete ? null : signContinuation(data), attachmentHandling: 'metadata_only', interpretationReady: false };
            const { continuation, ...summary } = result;
            await store.saveSyncRun({ summary, mailbox, requestedBy: uid, completedAt: new Date(now()).toISOString() }, { lease });
            return { ok: true, sync: result };
        });
    }
    return { status, start, callback, folders, sync, configuration, mailbox, origin, redirectUri };
}

module.exports = { createMailService, encryptionKey, sealTokens, openTokens, COOKIE_NAME, APP_ORIGIN, CALLBACK_PATH, MAX_DETAILS, MAX_PAGES };
