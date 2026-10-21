import { collection, doc, onSnapshot, orderBy, query, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { auth, db, isApprovedActiveProfile } from './firebase-client.js';
import { assertOrderRevision, buildOrderReview, emptyReviewChecks, normalizeOrderDraft, validateOrderDraft, validateOrderInput } from './order-request-model.js';

export const ORDER_REQUEST_COLLECTION = 'orderRequests';
const timestampToIso = value => value?.toDate ? value.toDate().toISOString() : '';
function assertUpdatedAt(record, expected) {
    if (expected != null && timestampToIso(record.updatedAt) !== expected) throw new Error('다른 담당자가 검토 내용을 변경했습니다. 최신 내용을 다시 확인해 주세요.');
}

function actor(session) {
    if (globalThis.navigator?.onLine === false) throw new Error('인터넷 연결 후 다시 시도해 주세요. 오프라인에서는 발주를 저장하거나 승인할 수 없습니다.');
    const { user, profile } = session || {};
    if (!user?.uid || auth.currentUser?.uid !== user.uid || !isApprovedActiveProfile(profile) || !['manager', 'admin'].includes(profile.role)) {
        throw new Error('승인된 관리자 또는 매니저 계정으로 다시 로그인해 주세요.');
    }
    return { uid: user.uid, name: profile.employeeName || profile.displayName || profile.email || user.uid };
}

function orderRef(id) {
    if (typeof id !== 'string' || !id || id.length > 1500 || id.includes('/')) throw new Error('발주 주소를 확인해 주세요.');
    return doc(db, ORDER_REQUEST_COLLECTION, id);
}

export function mapOrderRequest(snapshot) {
    if (!snapshot.exists()) return null;
    const data = snapshot.data();
    return { ...data, id: snapshot.id, createdAtIso: timestampToIso(data.createdAt), updatedAtIso: timestampToIso(data.updatedAt),
        receivedAtIso: timestampToIso(data.receivedAt), reviewedAtIso: timestampToIso(data.reviewedAt),
        syncState: snapshot.metadata.hasPendingWrites ? 'pending' : snapshot.metadata.fromCache ? 'cached' : 'confirmed' };
}

export function subscribeOrderRequests(onOrders, onError) {
    return onSnapshot(query(collection(db, ORDER_REQUEST_COLLECTION), orderBy('createdAt', 'desc')), { includeMetadataChanges: true },
        snapshot => onOrders(snapshot.docs.map(mapOrderRequest), { fromCache: snapshot.metadata.fromCache, hasPendingWrites: snapshot.metadata.hasPendingWrites }), onError);
}

export function subscribeOrderRequest(id, onOrder, onError) {
    return onSnapshot(orderRef(id), { includeMetadataChanges: true }, snapshot => onOrder(mapOrderRequest(snapshot)), onError);
}

export async function createOrderRequest(input, session) {
    const author = actor(session);
    const draft = normalizeOrderDraft(input?.draft);
    const values = { customerName: typeof input?.customerName === 'string' ? input.customerName.trim() : '', customerGroup: input?.customerGroup,
        sourceChannel: input?.sourceChannel, sourceText: typeof input?.sourceText === 'string' ? input.sourceText : '',
        sourceReference: typeof input?.sourceReference === 'string' ? input.sourceReference.trim() : '', isTest: input?.isTest === true, draft };
    const errors = validateOrderInput(values);
    if (errors.length) throw new Error(errors.join('\n'));
    const ref = doc(collection(db, ORDER_REQUEST_COLLECTION));
    // Reading a new document in a transaction requires a server connection; no offline approval queue is created.
    await runTransaction(db, async transaction => {
        const existing = await transaction.get(ref);
        if (existing.exists()) throw new Error('접수 번호가 중복되었습니다. 다시 시도해 주세요.');
        transaction.set(ref, { schemaVersion: 1, ...values, revision: 1, status: 'pending_review', createdByUid: author.uid, createdByName: author.name,
            receivedAt: serverTimestamp(), createdAt: serverTimestamp(), updatedAt: serverTimestamp(), reviewNotes: '', reviewChecks: emptyReviewChecks(),
            reviewedByUid: '', reviewedByName: '', reviewedAt: null, approvedRevision: 0 });
    });
    return { id: ref.id, revision: 1, status: 'pending_review' };
}

export async function updateOrderRequest(id, expectedRevision, input, session) {
    const author = actor(session);
    const draft = normalizeOrderDraft(input?.draft || input);
    const errors = validateOrderDraft(draft);
    if (errors.length) throw new Error(errors.join('\n'));
    const ref = orderRef(id);
    await runTransaction(db, async transaction => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists()) throw new Error('발주를 찾을 수 없습니다.');
        const previous = snapshot.data();
        assertOrderRevision(previous, expectedRevision);
        assertUpdatedAt(previous, input?.expectedUpdatedAtIso);
        transaction.set(doc(db, ORDER_REQUEST_COLLECTION, id, 'versions', String(expectedRevision)), {
            record: previous, archivedAt: serverTimestamp(), archivedByUid: author.uid,
        });
        transaction.update(ref, { draft, revision: expectedRevision + 1, status: 'pending_review', updatedAt: serverTimestamp(),
            reviewNotes: '', reviewChecks: emptyReviewChecks(), reviewedByUid: '', reviewedByName: '', reviewedAt: null, approvedRevision: 0 });
    });
    return { id, revision: expectedRevision + 1, status: 'pending_review' };
}

export async function reviewOrderRequest(id, expectedRevision, decision, session) {
    const reviewer = actor(session);
    const ref = orderRef(id);
    await runTransaction(db, async transaction => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists()) throw new Error('발주를 찾을 수 없습니다.');
        assertUpdatedAt(snapshot.data(), decision?.expectedUpdatedAtIso);
        const review = buildOrderReview(snapshot.data(), expectedRevision, decision, reviewer);
        transaction.update(ref, { ...review, reviewedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    });
    return { id, revision: expectedRevision, status: decision.status };
}
