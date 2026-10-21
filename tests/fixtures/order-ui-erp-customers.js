// LOOPBACK FICTIONAL FIXTURE ONLY. No Firebase or ERP requests are made here.
import { normalizeErpCustomer, validateErpCustomer, CUSTOMER_IMPORT_LIMIT } from '/dashboard/js/erp-customer-model.js';
export const ERP_CUSTOMER_COLLECTION = 'erpCustomers';
const KEY = 'dmnfood-fictional-erp-customers-v1', EVENT = 'fictional-erp-customers-changed';
function localOnly() { if (!['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('Local fictional verification only.'); }
export function getLocalErpCustomers() { localOnly(); return JSON.parse(sessionStorage.getItem(KEY) || '[]'); }
function actor(session) {
    localOnly(); if (navigator.onLine === false) throw new Error('인터넷 연결 후 다시 시도해 주세요.');
    if (session?.user?.uid !== 'fictional-local-manager' || !['manager', 'admin'].includes(session?.profile?.role)) throw new Error('가상 검증 계정을 확인해 주세요.');
    return { uid: session.user.uid, name: '가상 검증 담당자' };
}
function timestamp() { const previous = getLocalErpCustomers().map(item => Date.parse(item.updatedAtIso)).filter(Number.isFinite); return new Date(Math.max(Date.now(), ...previous.map(time => time + 1))).toISOString(); }
function publish(items) { sessionStorage.setItem(KEY, JSON.stringify(items)); window.dispatchEvent(new Event(EVENT)); }
export function subscribeErpCustomers(next, error) {
    let disposed = false; const emit = () => { if (disposed) return; try { next(getLocalErpCustomers().sort((a, b) => a.name.localeCompare(b.name, 'ko')), { fromCache: false, hasPendingWrites: false }); } catch (failure) { error?.(failure); } };
    window.addEventListener(EVENT, emit); queueMicrotask(emit); return () => { disposed = true; window.removeEventListener(EVENT, emit); };
}
function assertPrevious(previous, input) {
    if ((!previous && input.expectedRevision != null) || (previous && (previous.revision !== input.expectedRevision || (input.expectedUpdatedAtIso && previous.updatedAtIso !== input.expectedUpdatedAtIso)))) throw new Error('다른 담당자가 거래처를 변경했습니다. 최신 목록에서 다시 확인해 주세요.');
}
function updated(input, previous, author, now) {
    return { schemaVersion: 1, id: input.code, code: input.code, name: input.name, revision: (previous?.revision || 0) + 1,
        createdAtIso: previous?.createdAtIso || now, createdByUid: previous?.createdByUid || author.uid, createdByName: previous?.createdByName || author.name,
        updatedAtIso: now, updatedByUid: author.uid, updatedByName: author.name, syncState: 'confirmed' };
}
export async function saveErpCustomer(input, session) {
    const author = actor(session), value = normalizeErpCustomer(input), errors = validateErpCustomer(value); if (errors.length) throw new Error(errors.join(' '));
    const items = getLocalErpCustomers(), previous = items.find(item => item.code === value.code); assertPrevious(previous, input);
    if (previous?.name !== value.name) publish([...items.filter(item => item.code !== value.code), updated(value, previous, author, timestamp())]);
    return { id: value.code, code: value.code };
}
export async function saveErpCustomerImport(plan, session, { confirmNameChanges = false } = {}) {
    const author = actor(session), entries = plan?.entries, items = getLocalErpCustomers(), seen = new Set(), changes = [];
    if (!Array.isArray(entries) || !entries.length || entries.length > CUSTOMER_IMPORT_LIMIT) throw new Error('가져올 거래처를 다시 확인해 주세요.');
    const now = timestamp();
    for (const item of entries) {
        if (validateErpCustomer(item).length || seen.has(item.code)) throw new Error('거래처 가져오기 내용을 다시 확인해 주세요.'); seen.add(item.code);
        const previous = items.find(record => record.code === item.code); assertPrevious(previous, item);
        const action = !previous ? 'create' : previous.name === item.name ? 'unchanged' : 'update';
        if (item.action !== action || (action === 'update' && !confirmNameChanges)) throw new Error('기존 거래처명 변경 내용을 먼저 확인해 주세요.');
        if (action !== 'unchanged') changes.push(updated(item, previous, author, now));
    }
    const changedCodes = new Set(changes.map(item => item.code)); publish([...items.filter(item => !changedCodes.has(item.code)), ...changes]);
    return { saved: changes.length };
}
