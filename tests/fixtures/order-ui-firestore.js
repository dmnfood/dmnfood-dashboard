import { subscribeState } from '/__order_ui/transport.js';
export function collection(_db, name) { return { name }; }
export function where(field, operation, value) { return { field, operation, value }; }
export function query(ref, ...filters) { return { ...ref, filters }; }
export function onSnapshot(ref, options, next, error) {
    if (typeof options === 'function') { error = next; next = options; }
    let previous = new Map();
    return subscribeState(records => {
        const filtered = records.filter(record => (ref.filters || []).every(filter => filter.operation === '==' && record[filter.field] === filter.value));
        const metadata = { fromCache: false, hasPendingWrites: false };
        const docs = filtered.map(record => ({ id: record.id, data: () => ({ ...record }), exists: () => true, metadata }));
        const changes = [];
        docs.forEach(doc => { const prior = previous.get(doc.id); if (!prior) changes.push({ type: 'added', doc }); else if (JSON.stringify(prior.data()) !== JSON.stringify(doc.data())) changes.push({ type: 'modified', doc }); });
        previous.forEach((doc, id) => { if (!docs.some(current => current.id === id)) changes.push({ type: 'removed', doc }); });
        previous = new Map(docs.map(doc => [doc.id, doc]));
        next({ docs, metadata, size: docs.length, empty: docs.length === 0, docChanges: () => changes });
    }, error);
}
