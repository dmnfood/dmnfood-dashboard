import { collection, doc, onSnapshot, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db } from './firebase-client.js';

export function setupUserManagement(session, trigger) {
    if (!['manager', 'admin'].includes(session.role)) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'user-management-dialog';
    dialog.setAttribute('aria-labelledby', 'userManagementTitle');
    dialog.innerHTML = `
      <header class="um-header"><div><div class="um-eyebrow">들메내식품 · 계정 관리</div><h2 id="userManagementTitle">사용자 관리</h2></div><button type="button" class="um-close" aria-label="사용자 관리 닫기">×</button></header>
      <div class="um-body">
        <p class="um-description">가입 신청을 확인하고 직원의 사용을 승인하거나 중지할 수 있습니다.</p>
        <div class="um-toolbar"><p id="userManagementSummary" role="status"></p><label>표시할 계정 <select id="userManagementFilter"><option value="all">전체</option><option value="pending">승인 대기</option><option value="approved">사용 중</option><option value="inactive">사용 중지</option><option value="rejected">승인 거절</option></select></label></div>
        <div class="um-confirm" hidden><p></p><div class="actions"><button type="button" class="um-confirm-submit approve">확인</button><button type="button" class="um-confirm-cancel">취소</button></div></div>
        <p id="userManagementMessage" role="status"></p>
        <div class="um-table-wrap"><table><thead><tr><th>이름 / 이메일</th><th>권한</th><th>상태</th><th>관리</th></tr></thead><tbody id="userManagementUsers"></tbody></table></div>
      </div>
      <footer class="um-footer"><span>사용 중지 시에도 작성한 기록은 유지됩니다.</span><button type="button" class="um-done">닫기</button></footer>`;
    document.body.append(dialog);
    const message = dialog.querySelector('#userManagementMessage');
    const summary = dialog.querySelector('#userManagementSummary');
    const list = dialog.querySelector('#userManagementUsers');
    const filter = dialog.querySelector('#userManagementFilter');
    const confirmation = dialog.querySelector('.um-confirm');
    const confirmButton = dialog.querySelector('.um-confirm-submit');
    let pendingAction, unsubscribe;
    const roles = { worker: '직원', manager: '관리자', admin: '최고 관리자' };
    const labels = { pending: '승인 대기', approved: '사용 중', inactive: '사용 중지', rejected: '승인 거절' };
    const stateOf = profile => profile.approvalStatus === 'rejected' ? 'rejected'
        : profile.approvalStatus === 'pending' ? 'pending' : profile.isActive ? 'approved' : 'inactive';
    let accounts = [], busy = false;

    function render() {
        list.replaceChildren();
        const visible = accounts.filter(account => filter.value === 'all' || stateOf(account) === filter.value);
        for (const account of visible) {
            const row = document.createElement('tr');
            const name = document.createElement('td'); name.textContent = account.employeeName || account.displayName || '이름 미등록';
            const email = document.createElement('div'); email.className = 'email'; email.textContent = account.email || ''; name.append(email);
            const role = document.createElement('td'); role.textContent = roles[account.role] || '확인 필요';
            const state = document.createElement('td'); const badge = document.createElement('span'); badge.className = `um-status um-status-${stateOf(account)}`; badge.textContent = labels[stateOf(account)]; state.append(badge);
            const actions = document.createElement('td');
            if (account.id !== session.user.uid && account.role === 'worker') {
                const group = document.createElement('div'); group.className = 'actions';
                const options = stateOf(account) === 'approved' ? [['사용 중지', 'approved', false]]
                    : [['사용 승인', 'approved', true], ...(stateOf(account) === 'pending' ? [['승인 거절', 'rejected', false]] : [])];
                for (const [label, approvalStatus, isActive] of options) {
                    const button = document.createElement('button'); button.textContent = label; button.disabled = busy;
                    if (isActive) button.className = 'approve';
                    button.onclick = () => {
                        pendingAction = { account, label, approvalStatus, isActive };
                        confirmation.querySelector('p').textContent = `${account.displayName || account.email} 계정을 ${label}하시겠습니까?`;
                        confirmButton.textContent = label;
                        confirmation.hidden = false;
                        confirmButton.focus();
                        confirmation.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    };
                    group.append(button);
                }
                actions.append(group);
            } else { actions.textContent = account.id === session.user.uid ? '내 계정' : '관리자 계정'; }
            row.append(name, role, state, actions); list.append(row);
        }
        if (!visible.length) {
            const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 4; cell.textContent = '해당하는 계정이 없습니다.'; row.append(cell); list.append(row);
        }
    }
    confirmButton.onclick = async () => {
        if (!pendingAction || busy) return;
        const { account, label, approvalStatus, isActive } = pendingAction;
        confirmButton.disabled = true;
        busy = true; render();
        try {
            await runTransaction(db, async transaction => {
                const ref = doc(db, 'users', account.id);
                const snapshot = await transaction.get(ref);
                if (!snapshot.exists() || snapshot.data().role !== 'worker'
                    || stateOf(snapshot.data()) !== stateOf(account)) throw new Error('changed');
                transaction.update(ref, { approvalStatus, isActive, updatedAt: serverTimestamp() });
            });
            message.textContent = `${label} 처리했습니다.`;
        } catch { message.textContent = '처리하지 못했습니다. 계정 상태와 연결을 확인하고 다시 시도해 주세요.'; }
        finally { busy = false; confirmButton.disabled = false; pendingAction = null; confirmation.hidden = true; render(); }
    };
    dialog.querySelector('.um-confirm-cancel').onclick = () => {
        if (busy) return;
        pendingAction = null; confirmation.hidden = true; filter.focus();
    };
    function open() {
        if (dialog.open) return;
        message.textContent = ''; summary.textContent = '사용자 목록을 불러오고 있습니다.';
        list.replaceChildren(); accounts = [];
        dialog.showModal(); document.body.classList.add('user-management-open');
        const url = new URL(location.href); url.searchParams.set('panel', 'users'); history.replaceState(null, '', url);
        unsubscribe = onSnapshot(collection(db, 'users'), snapshot => {
            accounts = snapshot.docs.map(document => ({ ...document.data(), id: document.id }))
                .sort((a, b) => Number(stateOf(b) === 'pending') - Number(stateOf(a) === 'pending') || (a.displayName || a.email || '').localeCompare(b.displayName || b.email || '', 'ko'));
            summary.textContent = `승인 대기 ${accounts.filter(account => stateOf(account) === 'pending').length}명 · 전체 ${accounts.length}명`;
            render();
        }, () => { accounts = []; list.replaceChildren(); pendingAction = null; confirmation.hidden = true; summary.textContent = ''; message.textContent = '사용자 목록을 불러오지 못했습니다. 권한과 연결을 확인해 주세요.'; });
    }
    function close() { if (!busy) dialog.close(); }
    dialog.querySelector('.um-close').onclick = close;
    dialog.querySelector('.um-done').onclick = close;
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('click', event => {
        const bounds = dialog.getBoundingClientRect();
        if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) close();
    });
    dialog.addEventListener('close', () => {
        unsubscribe?.(); unsubscribe = null;
        accounts = []; list.replaceChildren(); pendingAction = null; confirmation.hidden = true;
        document.body.classList.remove('user-management-open');
        const url = new URL(location.href); url.searchParams.delete('panel'); history.replaceState(null, '', url);
        trigger.focus();
    });
    filter.addEventListener('change', render);
    trigger.addEventListener('click', open);
    if (new URLSearchParams(location.search).get('panel') === 'users' || location.pathname === '/users') open();
}
