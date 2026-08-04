import { getApp, getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
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

const VALID_PROFILE_ROLES = new Set(['worker', 'manager', 'admin']);

export function isApprovedActiveProfile(profile) {
    if (!profile) return false;
    const legacyApproved = profile.approvalStatus == null
        && profile.isActive === true
        && VALID_PROFILE_ROLES.has(profile.role);
    return (profile.approvalStatus === 'approved' && profile.isActive === true) || legacyApproved;
}

export function profileAccessMessage(profile) {
    if (!profile) return '사용자 프로필이 등록되지 않았습니다. 관리자에게 문의해 주세요.';
    if (profile.approvalStatus === 'rejected') return '가입 승인이 거절된 계정입니다. 관리자에게 문의해 주세요.';
    return '관리자 승인 대기 중입니다. 승인 후 로그인할 수 있습니다.';
}

export function requireApprovedActiveUser({ page = 'protected-page', redirectTo = '/' } = {}) {
    let navigationCommitted = false;
    const navigateOnce = (reason) => {
        if (navigationCommitted) return;
        navigationCommitted = true;
        console.info('[auth] redirect', { page, target: redirectTo, reason });
        window.location.replace(redirectTo);
    };
    return new Promise(resolve => {
        const unsubscribe = onAuthStateChanged(auth, async user => {
            unsubscribe();
            console.info('[auth] state resolved', { page, projectId: firebaseConfig.projectId, uid: user?.uid || null });
            if (!user) { navigateOnce('signed-out'); resolve(null); return; }
            try {
                const profile = await loadUserProfile(user.uid);
                if (!isApprovedActiveProfile(profile)) {
                    await signOut(auth).catch(error => console.error('[auth] blocked-user sign-out failed', error));
                    navigateOnce(profile?.approvalStatus || 'profile-blocked');
                    resolve(null);
                    return;
                }
                resolve({ user, profile, role: profile.role });
            } catch (error) {
                console.error('[auth] profile read failed', { page, code: error.code || 'unknown', error });
                await signOut(auth).catch(() => {});
                navigateOnce('profile-read-failed');
                resolve(null);
            }
        });
    });
}

export async function logoutToLogin({ redirectTo = '/', page = 'protected-page' } = {}) {
    await signOut(auth);
    console.info('[auth] redirect', { page, target: redirectTo, reason: 'logout' });
    window.location.replace(redirectTo);
}
