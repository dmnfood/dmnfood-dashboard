import { collection, onSnapshot, query, where } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db, isApprovedActiveProfile } from './firebase-client.js';
import {
    createOrderNoticeTracker, isOrderNoticeUnseen, normalizeOrderNotice,
    orderNotificationHref, readOrderNoticeSeen, serializeOrderNoticeSeen,
} from './order-notification-utils.js';

const instances = new WeakMap();
const channelLabels = { email: '메일', mail: '메일', naverworks: '네이버웍스', kakao: '카톡', kakaotalk: '카톡', sms: '문자', erp: '호텔 ERP', hotel_erp: '호텔 ERP', manual: '직접 등록', test: '연결 테스트' };

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function storageValue(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}

function storeValue(key, value) {
    try { localStorage.setItem(key, value); } catch { /* Alerts remain usable without browser storage. */ }
}

/**
 * Mount a read-only alert bell for an approved manager/admin.
 * Browser notifications require an explicit click and work while this webapp is open.
 * Returns { destroy(), refresh() }; safe to initialize again on the same mount.
 */
export function initOrderNotifications({ user, profile, mount } = {}) {
    const target = typeof mount === 'string' ? document.querySelector(mount) : mount;
    if (!target) return { destroy() {}, refresh() {} };
    instances.get(target)?.destroy();
    if (!user?.uid || !isApprovedActiveProfile(profile) || !['manager', 'admin'].includes(profile.role)) {
        return { destroy() {}, refresh() {} };
    }

    const seenKey = `dmnfood:order-notices:seen:v1:${user.uid}`;
    const nativeKey = `dmnfood:order-notices:browser:v1:${user.uid}`;
    let seen = readOrderNoticeSeen(storageValue(seenKey));
    let nativeEnabled = storageValue(nativeKey) === 'true';
    let orders = [], loaded = false, fromCache = true, failed = false, destroyed = false;
    let unsubscribe, toastTimer, toast, listSignature, tracker = createOrderNoticeTracker();
    const nativeNotices = new Set();
    const listeners = new AbortController();
    const { signal } = listeners;

    const root = element('div', 'order-notifications');
    const trigger = element('button', 'order-notifications-trigger');
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    const icon = element('span', 'order-notifications-icon', '🔔');
    icon.setAttribute('aria-hidden', 'true');
    const label = element('span', 'order-notifications-label', '발주 알림');
    const badge = element('span', 'order-notifications-badge', '…');
    badge.setAttribute('aria-hidden', 'true');
    const dot = element('span', 'order-notifications-unseen');
    dot.hidden = true;
    trigger.append(icon, label, badge, dot);

    const panel = element('section', 'order-notifications-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '발주 확인·승인 요청');
    panel.tabIndex = -1;
    panel.hidden = true;
    const panelId = `order-notifications-${crypto.randomUUID()}`;
    panel.id = panelId;
    trigger.setAttribute('aria-controls', panelId);
    const header = element('div', 'order-notifications-heading');
    const title = element('h2', '', '발주 확인·승인 요청');
    const close = element('button', 'order-notifications-close', '닫기');
    close.type = 'button';
    header.append(title, close);
    const connection = element('p', 'order-notifications-connection', '발주를 확인하고 있습니다.');
    connection.setAttribute('role', 'status');
    const summary = element('p', 'order-notifications-summary');
    const list = element('ul', 'order-notifications-list');
    const footer = element('div', 'order-notifications-footer');
    const inbox = element('a', 'order-notifications-inbox', '발주함 전체 보기');
    inbox.href = '/orders';
    const nativeButton = element('button', 'order-notifications-browser');
    nativeButton.type = 'button';
    const note = element('p', 'order-notifications-note', '알림을 열어도 발주는 승인되지 않습니다. 브라우저 알림은 웹앱이 열려 있을 때만 받을 수 있습니다.');
    const permissionStatus = element('p', 'order-notifications-permission');
    permissionStatus.setAttribute('role', 'status');
    const retry = element('button', 'order-notifications-retry', '다시 연결');
    retry.type = 'button';
    retry.hidden = true;
    footer.append(inbox, nativeButton, permissionStatus, note, retry);
    panel.append(header, connection, summary, list, footer);
    root.append(trigger, panel);
    target.append(root);

    function nativeSupported() {
        return 'Notification' in window && window.isSecureContext;
    }

    function renderNativeButton() {
        nativeButton.disabled = !nativeSupported();
        nativeButton.textContent = !nativeSupported() ? '이 환경에서는 브라우저 알림을 지원하지 않습니다'
            : nativeEnabled && Notification.permission === 'granted' ? '브라우저 알림 끄기'
                : Notification.permission === 'denied' ? '브라우저 알림 차단됨 · 설정 안내' : '브라우저 알림 켜기';
    }

    function positionPanel() {
        if (panel.hidden) return;
        const bounds = trigger.getBoundingClientRect();
        const top = Math.max(12, Math.min(bounds.bottom + 10, window.innerHeight - 180));
        panel.style.top = `${top}px`;
        panel.style.right = `${Math.max(12, window.innerWidth - bounds.right)}px`;
        panel.style.maxHeight = `${Math.max(160, window.innerHeight - top - 12)}px`;
    }

    function markVisibleSeen() {
        if (panel.hidden || document.visibilityState === 'hidden') return;
        orders.slice(0, 30).forEach(order => seen.set(order.id, Math.max(order.revision, seen.get(order.id) || 0)));
        storeValue(seenKey, serializeOrderNoticeSeen(seen));
    }

    function render() {
        if (destroyed) return;
        const unseen = orders.filter(order => isOrderNoticeUnseen(order, seen)).length;
        const unknown = !loaded || failed || fromCache || !navigator.onLine;
        badge.textContent = unknown ? (failed ? '!' : loaded ? '?' : '…') : orders.length > 99 ? '99+' : String(orders.length);
        dot.hidden = unseen === 0;
        trigger.classList.toggle('has-pending', orders.length > 0);
        trigger.classList.toggle('has-error', unknown);
        trigger.setAttribute('aria-label', unknown ? '발주 알림 · 연결 확인 필요 · 현재 대기 건수 미확정'
            : `발주 알림 · 승인 대기 ${orders.length}건 · 새 알림 ${unseen}건`);
        connection.classList.toggle('is-warning', unknown);
        connection.textContent = failed ? '발주 알림 연결에 실패했습니다. 대기 건수는 최신 상태가 아닐 수 있습니다.'
            : !navigator.onLine ? '인터넷 연결이 끊겼습니다. 마지막 확인 내용을 표시합니다.'
                : !loaded ? '발주를 확인하고 있습니다.'
                    : fromCache ? '서버 연결 확인 중입니다. 저장된 발주를 표시합니다.' : '실시간 수신 중 · 승인 대기 발주를 표시합니다.';
        retry.hidden = !failed;
        summary.textContent = unknown ? loaded && orders.length ? `마지막 확인: 승인 대기 ${orders.length}건 · 현재 연결 확인 필요` : '대기 발주 확인 중'
            : `승인 대기 ${orders.length}건${unseen ? ` · 새 알림 ${unseen}건` : ''}`;
        const emptyMessage = !loaded ? '연결 후 대기 발주가 표시됩니다.'
            : unknown ? '대기 발주가 확인되지 않았습니다. 연결 상태를 확인해 주세요.' : '확인·승인을 기다리는 발주가 없습니다.';
        const nextSignature = JSON.stringify([orders.slice(0, 30), orders.length, orders.length ? '' : emptyMessage]);
        // Metadata-only updates must preserve the keyboard focus inside the list.
        if (nextSignature !== listSignature) {
            const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.orderId : null;
            const entries = orders.slice(0, 30).map(order => {
                const item = element('li', 'order-notifications-item');
                const link = element('a', 'order-notifications-order');
                link.href = orderNotificationHref(order.id);
                link.dataset.orderId = order.id;
                const customer = element('strong', '', `${order.isTest ? '[연결 테스트] ' : ''}${order.customerName}`);
                const description = element('span', 'order-notifications-detail');
                const date = order.receivedAt === null ? '수신 시각 확인 필요'
                    : new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(order.receivedAt);
                description.textContent = `${channelLabels[order.sourceChannel] || '수신 발주'} · ${date} · ${order.revision}차`;
                const action = element('span', 'order-notifications-action', '확인·승인 →');
                link.append(customer, description, action);
                item.append(link);
                return item;
            });
            if (!entries.length) entries.push(element('li', 'order-notifications-empty', emptyMessage));
            if (orders.length > 30) entries.push(element('li', 'order-notifications-more', '최근 30건을 표시합니다. 전체 건은 발주함에서 확인해 주세요.'));
            list.replaceChildren(...entries);
            listSignature = nextSignature;
            if (focusedId) {
                const link = [...list.querySelectorAll('a')].find(item => item.dataset.orderId === focusedId);
                (link || panel).focus();
            }
        }
        renderNativeButton();
        positionPanel();
    }

    function closePanel(restoreFocus = false) {
        panel.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        if (restoreFocus) trigger.focus();
    }

    function dismissToast() {
        clearTimeout(toastTimer);
        toast?.remove();
        toast = null;
    }

    function announce(fresh) {
        if (!fresh.length || destroyed) return;
        dismissToast();
        toast = element('div', 'order-notifications-toast');
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        const message = element('span', '', `새 발주 ${fresh.length}건이 도착했습니다. 확인·승인이 필요합니다.`);
        const action = element('a', '', '발주 확인');
        action.href = fresh.length === 1 ? orderNotificationHref(fresh[0].id) : '/orders';
        const dismiss = element('button', '', '닫기');
        dismiss.type = 'button';
        dismiss.addEventListener('click', dismissToast, { signal });
        toast.append(message, action, dismiss);
        document.body.append(toast);
        toastTimer = window.setTimeout(dismissToast, 12000);
        toast.addEventListener('mouseenter', () => clearTimeout(toastTimer), { signal });
        toast.addEventListener('focusin', () => clearTimeout(toastTimer), { signal });
        if (nativeEnabled && nativeSupported() && Notification.permission === 'granted' && document.visibilityState === 'hidden') {
            try {
                const notification = new Notification(`들메내식품 · 새 발주 ${fresh.length}건`, {
                    body: '웹앱에서 발주 내용을 확인하고 승인해 주세요.',
                    tag: `dmnfood-order:${user.uid}:${fresh[0].id}:${fresh[0].revision}`,
                });
                nativeNotices.add(notification);
                notification.onclick = () => {
                    notification.close();
                    if (destroyed) return;
                    window.focus();
                    window.location.assign(action.href);
                };
                notification.onclose = () => nativeNotices.delete(notification);
            } catch {
                permissionStatus.textContent = '브라우저 알림을 표시하지 못했습니다. 웹앱 알림에서 확인해 주세요.';
            }
        }
    }

    function listen() {
        unsubscribe?.();
        failed = false;
        // Reconnection creates a new baseline and does not replay old toasts.
        tracker = createOrderNoticeTracker();
        render();
        unsubscribe = onSnapshot(query(collection(db, 'orderRequests'), where('status', '==', 'pending_review')),
            { includeMetadataChanges: true }, snapshot => {
                if (destroyed) return;
                orders = snapshot.docs.map(record => normalizeOrderNotice(record.id, record.data())).filter(Boolean)
                    .sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0) || a.id.localeCompare(b.id));
                loaded = true;
                failed = false;
                fromCache = snapshot.metadata.fromCache;
                const fresh = tracker.update(orders, snapshot.metadata);
                markVisibleSeen();
                render();
                announce(fresh);
            }, () => { if (!destroyed) { failed = true; render(); } });
    }

    trigger.addEventListener('click', () => {
        if (!panel.hidden) { closePanel(); return; }
        panel.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        markVisibleSeen();
        render();
        panel.focus();
    }, { signal });
    close.addEventListener('click', () => closePanel(true), { signal });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); closePanel(true); }
    }, { signal });
    document.addEventListener('pointerdown', event => {
        if (!panel.hidden && !root.contains(event.target)) closePanel();
    }, { signal });
    root.addEventListener('focusout', () => {
        queueMicrotask(() => { if (!destroyed && !root.contains(document.activeElement)) closePanel(); });
    }, { signal });
    nativeButton.addEventListener('click', async () => {
        if (!nativeSupported()) return;
        if (nativeEnabled && Notification.permission === 'granted') {
            nativeEnabled = false;
            storeValue(nativeKey, 'false');
            permissionStatus.textContent = '이 계정의 브라우저 알림을 껐습니다.';
            renderNativeButton();
            return;
        }
        if (Notification.permission === 'denied') {
            permissionStatus.textContent = '주소창의 사이트 설정에서 알림을 허용한 뒤 다시 켜 주세요.';
            return;
        }
        nativeButton.disabled = true;
        try {
            const permission = await Notification.requestPermission();
            if (destroyed) return;
            nativeEnabled = permission === 'granted';
            storeValue(nativeKey, String(nativeEnabled));
            permissionStatus.textContent = nativeEnabled ? '웹앱을 열어 두면 다른 탭을 보는 중에도 새 발주 알림을 받을 수 있습니다.'
                : '알림을 허용하지 않았습니다. 웹앱 안의 발주 알림은 계속 표시됩니다.';
        } catch {
            if (!destroyed) permissionStatus.textContent = '브라우저 알림 권한을 확인하지 못했습니다.';
        } finally { if (!destroyed) renderNativeButton(); }
    }, { signal });
    retry.addEventListener('click', listen, { signal });
    window.addEventListener('online', render, { signal });
    window.addEventListener('offline', render, { signal });
    window.addEventListener('resize', positionPanel, { signal });
    window.addEventListener('scroll', positionPanel, { signal, capture: true });
    document.addEventListener('visibilitychange', () => { markVisibleSeen(); render(); }, { signal });
    window.addEventListener('storage', event => {
        if (event.key === seenKey) { seen = readOrderNoticeSeen(event.newValue); render(); }
        if (event.key === nativeKey) { nativeEnabled = event.newValue === 'true'; renderNativeButton(); }
    }, { signal });

    const handle = {
        refresh() { if (!destroyed) listen(); },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            unsubscribe?.();
            listeners.abort();
            dismissToast();
            nativeNotices.forEach(notification => notification.close());
            nativeNotices.clear();
            root.remove();
            instances.delete(target);
        },
    };
    instances.set(target, handle);
    window.addEventListener('pagehide', event => { if (!event.persisted) handle.destroy(); }, { signal });
    listen();
    return handle;
}
