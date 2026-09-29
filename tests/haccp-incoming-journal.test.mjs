import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = name => readFileSync(new URL(`../dashboard/js/${name}`, import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
const api = runInNewContext(`${source('haccp-form-common.js')}\n${source('journal-month-selection.js')}\n${source('haccp-incoming-journal.js')}\n({journalMonthRange,groupInspectionMonth,row})`);
const plain = value => JSON.parse(JSON.stringify(value));

test('monthly selection includes leap day and year-end correctly', () => {
  assert.equal(api.journalMonthRange(2024, 2).end, '2024-02-29');
  assert.equal(api.journalMonthRange(2026, 2).end, '2026-02-28');
  assert.deepEqual(plain(api.journalMonthRange(2026, 12)), {mode:'month', start:'2026-12-01', end:'2026-12-31'});
});

test('monthly journal retains over 100 records, sorts dates and excludes adjacent months', () => {
  const records = Array.from({length:105}, (_, i) => ({id:String(i), recordDate:i%2 ? '2026-09-30' : '2026-09-01'}));
  records.push({recordDate:'2026-08-31'}, {recordDate:'2026-10-01'});
  const [[month, rows]] = api.groupInspectionMonth(records, api.journalMonthRange(2026,9));
  assert.equal(month, '2026-09'); assert.equal(rows.length,105);
  assert.equal(rows[0].recordDate,'2026-09-01'); assert.equal(rows.at(-1).recordDate,'2026-09-30');
  assert.equal(api.groupInspectionMonth([],api.journalMonthRange(2026,9)).length,1);
});

test('inspection values keep false distinct from missing and escape material and supplier names', () => {
  const html = api.row({itemName:'참깨<script>',supplierName:'매입처&',offOdorDetected:false,testReportReceived:true,expirationCheck:'o',packagingCondition:'poor'});
  assert.ok(html.includes('참깨&lt;script&gt;')); assert.ok(html.includes('(매입처&amp;)'));
  assert.ok(html.includes('<td>X</td>')); assert.ok(html.includes('<td>O</td>')); assert.ok(html.includes('불량'));
  assert.ok(!api.row({}).includes('<td>X</td>'));
});
