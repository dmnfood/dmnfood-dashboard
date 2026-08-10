import { collection, deleteDoc, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db } from '/dashboard/js/firebase-client.js';
export const COMPRESSED_AIR_COLLECTION='haccpCompressedAirFilterRecords';
export const subscribeCompressedAir=(ok,fail)=>onSnapshot(query(collection(db,COMPRESSED_AIR_COLLECTION),orderBy('recordDate','desc'),limit(100)),s=>ok(s.docs.map(d=>({id:d.id,...d.data()}))),fail);
export async function saveCompressedAir(values,user,existing=null){const periodKey=values.managementMonth;const payload={schemaVersion:1,...values,periodKey,createdByUid:existing?.createdByUid||user.uid,createdByEmail:existing?.createdByEmail||user.email||'',updatedByUid:user.uid,updatedAt:serverTimestamp()};if(!existing)payload.createdAt=serverTimestamp();await setDoc(doc(db,COMPRESSED_AIR_COLLECTION,periodKey),payload,{merge:Boolean(existing)});return periodKey;}
export const deleteCompressedAir=id=>deleteDoc(doc(db,COMPRESSED_AIR_COLLECTION,id));
