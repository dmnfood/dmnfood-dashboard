import { collection, onSnapshot, query, where } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db } from '/dashboard/js/firebase-client.js';

// One inclusive date-range query for all CCP forms; no recent-record limit.
export function subscribeJournalRange(collectionName, mapRecord, start, end, onRecords, onError) {
  const recordsQuery = query(collection(db, collectionName), where('recordDate', '>=', start), where('recordDate', '<=', end));
  return onSnapshot(recordsQuery, snapshot => onRecords(snapshot.docs.map(mapRecord)), onError);
}
