/* Pure read-only workbook bounds and display model. Shared by the worker and tests. */
(function (scope) {
  'use strict';
  const LIMITS = Object.freeze({ bytes: 3 * 1024 * 1024, zipEntries: 512, expandedBytes: 48 * 1024 * 1024,
    zipRatio: 200, sheets: 32, populatedCells: 150000, rows: 100000, columns: 1024,
    pageRows: 100, pageColumns: 20, merges: 5000, cellText: 32767 });
  const fail = message => { throw new Error(message); };
  const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  function inputBytes(value) {
    const bytes = value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : null;
    if (!bytes || !bytes.byteLength) fail('비어 있거나 읽을 수 없는 첨부 파일입니다.');
    if (bytes.byteLength > LIMITS.bytes) fail('Excel 미리보기는 3 MB 이하 파일을 지원합니다. 원본을 내려받아 확인해 주세요.');
    return bytes;
  }
  function sniffFormat(value, fileName = '') {
    const bytes = inputBytes(value);
    const ext = String(fileName).split('.').pop().toLowerCase();
    if (!['xls', 'xlsx', 'csv'].includes(ext)) fail('이 미리보기는 .xls, .xlsx, .csv 첨부 파일을 지원합니다.');
    let kind, label;
    if (ext === 'csv') {
      if (bytes.subarray(0, 4096).includes(0) && !((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) fail('CSV 텍스트 파일로 확인되지 않습니다.');
      if (/<(?:html|table|!doctype\s+html)\b/i.test(new TextDecoder().decode(bytes.subarray(0, 4096)))) fail('CSV 확장자와 실제 HTML 내용이 다릅니다. 원본을 내려받아 확인해 주세요.');
      kind = 'csv'; label = 'CSV 텍스트 표';
    }
    else if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) { kind = 'xlsx'; label = 'Excel 통합 문서'; }
    else if ([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((n, i) => bytes[i] === n)) { kind = 'xls'; label = 'Excel 97–2003'; }
    else {
      const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 4096)).replace(/^\uFEFF/, '');
      if (/<(?:html|table|!doctype\s+html)\b/i.test(head)) { kind = 'html'; label = 'HTML 표 형식의 Excel 내보내기'; }
      else if (/<(?:\w+:)?Workbook\b/i.test(head) && /urn:schemas-microsoft-com:office:spreadsheet/i.test(head)) { kind = 'xml'; label = 'Excel XML 2003'; }
      else fail('지원하는 Excel 파일 형식으로 확인되지 않습니다. 원본을 내려받아 확인해 주세요.');
    }
    return { kind, label, mismatch: kind !== ext, warning: kind !== ext ? `파일 확장자는 .${ext}이지만 실제 내용은 ${label}입니다. 셀 내용과 원본을 함께 확인해 주세요.` : '' };
  }
  function inspectZip(value) {
    const bytes = inputBytes(value), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = o => view.getUint16(o, true), u32 = o => view.getUint32(o, true);
    let eocd = -1;
    for (let i = bytes.length - 22, end = Math.max(0, bytes.length - 65557); i >= end; i--) {
      if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === bytes.length) { eocd = i; break; }
    }
    if (eocd < 0) fail('Excel 압축 구조가 손상되었습니다. 원본 파일을 확인해 주세요.');
    const count = u16(eocd + 10), size = u32(eocd + 12), offset = u32(eocd + 16);
    if (u16(eocd + 4) || u16(eocd + 6) || u16(eocd + 8) !== count || count === 0xffff || size === 0xffffffff || offset === 0xffffffff) fail('분할 또는 ZIP64 Excel 파일은 미리보기에서 지원하지 않습니다.');
    if (!count || count > LIMITS.zipEntries || offset + size !== eocd) fail('Excel 압축 항목이 너무 많거나 구조가 손상되었습니다.');
    const entries = [], names = new Set();
    let at = offset, total = 0;
    for (let index = 0; index < count; index++) {
      if (at + 46 > eocd || u32(at) !== 0x02014b50) fail('Excel 압축 목차가 손상되었습니다.');
      const flags = u16(at + 8), method = u16(at + 10), compressed = u32(at + 20), expanded = u32(at + 24);
      const nameLength = u16(at + 28), extraLength = u16(at + 30), commentLength = u16(at + 32), local = u32(at + 42);
      if (at + 46 + nameLength + extraLength + commentLength > eocd || local + 30 > offset || u32(local) !== 0x04034b50) fail('Excel 압축 위치가 손상되었습니다.');
      const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
      if (names.has(name) || name.includes('..') || name.startsWith('/') || name.includes('\\')) fail('Excel 압축 경로가 올바르지 않습니다.');
      names.add(name);
      const localNameLength = u16(local + 26), start = local + 30 + localNameLength + u16(local + 28);
      if (u16(local + 6) !== flags || new TextDecoder().decode(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name
        || (u32(local + 18) && u32(local + 18) !== compressed) || (u32(local + 22) && u32(local + 22) !== expanded)) fail('Excel 압축 파일과 목차가 일치하지 않습니다.');
      if (flags & 1 || ![0, 8].includes(method) || u16(local + 8) !== method || start + compressed > offset) fail('암호화되었거나 지원하지 않는 Excel 압축 파일입니다.');
      if (compressed === 0xffffffff || expanded === 0xffffffff || expanded > LIMITS.expandedBytes || expanded > Math.max(compressed, 1) * LIMITS.zipRatio) fail('Excel 압축 해제 크기가 미리보기 한도를 넘습니다.');
      total += expanded;
      if (total > LIMITS.expandedBytes) fail('Excel 압축 해제 크기가 48 MB를 넘습니다. 원본을 내려받아 확인해 주세요.');
      entries.push({ name, start, compressed, expanded, method });
      at += 46 + nameLength + extraLength + commentLength;
    }
    if (at !== eocd || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) fail('Excel .xlsx 통합 문서 구조가 확인되지 않습니다.');
    return entries;
  }
  async function verifyInflatedSize(bytes, entries, Stream = scope.DecompressionStream) {
    let total = 0;
    for (const entry of entries) {
      if (entry.method === 0) {
        if (entry.compressed !== entry.expanded) fail('Excel 압축 크기 정보가 일치하지 않습니다.');
        total += entry.expanded; continue;
      }
      if (!Stream) fail('이 브라우저는 안전한 Excel 압축 확인을 지원하지 않습니다. 최신 브라우저에서 열거나 원본을 내려받아 주세요.');
      let stream;
      try { stream = new Stream('deflate-raw'); } catch (_) { fail('이 브라우저는 안전한 Excel 압축 확인을 지원하지 않습니다. 최신 브라우저에서 열거나 원본을 내려받아 주세요.'); }
      const reader = new Blob([bytes.subarray(entry.start, entry.start + entry.compressed)]).stream().pipeThrough(stream).getReader();
      let actual = 0;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          actual += chunk.value.byteLength;
          if (actual > entry.expanded || total + actual > LIMITS.expandedBytes) { await reader.cancel(); fail('Excel의 실제 압축 해제 크기가 미리보기 한도를 넘습니다.'); }
        }
      } finally { reader.releaseLock(); }
      if (actual !== entry.expanded) fail('Excel의 실제 압축 해제 크기가 목차와 일치하지 않습니다.');
      total += actual;
    }
    return total;
  }
  function checkedRange(ref, XLSX) {
    if (typeof ref !== 'string' || !/^[A-Z]{1,3}[1-9]\d*(?::[A-Z]{1,3}[1-9]\d*)?$/.test(ref)) fail('Excel 셀 범위를 확인할 수 없습니다.');
    const range = XLSX.utils.decode_range(ref);
    if (range.e.r >= LIMITS.rows || range.e.c >= LIMITS.columns || range.s.r > range.e.r || range.s.c > range.e.c) fail('Excel 행·열 범위가 미리보기 한도(100,000행·1,024열)를 넘습니다. 원본을 내려받아 확인해 주세요.');
    return range;
  }
  function describeWorkbook(workbook, XLSX) {
    if (!Array.isArray(workbook.SheetNames) || !workbook.SheetNames.length || workbook.SheetNames.length > LIMITS.sheets) fail('시트가 없거나 32개를 넘는 통합 문서는 미리보기에서 지원하지 않습니다.');
    let totalCells = 0, formulas = 0, links = 0, characters = 0;
    const metadata = workbook.Workbook?.Sheets || [];
    const sheets = workbook.SheetNames.map((name, index) => {
      if (!has(workbook.Sheets || {}, name)) fail('일부 시트를 읽지 못했습니다. 원본 파일을 확인해 주세요.');
      const sheet = workbook.Sheets[name], range = sheet['!ref'] ? checkedRange(sheet['!ref'], XLSX) : null;
      let cells = 0, formulaCount = 0, linkCount = 0;
      for (const address of Object.keys(sheet)) {
        if (address[0] === '!') continue;
        checkedRange(address, XLSX);
        if (++totalCells > LIMITS.populatedCells) fail('Excel의 셀이 150,000개를 넘습니다. 원본을 내려받아 확인해 주세요.');
        const cell = sheet[address];
        if (!cell || typeof cell !== 'object') continue;
        const textLength = String(cell.w ?? cell.v ?? '').length, formulaLength = String(cell.f ?? '').length;
        if (textLength > LIMITS.cellText || formulaLength > LIMITS.cellText) fail('Excel 셀의 텍스트가 너무 길어 미리보기를 중단했습니다.');
        characters += textLength + formulaLength;
        if (characters > LIMITS.expandedBytes) fail('Excel 셀의 전체 텍스트가 미리보기 한도를 넘습니다.');
        cells++; if (cell.f) formulaCount++; if (cell.l) linkCount++;
        if (range) {
          const p = XLSX.utils.decode_cell(address);
          if (p.r < range.s.r || p.r > range.e.r || p.c < range.s.c || p.c > range.e.c) fail('셀 데이터와 시트 범위가 일치하지 않습니다. 원본을 확인해 주세요.');
        } else fail('셀 데이터의 원본 범위를 확인할 수 없습니다.');
      }
      const merges = sheet['!merges'] || [];
      if (merges.length > LIMITS.merges) fail('Excel 병합 영역이 너무 많습니다. 원본을 내려받아 확인해 주세요.');
      const intervals = new Map(); let mergedRowCount = 0;
      for (const merge of merges) {
        const ref = XLSX.utils.encode_range(merge), m = checkedRange(ref, XLSX);
        if (!range || m.s.r < range.s.r || m.e.r > range.e.r || m.s.c < range.s.c || m.e.c > range.e.c) fail('병합 영역이 시트 범위를 벗어납니다.');
        mergedRowCount += m.e.r - m.s.r + 1;
        if (mergedRowCount > LIMITS.populatedCells) fail('병합 영역이 너무 커서 정확한 미리보기를 중단했습니다.');
        // A sparse row index bounds overlap checks and prevents hiding populated cells.
        for (let r = m.s.r; r <= m.e.r; r++) {
          const spans = intervals.get(r) || [];
          if (spans.some(s => s[0] <= m.e.c && s[1] >= m.s.c)) fail('겹치는 병합 영역이 있어 정확하게 표시할 수 없습니다. 원본을 확인해 주세요.');
          spans.push([m.s.c, m.e.c]); intervals.set(r, spans);
          if (intervals.size > LIMITS.rows) fail('병합 영역이 너무 큽니다.');
        }
      }
      formulas += formulaCount; links += linkCount;
      return { index, name: String(name), hidden: Number(metadata[index]?.Hidden || 0), range,
        rows: range ? range.e.r - range.s.r + 1 : 0, columns: range ? range.e.c - range.s.c + 1 : 0,
        populatedCells: cells, formulaCount, linkCount,
        hiddenRows: (sheet['!rows'] || []).filter(row => row?.hidden).length,
        hiddenColumns: (sheet['!cols'] || []).filter(col => col?.hidden).length };
    });
    return { sheets, totalCells, formulaCount: formulas, linkCount: links, hasMacros: Boolean(workbook.vbaraw || metadata.some(s => s?.Type === 'macro')) };
  }
  function displayCell(cell, address, XLSX) {
    if (!cell) return { address, text: '', formula: '', cached: false, numeric: false, format: '', link: false, fill: '' };
    const formula = typeof cell.f === 'string' ? cell.f : '';
    const cached = cell.v !== undefined && cell.v !== null;
    let text;
    if (formula && !cached) text = '저장된 계산값 없음';
    else if (typeof cell.w === 'string') text = cell.w;
    else if (cached) {
      try { text = XLSX.utils.format_cell(cell); } catch (_) { text = String(cell.v); }
    } else text = '';
    const color = cell.s?.fgColor?.rgb || cell.s?.fill?.fgColor?.rgb || '';
    return { address, text: String(text), formula, cached, numeric: cell.t === 'n',
      format: typeof cell.z === 'string' ? cell.z : '', link: Boolean(cell.l),
      fill: /^[a-f\d]{6}$/i.test(color) ? `#${color}` : /^[a-f\d]{8}$/i.test(color) ? `#${color.slice(2)}` : '' };
  }
  function sheetPage(workbook, meta, request, XLSX) {
    const info = meta.sheets[Number(request.sheetIndex)];
    if (!info || !Number.isInteger(Number(request.sheetIndex))) fail('시트를 찾을 수 없습니다.');
    if (!info.range) return { info, rows: [], columns: [], merges: [], page: 0, columnPage: 0, pageCount: 1, columnPageCount: 1 };
    const pageCount = Math.ceil(info.rows / LIMITS.pageRows), columnPageCount = Math.ceil(info.columns / LIMITS.pageColumns);
    const page = Math.max(0, Math.min(pageCount - 1, Math.trunc(Number(request.page) || 0)));
    const columnPage = Math.max(0, Math.min(columnPageCount - 1, Math.trunc(Number(request.columnPage) || 0)));
    const startRow = info.range.s.r + page * LIMITS.pageRows, endRow = Math.min(info.range.e.r, startRow + LIMITS.pageRows - 1);
    const startColumn = info.range.s.c + columnPage * LIMITS.pageColumns, endColumn = Math.min(info.range.e.c, startColumn + LIMITS.pageColumns - 1);
    const sheet = workbook.Sheets[info.name];
    const columns = Array.from({ length: endColumn - startColumn + 1 }, (_, i) => {
      const column = startColumn + i, raw = sheet['!cols']?.[column];
      return { index: column, label: XLSX.utils.encode_col(column), hidden: Boolean(raw?.hidden), width: Math.max(72, Math.min(320, Number(raw?.wpx) || Number(raw?.wch) * 8 || 120)) };
    });
    const merges = (sheet['!merges'] || []).filter(m => m.s.r <= endRow && m.e.r >= startRow && m.s.c <= endColumn && m.e.c >= startColumn).map(m => ({
      startRow: Math.max(m.s.r, startRow), endRow: Math.min(m.e.r, endRow), startColumn: Math.max(m.s.c, startColumn), endColumn: Math.min(m.e.c, endColumn),
      address: XLSX.utils.encode_range(m), clipped: m.s.r < startRow || m.e.r > endRow || m.s.c < startColumn || m.e.c > endColumn,
      cell: displayCell(sheet[XLSX.utils.encode_cell(m.s)], XLSX.utils.encode_cell(m.s), XLSX)
    }));
    let displayedCharacters = merges.reduce((sum, merge) => sum + merge.cell.text.length + merge.cell.formula.length, 0);
    const rows = Array.from({ length: endRow - startRow + 1 }, (_, i) => {
      const row = startRow + i;
      return { index: row, label: row + 1, hidden: Boolean(sheet['!rows']?.[row]?.hidden), cells: columns.map(col => {
        const address = XLSX.utils.encode_cell({ r: row, c: col.index });
        const display = displayCell(sheet[address], address, XLSX);
        displayedCharacters += display.text.length + display.formula.length;
        if (displayedCharacters > 2 * 1024 * 1024) fail('이 셀 구간의 텍스트가 너무 많아 안전한 표시를 중단했습니다. 원본을 내려받아 확인해 주세요.');
        return display;
      }) };
    });
    return { info, rows, columns, merges, page, columnPage, pageCount, columnPageCount,
      startRow, endRow, startColumn, endColumn, displayedCells: rows.length * columns.length };
  }
  const api = { LIMITS, inputBytes, sniffFormat, inspectZip, verifyInflatedSize, describeWorkbook, sheetPage, displayCell };
  scope.MailWorkbookModel = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
