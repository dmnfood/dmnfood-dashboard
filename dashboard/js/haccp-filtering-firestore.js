import { addDoc, collection, deleteDoc, doc, getDoc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db } from '/dashboard/js/firebase-client.js';

const RECORDS_COLLECTION = 'haccpFilteringRecords';
const SETTINGS_DOCUMENT = 'haccpSettings/filtering';
export const PSI_PER_MPA = 145.0377377;
export const DEFAULT_FILTERING_SETTINGS = Object.freeze({
  schemaVersion: 1, inspectorName: '김석기', productName: '참기름', meshSpecification: '120mesh',
  cartridgeFilterSpecification: '100μm', pressureLimitMpa: 0.3,
});

const numberOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const asIso = timestamp => timestamp?.toDate ? timestamp.toDate().toISOString() : '';

export const pressureLimitPsi = settings => numberOr(settings?.pressureLimitMpa, DEFAULT_FILTERING_SETTINGS.pressureLimitMpa) * PSI_PER_MPA;
export function calculateFilteringJudgment(filterMeshDamaged, pressurePsi, settings = DEFAULT_FILTERING_SETTINGS) {
  if (typeof filterMeshDamaged !== 'boolean' || !Number.isFinite(Number(pressurePsi)) || Number(pressurePsi) < 0) return '';
  return !filterMeshDamaged && Number(pressurePsi) <= pressureLimitPsi(settings) + 1e-9 ? 'PASS' : 'FAIL';
}

export async function loadFilteringSettings() {
  const snapshot = await getDoc(doc(db, SETTINGS_DOCUMENT));
  return snapshot.exists() ? { ...DEFAULT_FILTERING_SETTINGS, ...snapshot.data(), pressureLimitMpa: numberOr(snapshot.data().pressureLimitMpa, .3) } : { ...DEFAULT_FILTERING_SETTINGS };
}
export async function saveFilteringSettings(settings, user) {
  await setDoc(doc(db, SETTINGS_DOCUMENT), { ...DEFAULT_FILTERING_SETTINGS, ...settings, schemaVersion: 1, pressureLimitMpa: numberOr(settings.pressureLimitMpa, .3), updatedByUid: user.uid, updatedAt: serverTimestamp() }, { merge: true });
}
export function subscribeToFilteringRecords(onRecords, onError) {
  return onSnapshot(query(collection(db, RECORDS_COLLECTION), orderBy('createdAt', 'desc'), limit(100)), snapshot => onRecords(snapshot.docs.map(mapFilteringRecord)), onError);
}
export function mapFilteringRecord(snapshot) {
  const data = snapshot.data();
  return { id: snapshot.id, ...data, createdAtIso: asIso(data.createdAt), updatedAtIso: asIso(data.updatedAt) };
}
export async function saveFilteringRecord(values, user, existingId = '', settings = DEFAULT_FILTERING_SETTINGS, existingRecord = null) {
  const pressurePsi = Number(values.pressurePsi);
  const judgment = calculateFilteringJudgment(values.filterMeshDamaged, pressurePsi, settings);
  const criteria = { pressureLimitMpa: numberOr(settings.pressureLimitMpa, .3), pressureLimitPsi: pressureLimitPsi(settings), meshMustBeIntact: true };
  const payload = {
    schemaVersion: 1, recordDate: values.recordDate, inspectorName: values.inspectorName, productName: values.productName,
    checkedTime: values.checkedTime, filterMeshDamaged: values.filterMeshDamaged, pressurePsi, foreignMaterialDescription: values.foreignMaterialDescription,
    judgment, deviationDetail: judgment === 'FAIL' ? values.deviationDetail : '', correctiveActionResult: judgment === 'FAIL' ? values.correctiveActionResult : '',
    actionBy: judgment === 'FAIL' ? values.actionBy : '', verifiedBy: judgment === 'FAIL' ? values.verifiedBy : '', notes: values.notes,
    judgmentCriteria: criteria, createdByUid: existingRecord?.createdByUid || user.uid, createdByEmail: existingRecord?.createdByEmail || user.email || '', updatedAt: serverTimestamp(),
  };
  if (existingId) { await setDoc(doc(db, RECORDS_COLLECTION, existingId), payload, { merge: true }); return existingId; }
  return (await addDoc(collection(db, RECORDS_COLLECTION), { ...payload, createdAt: serverTimestamp() })).id;
}
export const deleteFilteringRecord = id => deleteDoc(doc(db, RECORDS_COLLECTION, id));
