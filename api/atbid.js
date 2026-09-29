// Public aT past-bid lookup. Fixed endpoint and item; no login/session is forwarded.
const ENDPOINT = 'https://www.atbid.co.kr/u16/BUAG02L1/list.do';
const PAGE_SIZE = 20;

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const send = (status, data) => { res.statusCode = status; res.end(JSON.stringify(data)); };
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return send(405, { error: 'GET 요청만 지원합니다.' });
  }
  const { start, end, page = '1' } = req.query || {};
  if (!validDate(start) || !validDate(end) || start > end
      || (Date.parse(end) - Date.parse(start)) / 86400000 > 366
      || typeof page !== 'string' || !/^[1-9]\d{0,2}$/.test(page) || Number(page) > 500) {
    return send(400, { error: '조회 기간(최대 1년)과 페이지를 확인해 주세요.' });
  }
  const values = { sSDate: start.replaceAll('-', ''), sEDate: end.replaceAll('-', ''),
    sItemCd: '11', sCancelYn: '', iCurPageNo: page, iPageSize: PAGE_SIZE };
  const columns = Object.keys(values).map(id => `<Column id="${id}" type="${id.startsWith('i') ? 'INT' : 'STRING'}" size="256"/>`).join('');
  const row = Object.entries(values).map(([id, value]) => `<Col id="${id}">${value}</Col>`).join('');
  const body = `<?xml version="1.0" encoding="UTF-8"?><Root xmlns="http://www.nexacroplatform.com/platform/dataset"><Parameters/><Dataset id="dsSearch"><ColumnInfo>${columns}</ColumnInfo><Rows><Row>${row}</Row></Rows></Dataset></Root>`;
  try {
    const upstream = await fetch(ENDPOINT, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8' }, body, signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) throw new Error('upstream');
    const xml = await upstream.text();
    if (xml.length > 1000000 || !/<Dataset\s[^>]*id="dsBid"/.test(xml) || !/<Parameter\s[^>]*id="iTotalCnt"/.test(xml)) {
      throw new Error('format');
    }
    return send(200, { xml, page: Number(page), pageSize: PAGE_SIZE });
  } catch {
    return send(502, { error: 'aT 자동 조회에 연결하지 못했습니다. 잠시 후 다시 시도하거나 HAR 파일을 업로드해 주세요.' });
  }
};
