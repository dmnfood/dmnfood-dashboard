export function parseBidPage(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('aT 응답 형식이 변경되었습니다.');
  const error = doc.querySelector('Parameter[id="ErrorCode"]');
  if (error && Number(error.textContent) < 0) throw new Error('aT에서 조회 오류를 반환했습니다.');
  const count = doc.querySelector('Parameter[id="iTotalCnt"]')?.textContent.trim();
  const dataset = doc.querySelector('Dataset[id="dsBid"]');
  if (!count || !/^\d+$/.test(count) || !dataset) throw new Error('aT 전체 건수를 확인하지 못했습니다.');
  const rows = [...dataset.querySelectorAll('Rows > Row')].map(row => Object.fromEntries(
    [...row.querySelectorAll('Col')].map(col => [col.getAttribute('id'), col.textContent || ''])
  ));
  return { total: Number(count), rows };
}

// Keep staged data separate: only a complete, validated result replaces the analysis.
export async function collectBidPages({ start, end, signal, onProgress = () => {},
  fetchPage = fetch, parsePage = parseBidPage }) {
  const rows = [], seen = new Set();
  let total;
  for (let page = 1; page <= 500; page++) {
    signal?.throwIfAborted();
    const query = new URLSearchParams({ start, end, page: String(page) });
    const response = await fetchPage(`/api/atbid?${query}`, { signal, cache: 'no-store' });
    let result;
    try { result = await response.json(); } catch { throw new Error('자동 조회 응답을 읽지 못했습니다. HAR 업로드를 이용해 주세요.'); }
    if (!response.ok) throw new Error(result.error || 'aT 조회에 실패했습니다.');
    if (result.page !== page || result.pageSize !== 20) throw new Error('조회 페이지가 일치하지 않습니다.');
    const parsed = parsePage(result.xml);
    if (total === undefined) total = parsed.total;
    if (!Number.isSafeInteger(total) || total < 0 || total > 10000) throw new Error('조회 범위가 큽니다. 기간을 줄여 주세요.');
    if (parsed.total !== total) throw new Error('수집 중 aT 결과 건수가 바뀌었습니다. 다시 조회해 주세요.');
    const expected = Math.min(20, total - rows.length);
    if (parsed.rows.length !== expected) throw new Error('일부 입찰 결과가 누락되었습니다. 다시 조회해 주세요.');
    for (const row of parsed.rows) {
      const key = row['입찰일련번호'] || row['입찰번호'];
      if (!key || seen.has(key) || Number(row.RNUM) !== rows.length + 1 || row['품명'] !== '참깨') {
        throw new Error('입찰 결과의 중복 또는 순서 오류가 발견되었습니다. 다시 조회해 주세요.');
      }
      seen.add(key);
      rows.push(row);
    }
    onProgress(rows.length, total);
    if (rows.length === total) return { rows, total };
  }
  throw new Error('조회 범위가 큽니다. 기간을 줄여 주세요.');
}
