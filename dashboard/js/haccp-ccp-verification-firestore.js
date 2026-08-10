import { collection, deleteDoc, doc, onSnapshot, orderBy, query, serverTimestamp, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db } from '/dashboard/js/firebase-client.js';
import { monthKey } from '/dashboard/js/haccp-management-utils.js';
export const CCP_VERIFICATION_COLLECTION='haccpCcpVerificationRecords';
export const subscribeCcpVerification=(ok,fail)=>onSnapshot(query(collection(db,CCP_VERIFICATION_COLLECTION),orderBy('recordDate','desc')),s=>ok(s.docs.map(d=>({id:d.id,...d.data()}))),fail);
export async function saveCcpVerification(values,user,existing=null){const periodKey=values.periodKey||monthKey(values.recordDate);const payload={schemaVersion:1,...values,periodKey,createdByUid:existing?.createdByUid||user.uid,createdByEmail:existing?.createdByEmail||user.email||'',updatedByUid:user.uid,updatedAt:serverTimestamp()};if(!existing)payload.createdAt=serverTimestamp();await setDoc(doc(db,CCP_VERIFICATION_COLLECTION,periodKey),payload,{merge:Boolean(existing)});return periodKey;}
export const deleteCcpVerification=id=>deleteDoc(doc(db,CCP_VERIFICATION_COLLECTION,id));
