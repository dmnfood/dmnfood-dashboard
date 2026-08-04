import { getApp, getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { doc, getDoc, getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// Firebase web-app configuration. This is public client configuration, not a server credential.
export const firebaseConfig = {
    apiKey: 'AIzaSyAlvRWMpYV5Cq2vb0XxpA4t56KuByj8KuE',
    authDomain: 'dmnfood-erp.firebaseapp.com',
    projectId: 'dmnfood-erp',
    storageBucket: 'dmnfood-erp.firebasestorage.app',
    messagingSenderId: '918686575195',
    appId: '1:918686575195:web:699d961aa0a092ee9ead7e',
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

export async function loadUserProfile(uid) {
    if (!uid) return null;
    const snapshot = await getDoc(doc(db, 'users', uid));
    return snapshot.exists() ? snapshot.data() : null;
}
