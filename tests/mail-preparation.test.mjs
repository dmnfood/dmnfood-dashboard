import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { assertMailPreparationAddress, validateMailPreparationInput, validateMailPreparationSelection } from '../dashboard/js/mail-preparation-model.js';

const intakeId = 'a'.repeat(64), attachmentId = '12', sourceHash = 'b'.repeat(64), attachmentSha256 = 'c'.repeat(64);
const selection = () => ({ sheetIndex: 0, sheetName: '가상 발주서', range: 'A4:F6', startRow: 3, endRow: 5, startColumn: 0, endColumn: 5 });
const input = (extra = {}) => ({ intakeId, attachmentId, account: 'official@dmnfood.co.kr', sourceHash, attachmentSha256,
    customer: { id: '0007', code: '0007', name: '가상 거래처', revision: 1, syncState: 'confirmed' }, selection: selection(), expectedRevision: 0, ...extra });
const plain = value => JSON.parse(JSON.stringify(value));

test('manual ranges retain exact sheet identity and canonical cell addresses without clamping', () => {
    assert.deepEqual(validateMailPreparationSelection(selection()), selection());
    for (const change of [{ range: 'A4' }, { range: 'a4:f6' }, { range: 'A3:F6' }, { sheetIndex: 32 }, { sheetIndex: -1 },
        { endRow: 100000 }, { endColumn: 1024 }, { startRow: 8 }, { startColumn: 9 }, { endRow: 5.2 }, { sheetName: '' }, { sheetName: 'a\nb' }, { unexpected: true }]) {
        assert.throws(() => validateMailPreparationSelection({ ...selection(), ...change }));
    }
    assert.equal(validateMailPreparationSelection({ ...selection(), endRow: 3, endColumn: 0, range: 'A4:A4' }).range, 'A4:A4');
    assert.equal(validateMailPreparationSelection({ ...selection(), startRow: 99999, endRow: 99999, startColumn: 1023, endColumn: 1023, range: 'AMJ100000:AMJ100000' }).range, 'AMJ100000:AMJ100000');
});

test('source IDs, hashes and ERP master identities are exact and confirmed', () => {
    assert.equal(validateMailPreparationInput(input()).customer.code, '0007');
    for (const changes of [{ intakeId: 'x' }, { attachmentId: '0' }, { attachmentId: '01' }, { attachmentId: '../12' }, { account: 'elsewhere@example.invalid' },
        { sourceHash: 'c' }, { attachmentSha256: 'B'.repeat(64) }, { expectedRevision: -1 }, { expectedRevision: NaN },
        { customer: { ...input().customer, id: '7' } }, { customer: { ...input().customer, syncState: 'cached' } },
        { customer: { ...input().customer, syncState: 'pending' } }, { customer: { ...input().customer, name: ' 가상 거래처' } },
        { customer: { ...input().customer, id: '..', code: '..' } }]) assert.throws(() => validateMailPreparationInput(input(changes)));
    assert.throws(() => assertMailPreparationAddress(intakeId, '1'.repeat(20)));
});

