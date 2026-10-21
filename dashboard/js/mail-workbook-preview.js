/* Read-only, bounded cell preview. Archived original bytes are never changed. */
import { cellAddress, parseCellAddress, intersects, selectWorkbookRange, selectionFromCorners, selectionSnapshot, workbookEvidence, evidencePage, evidenceCellState } from './mail-workbook-selection.js';
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

export async function renderMailWorkbook({ mount, bytes, fileName = '', signal, onSelectionChange, initialSelection = null, selectionEnabled = false }) {
  if (!mount || typeof mount.replaceChildren !== 'function') throw new Error('Excel을 표시할 위치를 찾을 수 없습니다.');
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_BYTES) throw new Error('이 파일은 미리보기로 열 수 없습니다. 원본을 내려받아 확인해 주세요.');
  if (signal?.aborted) return () => {};
  ensureStyles();
  const id = `mail-workbook-${++nextInstance}`, root = element('section', 'mail-workbook');
  root.setAttribute('aria-label', 'Excel 읽기 전용 셀 미리보기');
  const status = element('p', 'mail-workbook-status', 'Excel을 여는 중…'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const notices = element('div', 'mail-workbook-notices'), controls = element('div', 'mail-workbook-controls');
  const sheetLabel = element('label', 'mail-workbook-field', '시트 선택'); sheetLabel.htmlFor = `${id}-sheet`;
  const sheetPicker = element('select', 'mail-workbook-select'); sheetPicker.id = sheetLabel.htmlFor; sheetPicker.disabled = true; sheetLabel.append(sheetPicker);
  const nav = element('div', 'mail-workbook-nav'), columnNav = element('div', 'mail-workbook-nav'); nav.hidden = true; columnNav.hidden = true;
  const pageLabel = element('span', 'mail-workbook-page'), columnLabel = element('span', 'mail-workbook-page');
  const region = element('div', 'mail-workbook-grid-region'); region.tabIndex = 0; region.setAttribute('aria-label', 'Excel 셀 표. 가로와 세로로 스크롤할 수 있습니다.');
  const detail = element('p', 'mail-workbook-cell-detail'); detail.setAttribute('role', 'status');
  const evidenceStatus = element('p', 'mail-workbook-evidence-status'); evidenceStatus.setAttribute('role', 'status'); evidenceStatus.setAttribute('aria-live', 'polite');
  const selectionControls = element('div', 'mail-workbook-selection-controls');
  selectionControls.hidden = !(typeof onSelectionChange === 'function' || initialSelection || selectionEnabled);
  const startLabel = element('label', 'mail-workbook-field', '시작 셀'), endLabel = element('label', 'mail-workbook-field', '끝 셀');
  const startInput = element('input', 'mail-workbook-address'), endInput = element('input', 'mail-workbook-address');
  startInput.id = `${id}-start`; endInput.id = `${id}-end`; startLabel.htmlFor = startInput.id; endLabel.htmlFor = endInput.id;
  startInput.placeholder = 'A4'; endInput.placeholder = 'I5';
  for (const input of [startInput, endInput]) { input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = 12; }
  startLabel.append(startInput); endLabel.append(endInput);
  const selectionSummary = element('p', 'mail-workbook-selection-summary'); selectionSummary.setAttribute('role', 'status'); selectionSummary.setAttribute('aria-live', 'polite');
  const selectionError = element('p', 'mail-workbook-selection-error'); selectionError.setAttribute('role', 'alert');
  const selectRange = button('범위 표시', () => selectAddresses()), clearRange = button('선택 해제', () => { if (canSelect()) commitSelection(null); });
  selectionControls.append(startLabel, endLabel, selectRange, clearRange, selectionSummary, selectionError);
  root.append(notices, controls, selectionControls, evidenceStatus, status, region, detail); controls.append(sheetLabel, nav, columnNav); mount.replaceChildren(root);
  let disposed = false, worker, layoutFrame = 0, requestId = 0, pageRevision = 0, sheetIndex = 0, rowPage = 0, columnPage = 0, currentPage, metadata;
  let selected = null, enabled = Boolean(selectionEnabled), busy = true, selectionRevision = 0, drag = null, touchAnchor = null, keyboardAnchor = null, keyboardFocus = null;
  let evidence = null, evidenceRevision = 0;
  const selectionInfos = new Map();
  const pending = new Map();
  function cleanup() {
    if (disposed) return; cancelDrag(); disposed = true; ++evidenceRevision; evidence = null; worker?.terminate();
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    signal?.removeEventListener('abort', cleanup);
    for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(new Error('Excel 미리보기가 닫혔습니다.')); }
    pending.clear();
    document.removeEventListener('pointermove', pointerMove, true); document.removeEventListener('pointerup', pointerUp, true);
    document.removeEventListener('pointercancel', pointerCancel, true); window.removeEventListener('blur', pointerCancel);
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
    // Loading a different page never changes the accepted original-coordinate selection.
    setSelectionBusy(busy);
    root.setAttribute('aria-busy', String(busy));
    sheetPicker.disabled = busy;
    for (const item of nav.querySelectorAll('button')) item.disabled = busy;
    for (const item of columnNav.querySelectorAll('button')) item.disabled = busy;
  }
  function canSelect() { return enabled && !busy && !disposed && Boolean(selectionInfos.get(sheetIndex)) && Boolean(currentPage?.info.range); }
  function setSelectionBusy(value) { busy = value; updateSelectionControls(); }
  function updateSelectionControls() {
    const disabled = !canSelect();
    root.classList.toggle('mail-workbook-selecting', !disabled);
    for (const input of [startInput, endInput, selectRange, clearRange]) input.disabled = disabled;
    clearRange.disabled = disabled || !selected;
  }
  function paintSelection() {
    for (const td of region.querySelectorAll('td[data-source-row]')) {
      const cellBounds = { startRow: Number(td.dataset.sourceRow), endRow: Number(td.dataset.sourceEndRow), startColumn: Number(td.dataset.sourceColumn), endColumn: Number(td.dataset.sourceEndColumn) };
      const active = selected?.sheetIndex === sheetIndex && intersects(selected, cellBounds);
      td.classList.toggle('mail-workbook-selected-cell', Boolean(active)); td.setAttribute('aria-selected', String(Boolean(active)));
    }
    if (selected) {
      startInput.value = cellAddress(selected.startRow, selected.startColumn); endInput.value = cellAddress(selected.endRow, selected.endColumn);
      const warnings = [];
      if (selected.hiddenRows.length) warnings.push(`숨김 행 ${selected.hiddenRows.length}개 포함`);
      if (selected.hiddenColumns.length) warnings.push(`숨김 열 ${selected.hiddenColumns.length}개 포함`);
      if (selected.formulaCells.length) warnings.push(`수식 ${selected.formulaCells.length}개${selected.hasUncachedFormulas ? ' · 계산값 없는 셀 포함' : ''}`);
      selectionSummary.textContent = `${selected.range} · ${selected.selectedRows.length}행${warnings.length ? ` · ${warnings.join(' · ')}` : ''}`;
    } else { startInput.value = ''; endInput.value = ''; selectionSummary.textContent = ''; }
    updateSelectionControls();
  }
  function paintEvidence() {
    const active = evidence?.sheetIndex === sheetIndex ? evidence : null;
    for (const td of region.querySelectorAll('td[data-source-row]')) {
      const state = evidenceCellState(active, {
        startRow: Number(td.dataset.mergeStartRow ?? td.dataset.sourceRow), endRow: Number(td.dataset.sourceEndRow),
        startColumn: Number(td.dataset.mergeStartColumn ?? td.dataset.sourceColumn), endColumn: Number(td.dataset.sourceEndColumn),
      });
      td.classList.toggle('mail-workbook-evidence-row', state.row);
      td.classList.toggle('mail-workbook-evidence-quantity', state.quantity);
      const label = td.dataset.originalLabel;
      if (label) td.setAttribute('aria-label', `${label}${state.quantity ? ' · 확인할 수량 셀' : state.row ? ' · 분석 근거 행' : ''}`);
    }
    for (const tr of region.querySelectorAll('tr[data-source-row]')) tr.classList.toggle('mail-workbook-evidence-row', Boolean(active?.rowIndexes.includes(Number(tr.dataset.sourceRow))));
    evidenceStatus.textContent = active ? `${active.sheetName} · ${active.rowIndexes.slice(0, 8).map(row => row + 1).join(', ')}행${active.rowIndexes.length > 8 ? ` 외 ${active.rowIndexes.length - 8}행` : ''}${active.quantityCells.length ? ` · 수량 ${active.quantityCells.slice(0, 8).map(cell => cell.address).join(', ')}${active.quantityCells.length > 8 ? '…' : ''}` : ''}` : '';
  }
  function clearEvidence() { ++evidenceRevision; evidence = null; paintEvidence(); }
  function selectionEqual(a, b) { return a === b || (Boolean(a) && Boolean(b) && a.sheetIndex === b.sheetIndex && a.range === b.range); }
  function commitSelection(value, previous = selected) {
    clearEvidence();
    ++selectionRevision;
    if (!value) { keyboardAnchor = null; keyboardFocus = null; touchAnchor = null; }
    selected = value; selectionError.textContent = ''; paintSelection();
    if (!selectionEqual(previous, value)) onSelectionChange?.(selectionSnapshot(value));
  }
  async function getSelectionInfo(index) {
    if (!selectionInfos.has(index)) {
      const result = await request('selectionInfo', { sheetIndex: index });
      if (result.sheetIndex !== index) throw new Error('선택할 시트를 확인할 수 없습니다.');
      selectionInfos.set(index, result);
    }
    return selectionInfos.get(index);
  }
  function selectAddresses() {
    if (!canSelect()) return;
    cancelDrag(); touchAnchor = null;
    try {
      const anchor = parseCellAddress(startInput.value), focus = parseCellAddress(endInput.value || startInput.value);
      const value = selectionFromCorners(anchor, focus, metadata.sheets[sheetIndex], selectionInfos.get(sheetIndex));
      keyboardAnchor = anchor; keyboardFocus = focus; commitSelection(value);
    } catch (error) {
      const inputs = [startInput.value, endInput.value]; commitSelection(null); [startInput.value, endInput.value] = inputs;
      selectionError.textContent = error.message;
    }
  }
  for (const input of [startInput, endInput]) {
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); selectAddresses(); } });
    input.addEventListener('input', () => {
      if (!canSelect()) return;
      const values = [startInput.value, endInput.value]; commitSelection(null); [startInput.value, endInput.value] = values;
    });
  }
  function cellNode(node) {
    const td = node?.closest?.('td[data-source-row]');
    return td && region.contains(td) ? td : null;
  }
  const cellPoint = td => ({ row: Number(td.dataset.sourceRow), column: Number(td.dataset.sourceColumn) });
  function pointerDown(event) {
    const td = cellNode(event.target);
    if (!td || !canSelect() || event.button !== 0) return;
    cancelDrag(); clearEvidence();
    const point = cellPoint(td), anchor = event.shiftKey && keyboardAnchor ? keyboardAnchor : point;
    drag = { pointerId: event.pointerId, pointerType: event.pointerType, anchor, focus: point, before: selected, moved: false };
    selected = selectionFromCorners(anchor, point, metadata.sheets[sheetIndex], { merges: selectionInfos.get(sheetIndex).merges });
    paintSelection();
    if (event.pointerType !== 'touch') event.preventDefault();
    try { region.setPointerCapture(event.pointerId); } catch (_) { /* Document listeners also finish pointers released outside the table. */ }
  }
  function pointerMove(event) {
    if (!drag || drag.pointerId !== event.pointerId || !canSelect()) return;
    const td = cellNode(document.elementFromPoint(event.clientX, event.clientY)) || cellNode(event.target);
    if (!td) return;
    const point = cellPoint(td);
    if (point.row === drag.focus.row && point.column === drag.focus.column) return;
    drag.focus = point; drag.moved = true;
    selected = selectionFromCorners(drag.anchor, point, metadata.sheets[sheetIndex], { merges: selectionInfos.get(sheetIndex).merges }); paintSelection();
  }
  function releasePointer(pointerId) { try { if (region.hasPointerCapture(pointerId)) region.releasePointerCapture(pointerId); } catch (_) {} }
  function pointerUp(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    pointerMove(event);
    const finished = drag; drag = null; releasePointer(finished.pointerId);
    if (!canSelect()) { selected = finished.before; paintSelection(); return; }
    let anchor = finished.anchor;
    if (finished.pointerType === 'touch' && !finished.moved) {
      if (touchAnchor) { anchor = touchAnchor; touchAnchor = null; } else touchAnchor = finished.focus;
    } else touchAnchor = null;
    const value = selectionFromCorners(anchor, finished.focus, metadata.sheets[sheetIndex], selectionInfos.get(sheetIndex));
    keyboardAnchor = anchor; keyboardFocus = finished.focus; commitSelection(value, finished.before);
  }
  function cancelDrag() {
    if (!drag) return;
    const cancelled = drag; drag = null; releasePointer(cancelled.pointerId); selected = cancelled.before; paintSelection();
  }
  function pointerCancel() { cancelDrag(); touchAnchor = null; }
  function selectionKey(event, td) {
    if (!canSelect()) return;
    if (event.key === 'Escape') { event.preventDefault(); cancelDrag(); touchAnchor = null; commitSelection(null); return; }
    const movements = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (!event.shiftKey || !movements[event.key]) return;
    event.preventDefault(); cancelDrag(); touchAnchor = null;
    const point = cellPoint(td), anchor = keyboardAnchor || point, focus = keyboardFocus || point, [dr, dc] = movements[event.key];
    const info = metadata.sheets[sheetIndex], next = { row: focus.row + dr, column: focus.column + dc };
    if (next.row < info.range.s.r || next.row > info.range.e.r || next.column < info.range.s.c || next.column > info.range.e.c) return;
    keyboardAnchor = anchor; keyboardFocus = next;
    commitSelection(selectionFromCorners(anchor, next, info, selectionInfos.get(sheetIndex)));
  }
  region.addEventListener('pointerdown', pointerDown);
  document.addEventListener('pointermove', pointerMove, true); document.addEventListener('pointerup', pointerUp, true);
  document.addEventListener('pointercancel', pointerCancel, true); window.addEventListener('blur', pointerCancel);
  cleanup.getSelection = () => selectionSnapshot(selected);
  cleanup.getMetadata = () => selectionSnapshot(metadata || null);
  cleanup.getEvidence = () => selectionSnapshot(disposed ? null : evidence);
  cleanup.focusEvidence = async value => {
    if (disposed) return null;
    clearEvidence();
    if (value == null) return null;
    const canonical = workbookEvidence(value, metadata), target = evidencePage(canonical, metadata), revision = evidenceRevision;
    cancelDrag(); touchAnchor = null;
    evidence = canonical; sheetIndex = target.sheetIndex; sheetPicker.value = String(sheetIndex);
    rowPage = target.rowPage; columnPage = target.columnPage;
    const loaded = await loadPage();
    if (disposed || revision !== evidenceRevision) return null;
    if (!loaded || !currentPage || currentPage.info?.index !== sheetIndex) { clearEvidence(); return null; }
    paintEvidence();
    const focus = region.querySelector('td.mail-workbook-evidence-quantity') || region.querySelector('td.mail-workbook-evidence-row');
    focus?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    return selectionSnapshot(evidence);
  };
  cleanup.setHighlightedRows = (rows, options = {}) => cleanup.focusEvidence(rows == null ? null : { sheetIndex: options.sheetIndex ?? sheetIndex, rowIndexes: rows, quantityCells: options.quantityCells ?? [],
    ...(options.columnIndex === undefined ? {} : { columnIndex: options.columnIndex }) });
  cleanup.setSelectionEnabled = value => {
    cancelDrag(); enabled = Boolean(value); touchAnchor = null;
    if (enabled) {
      selectionControls.hidden = false;
      if (metadata && !selectionInfos.has(sheetIndex)) void getSelectionInfo(sheetIndex).then(() => { if (!disposed) updateSelectionControls(); }).catch(error => { if (!disposed) selectionError.textContent = error.message; });
    }
    updateSelectionControls();
  };
  cleanup.setSelection = async value => {
    clearEvidence();
    const revision = ++selectionRevision; cancelDrag(); touchAnchor = null; keyboardAnchor = null; keyboardFocus = null;
    if (value == null) { selected = null; paintSelection(); return null; }
    const index = value.sheetIndex ?? sheetIndex, info = metadata?.sheets[index];
    if (!info) throw new Error('선택할 시트를 찾을 수 없습니다.');
    const extra = await getSelectionInfo(index);
    if (disposed || revision !== selectionRevision) return null;
    const restored = selectWorkbookRange(value, info, extra);
    if (typeof value === 'object' && value.range !== restored.range) throw new Error('저장된 범위와 원본 셀 주소가 일치하지 않습니다. 범위를 다시 선택해 주세요.');
    selected = restored; keyboardAnchor = { row: restored.startRow, column: restored.startColumn }; keyboardFocus = { row: restored.endRow, column: restored.endColumn };
    sheetIndex = index; sheetPicker.value = String(index);
    rowPage = Math.floor((restored.startRow - info.range.s.r) / 100); columnPage = Math.floor((restored.startColumn - info.range.s.c) / 20);
    await loadPage();
    if (disposed || revision !== selectionRevision) return null;
    paintSelection(); return selectionSnapshot(selected);
  };
  function fillTable(page) {
    const table = element('table', 'mail-workbook-grid');
    table.setAttribute('role', 'grid');
    table.style.width = `${48 + page.columns.reduce((sum, col) => sum + col.width, 0)}px`;
    const colgroup = element('colgroup'), rowNumberCol = element('col'); rowNumberCol.style.width = '48px'; colgroup.append(rowNumberCol);
    for (const column of page.columns) { const col = element('col'); col.style.width = `${column.width}px`; colgroup.append(col); }
    const caption = element('caption', 'mail-workbook-caption', page.info.name); table.append(caption);
    table.append(colgroup);
    const head = element('thead'), header = element('tr'), corner = element('th', 'mail-workbook-corner', '행'); corner.scope = 'col'; header.append(corner);
    for (const col of page.columns) {
      const th = element('th', col.hidden ? 'mail-workbook-hidden-source' : '', `${col.label}${col.hidden ? ' · 원본 숨김' : ''}`);
      th.scope = 'col'; header.append(th);
    }
    head.append(header); table.append(head);
    const body = element('tbody'), layoutCells = [];
    for (const row of page.rows) {
      const tr = element('tr'); tr.dataset.sourceRow = String(row.index); tr.style.height = `${row.height}px`; if (row.hidden) tr.classList.add('mail-workbook-hidden-source');
      const label = element('th', 'mail-workbook-row-number', `${row.label}${row.hidden ? ' · 숨김' : ''}`); label.scope = 'row'; tr.append(label);
      for (let i = 0; i < row.cells.length; i++) {
        const col = page.columns[i], merge = page.merges.find(m => row.index >= m.startRow && row.index <= m.endRow && col.index >= m.startColumn && col.index <= m.endColumn);
        if (merge && (row.index !== merge.startRow || col.index !== merge.startColumn)) continue;
        const cell = merge ? merge.cell : row.cells[i], td = element('td');
        td.dataset.cell = cell.address;
        const mergeStart = merge ? parseCellAddress(merge.address.split(':')[0]) : null;
        const mergeEnd = merge ? parseCellAddress(merge.address.split(':')[1] || merge.address) : null;
        // Use original coordinates, including the full uncut merge across pages.
        td.dataset.sourceRow = String(row.index); td.dataset.sourceColumn = String(col.index);
        td.dataset.sourceEndRow = String(mergeEnd?.row ?? row.index); td.dataset.sourceEndColumn = String(mergeEnd?.column ?? col.index);
        if (mergeStart) { td.dataset.mergeStartRow = String(mergeStart.row); td.dataset.mergeStartColumn = String(mergeStart.column); }
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
        td.dataset.originalLabel = cellText;
        td.title = cellText; td.tabIndex = 0; td.setAttribute('aria-label', cellText); td.setAttribute('role', 'gridcell');
        td.addEventListener('click', () => showCell(cell, merge));
        td.addEventListener('focus', () => { if (canSelect()) { keyboardAnchor = cellPoint(td); keyboardFocus = cellPoint(td); } });
        td.addEventListener('keydown', event => {
          selectionKey(event, td);
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showCell(cell, merge); }
        });
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(body); region.replaceChildren(table); region.scrollTop = 0; region.scrollLeft = 0; paintSelection(); paintEvidence();
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
    cancelDrag();
    const revision = ++pageRevision;
    setBusy(true); status.textContent = 'Excel을 여는 중…';
    try {
      if (!selectionControls.hidden || selected) await getSelectionInfo(sheetIndex);
      if (disposed || revision !== pageRevision) return false;
      const page = await request('page', { sheetIndex, page: rowPage, columnPage });
      if (disposed || revision !== pageRevision) return false;
      currentPage = page; rowPage = page.page; columnPage = page.columnPage;
      delete status.dataset.error;
      if (page.info.range) {
        fillTable(page);
        const partial = page.pageCount > 1 || page.columnPageCount > 1;
        status.textContent = `${page.startRow + 1}–${page.endRow + 1}행 · ${page.columns[0].label}–${page.columns.at(-1).label}열${partial ? ` · 전체 ${page.info.rows.toLocaleString('ko-KR')}행·${page.info.columns.toLocaleString('ko-KR')}열` : ''}`;
      } else { region.replaceChildren(element('p', 'mail-workbook-note', '이 시트에는 표시할 셀이 없습니다.')); status.textContent = '빈 시트입니다.'; }
      pageLabel.textContent = `행 ${page.page + 1} / ${page.pageCount}`; columnLabel.textContent = `열 ${page.columnPage + 1} / ${page.columnPageCount}`;
      detail.textContent = '';
      setBusy(false); previous.disabled = page.page === 0; next.disabled = page.page + 1 >= page.pageCount;
      previousColumns.disabled = page.columnPage === 0; nextColumns.disabled = page.columnPage + 1 >= page.columnPageCount;
      nav.hidden = page.pageCount <= 1; columnNav.hidden = page.columnPageCount <= 1;
      return true;
    } catch (error) {
      if (disposed || revision !== pageRevision) return false;
      status.textContent = error.message; status.dataset.error = 'true'; region.replaceChildren(); setBusy(true);
      return false;
    }
  }
  const previous = button('이전 행', () => { rowPage--; void loadPage(); });
  const next = button('다음 행', () => { rowPage++; void loadPage(); });
  const previousColumns = button('이전 열', () => { columnPage--; void loadPage(); });
  const nextColumns = button('다음 열', () => { columnPage++; void loadPage(); });
  nav.append(previous, pageLabel, next); columnNav.append(previousColumns, columnLabel, nextColumns);
  sheetPicker.addEventListener('change', () => {
    clearEvidence();
    ++selectionRevision; cancelDrag(); touchAnchor = null; keyboardAnchor = null; keyboardFocus = null;
    commitSelection(null); sheetIndex = Number(sheetPicker.value); rowPage = 0; columnPage = 0; void loadPage();
  });
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
    const hidden = metadata.sheets.filter(sheet => sheet.hidden);
    if (hidden.length) warn(`숨김 시트 ${hidden.length}개 · 시트 목록에서 확인`);
    const hiddenRows = metadata.sheets.reduce((sum, sheet) => sum + sheet.hiddenRows, 0), hiddenCols = metadata.sheets.reduce((sum, sheet) => sum + sheet.hiddenColumns, 0);
    if (hiddenRows || hiddenCols) warn(`숨김 행 ${hiddenRows}개 · 숨김 열 ${hiddenCols}개 포함`);
    if (metadata.formulaCount) warn(`수식 ${metadata.formulaCount}개 · 계산값이 최신인지 확인해 주세요.`);
    for (const sheet of metadata.sheets) {
      const option = element('option', '', `${sheet.name}${sheet.hidden ? sheet.hidden === 2 ? ' · 매우 숨김' : ' · 숨김' : ''}`);
      option.value = String(sheet.index); sheetPicker.append(option);
    }
    sheetIndex = metadata.sheets.find(sheet => !sheet.hidden)?.index ?? 0; sheetPicker.value = String(sheetIndex);
    if (initialSelection) await cleanup.setSelection(initialSelection); else await loadPage();
    return cleanup;
  } catch (error) {
    worker?.terminate();
    if (!disposed) { status.textContent = String(error.message || error); status.dataset.error = 'true'; region.replaceChildren(); setBusy(true); }
    return cleanup;
  }
}
