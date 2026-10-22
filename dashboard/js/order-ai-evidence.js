import { renderMailWorkbook } from './mail-workbook-preview.js';
import { parseCellAddress } from './mail-workbook-selection.js';
import { createOrderAiTextSource, getOrderAiTextRows, validOrderAiTextRange } from './order-text-source-model.js';
import { normalizeOrderAiQuantity } from './order-ai-model.js';

function el(tag, text, cls) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; }
function button(text, action, cls = '') { const node = el('button', text, `order-button ${cls}`); node.type = 'button'; node.addEventListener('click', action); return node; }
const fileId = source => String(source.attachmentId);

/** Opens archived bytes and their source positions. A review is valid only for the supplied analysis. */
export function initOrderAiEvidence(session) {
  const dialog = el('dialog', null, 'order-dialog order-ai-evidence-dialog'); dialog.setAttribute('aria-label', '발주 원본 대조');
  const panel = el('section', null, 'order-ai-evidence-panel'); panel.setAttribute('aria-label', '원본 대조');
  const header = el('div', null, 'order-dialog-header'), heading = el('h2', '원본 대조'), close = button('닫기', () => finish(false)); header.append(heading, close);
  const navigation = el('div', null, 'order-ai-evidence-navigation'), pageTitle = el('p', '', 'order-ai-note');
  const body = el('div', null, 'order-ai-evidence-body'), sourceMount = el('div', null, 'order-ai-evidence-source'), summary = el('aside', null, 'order-ai-evidence-summary'); body.append(sourceMount, summary);
  const error = el('p', '', 'order-ai-feedback'); error.setAttribute('role', 'alert'); error.hidden = true;
  const complete = button('이 상품 원본 대조 완료', () => finish(true), 'order-primary'); complete.disabled = true;
  const footer = el('div', null, 'order-ai-evidence-footer'), progress = el('p', '', 'order-ai-note'); footer.append(progress, complete);
  panel.append(header, navigation, pageTitle, error, body, footer); dialog.append(panel); document.body.append(dialog);
  const cache = new Map(); let active = null, inlineMount = null, parts = [], visited = new Set(), current = 0, generation = 0, controller, workbook, blobUrl, resolve, disposed = false, viewReady = false;
  function cleanupView() { controller?.abort(); controller = null; workbook?.(); workbook = null; if (blobUrl) URL.revokeObjectURL(blobUrl); blobUrl = ''; }
  function liveMount() { return !inlineMount || inlineMount.isConnected !== false && panel.parentNode === inlineMount; }
  function finish(accepted) {
    const allowed = accepted && !active?.readOnly && liveMount() && viewReady && parts.length > 0 && visited.size === parts.length;
    const done = resolve; resolve = null;
    if (allowed && inlineMount) { active.readOnly = true; active.completed = true; complete.textContent = '대조 완료'; complete.disabled = true; done?.(true); return; }
    generation++; cleanupView(); if (dialog.open) dialog.close(); if (inlineMount && panel.parentNode === inlineMount) panel.remove(); inlineMount = null; active = null; viewReady = false; done?.(allowed);
  }
  function currentView(token, value) { if (disposed || token !== generation || active !== value) return false; if (!liveMount()) { finish(false); return false; } return true; }
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
  async function archive(mail, attachmentId, expectedHash, signal) {
    const key = `${mail.id}:${attachmentId}:${expectedHash || ''}`;
    if (cache.has(key)) return cache.get(key);
    const token = await session.user.getIdToken();
    const response = await fetch('/api/naverworks/attachment', { method: 'POST', cache: 'no-store', credentials: 'same-origin', signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ intakeId: mail.id, attachmentId }) });
    const data = await response.json().catch(() => ({})); if (!response.ok || !data.ok) throw new Error(data.message || '원본 파일을 열지 못했습니다.');
    const item = data.attachment;
    if (String(item?.id) !== attachmentId || !/^[a-f0-9]{64}$/.test(item?.sha256 || '') || (expectedHash && expectedHash !== item.sha256)
      || typeof item.contentBase64 !== 'string' || item.contentBase64.length > 4194310 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.contentBase64)) throw new Error('분석에 사용한 원본과 현재 파일이 다릅니다.');
    const binary = atob(item.contentBase64), bytes = Uint8Array.from(binary, value => value.charCodeAt(0));
    if (!bytes.length || bytes.length > 3 * 1024 * 1024 || bytes.length !== item.byteLength) throw new Error('원본 파일의 크기가 일치하지 않습니다.');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (digest !== item.sha256) throw new Error('원본 파일 확인에 실패했습니다.');
    const value = { ...item, bytes }; if (!signal.aborted) { cache.set(key, value); if (cache.size > 8) cache.delete(cache.keys().next().value); } return value;
  }
  async function textArchive(mail, expectedHash, signal) {
    if (!/^[a-f0-9]{64}$/.test(mail?.id || '') || !/^[a-f0-9]{64}$/.test(expectedHash || mail?.rawStorage?.sha256 || '')) throw new Error('보관된 텍스트 원본을 확인할 수 없습니다.');
    const token = await session.user.getIdToken();
    const response = await fetch(`/api/order-ai/text-sources?id=${encodeURIComponent(mail.id)}`, { cache: 'no-store', credentials: 'same-origin', signal, headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json().catch(() => ({})); if (!response.ok || !data.ok) throw new Error(data.message || '텍스트 원본을 열지 못했습니다.');
    const item = data.source;
    if (item?.id !== mail.id || item.sha256 !== (expectedHash || mail.rawStorage.sha256)) throw new Error('분석한 텍스트와 보관된 원문이 다릅니다.');
    const source = createOrderAiTextSource(item);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source.text)))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (digest !== source.sha256) throw new Error('텍스트 원본 확인에 실패했습니다.');
    return source;
  }
  async function imageArchive(mail, expectedHash, signal) {
    if (!/^[a-f0-9]{64}$/.test(mail?.id || '') || !/^[a-f0-9]{64}$/.test(expectedHash || mail?.rawStorage?.sha256 || '')) throw new Error('보관된 이미지 원본을 확인할 수 없습니다.');
    const token = await session.user.getIdToken();
    const response = await fetch(`/api/order-ai/text-sources?id=${encodeURIComponent(mail.id)}`, { cache: 'no-store', credentials: 'same-origin', signal, headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json().catch(() => ({})); if (!response.ok || !data.ok) throw new Error(data.message || '이미지 원본을 열지 못했습니다.');
    const item = data.source, maximum = 600 * 1024;
    if (item?.id !== mail.id || item.kind !== 'image' || item.sha256 !== (expectedHash || mail.rawStorage.sha256)
      || !['image/png', 'image/jpeg'].includes(item.mimeType) || typeof item.fileName !== 'string' || !item.fileName || item.fileName.length > 255 || /[\u0000-\u001f\u007f]/.test(item.fileName)
      || !Number.isSafeInteger(item.byteLength) || item.byteLength < 1 || item.byteLength > maximum
      || typeof item.contentBase64 !== 'string' || item.contentBase64.length > Math.ceil(maximum / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.contentBase64)) throw new Error('분석한 이미지와 보관된 원문이 다릅니다.');
    const binary = atob(item.contentBase64), bytes = Uint8Array.from(binary, value => value.charCodeAt(0));
    if (bytes.length !== item.byteLength) throw new Error('이미지 원본의 크기가 일치하지 않습니다.');
    const png = bytes.length >= 24 && [137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value) && [73,72,68,82].every((value, index) => bytes[index + 12] === value);
    const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (item.mimeType === 'image/png' ? !png : !jpeg) throw new Error('이미지 원본 형식을 확인할 수 없습니다.');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (digest !== item.sha256) throw new Error('이미지 원본 확인에 실패했습니다.');
    return { ...item, bytes };
  }
  function showText(file, part, original) {
    const rows = getOrderAiTextRows(file.text), byRow = new Map(rows.map(row => [row.rowIndex, row]));
    if (original && (original.kind !== 'text' || !Array.isArray(original.rows) || original.rows.length !== rows.length || original.rows.some((row, index) => row.rowIndex !== rows[index].rowIndex || row.start !== rows[index].start || row.end !== rows[index].end))) throw new Error('분석한 텍스트 행과 원문이 다릅니다.');
    const ranges = [];
    for (const line of part.lines) {
      const row = byRow.get(line.source.rowIndex); if (!row) throw new Error('텍스트 원본 행을 찾을 수 없습니다.');
      if (active.exclusions) { ranges.push({ start: row.start, end: row.end, type: 'excluded' }); continue; }
      const textRanges = line.source.textRanges;
      if (!textRanges || !textRanges.product.length || [...textRanges.product, textRanges.quantity, textRanges.unit].some(range => !validOrderAiTextRange(range, row))) throw new Error('텍스트의 근거 위치를 확인할 수 없습니다.');
      if (normalizeOrderAiQuantity(file.text.slice(textRanges.quantity.start, textRanges.quantity.end)) !== line.quantity || file.text.slice(textRanges.unit.start, textRanges.unit.end).trim().toUpperCase() !== line.unit.trim().toUpperCase()) throw new Error('분석한 수량·단위와 원문이 다릅니다.');
      ranges.push(...textRanges.product.map(range => ({ ...range, type: 'product' })), { ...textRanges.unit, type: 'unit' }, { ...textRanges.quantity, type: 'quantity' });
    }
    const stage = el('div', null, 'order-ai-text-original'); stage.setAttribute('aria-label', '붙여넣은 원문');
    let rowIndex = 0;
    for (const match of file.text.matchAll(/([^\r\n]*)(?:\r\n|\r|\n|$)/g)) {
      if (!match[0] && match.index === file.text.length) break;
      const index = rowIndex++;
      if (part.textPage != null && Math.floor(index / 40) !== part.textPage) continue;
      const start = match.index, end = start + match[1].length, line = el('div', null, `order-ai-text-row${part.rows.includes(index) ? ' order-ai-text-row-highlight' : ''}`);
      const number = el('span', String(index + 1), 'order-ai-text-number'); number.setAttribute('aria-hidden', 'true');
      const content = el('span', null, 'order-ai-text-content');
      const inside = ranges.filter(range => range.start < end && start < range.end), boundaries = [...new Set([start, end, ...inside.flatMap(range => [Math.max(start, range.start), Math.min(end, range.end)])])].sort((a, b) => a - b);
      for (let i = 0; i < boundaries.length - 1; i++) {
        const left = boundaries[i], right = boundaries[i + 1], marks = inside.filter(range => range.start <= left && right <= range.end);
        const type = marks.some(range => range.type === 'quantity') ? 'quantity' : marks.length ? 'product' : '';
        const piece = el(type ? 'mark' : 'span', file.text.slice(left, right), type ? `order-ai-text-mark-${type}` : '');
        if (type === 'quantity') piece.setAttribute('aria-label', `확인할 원문 수량 ${file.text.slice(left, right)}`);
        content.append(piece);
      }
      if (!match[1]) content.append(el('span', '\u200b'));
      line.append(number, content); stage.append(line);
    }
    sourceMount.append(stage);
  }
  function renderNavigation() {
    navigation.replaceChildren();
    parts.forEach((part, index) => { const node = button(`${index + 1}/${parts.length}${visited.has(index) ? ' · 확인' : ''}`, () => void show(index)); node.setAttribute('aria-current', String(index === current)); navigation.append(node); });
    navigation.hidden = parts.length < 2;
    complete.disabled = !viewReady || !active?.group || parts.length === 0 || visited.size !== parts.length || !!active?.readOnly;
    complete.hidden = !active?.group || !!active?.readOnly && !active?.completed;
    progress.textContent = parts.length > 1 ? active?.reviewAll ? `${visited.size} / ${parts.length}` : `원본 근거 ${visited.size}/${parts.length} 열람` : '';
    progress.hidden = parts.length < 2;
    footer.hidden = complete.hidden && progress.hidden;
  }
  async function show(index) {
    cleanupView(); const token = ++generation, value = active, part = parts[index]; current = index; viewReady = false; controller = new AbortController(); const signal = controller.signal;
    sourceMount.replaceChildren(el('p', '원본을 여는 중…', 'order-ai-note')); summary.replaceChildren(); error.hidden = true; complete.disabled = true; renderNavigation();
    try {
      const original = value.analysis?.sources?.find(source => fileId(source) === part.attachmentId);
      if (value.group && (!original || !/^[a-f0-9]{64}$/.test(original.sha256 || ''))) throw new Error('분석에 연결된 원본 파일을 확인할 수 없습니다.');
      const isText = value.mail?.sourceKind === 'text' || original?.kind === 'text';
      const isPastedImage = value.mail?.sourceKind === 'image';
      if (isPastedImage && (part.attachmentId !== 'message-image' || original && original.kind !== 'image')) throw new Error('분석한 이미지 원본의 종류가 다릅니다.');
      const file = isText ? await textArchive(value.mail, original?.sha256, signal) : isPastedImage ? await imageArchive(value.mail, original?.sha256, signal) : await archive(value.mail, part.attachmentId, original?.sha256, signal);
      if (!currentView(token, value)) return;
      sourceMount.replaceChildren();
      pageTitle.textContent = `${file.fileName}${part.sheetIndex != null ? ` · 시트 ${part.sheetIndex + 1}${part.rows.length ? ` · ${part.rows.map(row => row + 1).join(', ')}행` : ''}` : ''}`;
      if (isText) {
        pageTitle.textContent = `${file.fileName}${part.rows.length ? ` · ${part.rows.map(row => row + 1).join(', ')}행` : ''}`;
        showText(file, part, original);
      } else if (!isPastedImage && /\.(xlsx|xls|csv)$/i.test(file.fileName)) {
        const opened = await renderMailWorkbook({ mount: sourceMount, bytes: new Uint8Array(file.bytes), fileName: file.fileName, signal,
          compact: true, fitWidth: true,
          onSheetChange: ({ sheetIndex }) => {
            if (!value.reviewAll || !currentView(token, value)) return;
            const next = parts.findIndex(candidate => candidate.attachmentId === part.attachmentId && candidate.sheetIndex === sheetIndex);
            if (next >= 0) void show(next);
          } });
        if (!currentView(token, value)) { opened?.(); return; }
        workbook = opened;
        if (part.rows.length) {
          const evidence = await opened.focusEvidence({ sheetIndex: part.sheetIndex, rowIndexes: part.rows, quantityCells: part.quantityCells, ...(part.columnIndex != null ? { columnIndex: part.columnIndex } : {}) }, { local: Boolean(inlineMount) });
          if (!currentView(token, value)) return;
          if (!evidence) throw new Error('분석한 셀 위치를 원본에서 확인하지 못했습니다.');
        } else if (!workbook.getMetadata?.()) throw new Error('원본 Excel을 읽지 못했습니다.');
      } else if (isPastedImage || /\.(png|jpe?g)$/i.test(file.fileName)) {
        const stage = el('div', null, 'order-ai-image-stage'), image = el('img'); image.alt = file.fileName; blobUrl = URL.createObjectURL(new Blob([file.bytes], { type: isPastedImage ? file.mimeType : /\.png$/i.test(file.fileName) ? 'image/png' : 'image/jpeg' })); image.src = blobUrl; stage.append(image); sourceMount.append(stage);
        await image.decode(); if (!currentView(token, value) || signal.aborted) return;
        if (!Number.isSafeInteger(image.naturalWidth) || image.naturalWidth < 1 || !Number.isSafeInteger(image.naturalHeight) || image.naturalHeight < 1 || image.naturalWidth * image.naturalHeight > 16000000) throw new Error('이미지 크기를 확인할 수 없습니다.');
        if (original && (original.width !== image.naturalWidth || original.height !== image.naturalHeight)) throw new Error('분석한 이미지 크기와 원본이 다릅니다.');
        for (const box of part.boxes) {
          if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0 || box.x + box.width > 1 || box.y + box.height > 1) throw new Error('이미지의 근거 위치를 확인하지 못했습니다.');
          const mark = el('span', null, 'order-ai-image-evidence'); mark.style.left = `${box.x * 100}%`; mark.style.top = `${box.y * 100}%`; mark.style.width = `${box.width * 100}%`; mark.style.height = `${box.height * 100}%`; mark.setAttribute('aria-label', '이 상품의 원본 근거 영역'); stage.append(mark);
        }
      } else throw new Error('이 파일은 네이버웍스 원문에서 확인해 주세요.');
      if (!currentView(token, value)) return;
      if (value.reviewAll) {
        for (const group of value.analysis.groups) {
          const result = el('article', null, 'order-ai-evidence-result');
          result.append(el('h3', group.label || group.productLabel || group.productId), el('p', `${group.quantity} ${group.unit}`, 'order-ai-evidence-total'));
          summary.append(result);
        }
      } else if (value.group) {
        summary.append(el('h3', value.group.label));
        if (!value.exclusions) summary.append(el('p', `합계 ${value.group.quantity} ${value.group.unit}`, 'order-ai-evidence-total'));
        const list = el('ul'); for (const line of part.lines) list.append(el('li', value.exclusions ? `${line.source.rowIndex == null ? '이미지' : `${line.source.rowIndex + 1}행`} · ${line.reason}` : `${line.source.rowIndex == null ? '이미지' : `${line.source.rowIndex + 1}행`} · ${line.quantity} ${line.unit}${line.source.quantityCell ? ` · ${line.source.quantityCell}` : ''}`)); summary.append(list);
        summary.append(el('p', value.exclusions ? '실제 발주가 제외되지 않았는지 확인해 주세요.' : '상품·규격·원산지와 각 수량을 원본에서 대조해 주세요.', 'order-ai-note'));
      }
      visited.add(index); viewReady = true; renderNavigation();
    } catch (e) { if (currentView(token, value) && e.name !== 'AbortError') { error.textContent = e.message; error.hidden = false; complete.disabled = true; visited.delete(index); } }
  }
  function buildParts(analysis, group, exclusions = false) {
    const byPage = new Map();
    const lines = exclusions ? (analysis.exclusions || []).map(item => ({ reason: item.reason, source: { attachmentId: item.attachmentId, sheetIndex: item.sheetIndex, rowIndex: item.rowIndex, productCells: [], quantityCell: null, unitCell: null, bbox: null } })) : (analysis.lines || []).filter(line => group.lineIds.includes(line.id));
    for (const line of lines) {
      const ref = line.source, source = analysis.sources?.find(item => fileId(item) === String(ref.attachmentId)), sheet = source?.sheets?.find(item => item.sheetIndex === ref.sheetIndex), originRow = sheet?.range?.s?.r, originColumn = sheet?.range?.s?.c;
      if (source?.kind === 'text') {
        const row = source.rows?.find(item => item.rowIndex === ref.rowIndex);
        if (ref.sheetIndex !== null || !row) throw new Error('텍스트 원본 행을 확인할 수 없습니다.');
        const textPage = Math.floor(ref.rowIndex / 40), key = `${ref.attachmentId}:text:${textPage}`;
        if (!byPage.has(key)) byPage.set(key, { attachmentId: String(ref.attachmentId), sheetIndex: null, textPage, rows: [], quantityCells: [], boxes: [], lines: [] });
        const part = byPage.get(key); part.lines.push(line); if (!part.rows.includes(ref.rowIndex)) part.rows.push(ref.rowIndex); continue;
      }
      const page = ref.rowIndex == null ? 0 : originRow == null ? ref.rowIndex : Math.floor((ref.rowIndex - originRow) / 100);
      const addresses = [...(ref.productCells || []), ref.quantityCell, ref.unitCell].filter(Boolean), positions = addresses.map(parseCellAddress);
      if (exclusions && ref.rowIndex != null && (!sheet?.range || originColumn == null)) throw new Error('제외한 행의 전체 열을 확인할 수 없습니다. 최신 분석을 불러와 주세요.');
      const columns = exclusions && ref.rowIndex != null
        ? Array.from({ length: Math.floor((sheet.range.e.c - originColumn) / 20) + 1 }, (_, index) => originColumn + index * 20)
        : positions.length ? [...new Set(positions.map(pos => originColumn == null ? pos.column : originColumn + Math.floor((pos.column - originColumn) / 20) * 20))] : [originColumn ?? null];
      for (const columnIndex of columns) {
        const key = `${ref.attachmentId}:${ref.sheetIndex}:${page}:${columnIndex}`;
        if (!byPage.has(key)) byPage.set(key, { attachmentId: String(ref.attachmentId), sheetIndex: ref.sheetIndex, columnIndex, rows: [], quantityCells: [], boxes: [], lines: [] });
        const part = byPage.get(key); part.lines.push(line);
        if (ref.rowIndex != null && !part.rows.includes(ref.rowIndex)) part.rows.push(ref.rowIndex);
        if (ref.quantityCell) part.quantityCells.push(parseCellAddress(ref.quantityCell));
        if (ref.bbox) part.boxes.push(ref.bbox);
      }
    }
    return [...byPage.values()];
  }
  function open(value, selectedParts) {
    finish(false); if (disposed) return Promise.resolve(false); active = value; parts = selectedParts; visited = new Set(); current = 0; error.hidden = true; error.textContent = ''; heading.textContent = value.group ? `${value.group.label} · 원본 대조` : value.mail?.sourceKind === 'text' ? '붙여넣은 원문' : value.mail?.sourceKind === 'image' ? '받은 이미지 원본' : '첨부 원본'; complete.textContent = value.exclusions ? '제외한 행 원본 확인 완료' : '이 상품 원본 대조 완료';
    const inline = value.group && value.mount;
    header.hidden = Boolean(inline); pageTitle.hidden = Boolean(inline);
    summary.className = 'order-ai-evidence-summary' + (value.reviewAll ? ' order-ai-evidence-results' : '');
    if (value.reviewAll) complete.textContent = '원본 대조 완료';
    if (panel.parentNode) panel.remove();
    if (inline) {
      inlineMount = value.mount; panel.className = 'order-ai-evidence-panel order-ai-evidence-inline'; close.hidden = true;
      heading.textContent = '원본과 인식 결과';
      if (typeof inlineMount.replaceChildren !== 'function' || inlineMount.isConnected === false) { inlineMount = null; active = null; return Promise.resolve(false); }
      inlineMount.replaceChildren(panel);
    } else { panel.className = 'order-ai-evidence-panel'; close.hidden = false; dialog.append(panel); dialog.showModal(); }
    const promise = new Promise(done => { resolve = done; }); if (parts.length) void show(0); else { sourceMount.replaceChildren(el('p', '대조할 원본 위치가 없습니다.')); summary.replaceChildren(); renderNavigation(); } return promise;
  }
  return { review: value => {
      const valid = value.analysis?.intakeId === value.mail?.id && value.analysis?.sourceHash === value.mail?.rawStorage?.sha256;
      let selectedParts = [], failure = valid ? '' : '분석과 수신 원본이 다릅니다. 최신 분석을 확인해 주세요.';
      let reviewedValue = value.reviewAll ? { ...value, group: { id: '__all__', label: '원본 대조', lineIds: [] }, exclusions: false } : value;
      try {
        if (valid && value.reviewAll) {
          const groups = value.analysis.groups, lines = value.analysis.lines;
          if (!Array.isArray(groups) || !groups.length || !Array.isArray(lines) || !lines.length) throw new Error('Missing product evidence');
          const ids = groups.flatMap(group => Array.isArray(group.lineIds) && group.lineIds.length ? group.lineIds : [null]);
          const lineIds = lines.map(line => line.id);
          if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length || new Set(lineIds).size !== lineIds.length
            || ids.length !== lineIds.length || ids.some(id => !lineIds.includes(id))) throw new Error('Incomplete product evidence');
          const group = { id: '__all__', label: '원본 대조', lineIds: ids };
          reviewedValue = { ...value, group, exclusions: false };
          selectedParts = buildParts(value.analysis, group);
        } else if (valid) selectedParts = buildParts(value.analysis, value.group, value.exclusions);
      } catch { failure = '원본의 전체 대조 위치를 확인할 수 없습니다. 최신 분석을 불러와 주세요.'; selectedParts = []; }
      const result = open({ ...reviewedValue, readOnly: ['confirmed', 'approved'].includes(value.analysis?.status) }, selectedParts);
      if (failure) { error.textContent = failure; error.hidden = false; }
      return result;
    },
    preview: ({ mail, attachment }) => open({ mail, readOnly: true }, [{ attachmentId: mail?.sourceKind === 'text' ? 'text' : mail?.sourceKind === 'image' ? 'message-image' : String(attachment.id || attachment.attachmentId), sheetIndex: null, rows: [], quantityCells: [], boxes: [], lines: [] }]),
    cancel: () => finish(false), close: () => finish(false), destroy() { disposed = true; finish(false); cache.clear(); dialog.remove(); } };
}