function mockStore() {
    const docs = new Map(), metadata = new Map();
    const base = `mailPreparations/${intakeId}/attachments/${attachmentId}`;
    docs.set(`mailIntakes/${intakeId}`, { schemaVersion: 1, account: 'official@dmnfood.co.kr', rawStorage: { sha256: sourceHash } });
    docs.set(`mailIntakes/${intakeId}/attachments/${attachmentId}`, { schemaVersion: 1, intakeId, attachmentId, sha256: attachmentSha256 });
    docs.set('erpCustomers/0007', { schemaVersion: 1, code: '0007', name: '가상 거래처', revision: 1 });
    const session = { user: { uid: 'manager' }, profile: { role: 'manager', isActive: true, approvalStatus: 'approved' } };
    const navigator = { onLine: true }, auth = { currentUser: session.user };
    let snapshots, transactionCount = 0;
    const snapshot = path => ({ id: path.split('/').at(-1), exists: () => docs.has(path), data: () => docs.get(path),
        metadata: { fromCache: false, hasPendingWrites: false, ...metadata.get(path) } });
    const source = name => readFileSync(new URL(`../dashboard/js/${name}`, import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
    const api = runInNewContext(`${source('mail-preparation-model.js')}\n${source('mail-preparation-store.js')}\n({ saveMailPreparation,subscribeMailPreparation,mapMailPreparation })`, {
        navigator, auth, db: {}, isApprovedActiveProfile: value => value?.isActive && value.approvalStatus === 'approved',
        doc: (_, ...parts) => ({ path: parts.join('/'), id: parts.at(-1) }), serverTimestamp: () => 'SERVER_TIME',
        onSnapshot: (ref, options, callback) => { assert.equal(options.includeMetadataChanges, true); snapshots = value => callback(value ?? snapshot(ref.path)); return () => {}; },
        runTransaction: async (_, callback) => {
            transactionCount++; const writes = new Map();
            await callback({ get: async ref => snapshot(ref.path), set: (ref, value) => writes.set(ref.path, value) });
            for (const [path, value] of writes) docs.set(path, value);
        },
    });
    return { api, docs, metadata, session, navigator, auth, base, snapshot, emit: value => snapshots(value), get transactionCount() { return transactionCount; } };
}

test('complete manual preparation is source-bound, starts unapproved, and preserves every previous revision', async () => {
    const state = mockStore();
    const result = await state.api.saveMailPreparation(input({ status: 'approved', approvedRevision: 7 }), state.session);
    assert.equal(result.revision, 1); assert.equal(result.status, 'range_selected');
    assert.equal(state.docs.get(state.base).customer.code, '0007');
    assert.equal(state.docs.get(state.base).sourceHash, sourceHash); assert.equal(state.docs.get(state.base).approvedRevision, undefined);
    const before = state.docs.get(state.base);
    const nextSelection = { ...selection(), endRow: 9, range: 'A4:F10' };
    await state.api.saveMailPreparation(input({ expectedRevision: 1, selection: nextSelection }), state.session);
    assert.equal(state.docs.get(state.base).revision, 2); assert.deepEqual(plain(state.docs.get(state.base).selection), nextSelection);
    assert.deepEqual(plain(state.docs.get(`${state.base}/versions/1`).record), plain(before));
    assert.equal(state.docs.get(`${state.base}/versions/1`).archivedByUid, 'manager');
    assert.equal(state.docs.get(state.base).createdByUid, 'manager');
    assert.equal([...state.docs.keys()].some(path => path.startsWith('orderRequests/')), false);
});

test('wrong mail, changed hash or missing attachment cannot create or alter a preparation', async () => {
    for (const [path, patch] of [
        [`mailIntakes/${intakeId}`, { account: 'other@example.invalid' }],
        [`mailIntakes/${intakeId}`, { rawStorage: { sha256: 'd'.repeat(64) } }],
        [`mailIntakes/${intakeId}/attachments/${attachmentId}`, { intakeId: 'd'.repeat(64) }],
        [`mailIntakes/${intakeId}/attachments/${attachmentId}`, { attachmentId: '13' }],
        [`mailIntakes/${intakeId}/attachments/${attachmentId}`, { sha256: 'd'.repeat(64) }],
    ]) {
        const state = mockStore(); state.docs.set(path, { ...state.docs.get(path), ...patch });
        await assert.rejects(state.api.saveMailPreparation(input(), state.session), /원본/);
        assert.equal(state.docs.has(state.base), false);
    }
    const state = mockStore(); state.docs.delete(`mailIntakes/${intakeId}/attachments/${attachmentId}`);
    await assert.rejects(state.api.saveMailPreparation(input(), state.session), /원본/);
    assert.equal(state.docs.has(state.base), false);
});

test('stale edits and changed master customer revisions stop before writes, retaining the saved selection', async () => {
    const state = mockStore(); await state.api.saveMailPreparation(input(), state.session);
    await assert.rejects(state.api.saveMailPreparation(input(), state.session), /다른 담당자/);
    const previous = state.docs.get(state.base);
    await assert.rejects(state.api.saveMailPreparation(input({ expectedRevision: 1, expectedUpdatedAtIso: '2026-10-21T01:00:00.000Z' }), state.session), /다른 담당자/);
    for (const patch of [{ revision: 2 }, { name: '가상 거래처 수정' }, { code: '0008' }]) {
        state.docs.set('erpCustomers/0007', { schemaVersion: 1, code: '0007', name: '가상 거래처', revision: 1, ...patch });
        await assert.rejects(state.api.saveMailPreparation(input({ expectedRevision: 1 }), state.session), /거래처/);
        assert.equal(state.docs.get(state.base), previous); assert.equal(state.docs.has(`${state.base}/versions/1`), false);
    }
});

test('existing source binding and archived history cannot silently be replaced', async () => {
    const state = mockStore(); await state.api.saveMailPreparation(input(), state.session);
    state.docs.get(state.base).sourceHash = 'd'.repeat(64);
    await assert.rejects(state.api.saveMailPreparation(input({ expectedRevision: 1 }), state.session), /다른 원본/);
    state.docs.get(state.base).sourceHash = sourceHash;
    state.docs.set(`${state.base}/versions/1`, { record: { invalid: true } });
    await assert.rejects(state.api.saveMailPreparation(input({ expectedRevision: 1 }), state.session), /이력/);
    assert.equal(state.docs.get(state.base).revision, 1);
});

test('offline, collector, pending and cached source states cannot save; snapshots expose confirmation state', async () => {
    const state = mockStore(); state.navigator.onLine = false;
    await assert.rejects(state.api.saveMailPreparation(input(), state.session), /오프라인/); assert.equal(state.transactionCount, 0);
    state.navigator.onLine = true;
    for (const role of ['worker', 'collector']) await assert.rejects(state.api.saveMailPreparation(input(), { ...state.session, profile: { ...state.session.profile, role } }), /매니저/);
    for (const flags of [{ fromCache: true }, { hasPendingWrites: true }]) {
        state.metadata.set('erpCustomers/0007', flags);
        await assert.rejects(state.api.saveMailPreparation(input(), state.session), /최신 내용/);
    }
    state.metadata.clear(); let current;
    state.api.subscribeMailPreparation(intakeId, attachmentId, (record, metadata) => { current = { record, metadata }; }, () => {});
    state.metadata.set(state.base, { fromCache: true }); state.emit();
    assert.equal(current.record, null); assert.equal(current.metadata.fromCache, true);
    state.metadata.clear(); state.emit(); assert.equal(current.metadata.fromCache, false);
    await state.api.saveMailPreparation(input(), state.session);
    state.emit(); assert.equal(current.record.syncState, 'confirmed');
    state.metadata.set(state.base, { fromCache: true }); state.emit(); assert.equal(current.record.syncState, 'cached');
    state.metadata.set(state.base, { hasPendingWrites: true }); state.emit(); assert.equal(current.record.syncState, 'pending');
});
