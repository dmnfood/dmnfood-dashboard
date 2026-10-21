// LOOPBACK FICTIONAL FIXTURE ONLY. No Firebase, production data, or ERP calls.
import { auth } from '/dashboard/js/firebase-client.js';
import { validateSchoolMealCompanyCatalog } from '/dashboard/js/school-meal-company-model.js';
const EVENT = 'fictional-school-companies-changed';
function localOnly() { if (!['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('Local fictional verification only.'); }
async function request(body) {
    localOnly();
    if (navigator.onLine === false) throw new Error('인터넷 연결 후 다시 시도해 주세요.');
    const token = await auth.currentUser.getIdToken();
    const response = await fetch('/__order_ui/school-companies', { method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin',
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok || value.ok !== true || value.mode !== 'fictional_local_only') throw new Error(value.error || '가상 업체 목록을 확인하지 못했습니다.');
    await validateSchoolMealCompanyCatalog(value.catalog); return value.catalog;
}
export function subscribeSchoolMealCompanies(next, error) {
    let disposed = false, revision = 0;
    const emit = async () => {
        const token = ++revision;
        try { const catalog = await request(); if (!disposed && token === revision) next(catalog.companies.map(item => ({ ...item,
            code: item.id, revision: catalog.revision, source: 'school_meal', erpCode: null, syncState: 'confirmed' })),
            { exists: true, revision: catalog.revision, fromCache: false, hasPendingWrites: false }); }
        catch (failure) { if (!disposed && token === revision) error?.(failure); }
    };
    window.addEventListener(EVENT, emit); queueMicrotask(emit);
    return () => { disposed = true; revision++; window.removeEventListener(EVENT, emit); };
}
function actor(session) { localOnly(); if (session?.user?.uid !== 'fictional-local-manager' || !['admin', 'manager'].includes(session?.profile?.role)) throw new Error('가상 검증 계정을 확인해 주세요.'); }
export async function ensureSchoolMealCompanies(session) { actor(session); const catalog = await request(); return { created: false, revision: catalog.revision }; }
export async function saveSchoolMealCompanies(names, { expectedRevision } = {}, session) {
    actor(session); const catalog = await request({ names, expectedRevision }); window.dispatchEvent(new Event(EVENT)); return { revision: catalog.revision };
}
