// Verify with Firebase itself; no service-account key is needed on the client or server.
const PROJECT_ID = 'dmnfood-haccp';
const WEB_API_KEY = 'AIzaSyDrBi1E23fKRmd1EkkCFBLQQdqccjHrwLk';
const failure = (status, message) => Object.assign(new Error(message), { status });

module.exports = async function authorize(request) {
    const header = request.headers?.authorization;
    if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_.-]{50,8192}$/.test(header)) {
        throw failure(401, '로그인이 필요합니다.');
    }
    const token = header.slice(7);
    const lookup = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${WEB_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token }), signal: AbortSignal.timeout(10000),
    });
    if (!lookup.ok) throw failure(lookup.status >= 500 || lookup.status === 429 ? 503 : 401, '로그인 정보를 확인하지 못했습니다. 다시 로그인해 주세요.');
    const account = (await lookup.json()).users?.[0];
    let claims;
    try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
    catch { throw failure(401, '유효하지 않은 로그인입니다.'); }
    const now = Math.floor(Date.now() / 1000);
    if (!account || account.disabled || account.localId !== claims.sub
        || claims.aud !== PROJECT_ID || claims.iss !== `https://securetoken.google.com/${PROJECT_ID}`
        || !Number.isFinite(claims.exp) || claims.exp <= now
        || !Number.isFinite(claims.auth_time) || claims.auth_time > now
        || claims.auth_time < now - 7 * 86400
        || Number(account.validSince || 0) > claims.auth_time) {
        throw failure(401, '로그인이 만료되었습니다. 다시 로그인해 주세요.');
    }
    const result = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${encodeURIComponent(account.localId)}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
    });
    if (!result.ok) throw failure(result.status >= 500 || result.status === 429 ? 503 : 403, '계정 권한을 확인할 수 없습니다.');
    const fields = (await result.json()).fields || {};
    const role = fields.role?.stringValue;
    const status = fields.approvalStatus?.stringValue;
    if (fields.isActive?.booleanValue !== true || !['manager', 'admin'].includes(role)
        || (status !== undefined && status !== 'approved')) {
        throw failure(403, '승인된 관리자만 사용할 수 있습니다.');
    }
    return { uid: account.localId, role };
};
