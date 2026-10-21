// Shared by both local store and fake SDK so the real notification UI sees writes.
let records = [], ready = false;
const subscribers = new Set();
const events = new EventSource('/__order_ui/events');
events.onmessage = event => {
    records = JSON.parse(event.data); ready = true;
    subscribers.forEach(listener => listener.next(records));
};
events.onerror = () => subscribers.forEach(listener => listener.error?.(Object.assign(new Error('로컬 검증 서버 연결을 확인해 주세요.'), { code: 'unavailable' })));
export function subscribeState(next, error) {
    const listener = { next, error }; subscribers.add(listener);
    if (ready) queueMicrotask(() => { if (subscribers.has(listener)) next(records); });
    return () => subscribers.delete(listener);
}
export async function mutate(action) {
    if (navigator.onLine === false) throw Object.assign(new Error('인터넷 연결 후 다시 시도해 주세요.'), { code: 'unavailable' });
    const response = await fetch('/__order_ui/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '로컬 테스트 요청이 실패했습니다.');
    return result;
}
