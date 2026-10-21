// LOCAL BROWSER VERIFICATION ONLY. No user records or administration API calls.
// The actual home page retains its manager layout without loading Firebase.
export function setupUserManagement(_session, trigger) {
    if (!trigger) return;
    trigger.disabled = true;
    trigger.title = '로컬 디자인 확인에서는 사용자 관리를 실행하지 않습니다.';
}
