import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as Model from '../dashboard/js/school-meal-company-model.js';
const storeSource = await readFile(new URL('../dashboard/js/school-meal-company-store.js', import.meta.url), 'utf8');
const session = { user: { uid: 'manager' }, profile: { role: 'manager', isActive: true } };
const canonical = async names => ({ schemaVersion: 1, revision: 1, companies: await Model.buildSchoolMealCompanies(names), updatedByUid: 'manager' });
function harness({ data = null, local = null, race = null, storageThrows = false, online = true } = {}) {
    let current = data, writes = 0, localReads = 0, snapshotHandler;
    const snapshot = value => ({ exists: () => value != null, data: () => value, metadata: { fromCache: false, hasPendingWrites: false } });
    const context = vm.createContext({ ...Model, navigator: { onLine: online }, auth: { currentUser: session.user }, db: {}, isApprovedActiveProfile: profile => profile?.isActive,
        localStorage: { getItem: () => { localReads++; if (storageThrows) throw new Error('blocked'); return local; } }, doc: (_, path) => ({ path }), serverTimestamp: () => 'server-time',
        getDocFromServer: async () => snapshot(current), onSnapshot: (_, __, callback) => { snapshotHandler = callback; return () => {}; },
        runTransaction: async (_, run) => { if (race) { current = race; race = null; } return run({ get: async () => snapshot(current), set: (_, next) => { writes++; current = next; } }); } });
    // The legacy reader's default must use the harness storage, as it would in the browser.
    context.legacySchoolMealCompanyNames = () => Model.legacySchoolMealCompanyNames(context.localStorage);
    vm.runInContext(`${storeSource.replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')}\nglobalThis.store = {ensureSchoolMealCompanies,saveSchoolMealCompanies,subscribeSchoolMealCompanies};`, context);
    return { store: context.store, get data() { return current; }, get writes() { return writes; }, get localReads() { return localReads; }, publish: value => snapshotHandler(value) };
}
test('company IDs use exact normalized UTF-8 names and never invent an ERP code', async () => {
    const name = '가상 업체', expected = `school-${createHash('sha256').update(name).digest('hex').slice(0, 24)}`;
    assert.equal(await Model.schoolMealCompanyId('  가상　업체  '), expected);
    assert.deepEqual(await Model.buildSchoolMealCompanies(['  가상　업체  ']), [{ id: expected, name }]);
    assert.throws(() => Model.normalizeSchoolMealCompanyNames(['가상 업체', '가상업체']), /중복/);
    assert.throws(() => Model.normalizeSchoolMealCompanyNames(Array(201).fill('가상')), /200/);
    const data = await canonical(['가상 업체']); data.companies[0].id = 'fake-erp-code';
    await assert.rejects(Model.validateSchoolMealCompanyCatalog(data), /일치/);
});
test('first shared catalog migrates existing browser names, preserving deliberate empty lists', async () => {
    for (const names of [['가상 기존 업체'], []]) {
        const app = harness({ local: JSON.stringify(names) }); const result = await app.store.ensureSchoolMealCompanies(session);
        assert.equal(result.created, true); assert.deepEqual(app.data.companies.map(item => item.name), names); assert.equal(app.writes, 1);
    }
    const app = harness(); await app.store.ensureSchoolMealCompanies(session);
    assert.deepEqual(app.data.companies.map(item => item.name), [...Model.DEFAULT_SCHOOL_MEAL_COMPANIES]); assert.equal(app.data.companies.length, 19);
});
test('existing shared catalog always wins over stale local data, including concurrent initialization', async () => {
    const server = await canonical(['가상 서버 업체']);
    for (const options of [{ data: server, local: 'invalid-json' }, { local: JSON.stringify(['가상 오래된 업체']), race: server }]) {
        const app = harness(options); const result = await app.store.ensureSchoolMealCompanies(session);
        assert.equal(result.created, false); assert.equal(app.writes, 0); assert.equal(app.data.companies[0].name, '가상 서버 업체');
    }
    const untouched = harness({ data: server, storageThrows: true }); await untouched.store.ensureSchoolMealCompanies(session); assert.equal(untouched.localReads, 0);
});
test('invalid migration, stale revisions, offline and worker saves leave shared data untouched', async () => {
    const invalid = harness({ local: '{bad-json' }); await assert.rejects(invalid.store.ensureSchoolMealCompanies(session), /덮어쓰지/); assert.equal(invalid.writes, 0);
    const app = harness({ data: await canonical(['가상 기존 업체']) });
    await assert.rejects(app.store.saveSchoolMealCompanies(['가상 변경'], { expectedRevision: 2 }, session), /다른 담당자/); assert.equal(app.writes, 0);
    await assert.rejects(app.store.saveSchoolMealCompanies(['가상 변경'], { expectedRevision: 1 }, { ...session, profile: { role: 'worker', isActive: true } }), /관리자/); assert.equal(app.writes, 0);
    const offline = harness({ data: await canonical(['가상 기존 업체']), online: false }); await assert.rejects(offline.store.saveSchoolMealCompanies(['가상 변경'], { expectedRevision: 1 }, session), /인터넷/); assert.equal(offline.writes, 0);
    const result = await app.store.saveSchoolMealCompanies(['가상 변경'], { expectedRevision: 1 }, session); assert.equal(result.revision, 2); assert.equal(app.data.companies[0].name, '가상 변경');
});
test('weekly page scripts remain valid after sharing the company catalog', async () => {
    const html = await readFile(new URL('../dashboard/school-meal-weekly.html', import.meta.url), 'utf8');
    for (const [, body] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(body.replace(/^\s*import .*;\r?\n/gm, ''));
});
test('catalog subscriptions expose internal identity and confirmed metadata without ERP mapping', async () => {
    const app = harness(), observed = [], errors = []; const unsubscribe = app.store.subscribeSchoolMealCompanies((items, meta) => observed.push({ items, meta }), error => errors.push(error));
    const companies = await Model.buildSchoolMealCompanies(['가상 업체']);
    app.publish({ exists: () => true, data: () => ({ schemaVersion: 1, revision: 3, companies }), metadata: { fromCache: false, hasPendingWrites: false } });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(observed.length, 1); const item = observed[0].items[0]; assert.equal(item.source, 'school_meal'); assert.equal(item.erpCode, null); assert.equal(item.code, item.id); assert.equal(item.revision, 3); assert.equal(item.syncState, 'confirmed'); assert.equal(errors.length, 0); unsubscribe();
});
