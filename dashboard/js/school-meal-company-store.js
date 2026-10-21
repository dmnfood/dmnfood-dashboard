import { doc, getDocFromServer, onSnapshot, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { auth, db, isApprovedActiveProfile } from './firebase-client.js';
import { SCHOOL_MEAL_COMPANY_PATH, buildSchoolMealCompanies, legacySchoolMealCompanyNames, validateSchoolMealCompanyCatalog } from './school-meal-company-model.js';
const ref = () => doc(db, SCHOOL_MEAL_COMPANY_PATH);
function actor(session) {
    if (globalThis.navigator?.onLine === false) throw new Error('인터넷 연결 후 업체 목록을 저장해 주세요.');
    if (!session?.user?.uid || auth.currentUser?.uid !== session.user.uid || !isApprovedActiveProfile(session.profile) || !['admin', 'manager'].includes(session.profile.role)) throw new Error('업체 목록 변경은 승인된 관리자와 매니저만 할 수 있습니다.');
    return session.user.uid;
}
export function subscribeSchoolMealCompanies(onCompanies, onError) {
    let disposed = false, revision = 0;
    const unsubscribe = onSnapshot(ref(), { includeMetadataChanges: true }, async snapshot => {
        const request = ++revision, metadata = { exists: snapshot.exists(), revision: snapshot.exists() ? snapshot.data().revision : 0, fromCache: snapshot.metadata.fromCache, hasPendingWrites: snapshot.metadata.hasPendingWrites };
        try {
            const data = snapshot.exists() ? await validateSchoolMealCompanyCatalog(snapshot.data()) : [];
            if (disposed || request !== revision) return;
            const syncState = metadata.hasPendingWrites ? 'pending' : metadata.fromCache ? 'cached' : 'confirmed';
            onCompanies(data.map(item => ({ ...item, code: item.id, revision: metadata.revision, source: 'school_meal', erpCode: null, syncState })), metadata);
        } catch (error) { if (!disposed && request === revision) onError?.(error); }
    }, onError);
    return () => { disposed = true; ++revision; unsubscribe(); };
}
export async function ensureSchoolMealCompanies(session) {
    const uid = actor(session), existing = await getDocFromServer(ref());
    if (existing.exists()) { await validateSchoolMealCompanyCatalog(existing.data()); return { created: false, revision: existing.data().revision }; }
    const companies = await buildSchoolMealCompanies(legacySchoolMealCompanyNames());
    return runTransaction(db, async transaction => {
        const snapshot = await transaction.get(ref());
        if (snapshot.exists()) { await validateSchoolMealCompanyCatalog(snapshot.data()); return { created: false, revision: snapshot.data().revision }; }
        transaction.set(ref(), { schemaVersion: 1, revision: 1, companies, updatedAt: serverTimestamp(), updatedByUid: uid });
        return { created: true, revision: 1 };
    });
}
export async function saveSchoolMealCompanies(names, { expectedRevision } = {}, session) {
    const uid = actor(session), companies = await buildSchoolMealCompanies(names);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('최신 업체 목록을 불러온 뒤 저장해 주세요.');
    return runTransaction(db, async transaction => {
        const snapshot = await transaction.get(ref());
        if (!snapshot.exists() || snapshot.data().revision !== expectedRevision) throw new Error('다른 담당자가 업체 목록을 변경했습니다. 최신 목록을 확인한 뒤 다시 저장해 주세요.');
        await validateSchoolMealCompanyCatalog(snapshot.data());
        if (JSON.stringify(snapshot.data().companies) === JSON.stringify(companies)) return { revision: expectedRevision };
        const revision = expectedRevision + 1;
        transaction.set(ref(), { schemaVersion: 1, revision, companies, updatedAt: serverTimestamp(), updatedByUid: uid });
        return { revision };
    });
}
