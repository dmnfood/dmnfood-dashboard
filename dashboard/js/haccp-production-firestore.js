import { collection, deleteDoc, doc, getDoc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db } from '/dashboard/js/firebase-client.js';

import { normalizeProductionItems } from '/dashboard/js/haccp-production-options.js';
export { PRODUCTION_OPTIONS, productionItemKey, isAllowedProductionItem, normalizeProductionItems, upsertProductionItem } from '/dashboard/js/haccp-production-options.js';

export const PRODUCTION_COLLECTION = 'haccpProductionRecords';

const timestampToIso = timestamp => timestamp?.toDate ? timestamp.toDate().toISOString() : '';

export function mapProductionRecord(snapshot) {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    ...data,
    items: Array.isArray(data.items) ? data.items : [],
    createdAtIso: timestampToIso(data.createdAt),
    updatedAtIso: timestampToIso(data.updatedAt),
  };
}

export function subscribeToProductionRecords(onRecords, onError) {
  return onSnapshot(
    query(collection(db, PRODUCTION_COLLECTION), orderBy('recordDate', 'desc'), limit(100)),
    snapshot => onRecords(snapshot.docs.map(mapProductionRecord)),
    onError,
  );
}

export async function getProductionRecordByDate(date) {
  const snapshot = await getDoc(doc(db, PRODUCTION_COLLECTION, date));
  return snapshot.exists() ? mapProductionRecord(snapshot) : null;
}

export async function saveProductionRecord(values, user, existingRecord = null) {
  const payload = {
    schemaVersion: 1,
    recordDate: values.recordDate,
    items: normalizeProductionItems(values.items),
    createdByUid: existingRecord?.createdByUid || user.uid,
    createdByEmail: existingRecord?.createdByEmail || user.email || '',
    updatedByUid: user.uid,
    updatedAt: serverTimestamp(),
  };
  if (!existingRecord) payload.createdAt = serverTimestamp();
  await setDoc(doc(db, PRODUCTION_COLLECTION, values.recordDate), payload, { merge: Boolean(existingRecord) });
  return values.recordDate;
}

export const deleteProductionRecord = id => deleteDoc(doc(db, PRODUCTION_COLLECTION, id));
