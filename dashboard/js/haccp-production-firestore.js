import { collection, deleteDoc, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db } from '/dashboard/js/firebase-client.js';

export const PRODUCTION_COLLECTION = 'haccpProductionRecords';

export const PRODUCTION_OPTIONS = Object.freeze({
  sesame_oil: Object.freeze({
    label: '참기름',
    sizeUnit: 'ml',
    categories: Object.freeze({
      china: Object.freeze({ label: '중국산', sizes: Object.freeze([250, 350, 1000, 1800]) }),
      imported: Object.freeze({ label: '수입산', sizes: Object.freeze([180, 270, 350, 1000, 1800]) }),
      korea: Object.freeze({ label: '국산', sizes: Object.freeze([150, 180, 250, 300, 500, 1000, 1800]) }),
      imported_sesame_powder: Object.freeze({ label: '수입깨분', sizes: Object.freeze([180, 270, 1000, 1800]) }),
    }),
  }),
  roasted_sesame: Object.freeze({
    label: '볶음통깨',
    sizeUnit: 'g',
    categories: Object.freeze({
      china: Object.freeze({ label: '중국산', sizes: Object.freeze([120, 1000]) }),
      imported: Object.freeze({ label: '수입산', sizes: Object.freeze([120, 140, 1000]) }),
      korea: Object.freeze({ label: '국산', sizes: Object.freeze([80, 130, 1000]) }),
    }),
  }),
});

const timestampToIso = timestamp => timestamp?.toDate ? timestamp.toDate().toISOString() : '';

export const productionItemKey = item => `${item.productType}:${item.sourceCategory}:${item.sizeUnit}:${Number(item.sizeValue)}`;

export function isAllowedProductionItem(item) {
  const product = PRODUCTION_OPTIONS[item.productType];
  const category = product?.categories[item.sourceCategory];
  return Boolean(product && category
    && item.sizeUnit === product.sizeUnit
    && category.sizes.includes(Number(item.sizeValue))
    && Number.isFinite(Number(item.quantity))
    && Number(item.quantity) >= 0);
}

export function normalizeProductionItems(items) {
  return items.map(item => ({
    productType: item.productType,
    sourceCategory: item.sourceCategory,
    sizeValue: Number(item.sizeValue),
    sizeUnit: item.sizeUnit,
    quantity: Number(item.quantity),
  }));
}

export function upsertProductionItem(currentItems, nextItem, editingKey = '') {
  const normalized = normalizeProductionItems([nextItem])[0];
  const nextKey = productionItemKey(normalized);
  const items = editingKey
    ? currentItems.filter(item => productionItemKey(item) !== editingKey).map(item => ({ ...item }))
    : currentItems.map(item => ({ ...item }));
  const duplicateIndex = items.findIndex(item => productionItemKey(item) === nextKey);
  if (duplicateIndex >= 0) items[duplicateIndex] = normalized;
  else items.push(normalized);
  return { items, replacedExisting: duplicateIndex >= 0 };
}

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
