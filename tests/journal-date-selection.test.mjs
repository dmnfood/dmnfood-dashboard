import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = name => readFileSync(new URL(`../dashboard/js/${name}`, import.meta.url), 'utf8');
const common = source('haccp-form-common.js').replace(/export /g, '');
const selection = source('journal-date-selection.js').replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
const api = runInNewContext(`${common}\n${selection}\n({isJournalDate,journalSelectionError,groupJournalDates})`);
const plain = value => JSON.parse(JSON.stringify(value));

test('date validation handles leap years and rejects incomplete, impossible and reversed ranges', () => {
  assert.equal(api.isJournalDate('2024-02-29'),true);
  for(const date of ['2026-02-29','2026-04-31','2026-1-01','',undefined]) assert.equal(api.isJournalDate(date),false);
  assert.equal(api.journalSelectionError({start:'2026-09-29',end:'2026-09-29'}),'');
  assert.ok(api.journalSelectionError({start:'2026-09-30',end:'2026-09-29'}));
  assert.ok(api.journalSelectionError({start:'2026-09-30',end:''}));
});

test('range printing groups inclusive endpoints in date order, skips empty dates and excludes other dates', () => {
  const records=[{id:'last',recordDate:'2026-10-02'},{id:'first',recordDate:'2026-09-29'},{id:'outside',recordDate:'2026-10-03'},{id:'second',recordDate:'2026-09-29'},{id:'invalid',recordDate:''}];
  const groups=plain(api.groupJournalDates(records,{mode:'range',start:'2026-09-29',end:'2026-10-02'}));
  assert.deepEqual(groups.map(([date,rows])=>[date,rows.map(r=>r.id)]),[['2026-09-29',['first','second']],['2026-10-02',['last']]]);
});

test('single empty dates have a printable blank form, empty ranges have no sheets', () => {
  assert.deepEqual(plain(api.groupJournalDates([],{mode:'date',start:'2026-09-29',end:'2026-09-29'})),[['2026-09-29',[]]]);
  assert.deepEqual(plain(api.groupJournalDates([],{mode:'range',start:'2026-09-29',end:'2026-10-02'})),[]);
  assert.deepEqual(plain(api.groupJournalDates([],{mode:'range',start:'2026-10-02',end:'2026-09-29'})),[]);
});

test('shared range query is inclusive, uncapped, maps records and returns unsubscribe', () => {
  let captured, callback;
  const module=source('haccp-journal-records.js').replace(/^import .*;\r?\n/gm,'').replace(/export /g,'');
  const subscribe=runInNewContext(`${module}\nsubscribeJournalRange`,{db:{},collection:(_,name)=>name,where:(field,operator,value)=>({field,operator,value}),query:(collection,...clauses)=>({collection,clauses}),onSnapshot:(q,onRecords)=>{captured=q;callback=onRecords;return 'unsubscribe';}});
  let mapped;
  assert.equal(subscribe('haccpHeatingRecords',doc=>doc.id,'2026-09-01','2026-09-30',records=>{mapped=records;},()=>{}),'unsubscribe');
  assert.deepEqual(plain(captured),{collection:'haccpHeatingRecords',clauses:[{field:'recordDate',operator:'>=',value:'2026-09-01'},{field:'recordDate',operator:'<=',value:'2026-09-30'}]});
  callback({docs:[{id:'record'}]});assert.deepEqual(plain(mapped),['record']);
});
