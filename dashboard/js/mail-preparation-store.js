import { doc, onSnapshot, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { auth, db, isApprovedActiveProfile } from './firebase-client.js';
import { assertMailPreparationAddress, assertMailPreparationRevision, assertMailPreparationSource, validateMailPreparationCustomer, validateMailPreparationInput } from './mail-preparation-model.js';

export const MAIL_PREPARATION_COLLECTION = 'mailPreparations';
const timestampToIso = value => value?.toDate ? value.toDate().toISOString() : '';
function preparationRef(intakeId, attachmentId) {
    assertMailPreparationAddress(intakeId, attachmentId);
    return doc(db, MAIL_PREPARATION_COLLECTION, intakeId, 'attachments', attachmentId);
}
function actor(session) {
    if (globalThis.navigator?.onLine === false) throw new Error('인터넷 연결 후 다시 시도해 주세요. 오프라인에서는 작업을 저장할 수 없습니다.');
    const { user, profile } = session || {};
    if (!user?.uid || auth.currentUser?.uid !== user.uid || !isApprovedActiveProfile(profile) || !['manager', 'admin'].includes(profile.role)) {
        throw new Error('승인된 관리자 또는 매니저 계정으로 다시 로그인해 주세요.');
    }
    return user.uid;
}
function assertConfirmed(snapshot) {
    if (snapshot.metadata?.fromCache || snapshot.metadata?.hasPendingWrites) throw new Error('서버의 최신 내용을 확인한 후 다시 시도해 주세요.');
}
export function mapMailPreparation(snapshot) {
    if (!snapshot.exists()) return null;
    const data = snapshot.data();
    return { ...data, id: data.intakeId, createdAtIso: timestampToIso(data.createdAt), updatedAtIso: timestampToIso(data.updatedAt),
        syncState: snapshot.metadata.hasPendingWrites ? 'pending' : snapshot.metadata.fromCache ? 'cached' : 'confirmed' };
}
export function subscribeMailPreparation(intakeId, attachmentId, onRecord, onError) {
    return onSnapshot(preparationRef(intakeId, attachmentId), { includeMetadataChanges: true }, snapshot => {
        onRecord(mapMailPreparation(snapshot), { fromCache: snapshot.metadata.fromCache, hasPendingWrites: snapshot.metadata.hasPendingWrites });
    }, onError);
}

export async function saveMailPreparation(input, session) {
    const uid = actor(session), values = validateMailPreparationInput(input);
    const ref = preparationRef(values.intakeId, values.attachmentId);
    await runTransaction(db, async transaction => {
        // Each save rechecks the immutable source and current customer on the server.
        const previousSnapshot = await transaction.get(ref);
        const parentSnapshot = await transaction.get(doc(db, 'mailIntakes', values.intakeId));
        const attachmentSnapshot = await transaction.get(doc(db, 'mailIntakes', values.intakeId, 'attachments', values.attachmentId));
        const customerSnapshot = await transaction.get(doc(db, 'erpCustomers', values.customer.id));
        for (const snapshot of [previousSnapshot, parentSnapshot, attachmentSnapshot, customerSnapshot]) assertConfirmed(snapshot);
        const previous = previousSnapshot.exists() ? previousSnapshot.data() : null;
        assertMailPreparationRevision(previous, input, timestampToIso);
        assertMailPreparationSource(values, parentSnapshot.exists() ? parentSnapshot.data() : null, attachmentSnapshot.exists() ? attachmentSnapshot.data() : null);
        if (!customerSnapshot.exists()) throw new Error('선택한 ERP 거래처를 찾을 수 없습니다. 거래처를 다시 선택해 주세요.');
        const customer = validateMailPreparationCustomer({ ...customerSnapshot.data(), id: customerSnapshot.id });
        if (customerSnapshot.data().schemaVersion !== 1 || ['id', 'code', 'name', 'revision'].some(key => customer[key] !== values.customer[key])) {
            throw new Error('ERP 거래처 정보가 변경되었습니다. 최신 거래처를 다시 확인해 주세요.');
        }
        let versionRef;
        if (previous) {
            versionRef = doc(db, MAIL_PREPARATION_COLLECTION, values.intakeId, 'attachments', values.attachmentId, 'versions', String(previous.revision));
            const version = await transaction.get(versionRef);
            assertConfirmed(version);
            if (version.exists()) throw new Error('작업 이력을 확인해야 합니다. 최신 내용을 다시 불러와 주세요.');
        }
        if (actor(session) !== uid) throw new Error('로그인 계정이 변경되었습니다. 다시 로그인해 주세요.');
        if (previous) transaction.set(versionRef, { record: previous, archivedAt: serverTimestamp(), archivedByUid: uid });
        transaction.set(ref, { ...values, revision: input.expectedRevision + 1,
            createdAt: previous?.createdAt ?? serverTimestamp(), createdByUid: previous?.createdByUid ?? uid,
            updatedAt: serverTimestamp(), updatedByUid: uid });
    });
    return { id: values.intakeId, attachmentId: values.attachmentId, revision: input.expectedRevision + 1, status: 'range_selected' };
}
