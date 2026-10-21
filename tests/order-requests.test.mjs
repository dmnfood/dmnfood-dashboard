import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { isOrderDate, normalizeOrderDraft, validateOrderInput, getApprovalIssues, buildOrderReview, emptyReviewChecks } from '../dashboard/js/order-request-model.js';

const draft = extra => ({ deliveryDate: '2026-10-30', deliveryMethod: 'courier', recipientName: '테스트 수령인', recipientPhone: '010-0000-0000',
    deliveryAddress: '테스트 배송지', lines: [{ productName: '테스트 상품', specification: '180ml', quantity: 12, unit: '개' }], ...extra });
const order = extra => ({ schemaVersion: 1, customerName: '테스트 거래처', customerGroup: 'wedding', sourceChannel: 'manual', sourceText: '가상 테스트 발주: 테스트 상품 12개',
    sourceReference: '자동화 검증용 가상 발주', draft: draft(), revision: 1, status: 'pending_review', isTest: true, reviewNotes: '',
    reviewChecks: emptyReviewChecks(), reviewedByUid: '', reviewedByName: '', reviewedAt: null, approvedRevision: 0, createdByUid: 'manager', createdByName: '담당자', ...extra });
const checked = { identity: true, items: true, delivery: true };
const reviewer = { uid: 'manager', name: '담당자' };
const plain = value => JSON.parse(JSON.stringify(value));

test('draft keeps unknown details unconfirmed and accepts incomplete source intake', () => {
    const empty = normalizeOrderDraft();
    assert.deepEqual(empty, { deliveryDate: '', deliveryMethod: 'undetermined', recipientName: '', recipientPhone: '', deliveryAddress: '', lines: [] });
    assert.deepEqual(validateOrderInput(order({ draft: empty })), []);
    const issues = getApprovalIssues(order({ draft: empty }));
    for (const field of ['납품일', '배송 방법', '수령인', '배송지', '품목']) assert.ok(issues.some(message => message.includes(field)));
    assert.ok(validateOrderInput(order({ sourceText: '   ' })).length);
});

test('approval checks exact quantity and unit and respects pickup delivery', () => {
    assert.deepEqual(getApprovalIssues(order()), []);
    assert.deepEqual(getApprovalIssues(order({ draft: draft({ deliveryMethod: 'pickup', deliveryAddress: '' }) })), []);
    for (const quantity of [0, -1, NaN, Infinity, 1000001]) {
        assert.ok(getApprovalIssues(order({ draft: draft({ lines: [{ productName: '상품', specification: '', quantity, unit: '개' }] }) })).length);
    }
    const issues = getApprovalIssues(order({ draft: draft({ lines: [{ productName: '', specification: '', quantity: 1, unit: '' }] }) }));
    assert.ok(issues.some(message => message.includes('품목명'))); assert.ok(issues.some(message => message.includes('단위')));
    assert.ok(getApprovalIssues(order({ draft: draft({ recipientPhone: '' }) })).some(message => message.includes('연락처')));
});

test('invalid calendar dates, excessive lines and non-finite quantities cannot be saved', () => {
    for (const date of ['2026-02-29', '2026-04-31', '2026-1-01', 'not-a-date']) assert.equal(isOrderDate(date), false);
    for (const date of ['2024-02-29', '2000-02-29', '2026-10-30']) assert.equal(isOrderDate(date), true);
    assert.equal(isOrderDate('1900-02-29'), false);
    assert.ok(validateOrderInput(order({ draft: draft({ lines: Array(6).fill(draft().lines[0]) }) })).length);
    assert.ok(validateOrderInput(order({ draft: normalizeOrderDraft(draft({ lines: [{ quantity: '1,000' }] })) })).length);
    assert.ok(validateOrderInput(order({ customerGroup: 'unknown' })).length);
});

