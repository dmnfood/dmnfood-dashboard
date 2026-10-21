/* Read-only, bounded cell preview. Archived original bytes are never changed. */
const MAX_BYTES = 3 * 1024 * 1024;
const WORKER_URL = new URL('./mail-workbook-worker.js', import.meta.url);
const CSS_URL = new URL('../css/mail-workbook-preview.css', import.meta.url);
let nextInstance = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function button(label, handler) {
  const node = element('button', 'mail-workbook-button', label);
  node.type = 'button'; node.addEventListener('click', handler); return node;
}
function ensureStyles() {
  if (document.querySelector('link[data-mail-workbook-styles]')) return;
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = CSS_URL.href;
  link.dataset.mailWorkbookStyles = 'true'; document.head.append(link);
}

export async function renderMailWorkbook({ mount, bytes, fileName = '', signal }) {
  if (!mount || typeof mount.replaceChildren !== 'function') throw new Error('Excel을 표시할 위치를 찾을 수 없습니다.');
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_BYTES) throw new Error('Excel 미리보기는 비어 있지 않은 3 MB 이하 파일을 지원합니다. 원본을 내려받아 확인해 주세요.');
  if (signal?.aborted) return () => {};
  ensureStyles();
  const id = `mail-workbook-${++nextInstance}`, root = element('section', 'mail-workbook');
  root.setAttribute('aria-label', 'Excel 읽기 전용 셀 미리보기');
  const heading = element('h4', 'mail-workbook-title', 'Excel 셀 미리보기 · 원본 파일과 서식이 다를 수 있음');
  const originalNote = element('p', 'mail-workbook-note', '읽기 전용입니다. 긴 글은 오른쪽 빈 셀 위로 이어 표시합니다. ‘…’ 표시가 있으면 셀을 눌러 원문 전체를 확인하세요. 수식은 저장된 계산값을 표시하며 매크로·외부 링크는 실행하지 않습니다.');
  const status = element('p', 'mail-workbook-status', 'Excel 원본의 셀을 읽고 있습니다…'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const notices = element('div', 'mail-workbook-notices'), controls = element('div', 'mail-workbook-controls');
  const sheetLabel = element('label', 'mail-workbook-field', '시트 선택'); sheetLabel.htmlFor = `${id}-sheet`;
  const sheetPicker = element('select', 'mail-workbook-select'); sheetPicker.id = sheetLabel.htmlFor; sheetPicker.disabled = true; sheetLabel.append(sheetPicker);
  const nav = element('div', 'mail-workbook-nav'), columnNav = element('div', 'mail-workbook-nav');
  const pageLabel = element('span', 'mail-workbook-page'), columnLabel = element('span', 'mail-workbook-page');
  const region = element('div', 'mail-workbook-grid-region'); region.tabIndex = 0; region.setAttribute('aria-label', 'Excel 셀 표. 가로와 세로로 스크롤할 수 있습니다.');
  const detail = element('p', 'mail-workbook-cell-detail', '셀을 누르면 주소와 수식·표시 형식을 확인할 수 있습니다.'); detail.setAttribute('role', 'status');
  root.append(heading, originalNote, notices, controls, status, region, detail); controls.append(sheetLabel, nav, columnNav); mount.replaceChildren(root);
  let disposed = false, worker, layoutFrame = 0, requestId = 0, pageRevision = 0, sheetIndex = 0, rowPage = 0, columnPage = 0, currentPage, metadata;
  const pending = new Map();
  function cleanup() {
    if (disposed) return; disposed = true; worker?.terminate();
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    signal?.removeEventListener('abort', cleanup);
    for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(new Error('Excel 미리보기가 닫혔습니다.')); }
    pending.clear();
    if (root.parentNode === mount) mount.replaceChildren();
  }
  signal?.addEventListener('abort', cleanup, { once: true });
  const request = (type, fields = {}, transfer = []) => new Promise((resolve, reject) => {
    if (disposed) { reject(new Error('Excel 미리보기가 닫혔습니다.')); return; }
    const messageId = ++requestId;
    const timeout = setTimeout(() => {
      const error = new Error('Excel 읽기 시간이 초과되었습니다. 원본을 내려받아 확인해 주세요.');
      worker.terminate();
      for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(error); }
      pending.clear();
    }, type === 'open' ? 15000 : 8000);
    pending.set(messageId, { resolve, reject, timeout });
    try { worker.postMessage({ id: messageId, type, ...fields }, transfer); }
    catch (error) { clearTimeout(timeout); pending.delete(messageId); reject(error); }
  });
  function warn(text) { notices.append(element('p', 'mail-workbook-warning', text)); }
  function showCell(cell, merge) {
    const sections = [`${cell.address}${merge ? ` · 병합 ${merge.address}${merge.clipped ? ' (현재 구간에 나눠 표시)' : ''}` : ''}`, `표시값: ${cell.text || '(빈 셀)'}`];
    if (cell.formula) sections.push(`수식: =${cell.formula}`, cell.cached ? '파일에 저장된 계산값 · 최신 여부는 원본에서 확인' : '저장된 계산값 없음 · 수량으로 사용하지 마세요');
    if (cell.format) sections.push(`표시 형식: ${cell.format}`);
    if (cell.link) sections.push('원본에 링크가 있으나 연결하지 않습니다.');
    detail.textContent = sections.join(' / ');
  }
  function setBusy(busy) {
    root.setAttribute('aria-busy', String(busy));
    sheetPicker.disabled = busy;
    for (const item of nav.querySelectorAll('button')) item.disabled = busy;
    for (const item of columnNav.querySelectorAll('button')) item.disabled = busy;
  }
  function fillTable(page) {
    const table = element('table', 'mail-workbook-grid');
    table.style.width = `${48 + page.columns.reduce((sum, col) => sum + col.width, 0)}px`;
    const colgroup = element('colgroup'), rowNumberCol = element('col'); rowNumberCol.style.width = '48px'; colgroup.append(rowNumberCol);
    for (const column of page.columns) { const col = element('col'); col.style.width = `${column.width}px`; colgroup.append(col); }
    const caption = element('caption', 'mail-workbook-caption', `${page.info.name} · 원본 행·열 번호 기준`); table.append(caption);
    table.append(colgroup);
    const head = element('thead'), header = element('tr'), corner = element('th', 'mail-workbook-corner', '행'); corner.scope = 'col'; header.append(corner);
    for (const col of page.columns) {
      const th = element('th', col.hidden ? 'mail-workbook-hidden-source' : '', `${col.label}${col.hidden ? ' · 원본 숨김' : ''}`);
      th.scope = 'col'; header.append(th);
    }
    head.append(header); table.append(head);
    const body = element('tbody'), layoutCells = [];
    for (const row of page.rows) {
      const tr = element('tr'); tr.style.height = `${row.height}px`; if (row.hidden) tr.classList.add('mail-workbook-hidden-source');
      const label = element('th', 'mail-workbook-row-number', `${row.label}${row.hidden ? ' · 숨김' : ''}`); label.scope = 'row'; tr.append(label);
      for (let i = 0; i < row.cells.length; i++) {
        const col = page.columns[i], merge = page.merges.find(m => row.index >= m.startRow && row.index <= m.endRow && col.index >= m.startColumn && col.index <= m.endColumn);
        if (merge && (row.index !== merge.startRow || col.index !== merge.startColumn)) continue;
        const cell = merge ? merge.cell : row.cells[i], td = element('td');
        td.dataset.cell = cell.address;
        if (merge) { td.rowSpan = merge.endRow - merge.startRow + 1; td.colSpan = merge.endColumn - merge.startColumn + 1; td.dataset.merge = merge.address; }
        if (cell.numeric) td.classList.add('mail-workbook-numeric');
        if (col.hidden) td.classList.add('mail-workbook-hidden-source');
        if (cell.fill) { td.style.backgroundColor = cell.fill; td.style.color = '#111827'; }
        const content = element('div', 'mail-workbook-cell-content');
        const value = element('span', 'mail-workbook-cell-value', cell.text); content.append(value); td.append(content);
        if (cell.wrap) value.classList.add('mail-workbook-wrap');
        else {
          const visualWidth = merge ? page.columns.filter(column => column.index >= merge.startColumn && column.index <= merge.endColumn).reduce((sum, column) => sum + column.width, 0)
            : cell.displayWidth || col.width;
          value.style.width = `${Math.max(8, visualWidth - 16)}px`;
          layoutCells.push({ value, td, content });
        }
        if (cell.formula) td.append(element('span', cell.cached ? 'mail-workbook-formula' : 'mail-workbook-formula mail-workbook-missing-cache', cell.cached ? '수식 저장값' : '계산값 없음'));
        if (merge?.clipped) td.append(element('span', 'mail-workbook-formula', '병합 구간 이어짐'));
        const cellText = `${cell.address}${merge ? ` · 병합 ${merge.address}` : ''}: ${cell.text || '(빈 셀)'}${cell.formula ? ' · 수식 저장값' : ''}`;
        td.title = cellText; td.tabIndex = 0; td.setAttribute('aria-label', cellText);
        td.addEventListener('click', () => showCell(cell, merge));
        td.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showCell(cell, merge); } });
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(body); region.replaceChildren(table); region.scrollTop = 0; region.scrollLeft = 0;
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0; if (disposed || !table.isConnected) return;
      for (const { value, td } of layoutCells) {
        if (value.scrollWidth <= value.clientWidth + 1) continue;
        td.dataset.clipped = 'true';
        td.append(element('span', 'mail-workbook-clipped-note', '… 전체 내용'));
      }
    });
  }
  async function loadPage() {
    const revision = ++pageRevision;
    setBusy(true); status.textContent = '선택한 셀 구간을 읽고 있습니다…';
    try {
      const page = await request('page', { sheetIndex, page: rowPage, columnPage });
      if (disposed || revision !== pageRevision) return;
      currentPage = page; rowPage = page.page; columnPage = page.columnPage;
      if (page.info.range) {
        fillTable(page);
        status.textContent = `전체 ${page.info.rows.toLocaleString('ko-KR')}행 × ${page.info.columns.toLocaleString('ko-KR')}열 중 원본 ${page.startRow + 1}–${page.endRow + 1}행 · ${page.columns[0].label}–${page.columns.at(-1).label}열 표시. 나머지는 행·열 구간을 이동해 확인하세요.`;
      } else { region.replaceChildren(element('p', 'mail-workbook-note', '이 시트에는 표시할 셀이 없습니다.')); status.textContent = '빈 시트입니다.'; }
      pageLabel.textContent = `행 ${page.page + 1} / ${page.pageCount}`; columnLabel.textContent = `열 ${page.columnPage + 1} / ${page.columnPageCount}`;
      detail.textContent = '셀을 누르면 주소와 수식·표시 형식을 확인할 수 있습니다.';
      setBusy(false); previous.disabled = page.page === 0; next.disabled = page.page + 1 >= page.pageCount;
      previousColumns.disabled = page.columnPage === 0; nextColumns.disabled = page.columnPage + 1 >= page.columnPageCount;
      columnNav.hidden = page.columnPageCount <= 1;
    } catch (error) {
      if (disposed || revision !== pageRevision) return;
      status.textContent = error.message; status.dataset.error = 'true'; region.replaceChildren(); setBusy(true);
    }
  }
  const previous = button('이전 행', () => { rowPage--; void loadPage(); });
  const next = button('다음 행', () => { rowPage++; void loadPage(); });
  const previousColumns = button('이전 열', () => { columnPage--; void loadPage(); });
  const nextColumns = button('다음 열', () => { columnPage++; void loadPage(); });
  nav.append(previous, pageLabel, next); columnNav.append(previousColumns, columnLabel, nextColumns);
  sheetPicker.addEventListener('change', () => { sheetIndex = Number(sheetPicker.value); rowPage = 0; columnPage = 0; void loadPage(); });
  try {
    worker = new Worker(WORKER_URL, { name: 'mail-excel-readonly' });
    worker.onmessage = event => {
      const item = pending.get(event.data?.id); if (!item) return;
      clearTimeout(item.timeout); pending.delete(event.data.id);
      if (event.data.error) item.reject(new Error(event.data.error)); else item.resolve(event.data.result);
    };
    worker.onerror = () => {
      for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(new Error('Excel 미리보기를 시작할 수 없습니다. 원본을 내려받아 확인해 주세요.')); }
      pending.clear(); worker.terminate();
    };
    // Transfer a copy. The authenticated archived original and caller's byte array remain intact.
    const copy = bytes.slice();
    metadata = await request('open', { bytes: copy, fileName }, [copy.buffer]);
    if (disposed) return cleanup;
    if (metadata.format.warning) warn(metadata.format.warning);
    const hidden = metadata.sheets.filter(sheet => sheet.hidden);
    if (hidden.length) warn(`원본에 숨김 시트 ${hidden.length}개가 있습니다. 시트 선택 목록에서 열어 확인할 수 있습니다.`);
    const hiddenRows = metadata.sheets.reduce((sum, sheet) => sum + sheet.hiddenRows, 0), hiddenCols = metadata.sheets.reduce((sum, sheet) => sum + sheet.hiddenColumns, 0);
    if (hiddenRows || hiddenCols) warn(`원본 숨김 행 ${hiddenRows}개 · 숨김 열 ${hiddenCols}개도 미리보기에 표시하고 ‘원본 숨김’으로 구분합니다.`);
    if (metadata.formulaCount) warn(`수식 셀 ${metadata.formulaCount}개: 저장된 계산값은 오래되었을 수 있습니다. 계산값이 없는 셀은 수량으로 확정하지 마세요.`);
    if (metadata.hasMacros) warn('원본에 매크로가 포함되어 있습니다. 미리보기에서는 실행하지 않습니다.');
    if (metadata.linkCount) warn(`원본에 링크 ${metadata.linkCount}개가 있습니다. 미리보기에서는 열지 않습니다.`);
    for (const sheet of metadata.sheets) {
      const option = element('option', '', `${sheet.name}${sheet.hidden ? sheet.hidden === 2 ? ' · 매우 숨김' : ' · 숨김' : ''}`);
      option.value = String(sheet.index); sheetPicker.append(option);
    }
    sheetIndex = metadata.sheets.find(sheet => !sheet.hidden)?.index ?? 0; sheetPicker.value = String(sheetIndex);
    await loadPage();
    return cleanup;
  } catch (error) {
    worker?.terminate();
    if (!disposed) { status.textContent = String(error.message || error); status.dataset.error = 'true'; region.replaceChildren(); setBusy(true); }
    return cleanup;
  }
}
