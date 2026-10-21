// Served only by tests/order-ui-server.mjs on loopback. Never import in production.
const user = Object.freeze({ uid: 'fictional-local-manager', email: 'local-manager@example.test',
    async getIdToken() {
        if (!['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('Local verification only.');
        return 'fictional-local-token-not-a-firebase-credential';
    } });
const role = new URLSearchParams(location.search).get('verificationRole') === 'admin' ? 'admin' : 'manager';
const profile = Object.freeze({ role, approvalStatus: 'approved', isActive: true, displayName: '가상 검증 담당자', employeeName: '가상 검증 담당자' });
export const auth = { currentUser: user };
export const db = Object.freeze({ localVerificationOnly: true });
export const isApprovedActiveProfile = value => value?.approvalStatus === 'approved' && value.isActive === true && ['worker', 'manager', 'admin'].includes(value.role);
export async function requireApprovedActiveUser() {
    const requestedDelay = Number(new URLSearchParams(location.search).get('authDelayMs') || 0);
    const delayMs = Number.isFinite(requestedDelay) ? Math.min(5000, Math.max(0, requestedDelay)) : 0;
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    return { user, profile, role: profile.role };
}
export async function logoutToLogin() { location.assign('/home'); }
