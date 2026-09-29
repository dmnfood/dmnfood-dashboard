import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the same inline parser used by both HAR imports and the aT pilot.
const html = readFileSync(new URL('../dashboard/sesame-bid-analysis.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('    function parseTitle('), html.indexOf('    function parseXmlText('));
const parseTitle = runInNewContext(`${source}; parseTitle`);
const plain = title => JSON.parse(JSON.stringify(parseTitle(title)));

test('normal sale uses the sesame specification, date and trailing region', () => {
  assert.deepEqual(plain('(서울경기:전국통합)(구분:1) 수입참깨(일반품:인도산:1등:파렛타이징) 판매 (26. 7. 7. 화) 이천 '),
    { origin: '인도산', grade: '1등', pack: '파렛타이징', date: '2026-07-07', region: '이천' });
});
test('Busan returned-goods sale never treats the branch as origin', () => {
  assert.deepEqual(plain('(부산울산:자체판매)(구분:1) 수입참깨(반송품:인도산:1등) 판매 (26. 8. 21. 금) 부산 '),
    { origin: '인도산', grade: '1등', pack: '일반', date: '2026-08-21', region: '부산' });
});
test('country suffix variants are grouped together, including returned goods', () => {
  for (const country of ['인도', '파키스탄', '부르키나파소']) {
    for (const suffix of ['', '산']) {
      const parsed = parseTitle(`(부산울산:자체판매)(구분:2) 수입참깨(반송품:${country}${suffix}:2등:첸나이4) 판매 (26.8.13.목) 청원`);
      assert.equal(parsed.origin, `${country}산`);
      assert.equal(parsed.grade, '2등');
      assert.equal(parsed.date, '2026-08-13');
    }
  }
});
test('missing specification or origin does not fall back to unrelated parentheses', () => {
  for (const title of ['', '(부산울산:자체판매)(구분:1) 수입참깨 판매 (26.8.21.금) 부산',
    '(부산울산:자체판매) 수입참깨(반송품:1등) 판매 (26.8.21.금) 부산']) {
    assert.equal(parseTitle(title).origin, '');
  }
});
test('spacing, grade and packaging are read within the product specification', () => {
  const parsed = parseTitle('(울산:자체판매)(구분:1) 수입 참깨 ( 일반품 : 중국산 : 1 등 : 점보백 ) 판매 (26. 9. 1. 화) 부산');
  assert.equal(parsed.origin, '중국산');
  assert.equal(parsed.grade, '1등');
  assert.equal(parsed.pack, '점보백');
});
