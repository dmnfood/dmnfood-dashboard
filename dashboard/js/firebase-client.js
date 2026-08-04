import { getApp, getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { doc, getDoc, getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// Firebase web-app configuration. This is public client configuration, not a server credential.
export const firebaseConfig = {
    apiKey: "AIzaSyDrBi1E23fKRmd1EkkCFBLQQdqccjHrwLk",
    authDomain: "dmnfood-haccp.firebaseapp.com",
    projectId: "dmnfood-haccp",
    storageBucket: "dmnfood-haccp.firebasestorage.app",
    messagingSenderId: "287394117612",
    appId: "1:287394117612:web:e464b82612b559b09632c9"
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

export async function loadUserProfile(uid) {
    if (!uid) return null;
    const snapshot = await getDoc(doc(db, 'users', uid));
    return snapshot.exists() ? snapshot.data() : null;
}
