import { collection, doc, onSnapshot, orderBy, query, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { auth, db, isApprovedActiveProfile } from './firebase-client.js';
import { CUSTOMER_IMPORT_LIMIT, normalizeErpCustomer, validateErpCustomer } from './erp-customer-model.js';

export const ERP_CUSTOMER_COLLECTION = 'erpCustomers';
const timestampToIso = value => value?.toDate ? value.toDate().toISOString() : '';
function actor(session) {
    if (globalThis.navigator?.onLine === false) throw new Error('인터넷 연결 후 다시 저장해 주세요.');
    const { user, profile } = session || {};
    if (!user?.uid || auth.currentUser?.uid !== user.uid || !isApprovedActiveProfile(profile) || !['manager', 'admin'].includes(profile.role)) throw new Error('승인된 관리자 또는 매니저 계정으로 다시 로그인해 주세요.');
    return { uid: user.uid, name: profile.employeeName || profile.displayName || profile.email || user.uid };
}
export function subscribeErpCustomers(onCustomers, onError) {
    return onSnapshot(query(collection(db, ERP_CUSTOMER_COLLECTION), orderBy('name')), { includeMetadataChanges: true }, snapshot => {
        onCustomers(snapshot.docs.map(item => ({ ...item.data(), id: item.id, updatedAtIso: timestampToIso(item.data().updatedAt),
            syncState: item.metadata.hasPendingWrites ? 'pending' : item.metadata.fromCache ? 'cached' : 'confirmed' })),
        { fromCache: snapshot.metadata.fromCache, hasPendingWrites: snapshot.metadata.hasPendingWrites });
    }, onError);
}
function assertPrevious(previous, input) {
    if (!previous) { if (input.expectedRevision != null) throw new Error('거래처 목록이 변경되었습니다. 다시 확인해 주세요.'); return; }
    if (!Number.isSafeInteger(input.expectedRevision) || previous.revision !== input.expectedRevision
        || (input.expectedUpdatedAtIso && timestampToIso(previous.updatedAt) !== input.expectedUpdatedAtIso)) throw new Error('다른 담당자가 거래처를 변경했습니다. 최신 목록에서 다시 확인해 주세요.');
}
function writeCustomer(transaction, ref, previous, input, author) {
    if (previous) transaction.update(ref, { name: input.name, revision: previous.revision + 1, updatedAt: serverTimestamp(), updatedByUid: author.uid, updatedByName: author.name });
    else transaction.set(ref, { schemaVersion: 1, code: input.code, name: input.name, revision: 1,
        createdAt: serverTimestamp(), createdByUid: author.uid, createdByName: author.name,
        updatedAt: serverTimestamp(), updatedByUid: author.uid, updatedByName: author.name });
}
export async function saveErpCustomer(input, session) {
    const author = actor(session), customer = normalizeErpCustomer(input), errors = validateErpCustomer(customer);
    if (errors.length) throw new Error(errors.join('\n'));
    const ref = doc(db, ERP_CUSTOMER_COLLECTION, customer.code);
    await runTransaction(db, async transaction => {
        const snapshot = await transaction.get(ref), previous = snapshot.exists() ? snapshot.data() : null;
        assertPrevious(previous, input); if (previous?.name === customer.name) return;
        writeCustomer(transaction, ref, previous, customer, author);
    });
    return { id: customer.code, code: customer.code };
}
/** One transaction prevents partially saved imports and rechecks the reviewed revisions. */
export async function saveErpCustomerImport(plan, session, { confirmNameChanges = false } = {}) {
    const author = actor(session), entries = plan?.entries;
    if (!Array.isArray(entries) || !entries.length || entries.length > CUSTOMER_IMPORT_LIMIT) throw new Error('가져올 거래처를 다시 확인해 주세요.');
    const seen = new Set();
    for (const item of entries) {
        const errors = validateErpCustomer(item); if (errors.length || seen.has(item.code) || !['create', 'update', 'unchanged'].includes(item.action)) throw new Error('거래처 가져오기 내용을 다시 확인해 주세요.');
        seen.add(item.code);
        if (item.action === 'update' && !confirmNameChanges) throw new Error('기존 거래처명 변경 내용을 먼저 확인해 주세요.');
    }
    await runTransaction(db, async transaction => {
        const records = [];
        for (const item of entries) {
            const ref = doc(db, ERP_CUSTOMER_COLLECTION, item.code), snapshot = await transaction.get(ref), previous = snapshot.exists() ? snapshot.data() : null;
            assertPrevious(previous, item);
            const actualAction = !previous ? 'create' : previous.name === item.name ? 'unchanged' : 'update';
            if (actualAction !== item.action) throw new Error('거래처 목록이 변경되었습니다. 파일을 다시 열어 확인해 주세요.');
            records.push({ ref, previous, item });
        }
        for (const { ref, previous, item } of records) if (item.action !== 'unchanged') writeCustomer(transaction, ref, previous, item, author);
    });
    return { saved: entries.filter(item => item.action !== 'unchanged').length };
}
