import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { CUSTOMER_IMPORT_LIMIT, normalizeErpCustomer, validateErpCustomer, planCustomerImport } from '../dashboard/js/erp-customer-model.js';
const source = await readFile(new URL('../dashboard/js/erp-customer-store.js', import.meta.url), 'utf8');
const stamp = () => ({ toDate: () => new Date('2026-10-21T00:00:00Z') });
function harness(initial = []) {
    const records = new Map(initial.map(item => [item.code, item])), writes = [], db = {}, user = { uid: 'manager' };
    const context = vm.createContext({ CUSTOMER_IMPORT_LIMIT, normalizeErpCustomer, validateErpCustomer, auth: { currentUser: user }, db,
        isApprovedActiveProfile: profile => profile.approvalStatus === 'approved' && profile.isActive,
        serverTimestamp: stamp, doc: (db, collection, id) => ({ collection, id }),
        runTransaction: async (db, callback) => {
            const pending = [];
            await callback({ get: async ref => ({ exists: () => records.has(ref.id), data: () => records.get(ref.id) }),
                set: (ref, data) => pending.push({ type: 'set', ref, data }), update: (ref, data) => pending.push({ type: 'update', ref, data }) });
            for (const write of pending) { writes.push(write); records.set(write.ref.id, { ...(write.type === 'update' ? records.get(write.ref.id) : {}), ...write.data }); }
        }, navigator: { onLine: true } });
    vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + '\nglobalThis.api={saveErpCustomer,saveErpCustomerImport};', context);
    return { ...context.api, records, writes, context, session: { user, profile: { role: 'manager', approvalStatus: 'approved', isActive: true, employeeName: '담당자' } } };
}
test('catalog creates exact code and requires reviewed revision to change existing name', async () => {
    const app = harness(); await app.saveErpCustomer({ code: '0001', name: '동방' }, app.session);
    assert.equal(app.writes[0].ref.id, '0001'); assert.equal(app.records.get('0001').revision, 1);
    await assert.rejects(() => app.saveErpCustomer({ code: '0001', name: '변경명' }, app.session), /다른 담당자/);
    await app.saveErpCustomer({ code: '0001', name: '변경명', expectedRevision: 1, expectedUpdatedAtIso: '2026-10-21T00:00:00.000Z' }, app.session);
    assert.equal(app.records.get('0001').revision, 2); assert.equal(app.records.get('0001').name, '변경명');
    assert.equal(app.writes[1].data.code, undefined, 'update never rewrites immutable code');
    await assert.rejects(() => app.saveErpCustomer({ code: '0001', name: '오래된 수정', expectedRevision: 1 }, app.session), /다른 담당자/);
    assert.equal(app.writes.length, 2);
});
test('bulk import is all-or-nothing and requires explicit confirmation before name replacement', async () => {
    const previous = { code: '0001', name: '동방', revision: 1, updatedAt: stamp(), updatedAtIso: '2026-10-21T00:00:00.000Z' };
    const app = harness([previous]), plan = planCustomerImport([['CODE', 'NAME'], ['0002', '신규'], ['0001', '새 이름']], [previous]);
    await assert.rejects(() => app.saveErpCustomerImport(plan, app.session), /변경 내용을/); assert.equal(app.writes.length, 0);
    app.records.set('0001', { ...previous, revision: 2 });
    await assert.rejects(() => app.saveErpCustomerImport(plan, app.session, { confirmNameChanges: true }), /다른 담당자/);
    assert.equal(app.writes.length, 0); assert.equal(app.records.has('0002'), false);
    app.records.set('0001', previous);
    const result = await app.saveErpCustomerImport(plan, app.session, { confirmNameChanges: true });
    assert.equal(result.saved, 2); assert.equal(app.records.get('0002').code, '0002'); assert.equal(app.records.get('0001').revision, 2);
});
test('catalog save rejects offline, worker and changed signed-in identities', async () => {
    const app = harness(); app.context.navigator.onLine = false;
    await assert.rejects(() => app.saveErpCustomer({ code: '0001', name: '동방' }, app.session), /인터넷/);
    app.context.navigator.onLine = true;
    await assert.rejects(() => app.saveErpCustomer({ code: '0001', name: '동방' }, { ...app.session, profile: { ...app.session.profile, role: 'worker' } }), /관리자/);
    app.context.auth.currentUser = { uid: 'other' };
    await assert.rejects(() => app.saveErpCustomer({ code: '0001', name: '동방' }, app.session), /관리자/);
    assert.equal(app.writes.length, 0);
});
