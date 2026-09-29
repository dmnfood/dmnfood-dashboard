import { collection, doc, onSnapshot, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db, requireApprovedActiveUser } from './firebase-client.js';

const message = document.getElementById('message');
const list = document.getElementById('users');
const filter = document.getElementById('filter');
const session = await requireApprovedActiveUser({ page: 'users' });
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
        const state = document.createElement('td'); state.textContent = labels[stateOf(account)];
        const actions = document.createElement('td');
        if (account.id !== session.user.uid && account.role === 'worker') {
            const group = document.createElement('div'); group.className = 'actions';
            const options = stateOf(account) === 'approved' ? [['사용 중지', 'approved', false]]
                : [['사용 승인', 'approved', true], ...(stateOf(account) === 'pending' ? [['승인 거절', 'rejected', false]] : [])];
            for (const [label, approvalStatus, isActive] of options) {
                const button = document.createElement('button'); button.textContent = label; button.disabled = busy;
                if (isActive) button.className = 'approve';
                button.onclick = async () => {
                    if (!confirm(`${account.displayName || account.email} 계정을 ${label}하시겠습니까?`)) return;
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
                    finally { busy = false; render(); }
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
if (session) {
    if (!['manager', 'admin'].includes(session.role)) {
        message.textContent = '관리자만 접근할 수 있는 화면입니다.';
    } else {
        document.getElementById('management').hidden = false;
        onSnapshot(collection(db, 'users'), snapshot => {
            accounts = snapshot.docs.map(document => ({ ...document.data(), id: document.id }))
                .sort((a, b) => Number(stateOf(b) === 'pending') - Number(stateOf(a) === 'pending') || (a.displayName || a.email || '').localeCompare(b.displayName || b.email || '', 'ko'));
            message.textContent = `승인 대기 ${accounts.filter(account => stateOf(account) === 'pending').length}명 · 전체 ${accounts.length}명`;
            render();
        }, () => { list.replaceChildren(); message.textContent = '사용자 목록을 불러오지 못했습니다. 권한과 연결을 확인해 주세요.'; });
        filter.addEventListener('change', render);
    }
}
