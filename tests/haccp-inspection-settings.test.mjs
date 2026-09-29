import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const code = readFileSync(new URL('../dashboard/js/haccp-inspection-settings.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
const stored = new Map();
const api = runInNewContext(`${code}\n({normalizeInspectionSettings,createInspectionSettingsStore})`, {
  db: {}, doc: (_, ...parts) => parts.join('/'), serverTimestamp: () => 'timestamp',
  getDoc: async path => ({ exists: () => stored.has(path), data: () => stored.get(path) }),
  setDoc: async (path, values) => stored.set(path, values),
});

test('missing or invalid saved settings preserve current input defaults', () => {
  const defaults = api.normalizeInspectionSettings({temperature:' ',offOdorDetected:'true',expirationCheck:'invalid'});
  assert.equal(defaults.temperature,'실온'); assert.equal(defaults.grade,'일반');
  assert.equal(defaults.writerConfirmName,'이승표'); assert.equal(defaults.offOdorDetected,false);
  assert.equal(defaults.expirationCheck,'x');
});

test('raw and auxiliary settings persist independently and retain all choice values', async () => {
  const raw = api.createInspectionSettingsStore('rawMaterialInspection');
  const aux = api.createInspectionSettingsStore('auxMaterialInspection');
  await raw.saveInspectionSettings({temperature:' 냉장 ',offOdorDetected:true,packagingCondition:'poor',expirationCheck:'o',testReportReceived:true}, {uid:'manager'});
  const loaded = await raw.loadInspectionSettings();
  assert.equal(loaded.temperature,'냉장'); assert.equal(loaded.offOdorDetected,true);
  assert.equal(loaded.packagingCondition,'poor'); assert.equal(loaded.expirationCheck,'o'); assert.equal(loaded.testReportReceived,true);
  assert.equal((await aux.loadInspectionSettings()).temperature,'실온');
  assert.equal(stored.get('haccpSettings/rawMaterialInspection').updatedByUid,'manager');
  assert.throws(()=>api.createInspectionSettingsStore('heating'));
});
