import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = name => readFileSync(new URL(`../dashboard/js/${name}`, import.meta.url), 'utf8');
const common = source('haccp-form-common.js').replace(/export /g, '');
const renderer = source('haccp-process-journal.js').replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
const api = runInNewContext(`${common}\n${renderer}\n({renderFilteringJournal,renderBottleWashingJournal})`);
const filteringSettings = { meshSpecification:'120mesh', cartridgeFilterSpecification:'100μm', pressureLimitMpa:0.3 };
const bottleSettings = { minPressureMpa:0.3, minDurationSec:1 };
function render(kind, records) {
  const container = { innerHTML:'', querySelectorAll() { return this.innerHTML.match(/class="journal-sheet sheet-page"/g) || []; } };
  const pages = api[kind === 'filtering' ? 'renderFilteringJournal' : 'renderBottleWashingJournal']({container,date:'2026-09-29',records,settings:kind === 'filtering' ? filteringSettings : bottleSettings});
  return { pages, html:container.innerHTML };
}

test('filtering prints every dated record beyond the 100-record list limit in time order', () => {
  const records = Array.from({length:103},(_,i) => ({id:String(i),productName:`품목-${i}-끝`,checkedTime:String(i).padStart(3,'0'),judgment:'PASS'})).reverse();
  const {pages,html} = render('filtering', records);
  assert.equal(pages,18);
  for(let i=0;i<103;i++) assert.equal(html.split(`품목-${i}-끝`).length-1,1);
  assert.ok(html.indexOf('품목-0-끝') < html.indexOf('품목-1-끝'));
  assert.equal((html.match(/is-selected/g) || []).length,103);
});

test('filtering preserves zero pressure, undamaged state and escapes recorded text', () => {
  const {html} = render('filtering',[{productName:'<b>참기름</b>',checkedTime:'08:00',pressurePsi:0,filterMeshDamaged:false,foreignMaterialDescription:'없음 & 정상',judgment:'PASS'}]);
  assert.ok(html.includes('0 psi')); assert.ok(html.includes('파손 없음'));
  assert.ok(html.includes('&lt;b&gt;참기름&lt;/b&gt;'));assert.ok(html.includes('없음 &amp; 정상'));
  assert.ok(html.includes('is-selected">○'));assert.ok(!html.includes('is-selected">×'));
});

test('bottle washing includes 150ml, keeps MPa and zero quantity, and paginates repeated containers', () => {
  const record={containerMaterial:'glass',containerVolumeMl:150,pressureMpa:0.35,washDurationSec:1.5,washedQuantity:0,judgment:'PASS'};
  const {pages,html}=render('bottle',[{...record,measuredTime:'12:00'},{...record,measuredTime:'08:00'}]);
  assert.equal(pages,2);
  assert.equal((html.match(/150<br>ml/g)||[]).length,2);
  assert.equal((html.match(/0\.35 MPa/g)||[]).length,2);
  assert.equal((html.match(/>0개</g)||[]).length,2);
  assert.ok(html.indexOf('08:00')<html.indexOf('12:00'));
});

test('failed records and corrective actions stay on their own filtering page', () => {
  const records=Array.from({length:7},(_,i)=>({checkedTime:`0${i}:00`,judgment:i===6?'FAIL':'PASS',deviationDetail:i===6?'파손 기록':'',correctiveActionResult:i===6?'망 교체 완료':''}));
  const {html}=render('filtering',records);
  const pages=html.split('<section class="journal-sheet sheet-page">').slice(1);
  assert.ok(!pages[0].includes('파손 기록'));assert.ok(pages[1].includes('파손 기록'));
  assert.ok(pages[1].includes('망 교체 완료'));assert.ok(pages[1].includes('is-selected">×'));
});

test('empty forms retain original six record rows without preselected judgments', () => {
  for(const kind of ['filtering','bottle']) {
    const {pages,html}=render(kind,[]);
    assert.equal(pages,1);assert.equal((html.match(/class="judgment"/g)||[]).length,6);
    assert.ok(!html.includes('is-selected'));
  }
});

test('date subscriptions query the whole selected day without a recent-record limit', () => {
  for(const [filename,fn] of [['haccp-filtering-firestore.js','subscribeFilteringRecordsByDate'],['haccp-bottle-washing-firestore.js','subscribeBottleWashingRecordsByDate']]) {
    let captured;
    const module=source(filename).replace(/^import .*;\r?\n/gm,'').replace(/export /g,'');
    const subscribe=runInNewContext(`${module}\n${fn}`,{db:{},collection:(_,name)=>name,where:(field,operator,value)=>({field,operator,value}),query:(collection,...clauses)=>({collection,clauses}),onSnapshot:q=>{captured=q;return 'unsubscribe';}});
    assert.equal(subscribe('2025-01-01',()=>{},()=>{}),'unsubscribe');
    assert.deepEqual(JSON.parse(JSON.stringify(captured.clauses)),[{field:'recordDate',operator:'==',value:'2025-01-01'}]);
  }
});
