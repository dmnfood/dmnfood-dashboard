// UI session limits are separate from Firebase's server-side token validity.
export const SESSION_KEY = 'dmnfood.auth.session.v1';
export const LOGOUT_KEY = 'dmnfood.auth.logout.v1';
export const SESSION_HOURS = 8;
export const REMEMBER_HOURS = 7 * 24;

export function validSession(session, uid, now = Date.now()) {
    return !!session && session.uid === uid && Number.isFinite(session.startedAt)
        && Number.isFinite(session.expiresAt) && session.startedAt <= now
        && session.expiresAt > now
        && session.expiresAt - session.startedAt <= (session.remember ? REMEMBER_HOURS : SESSION_HOURS) * 3600000;
}

export function readSession(uid) {
    for (const storageName of ['sessionStorage', 'localStorage']) {
        try {
            const value = JSON.parse(globalThis[storageName].getItem(SESSION_KEY));
            if (value?.uid === uid) return value;
        } catch { /* Missing or unavailable storage requires a new login. */ }
    }
    return null;
}

export function saveSession(uid, remember) {
    const startedAt = Date.now();
    const session = { uid, remember: !!remember, startedAt, expiresAt: startedAt + (remember ? REMEMBER_HOURS : SESSION_HOURS) * 3600000 };
    clearSession();
    (remember ? localStorage : sessionStorage).setItem(SESSION_KEY, JSON.stringify(session));
    return session;
}

export function clearSession() {
    for (const storageName of ['sessionStorage', 'localStorage']) {
        try { globalThis[storageName].removeItem(SESSION_KEY); } catch { /* Sign-out must still proceed. */ }
    }
}
