import { collection, deleteDoc, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db } from '/dashboard/js/firebase-client.js';

export const RAW_MATERIAL_USAGE_COLLECTION = 'haccpRawMaterialUsageRecords';
export const RAW_MATERIAL_KEYS = Object.freeze([
  'chinaSesame',
  'importedSesame',
  'koreanSesame',
  'importedSesamePowderOil',
]);

const timestampToIso = timestamp => timestamp?.toDate ? timestamp.toDate().toISOString() : '';

export function normalizeRawMaterials(materials) {
  return Object.fromEntries(RAW_MATERIAL_KEYS
    .filter(key => materials[key] !== '' && materials[key] != null)
    .map(key => [key, Number(materials[key])]));
}

export function mapRawMaterialUsageRecord(snapshot) {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    ...data,
    materials: data.materials || {},
    createdAtIso: timestampToIso(data.createdAt),
    updatedAtIso: timestampToIso(data.updatedAt),
  };
}

export function subscribeToRawMaterialUsageRecords(onRecords, onError) {
  return onSnapshot(
    query(collection(db, RAW_MATERIAL_USAGE_COLLECTION), orderBy('recordDate', 'desc'), limit(100)),
    snapshot => onRecords(snapshot.docs.map(mapRawMaterialUsageRecord)),
    onError,
  );
}

export async function saveRawMaterialUsageRecord(values, user, existingRecord = null) {
  const materials = normalizeRawMaterials(values.materials);
  const payload = {
    schemaVersion: 1,
    recordDate: values.recordDate,
    materials,
    createdByUid: existingRecord?.createdByUid || user.uid,
    createdByEmail: existingRecord?.createdByEmail || user.email || '',
    updatedByUid: user.uid,
    updatedAt: serverTimestamp(),
  };
  if (!existingRecord) payload.createdAt = serverTimestamp();
  await setDoc(doc(db, RAW_MATERIAL_USAGE_COLLECTION, values.recordDate), payload, { merge: Boolean(existingRecord) });
  return values.recordDate;
}

export const deleteRawMaterialUsageRecord = id => deleteDoc(doc(db, RAW_MATERIAL_USAGE_COLLECTION, id));