test('approval requires three explicit checks and current revision; reasons required for other decisions', () => {
    const approved = buildOrderReview(order(), 1, { status: 'approved', reviewChecks: checked }, reviewer);
    assert.equal(approved.approvedRevision, 1); assert.equal(approved.reviewedByUid, 'manager');
    for (const checks of [{}, { ...checked, delivery: false }, { ...checked, items: 'true' }]) {
        assert.throws(() => buildOrderReview(order(), 1, { status: 'approved', reviewChecks: checks }, reviewer), /모두 확인/);
    }
    for (const revision of [0, 2, 1.5]) assert.throws(() => buildOrderReview(order(), revision, { status: 'approved', reviewChecks: checked }, reviewer), /최신 내용/);
    assert.throws(() => buildOrderReview(order({ status: 'approved' }), 1, { status: 'approved', reviewChecks: checked }, reviewer), /이미 처리/);
    assert.throws(() => buildOrderReview(order({ status: 'needs_information' }), 1, { status: 'approved', expectedStatus: 'pending_review', reviewChecks: checked }, reviewer), /상태를 변경/);
    for (const status of ['needs_information', 'rejected']) {
        assert.throws(() => buildOrderReview(order(), 1, { status }, reviewer), /사유/);
        const result = buildOrderReview(order(), 1, { status, reviewNotes: '배송지 확인 필요', reviewChecks: checked }, reviewer);
        assert.equal(result.approvedRevision, 0); assert.deepEqual(result.reviewChecks, emptyReviewChecks());
    }
});

