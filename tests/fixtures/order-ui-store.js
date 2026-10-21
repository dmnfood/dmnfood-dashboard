import { subscribeState, mutate } from '/__order_ui/transport.js';
export const ORDER_REQUEST_COLLECTION = 'orderRequests';
function mapped(record) {
    if (!record) return null;
    const iso = value => typeof value?.seconds === 'number' ? new Date(value.seconds * 1000).toISOString() : '';
    return { ...record, createdAtIso: iso(record.createdAt), updatedAtIso: iso(record.updatedAt), receivedAtIso: iso(record.receivedAt), reviewedAtIso: iso(record.reviewedAt), syncState: 'confirmed' };
}
export function subscribeOrderRequests(next, error) { return subscribeState(records => next(records.map(mapped)), error); }
export function subscribeOrderRequest(id, next, error) { return subscribeState(records => next(mapped(records.find(record => record.id === id))), error); }
export function createOrderRequest(input) { return mutate({ type: 'create', input }); }
export function updateOrderRequest(id, expectedRevision, input) { return mutate({ type: 'update', id, expectedRevision, input }); }
export function reviewOrderRequest(id, expectedRevision, decision) { return mutate({ type: 'review', id, expectedRevision, decision }); }
