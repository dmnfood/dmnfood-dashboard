// UI session limits are separate from Firebase's server-side token validity.
export const SESSION_KEY = 'dmnfood.auth.session.v1';
export const LOGOUT_KEY = 'dmnfood.auth.logout.v1';
export const SESSION_HOURS = 8;
export const REMEMBER_HOURS = 7 * 24;

// Only pages that perform their own approved-user check can be login destinations.
const RETURN_PATHS = new Set([
    '/home', '/orders', '/users', '/bond', '/cashflow', '/sesame-bid-analysis',
    '/school-meal-weekly', '/haccp', '/haccp-heating', '/haccp-heating-journal',
    '/haccp-filtering', '/haccp-bottle-washing', '/haccp-raw-material-usage',
    '/haccp-production', '/haccp-raw-material-inspection', '/haccp-aux-material-inspection',
    '/haccp-data-export', '/haccp-ccp-verification', '/haccp-general-hygiene-process',
    '/haccp-compressed-air-filter', '/haccp-pest-control', '/cost-management',
    '/cost-bom', '/cost-materials', '/cost-sheets', '/new-product-cost-calculator',
    '/dashboard/home.html', '/dashboard/orders.html', '/dashboard/users.html',
    '/dashboard/monthlybond.html', '/dashboard/cashflow.html', '/dashboard/sesame-bid-analysis.html',
    '/dashboard/school-meal-weekly.html', '/dashboard/haccp.html', '/dashboard/haccp-master.html',
    '/dashboard/haccp-heating.html', '/dashboard/haccp-heating-v2.html', '/dashboard/haccp-heating-journal.html',
    '/dashboard/haccp-filtering.html', '/dashboard/haccp-filtering-v2.html', '/dashboard/haccp-bottle-washing.html',
    '/dashboard/haccp-raw-material-usage.html', '/dashboard/haccp-production.html',
    '/dashboard/haccp-raw-material-inspection.html', '/dashboard/haccp-aux-material-inspection.html',
    '/dashboard/haccp-data-export.html', '/dashboard/haccp-ccp-verification.html',
    '/dashboard/haccp-general-hygiene-process.html', '/dashboard/haccp-compressed-air-filter.html',
    '/dashboard/haccp-pest-control.html', '/dashboard/cost-management.html',
]);
const LOGIN_PATHS = new Set(['/', '/dashboard/loginpage.html']);
const RETURN_URL_BASE = 'https://dashboard.invalid';

function allowedReturnTo(value) {
    if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/')
        || value.startsWith('//') || /[\\\s\u0000-\u001f\u007f]/.test(value)) return null;
    try {
        const parsed = new URL(value, RETURN_URL_BASE);
        // Reject encoded paths and normalization tricks; query values may remain encoded.
        const originalPath = value.split(/[?#]/, 1)[0];
        if (parsed.origin !== RETURN_URL_BASE || originalPath !== parsed.pathname
            || originalPath.includes('%') || !RETURN_PATHS.has(parsed.pathname)) return null;
        return parsed.pathname + parsed.search + parsed.hash;
    } catch { return null; }
}

export function getSafeReturnTo(value, fallback = '/home') {
    return allowedReturnTo(value) || allowedReturnTo(fallback) || '/home';
}

export function buildLoginUrl(returnTo, loginPath = '/') {
    const path = LOGIN_PATHS.has(loginPath) ? loginPath : '/';
    return `${path}?next=${encodeURIComponent(getSafeReturnTo(returnTo))}`;
}

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
