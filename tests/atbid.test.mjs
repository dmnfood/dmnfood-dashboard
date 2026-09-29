import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/atbid.js';
import { collectBidPages } from '../dashboard/js/atbid-pilot.js';

const row = n => ({ RNUM: String(n), '입찰번호': `bid-${n}`, '품명': '참깨' });
function mockPages(total, transform = x => x) {
  return async url => {
    const page = Number(new URL(url, 'http://localhost').searchParams.get('page'));
    const start = (page - 1) * 20;
    const data = transform({ total, rows: Array.from({ length: Math.min(20, total - start) }, (_, i) => row(start + i + 1)) }, page);
    return { ok: true, json: async () => ({ xml: data, page, pageSize: 20 }) };
  };
}
const options = { start: '2026-08-01', end: '2026-09-29', parsePage: data => data };

test('collects every page including the short final page', async () => {
  const progress = [];
  const result = await collectBidPages({ ...options, fetchPage: mockPages(117), onProgress: n => progress.push(n) });
  assert.equal(result.rows.length, 117);
  assert.deepEqual(progress, [20, 40, 60, 80, 100, 117]);
});
test('rejects a duplicated page rather than presenting partial success', async () => {
  await assert.rejects(collectBidPages({ ...options, fetchPage: mockPages(40, (data, page) => {
    if (page === 2) data.rows[0] = row(1);
    return data;
  }) }), /중복/);
});
test('rejects missing rows and changing source totals', async () => {
  await assert.rejects(collectBidPages({ ...options, fetchPage: mockPages(21, data => ({ ...data, rows: [] })) }), /누락/);
  await assert.rejects(collectBidPages({ ...options, fetchPage: mockPages(21, (data, page) => ({ ...data, total: data.total + page - 1 })) }), /바뀌/);
});
test('supports empty results and cancellation', async () => {
  assert.equal((await collectBidPages({ ...options, fetchPage: mockPages(0) })).total, 0);
  const controller = new AbortController();
  await assert.rejects(collectBidPages({ ...options, fetchPage: mockPages(40), signal: controller.signal,
    onProgress: () => controller.abort() }), { name: 'AbortError' });
});
async function invoke(query, method = 'GET') {
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(body) { this.body = JSON.parse(body); } };
  await handler({ method, query }, res);
  return res;
}
test('API rejects invalid dates, injection and excessive ranges before fetching', async () => {
  for (const query of [
    { start: '2026-02-30', end: '2026-03-01' },
    { start: '2026-08-01', end: '2026-09-29', page: '<bad>' },
    { start: '2020-01-01', end: '2026-09-29' },
    { start: '2026-09-29', end: '2026-08-01' },
  ]) assert.equal((await invoke(query)).statusCode, 400);
  assert.equal((await invoke({}, 'POST')).statusCode, 405);
});
test('API sends a fixed read-only request and handles unavailable source', async t => {
  t.mock.method(globalThis, 'fetch', async (url, config) => {
    assert.equal(url, 'https://www.atbid.co.kr/u16/BUAG02L1/list.do');
    assert(config.body.includes('<Col id="sItemCd">11</Col>'));
    assert(config.body.includes('<Col id="iCurPageNo">2</Col>'));
    assert(config.body.includes('<Col id="iPageSize">20</Col>'));
    return { ok: true, text: async () => '<Root><Parameter id="iTotalCnt">21</Parameter><Dataset id="dsBid"/></Root>' };
  });
  assert.equal((await invoke({ ...options, page: '2' })).statusCode, 200);
  globalThis.fetch.mock.mockImplementation(async () => { throw new Error('connection'); });
  assert.equal((await invoke(options)).statusCode, 502);
});
