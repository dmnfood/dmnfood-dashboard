import { getApp, getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { browserLocalPersistence, browserSessionPersistence, getAuth, onAuthStateChanged, setPersistence, signOut } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { doc, getDoc, getFirestore, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { clearSession, LOGOUT_KEY, readSession, saveSession, validSession } from './auth-session.js';

export async function configureLoginPersistence(remember = false) {
    await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
}
export function beginLoginSession(user, remember = false) { return saveSession(user.uid, remember); }
export function hasValidLoginSession(user) { return validSession(readSession(user.uid), user.uid); }

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
    return VALID_PROFILE_ROLES.has(profile.role) && ((profile.approvalStatus === 'approved' && profile.isActive === true) || legacyApproved);
}

export function profileAccessMessage(profile) {
    if (!profile) return '사용자 프로필이 등록되지 않았습니다. 관리자에게 문의해 주세요.';
    if (profile.approvalStatus === 'rejected') return '가입 승인이 거절된 계정입니다. 관리자에게 문의해 주세요.';
    if (profile.approvalStatus === 'approved' && !profile.isActive) return '사용이 중지된 계정입니다. 관리자에게 문의해 주세요.';
    return '관리자 승인 대기 중입니다. 승인 후 로그인할 수 있습니다.';
}

let protectedSession;
export function requireApprovedActiveUser({ redirectTo = '/' } = {}) {
    if (protectedSession) return protectedSession;
    protectedSession = new Promise(resolve => {
        let stopped = false, unsubscribeProfile, initialRole, initialUid, generation = 0;
        const block = async message => {
            if (stopped) return;
            stopped = true;
            unsubscribeProfile?.();
            clearInterval(timer);
            clearSession();
            // Lock immediately, even when a page's unsaved-work prompt prevents navigation.
            const dialog = document.createElement('dialog');
            dialog.style.cssText = 'margin:auto;width:calc(100% - 32px);max-width:420px;padding:28px;border:1px solid #b7d6cc;border-radius:16px;color:#163d31;background:#fff';
            dialog.setAttribute('aria-label', '다시 로그인');
            const note = document.createElement('p'); note.textContent = message;
            note.style.cssText = 'line-height:1.6;margin:0 0 20px';
            const button = document.createElement('button'); button.textContent = '로그인 화면으로';
            button.style.cssText = 'padding:10px 16px;border:0;border-radius:8px;background:#237a55;color:#fff;cursor:pointer';
            button.onclick = () => window.location.replace(redirectTo);
            dialog.append(note, button); document.body.append(dialog);
            dialog.addEventListener('cancel', event => event.preventDefault()); dialog.showModal();
            resolve(null);
            await signOut(auth).catch(() => {});
            if (!initialRole) window.location.replace(redirectTo);
        };
        const check = () => {
            if (stopped || !auth.currentUser) return;
            const session = readSession(auth.currentUser.uid);
            if (!validSession(session, auth.currentUser.uid)) {
                void block('로그인 유지 시간이 끝났습니다. 다시 로그인해 주세요.'); return;
            }
            if (session.expiresAt - Date.now() <= 10 * 60000 && !document.getElementById('authExpiryNotice')) {
                const notice = document.createElement('div'); notice.id = 'authExpiryNotice'; notice.setAttribute('role', 'alert');
                notice.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:16px 24px;background:#fff4d6;color:#513900;border:1px solid #d9bb65;border-radius:12px;max-width:90vw';
                notice.textContent = '10분 이내에 로그인 시간이 끝납니다. 작성 중인 내용을 저장한 뒤 다시 로그인해 주세요.';
                const printStyle = document.createElement('style');
                printStyle.textContent = '@media print { #authExpiryNotice { display: none !important; } }';
                notice.append(printStyle);
                document.body.append(notice);
            }
        };
        const timer = setInterval(check, 15000);
        document.addEventListener('visibilitychange', check);
        window.addEventListener('focus', check);
        window.addEventListener('storage', event => {
            if (event.key === LOGOUT_KEY && event.newValue) void block('다른 창에서 로그아웃했습니다. 다시 로그인해 주세요.');
            else check();
        });
        onAuthStateChanged(auth, user => {
            const revision = ++generation;
            unsubscribeProfile?.();
            if (stopped) return;
            if (!user) { void block('로그인이 필요합니다.'); return; }
            if (initialUid && initialUid !== user.uid) { void block('로그인 계정이 변경되었습니다. 다시 접속해 주세요.'); return; }
            if (!hasValidLoginSession(user)) { void block('로그인 유지 정책이 변경되었거나 시간이 만료되었습니다. 다시 로그인해 주세요.'); return; }
            initialUid = user.uid;
            unsubscribeProfile = onSnapshot(doc(db, 'users', user.uid), snapshot => {
                if (stopped || revision !== generation) return;
                const profile = snapshot.exists() ? snapshot.data() : null;
                if (!isApprovedActiveProfile(profile)) { void block(profileAccessMessage(profile)); return; }
                if (initialRole && initialRole !== profile.role) { void block('계정 권한이 변경되었습니다. 다시 로그인해 주세요.'); return; }
                initialRole = profile.role;
                resolve({ user, profile, role: profile.role });
                check();
            }, () => void block('계정 권한을 확인하지 못했습니다. 연결을 확인하고 다시 로그인해 주세요.'));
        });
    });
    return protectedSession;
}

export async function logoutToLogin({ redirectTo = '/', page = 'protected-page' } = {}) {
    try { localStorage.setItem(LOGOUT_KEY, String(Date.now())); } catch { /* Firebase also synchronizes local sessions. */ }
    clearSession();
    await signOut(auth);
    console.info('[auth] redirect', { page, target: redirectTo, reason: 'logout' });
    window.location.replace(redirectTo);
}
