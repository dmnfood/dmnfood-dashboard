import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const code = name => readFileSync(new URL(`../dashboard/js/${name}`,import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export /g,'');
const api = runInNewContext(`${code('haccp-management-utils.js')}\n${code('haccp-hygiene-schedule.js')}\n({hygieneSchedule,hygieneRecordFor,hygieneQueryRange})`);
test('weekly checks become due on Friday and remain overdue through Sunday',()=>{
  assert.equal(api.hygieneSchedule('2026-10-01','weekly',[]).state,'upcoming');
  assert.equal(api.hygieneSchedule('2026-10-02','weekly',[]).state,'due');
  assert.equal(api.hygieneSchedule('2026-10-04','weekly',[]).state,'overdue');
});
test('monthly checks use the first Monday, including months starting on Monday',()=>{
  assert.equal(api.hygieneSchedule('2026-10-04','monthly',[]).state,'upcoming');
  assert.equal(api.hygieneSchedule('2026-10-05','monthly',[]).state,'due');
  assert.equal(api.hygieneSchedule('2026-10-31','monthly',[]).state,'overdue');
  assert.equal(api.hygieneSchedule('2026-06-01','monthly',[]).state,'due');
});
test('completion respects group and period including ISO weeks spanning years',()=>{
  const rows=[{id:'week',recordDate:'2025-12-29',inspectionGroup:'weekly'},{id:'month',recordDate:'2026-01-02',inspectionGroup:'monthly'}];
  assert.equal(api.hygieneSchedule('2026-01-02','weekly',rows).state,'completed');
  assert.equal(api.hygieneSchedule('2026-01-30','monthly',rows).state,'completed');
  assert.equal(api.hygieneSchedule('2026-02-02','monthly',rows).state,'due');
  assert.equal(api.hygieneSchedule('2026-01-02','pre_work',rows).state,'due');
});
test('incoming stays available after a record, annual completion is scoped to year',()=>{
  const rows=[{recordDate:'2026-01-01',inspectionGroup:'annual'},{recordDate:'2026-09-29',inspectionGroup:'incoming'}];
  assert.equal(api.hygieneSchedule('2026-09-29','incoming',rows).label,'1건 작성 · 추가 가능');
  assert.equal(api.hygieneRecordFor(rows,'2026-09-29','incoming'),null);
  assert.equal(api.hygieneSchedule('2026-09-29','annual',rows).state,'completed');
  assert.equal(api.hygieneSchedule('2027-01-01','annual',rows).state,'due');
  const range=api.hygieneQueryRange('2026-01-02');assert.ok(range.start<'2026-01-01');assert.ok(range.end>'2026-12-31');
});
