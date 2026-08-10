import { collection, deleteDoc, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db } from '/dashboard/js/firebase-client.js';
import { isoWeekKey } from '/dashboard/js/haccp-management-utils.js';
export const PEST_CONTROL_COLLECTION='haccpPestControlRecords';
export const subscribePestControl=(ok,fail)=>onSnapshot(query(collection(db,PEST_CONTROL_COLLECTION),orderBy('recordDate','desc'),limit(100)),s=>ok(s.docs.map(d=>({id:d.id,...d.data()}))),fail);
export async function savePestControl(values,user,existing=null){const periodKey=isoWeekKey(values.recordDate);const payload={schemaVersion:1,...values,periodKey,createdByUid:existing?.createdByUid||user.uid,createdByEmail:existing?.createdByEmail||user.email||'',updatedByUid:user.uid,updatedAt:serverTimestamp()};if(!existing)payload.createdAt=serverTimestamp();await setDoc(doc(db,PEST_CONTROL_COLLECTION,periodKey),payload,{merge:Boolean(existing)});return periodKey;}
export const deletePestControl=id=>deleteDoc(doc(db,PEST_CONTROL_COLLECTION,id));
