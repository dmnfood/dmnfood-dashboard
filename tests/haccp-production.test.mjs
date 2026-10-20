import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = name => readFileSync(new URL(`../dashboard/js/${name}`, import.meta.url), 'utf8');
const strip = text => text.replace(/^import .*;\r?\n/gm, '').replace(/^export \{.*;\r?\n/gm, '').replace(/export /g, '');
const options = strip(source('haccp-production-options.js'));
const api = runInNewContext(`${options}\n({ PRODUCTION_OPTIONS, productionSizeOptions, productionSizeLabel, productionItemKey, isAllowedProductionItem, normalizeProductionItems, upsertProductionItem })`);
const plain = value => JSON.parse(JSON.stringify(value));
const item = (sourceCategory, sizeValue, extra = {}) => ({ productType: 'sesame_oil', sourceCategory, sizeValue, sizeUnit: 'ml', quantity: 10, ...extra });

test('both products present origins in the requested order', () => {
  assert.deepEqual(Object.keys(api.PRODUCTION_OPTIONS.sesame_oil.categories), ['korea', 'china', 'imported', 'imported_sesame_powder']);
  assert.deepEqual(Object.keys(api.PRODUCTION_OPTIONS.roasted_sesame.categories), ['korea', 'china', 'imported']);
});

test('sesame oil choices and grid columns match each origin, including Korean 350ml', () => {
  const expected = {
    korea: ['150ml', '180ml', '250ml', '300ml', '350ml', '500ml', '1L', '1.8L'],
    china: ['180ml', '250ml', '350ml', '1L', '1.8L'],
    imported: ['180ml', '250ml(사각병)', '250ml(원형병)', '350ml', '1L', '1.8L'],
    imported_sesame_powder: ['180ml', '250ml', '1L', '1.8L'],
  };
  for (const [category, labels] of Object.entries(expected)) {
    const choices = api.productionSizeOptions('sesame_oil', category);
    assert.deepEqual(plain(choices.map(api.productionSizeLabel)), labels);
    assert.ok(choices.every(choice => api.isAllowedProductionItem({ ...choice, quantity: 5 })));
  }
  assert.equal(api.PRODUCTION_OPTIONS.sesame_oil.categories.china.sizeColumns, 5);
  assert.equal(api.PRODUCTION_OPTIONS.sesame_oil.categories.imported.sizeColumns, 3);
  assert.equal(api.PRODUCTION_OPTIONS.sesame_oil.categories.imported_sesame_powder.sizeColumns, 4);
});

test('roasted sesame includes Korean 65g and imported 75g while retaining previous sizes', () => {
  for (const [category, labels] of [
    ['korea', ['65g', '80g', '130g', '1kg']],
    ['imported', ['75g', '120g', '140g', '1kg']],
  ]) {
    const choices = api.productionSizeOptions('roasted_sesame', category);
    assert.deepEqual(plain(choices.map(api.productionSizeLabel)), labels);
    assert.ok(choices.every(choice => api.isAllowedProductionItem({ ...choice, quantity: 0 })));
  }
});

test('square and round 250ml bottles remain distinct through add, replace and normalize', () => {
  const square = item('imported', 250, { bottleType: 'square' });
  const round = item('imported', 250, { bottleType: 'round' });
  let result = api.upsertProductionItem([square], round);
  assert.equal(result.items.length, 2);
  assert.notEqual(api.productionItemKey(square), api.productionItemKey(round));
  result = api.upsertProductionItem(result.items, { ...square, quantity: 25 });
  assert.equal(result.items.length, 2);
  assert.equal(result.replacedExisting, true);
  assert.equal(result.items.find(row => row.bottleType === 'square').quantity, 25);
  assert.deepEqual(plain(api.normalizeProductionItems(result.items)), [ { ...square, quantity: 25 }, round ]);
});

test('legacy 270ml entries keep their original identity and values while remaining editable', () => {
  for (const category of ['imported', 'imported_sesame_powder']) {
    const legacy = item(category, 270);
    assert.ok(api.isAllowedProductionItem(legacy));
    assert.equal(api.productionItemKey(legacy), `sesame_oil:${category}:ml:270`);
    assert.equal(api.productionSizeLabel(legacy), '270ml');
    assert.deepEqual(plain(api.normalizeProductionItems([legacy])), [legacy]);
    const result = api.upsertProductionItem([legacy], { ...legacy, quantity: 30 }, api.productionItemKey(legacy));
    assert.equal(result.items[0].sizeValue, 270);
    assert.equal(result.items[0].quantity, 30);
    assert.ok(!api.productionSizeOptions('sesame_oil', category).some(row => row.sizeValue === 270));
  }
});

test('validation rejects missing or incompatible bottle shapes and invalid quantities', () => {
  for (const invalid of [
    item('imported', 250), item('imported', 250, { bottleType: 'other' }),
    item('china', 250, { bottleType: 'round' }), item('imported', 350, { bottleType: 'square' }),
    item('china', 270), item('china', 180, { quantity: -1 }), item('china', 180, { quantity: 'abc' }),
  ]) assert.equal(api.isAllowedProductionItem(invalid), false);
});

test('date lookup reads the exact document even outside the recent list', async () => {
  let requested;
  let exists = true;
  const legacy = item('imported', 270);
  const module = strip(source('haccp-production-firestore.js'));
  const lookup = runInNewContext(`${options}\n${module}\ngetProductionRecordByDate`, {
    db: {}, doc: (_, collection, date) => { requested = { collection, date }; return requested; },
    getDoc: async () => ({ id: '2024-01-02', exists: () => exists, data: () => ({ recordDate: '2024-01-02', items: [legacy] }) }),
  });
  const record = await lookup('2024-01-02');
  assert.deepEqual(requested, { collection: 'haccpProductionRecords', date: '2024-01-02' });
  assert.deepEqual(plain(record.items), [legacy]);
  exists = false;
  assert.equal(await lookup('2024-01-03'), null);
});

test('saving a mixed old and new journal retains legacy sizes, both bottles and original author', async () => {
  let saved;
  const module = strip(source('haccp-production-firestore.js'));
  const save = runInNewContext(`${options}\n${module}\nsaveProductionRecord`, {
    db: {}, doc: (_, collection, id) => ({ collection, id }), serverTimestamp: () => 'timestamp',
    setDoc: async (ref, payload, options) => { saved = plain({ ref, payload, options }); },
  });
  const items = [item('imported', 270), item('imported_sesame_powder', 270), item('imported', 250, { bottleType: 'square' }), item('imported', 250, { bottleType: 'round' })];
  await save({ recordDate: '2024-01-02', items }, { uid: 'manager', email: 'manager@example.com' }, { createdByUid: 'original', createdByEmail: 'original@example.com' });
  assert.equal(saved.ref.id, '2024-01-02');
  assert.deepEqual(saved.payload.items, items);
  assert.equal(saved.payload.createdByUid, 'original');
  assert.equal(saved.options.merge, true);
  assert.equal(Object.hasOwn(saved.payload, 'createdAt'), false);
});

test('data export distinguishes bottle variants without relabeling legacy records', () => {
  const definitions = strip(source('haccp-management-definitions.js'));
  const adapters = strip(source('haccp-data-export-adapters.js'));
  const exports = runInNewContext(`${options}\n${definitions}\n${adapters}\nEXPORT_DEFINITIONS`);
  const rows = exports.production.flattenRecord({ recordDate: '2026-10-20', items: [
    item('imported', 270), item('imported', 250, { bottleType: 'square' }), item('imported', 250, { bottleType: 'round' }),
  ] }, '2026-10-20');
  assert.deepEqual(plain(rows.map(row => row.size)), ['270ml', '250ml(사각병)', '250ml(원형병)']);
});
