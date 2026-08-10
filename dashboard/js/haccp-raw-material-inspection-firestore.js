import { addDoc, collection, deleteDoc, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db } from '/dashboard/js/firebase-client.js';

export const RAW_MATERIAL_INSPECTION_COLLECTION = 'haccpRawMaterialInspectionRecords';

const timestampToIso = timestamp => timestamp?.toDate ? timestamp.toDate().toISOString() : '';

export function mapInspectionRecord(snapshot) {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    ...data,
    createdAtIso: timestampToIso(data.createdAt),
    updatedAtIso: timestampToIso(data.updatedAt),
  };
}

export function subscribeToInspectionRecords(onRecords, onError) {
  return onSnapshot(
    query(collection(db, RAW_MATERIAL_INSPECTION_COLLECTION), orderBy('createdAt', 'desc'), limit(100)),
    snapshot => onRecords(snapshot.docs.map(mapInspectionRecord)),
    onError,
  );
}

export async function saveInspectionRecord(values, user, existingRecord = null) {
  const payload = {
    schemaVersion: 1,
    recordDate: values.recordDate,
    itemName: values.itemName.trim(),
    supplierName: values.supplierName.trim(),
    purchaseQuantity: Number(values.purchaseQuantity),
    offOdorDetected: values.offOdorDetected,
    packagingCondition: values.packagingCondition,
    temperature: values.temperature.trim(),
    expirationCheck: values.expirationCheck,
    vehicleTemperature: values.vehicleTemperature.trim(),
    testReportReceived: values.testReportReceived,
    grade: values.grade.trim(),
    writerConfirmName: values.writerConfirmName.trim(),
    notes: values.notes.trim(),
    createdByUid: existingRecord?.createdByUid || user.uid,
    createdByEmail: existingRecord?.createdByEmail || user.email || '',
    updatedByUid: user.uid,
    updatedAt: serverTimestamp(),
  };
  if (existingRecord) {
    await setDoc(doc(db, RAW_MATERIAL_INSPECTION_COLLECTION, existingRecord.id), payload, { merge: true });
    return existingRecord.id;
  }
  return (await addDoc(collection(db, RAW_MATERIAL_INSPECTION_COLLECTION), { ...payload, createdAt: serverTimestamp() })).id;
}

export const deleteInspectionRecord = id => deleteDoc(doc(db, RAW_MATERIAL_INSPECTION_COLLECTION, id));
