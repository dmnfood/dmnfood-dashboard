import { addDoc, collection, deleteDoc, doc, getDoc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db } from '/dashboard/js/firebase-client.js';

const RECORDS_COLLECTION = 'haccpBottleWashingRecords';
const SETTINGS_DOCUMENT = 'haccpSettings/bottleWashing';

export const DEFAULT_BOTTLE_WASHING_SETTINGS = Object.freeze({
  schemaVersion: 1,
  inspectorName: '김석기',
  minPressureMpa: 0.3,
  minDurationSec: 1,
});

const numberOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const timestampToIso = timestamp => timestamp?.toDate ? timestamp.toDate().toISOString() : '';

export function calculateBottleWashingJudgment(pressureMpa, washDurationSec, settings = DEFAULT_BOTTLE_WASHING_SETTINGS) {
  if (pressureMpa === '' || washDurationSec === '') return '';
  const pressure = Number(pressureMpa);
  const duration = Number(washDurationSec);
  if (!Number.isFinite(pressure) || pressure < 0 || !Number.isFinite(duration) || duration < 0) return '';
  return pressure >= numberOr(settings.minPressureMpa, 0.3)
    && duration >= numberOr(settings.minDurationSec, 1) ? 'PASS' : 'FAIL';
}

export function bottleWashingFailureReasons(pressureMpa, washDurationSec, settings = DEFAULT_BOTTLE_WASHING_SETTINGS) {
  const reasons = [];
  if (Number(pressureMpa) < numberOr(settings.minPressureMpa, 0.3)) reasons.push('pressure_below_limit');
  if (Number(washDurationSec) < numberOr(settings.minDurationSec, 1)) reasons.push('duration_below_limit');
  return reasons;
}

export async function loadBottleWashingSettings() {
  const snapshot = await getDoc(doc(db, SETTINGS_DOCUMENT));
  if (!snapshot.exists()) return { ...DEFAULT_BOTTLE_WASHING_SETTINGS };
  const saved = snapshot.data();
  return {
    ...DEFAULT_BOTTLE_WASHING_SETTINGS,
    ...saved,
    minPressureMpa: numberOr(saved.minPressureMpa, 0.3),
    minDurationSec: numberOr(saved.minDurationSec, 1),
  };
}

export async function saveBottleWashingSettings(settings, user) {
  await setDoc(doc(db, SETTINGS_DOCUMENT), {
    ...DEFAULT_BOTTLE_WASHING_SETTINGS,
    ...settings,
    schemaVersion: 1,
    minPressureMpa: numberOr(settings.minPressureMpa, 0.3),
    minDurationSec: numberOr(settings.minDurationSec, 1),
    updatedByUid: user.uid,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

export function mapBottleWashingRecord(snapshot) {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    ...data,
    createdAtIso: timestampToIso(data.createdAt),
    updatedAtIso: timestampToIso(data.updatedAt),
  };
}

export function subscribeToBottleWashingRecords(onRecords, onError) {
  return onSnapshot(
    query(collection(db, RECORDS_COLLECTION), orderBy('createdAt', 'desc'), limit(100)),
    snapshot => onRecords(snapshot.docs.map(mapBottleWashingRecord)),
    onError,
  );
}

export async function saveBottleWashingRecord(values, user, existingId = '', settings = DEFAULT_BOTTLE_WASHING_SETTINGS, existingRecord = null) {
  const pressureMpa = Number(values.pressureMpa);
  const washDurationSec = Number(values.washDurationSec);
  const washedQuantity = Number(values.washedQuantity);
  const judgment = calculateBottleWashingJudgment(pressureMpa, washDurationSec, settings);
  const failureReasons = judgment === 'FAIL' ? bottleWashingFailureReasons(pressureMpa, washDurationSec, settings) : [];
  const payload = {
    schemaVersion: 1,
    recordDate: values.recordDate,
    measuredTime: values.measuredTime,
    inspectorName: values.inspectorName,
    containerMaterial: values.containerMaterial,
    containerVolumeMl: Number(values.containerVolumeMl),
    pressureMpa,
    washDurationSec,
    washedQuantity,
    judgment,
    failureReasons,
    deviationDetail: judgment === 'FAIL' ? values.deviationDetail : '',
    correctiveActionResult: judgment === 'FAIL' ? values.correctiveActionResult : '',
    actionBy: judgment === 'FAIL' ? values.actionBy : '',
    verifiedBy: judgment === 'FAIL' ? values.verifiedBy : '',
    notes: values.notes,
    judgmentCriteria: {
      minPressureMpa: numberOr(settings.minPressureMpa, 0.3),
      minDurationSec: numberOr(settings.minDurationSec, 1),
    },
    createdByUid: existingRecord?.createdByUid || user.uid,
    createdByEmail: existingRecord?.createdByEmail || user.email || '',
    updatedByUid: user.uid,
    updatedAt: serverTimestamp(),
  };
  if (existingId) {
    await setDoc(doc(db, RECORDS_COLLECTION, existingId), payload, { merge: true });
    return existingId;
  }
  return (await addDoc(collection(db, RECORDS_COLLECTION), { ...payload, createdAt: serverTimestamp() })).id;
}

export const deleteBottleWashingRecord = id => deleteDoc(doc(db, RECORDS_COLLECTION, id));