function mockStore() {
    let record = order(), transactionCount = 0, recordId = 'test-order';
    let queryCallback;
    const archives = new Map();
    const session = { user: { uid: 'manager' }, profile: { role: 'manager', employeeName: '담당자', isActive: true, approvalStatus: 'approved' } };
    const navigator = { onLine: true };
    const snapshot = (sync = {}) => ({ id: recordId, exists: () => record != null, data: () => record, metadata: { fromCache: false, hasPendingWrites: false, ...sync } });
    const source = name => readFileSync(new URL(`../dashboard/js/${name}`, import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
    const api = runInNewContext(`${source('order-request-model.js')}\n${source('order-request-store.js')}\n({createOrderRequest,updateOrderRequest,reviewOrderRequest,mapOrderRequest,subscribeOrderRequests})`, {
        navigator, auth: { currentUser: session.user }, db: {}, isApprovedActiveProfile: p => p.isActive && p.approvalStatus === 'approved',
        doc: (...parts) => ({ id: parts.at(-1)?.id || (typeof parts.at(-1) === 'string' ? parts.at(-1) : 'new-id'), isArchive: parts.includes('versions') }), collection: () => ({}),
        orderBy: () => ({}), query: () => ({}), onSnapshot: (_, options, callback) => { assert.equal(options.includeMetadataChanges, true); queryCallback = callback; return () => {}; },
        serverTimestamp: () => 'SERVER_TIME', runTransaction: async (_, work) => { transactionCount++; return work({ get: async () => snapshot(), set: (ref, value) => { if (ref.isArchive) archives.set(ref.id, value); else record = value; }, update: (_, patch) => { record = { ...record, ...patch }; } }); },
    });
    return { api, session, navigator, snapshot, archives, emitQuery: snapshot => queryCallback(snapshot), get record() { return record; }, set record(value) { record = value; }, get transactions() { return transactionCount; } };
}

test('store transactions preserve source metadata, invalidate approval on edits and reject stale review', async () => {
    const state = mockStore();
    await state.api.reviewOrderRequest('test-order', 1, { status: 'approved', reviewChecks: checked }, state.session);
    assert.equal(state.record.approvedRevision, 1);
    await state.api.updateOrderRequest('test-order', 1, { draft: draft({ recipientName: '수정 수령인' }), sourceText: 'forged original' }, state.session);
    assert.equal(state.record.status, 'pending_review'); assert.equal(state.record.revision, 2);
    assert.equal(state.record.sourceText, order().sourceText); assert.equal(state.record.customerName, order().customerName);
    assert.equal(state.record.approvedRevision, 0); assert.equal(state.record.reviewedAt, null);
    assert.deepEqual(plain(state.record.reviewChecks), emptyReviewChecks());
    assert.equal(state.archives.get('1').record.approvedRevision, 1);
    assert.equal(state.archives.get('1').record.reviewedByUid, 'manager');
    assert.equal(state.archives.get('1').record.draft.recipientName, '테스트 수령인');
    await assert.rejects(state.api.reviewOrderRequest('test-order', 1, { status: 'approved', reviewChecks: checked }, state.session), /최신 내용/);
});

test('offline or unauthorized approval stops before a transaction; cached and pending snapshots are distinguishable', async () => {
    const state = mockStore();
    state.navigator.onLine = false;
    await assert.rejects(state.api.reviewOrderRequest('test-order', 1, { status: 'approved', reviewChecks: checked }, state.session), /오프라인/);
    assert.equal(state.transactions, 0); state.navigator.onLine = true;
    await assert.rejects(state.api.createOrderRequest(order(), { ...state.session, profile: { ...state.session.profile, role: 'worker' } }), /매니저/);
    assert.equal(state.transactions, 0);
    assert.equal(state.api.mapOrderRequest(state.snapshot()).syncState, 'confirmed');
    assert.equal(state.api.mapOrderRequest(state.snapshot({ fromCache: true })).syncState, 'cached');
    assert.equal(state.api.mapOrderRequest(state.snapshot({ hasPendingWrites: true })).syncState, 'pending');
});

test('review and draft edits reject an intervening review note even when content revision is unchanged', async () => {
    const state = mockStore();
    state.record = order({ updatedAt: { toDate: () => new Date('2026-10-21T01:01:00Z') } });
    const expectedUpdatedAtIso = '2026-10-21T01:00:00.000Z';
    await assert.rejects(state.api.reviewOrderRequest('test-order', 1, { status: 'approved', reviewChecks: checked, expectedUpdatedAtIso }, state.session), /검토 내용을 변경/);
    await assert.rejects(state.api.updateOrderRequest('test-order', 1, { draft: draft(), expectedUpdatedAtIso }, state.session), /검토 내용을 변경/);
    assert.equal(state.record.status, 'pending_review'); assert.equal(state.archives.size, 0);
});

test('an empty cached inbox is distinguishable from a server-confirmed empty inbox', () => {
    const state = mockStore();
    let received;
    state.api.subscribeOrderRequests((orders, metadata) => { received = { orders, metadata }; }, () => {});
    state.emitQuery({ docs: [], metadata: { fromCache: true, hasPendingWrites: false } });
    assert.equal(received.orders.length, 0); assert.equal(received.metadata.fromCache, true);
    state.emitQuery({ docs: [], metadata: { fromCache: false, hasPendingWrites: false } });
    assert.equal(received.orders.length, 0); assert.equal(received.metadata.fromCache, false);
});

test('creation is always a new pending revision with separate test label', async () => {
    const state = mockStore(); state.record = null;
    const sourceText = '  원문 앞뒤 공백\n줄바꿈 보존  ';
    const result = await state.api.createOrderRequest({ ...order(), sourceText, status: 'approved', approvedRevision: 10 }, state.session);
    assert.ok(result.id); assert.equal(state.record.status, 'pending_review'); assert.equal(state.record.revision, 1);
    assert.equal(state.record.approvedRevision, 0); assert.equal(state.record.isTest, true);
    assert.equal(state.record.createdByUid, 'manager'); assert.equal(state.record.createdAt, 'SERVER_TIME');
    assert.equal(state.record.sourceText, sourceText);
});

// Optional integration tests target a disposable emulator only; this never accepts a live Firebase host.
const emulatorHost = process.env.ORDER_FIRESTORE_EMULATOR_HOST;
test('Firestore emulator enforces roles, revisions, immutable originals, complete approval and denied deletion', { skip: !emulatorHost }, async () => {
    assert.match(emulatorHost, /^(127\.0\.0\.1|localhost):[0-9]+$/);
    const project = 'demo-order-notifications';
    const base = `http://${emulatorHost}/v1/projects/${project}/databases/(default)/documents`;
    const rulesLoaded = await fetch(`http://${emulatorHost}/emulator/v1/projects/${project}:securityRules`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') }] } }) });
    assert.equal(rulesLoaded.status, 200, await rulesLoaded.text());
    const name = id => `projects/${project}/databases/(default)/documents/orderRequests/${id}`;
    function value(input) {
        if (input === null) return { nullValue: null };
        if (input?.$timestamp) return { timestampValue: input.$timestamp };
        if (Array.isArray(input)) return { arrayValue: { values: input.map(value) } };
        if (typeof input === 'object') return { mapValue: { fields: fields(input) } };
        if (typeof input === 'boolean') return { booleanValue: input };
        if (typeof input === 'number') return Number.isInteger(input) ? { integerValue: String(input) } : { doubleValue: input };
        return { stringValue: input };
    }
    const fields = input => Object.fromEntries(Object.entries(input).map(([key, item]) => [key, value(item)]));
    function decode(item) {
        if ('nullValue' in item) return null;
        if ('timestampValue' in item) return { $timestamp: item.timestampValue };
        if ('mapValue' in item) return Object.fromEntries(Object.entries(item.mapValue.fields || {}).map(([key, v]) => [key, decode(v)]));
        if ('arrayValue' in item) return (item.arrayValue.values || []).map(decode);
        return item.stringValue ?? item.booleanValue ?? Number(item.integerValue ?? item.doubleValue);
    }
    function token(uid) {
        if (!uid) return '';
        const now = Math.floor(Date.now() / 1000);
        return `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: `https://securetoken.google.com/${project}`, aud: project, sub: uid, user_id: uid, iat: now, exp: now + 3600, auth_time: now, firebase: { sign_in_provider: 'custom' } })).toString('base64url')}.`;
    }
    const headers = uid => ({ 'Content-Type': 'application/json', ...(uid ? { Authorization: `Bearer ${uid === 'owner' ? 'owner' : token(uid)}` } : {}) });
    async function commit(id, record, uid = 'manager', timestamps = ['updatedAt'], archiveRecord = null) {
        const data = { ...record };
        for (const field of timestamps) delete data[field];
        const writes = [{ update: { name: name(id), fields: fields(data) }, updateTransforms: timestamps.map(fieldPath => ({ fieldPath, setToServerValue: 'REQUEST_TIME' })) }];
        if (archiveRecord) writes.push({ update: { name: `${name(id)}/versions/${archiveRecord.revision}`, fields: fields({ record: archiveRecord, archivedByUid: uid }) }, updateTransforms: [{ fieldPath: 'archivedAt', setToServerValue: 'REQUEST_TIME' }] });
        const response = await fetch(`${base}:commit`, { method: 'POST', headers: headers(uid), body: JSON.stringify({ writes }) });
        return { status: response.status, body: await response.json() };
    }
    async function read(id, uid = 'manager') {
        const response = await fetch(`${base}/orderRequests/${id}`, { headers: headers(uid) });
        const body = await response.json();
        return { status: response.status, record: body.fields ? Object.fromEntries(Object.entries(body.fields).map(([key, v]) => [key, decode(v)])) : null };
    }
    for (const [uid, role, approvalStatus, isActive] of [['manager', 'manager', 'approved', true], ['worker', 'worker', 'approved', true], ['pending-manager', 'manager', 'pending', true], ['inactive-manager', 'manager', 'approved', false]]) {
        const seeded = await fetch(`${base}/users/${uid}`, { method: 'PATCH', headers: headers('owner'), body: JSON.stringify({ fields: fields({ role, approvalStatus, isActive, employeeName: '담당자' }) }) });
        assert.equal(seeded.status, 200, await seeded.text());
    }
    const id = `test-${Date.now()}`;
    const create = (suffix, patch = {}, uid = 'manager') => commit(`${id}${suffix}`, order(patch), uid, ['receivedAt', 'createdAt', 'updatedAt']);
    for (const uid of ['', 'worker', 'pending-manager', 'inactive-manager']) assert.equal((await create(`-${uid || 'anonymous'}`, { createdByUid: uid || 'manager' }, uid)).status, 403);
    assert.equal((await create('-already-approved', { status: 'approved', approvedRevision: 1, reviewChecks: checked })).status, 403);
    assert.equal((await create('-invalid-calendar', { draft: draft({ deliveryDate: '2026-02-29' }) })).status, 403);
    assert.equal((await create('-bad-fifth-line', { draft: draft({ lines: [...Array(4).fill(draft().lines[0]), { ...draft().lines[0], quantity: -1 }] }) })).status, 403);
    assert.equal((await create('-line-extra-field', { draft: draft({ lines: [{ ...draft().lines[0], erpRegistered: true }] }) })).status, 403);
    assert.equal((await create('-line-wrong-type', { draft: draft({ lines: [{ ...draft().lines[0], specification: 180 }] }) })).status, 403);
    assert.equal((await create('-quantity-wrong-type', { draft: draft({ lines: [{ ...draft().lines[0], quantity: '12' }] }) })).status, 403);
    assert.equal((await create('-six-lines', { draft: draft({ lines: Array(6).fill(draft().lines[0]) }) })).status, 403);
    const fiveLines = await create('-five-lines', { draft: draft({ lines: Array(5).fill(draft().lines[0]) }) });
    assert.equal(fiveLines.status, 200, JSON.stringify(fiveLines.body));
    const fiveSaved = (await read(`${id}-five-lines`)).record;
    const fiveReview = buildOrderReview(fiveSaved, 1, { status: 'approved', reviewChecks: checked }, reviewer);
    const fiveApproved = await commit(`${id}-five-lines`, { ...fiveSaved, ...fiveReview }, 'manager', ['reviewedAt', 'updatedAt']);
    assert.equal(fiveApproved.status, 200, JSON.stringify(fiveApproved.body));
    const fiveApprovedRecord = (await read(`${id}-five-lines`)).record;
    const fiveRevised = await commit(`${id}-five-lines`, { ...fiveApprovedRecord, status: 'pending_review', revision: 2,
        reviewNotes: '', reviewChecks: emptyReviewChecks(), reviewedByUid: '', reviewedByName: '', reviewedAt: null, approvedRevision: 0,
        draft: draft({ lines: Array(5).fill({ ...draft().lines[0], quantity: 2 }) }) }, 'manager', ['updatedAt'], fiveApprovedRecord);
    assert.equal(fiveRevised.status, 200, JSON.stringify(fiveRevised.body));
    assert.equal((await create('')).status, 200);
    assert.equal((await read(id, 'worker')).status, 403);
    let saved = (await read(id)).record;
    assert.equal((await commit(id, { ...saved, sourceText: '원문 위조', revision: 2 })).status, 403);
    assert.equal((await commit(id, { ...saved, draft: draft({ recipientName: '수정' }) })).status, 403);
    const review = buildOrderReview(saved, 1, { status: 'approved', reviewChecks: checked }, reviewer);
    assert.equal((await commit(id, { ...saved, ...review, reviewChecks: { ...checked, delivery: false } }, 'manager', ['reviewedAt', 'updatedAt'])).status, 403);
    assert.equal((await commit(id, { ...saved, ...review, draft: draft({ deliveryDate: '2026-02-29' }) }, 'manager', ['reviewedAt', 'updatedAt'])).status, 403);
    assert.equal((await commit(id, { ...saved, ...review }, 'manager', ['reviewedAt', 'updatedAt'])).status, 200);
    saved = (await read(id)).record;
    const reset = { status: 'pending_review', revision: 2, reviewNotes: '', reviewChecks: emptyReviewChecks(), reviewedByUid: '', reviewedByName: '', reviewedAt: null, approvedRevision: 0 };
    assert.equal((await commit(id, { ...saved, ...reset, draft: draft({ lines: Array(6).fill(draft().lines[0]) }) })).status, 403);
    assert.equal((await commit(id, { ...saved, ...reset, draft: draft() })).status, 403, 'revision without immutable archive must fail');
    assert.equal((await commit(id, { ...saved, ...reset, draft: draft({ lines: [{ ...draft().lines[0], quantity: 0 }] }) }, 'manager', ['updatedAt'], saved)).status, 200);
    const archivedResponse = await fetch(`${base}/orderRequests/${id}/versions/1`, { headers: headers('manager') });
    assert.equal(archivedResponse.status, 200);
    const archived = await archivedResponse.json();
    assert.equal(archived.fields.record.mapValue.fields.approvedRevision.integerValue, '1');
    assert.equal(archived.fields.record.mapValue.fields.reviewedByUid.stringValue, 'manager');
    const forgedArchive = await fetch(`${base}/orderRequests/${id}/versions/1`, { method: 'PATCH', headers: headers('manager'), body: JSON.stringify({ fields: fields({ record: saved, archivedByUid: 'manager' }) }) });
    assert.equal(forgedArchive.status, 403);
    assert.equal((await fetch(`${base}/orderRequests/${id}/versions/1`, { method: 'DELETE', headers: headers('manager') })).status, 403);
    saved = (await read(id)).record;
    const approval = { ...review, revision: 2, approvedRevision: 2 };
    assert.equal((await commit(id, { ...saved, ...approval }, 'manager', ['reviewedAt', 'updatedAt'])).status, 403);
    assert.equal((await commit(id, { ...saved, ...approval, draft: draft() }, 'manager', ['reviewedAt', 'updatedAt'])).status, 403);
    assert.equal((await commit(id, { ...saved, status: 'needs_information', reviewedByUid: 'manager', reviewedByName: '담당자' }, 'manager', ['reviewedAt', 'updatedAt'])).status, 403);
    assert.equal((await commit(id, { ...saved, status: 'needs_information', reviewNotes: '수량 확인 필요', reviewedByUid: 'manager', reviewedByName: '담당자' }, 'manager', ['reviewedAt', 'updatedAt'])).status, 200);
    const deleted = await fetch(`${base}/orderRequests/${id}`, { method: 'DELETE', headers: headers('manager') });
    assert.equal(deleted.status, 403);
});
