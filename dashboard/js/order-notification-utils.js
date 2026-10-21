// Notification state is a convenience only. Approval always comes from the order record.
export function orderNotificationHref(id) {
    if (typeof id !== 'string' || !id || id.includes('/') || id.length > 1500) return '/orders';
    return `/orders?order=${encodeURIComponent(id)}`;
}

export function orderNotificationKey(order) {
    return JSON.stringify([order.id, order.revision]);
}

export function normalizeOrderNotice(id, data = {}) {
    if (typeof id !== 'string' || !id || id.includes('/') || data.status !== 'pending_review') return null;
    let receivedAt = null;
    try {
        const millis = typeof data.receivedAt?.toMillis === 'function'
            ? data.receivedAt.toMillis()
            : typeof data.receivedAt?.seconds === 'number' ? data.receivedAt.seconds * 1000 : null;
        if (Number.isFinite(millis) && Math.abs(millis) <= 8640000000000000) receivedAt = millis;
    } catch { /* An incomplete timestamp stays visibly unconfirmed. */ }
    return {
        id,
        revision: Number.isSafeInteger(data.revision) && data.revision >= 1 ? data.revision : 1,
        customerName: typeof data.customerName === 'string' && data.customerName.trim() ? data.customerName.trim() : '거래처 확인 필요',
        sourceChannel: typeof data.sourceChannel === 'string' ? data.sourceChannel : '',
        receivedAt,
        isTest: data.isTest === true,
    };
}

export function readOrderNoticeSeen(value) {
    try {
        const data = JSON.parse(value);
        if (data?.version !== 1 || !Array.isArray(data.seen)) return new Map();
        return new Map(data.seen.filter(entry => Array.isArray(entry) && entry.length === 2
            && typeof entry[0] === 'string' && Number.isSafeInteger(entry[1]) && entry[1] >= 1).slice(-2000));
    } catch { return new Map(); }
}

export function serializeOrderNoticeSeen(seen) {
    return JSON.stringify({ version: 1, seen: [...seen].slice(-2000) });
}

export function isOrderNoticeUnseen(order, seen) {
    return order.revision > (seen.get(order.id) || 0);
}

// The first server-confirmed snapshot establishes a baseline. Cache hydration and
// local pending writes must never announce historical orders as newly received.
export function createOrderNoticeTracker() {
    let ready = false;
    const announced = new Set();
    return {
        update(orders, { fromCache = false, hasPendingWrites = false } = {}) {
            if (fromCache || hasPendingWrites) return [];
            if (!ready) {
                ready = true;
                orders.forEach(order => announced.add(orderNotificationKey(order)));
                return [];
            }
            const fresh = orders.filter(order => !announced.has(orderNotificationKey(order)));
            fresh.forEach(order => announced.add(orderNotificationKey(order)));
            return fresh;
        },
    };
}
