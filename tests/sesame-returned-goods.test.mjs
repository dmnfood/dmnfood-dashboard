import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../dashboard/sesame-bid-analysis.html', import.meta.url), 'utf8');
const extract = (start, end) => html.slice(html.indexOf(start), html.indexOf(end));

function setup() {
  const fields = Object.fromEntries(['fDate', 'fOrigin', 'fGrade', 'fPack', 'fRegion'].map(id => [id, { value: '' }]));
  fields.includeReturned = { checked: false };
  const row = (title, price, date = '2026-08-21', origin = '인도산') => ({
    title, date, origin, grade: '1등', pack: '일반', region: '부산',
    minPrice: price - 100, avgPrice: price, maxPrice: price + 100
  });
  const state = { rawRows: [
    row('수입참깨(일반품:인도산:1등)', 3000),
    row('수입참깨(반송품:인도산:1등)', 1000),
    row('수입참깨( 반 송 품 :인도산:1등)', 500, '2026-08-22'),
    row('수입참깨(일반품:중국산:1등)', 5000, '2026-08-23', '중국산')
  ], filteredRows: [] };
  let renders = 0;
  const api = runInNewContext(`
    ${extract('    function groupByDate(', '    function renderTable(')}
    ${extract('    function applyFilters(', '    let pilotController')}
    ({ applyFilters, groupByDate });
  `, { state, $: id => fields[id], render: () => renders++, avg: values => values.reduce((a, b) => a + b, 0) / values.length });
  return { ...api, fields, state, renders: () => renders };
}

test('exclusion removes returned prices and dates before chart aggregation; inclusion restores them', () => {
  const api = setup();
  api.applyFilters();
  assert.equal(api.state.filteredRows.length, 2);
  let dates = api.groupByDate(api.state.filteredRows);
  assert.equal(dates.length, 2);
  assert.equal(dates[0].avg, 3000);
  assert.equal(dates[0].min, 2900);
  assert.equal(dates[0].max, 3100);
  api.fields.includeReturned.checked = true;
  api.applyFilters();
  dates = api.groupByDate(api.state.filteredRows);
  assert.equal(api.state.filteredRows.length, 4);
  assert.equal(dates.length, 3);
  assert.equal(dates[0].avg, 2000);
  assert.equal(api.state.rawRows.length, 4);
  assert.equal(api.renders(), 2);
});

test('returned-goods choice combines with existing filters and supports an empty result', () => {
  const api = setup();
  api.fields.fOrigin.value = '인도산';
  api.fields.fDate.value = '2026-08-22';
  api.applyFilters();
  assert.equal(api.state.filteredRows.length, 0);
  assert.equal(api.groupByDate(api.state.filteredRows).length, 0);
  api.fields.includeReturned.checked = true;
  api.applyFilters();
  assert.equal(api.state.filteredRows.length, 1);
});
