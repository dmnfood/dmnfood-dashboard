/* Original-coordinate selection only. No cell values are inferred or calculated. */
const MAX_ROWS = 100000, MAX_COLUMNS = 1024;
const fail = () => { throw new Error('선택 범위가 이 시트의 원본 범위를 벗어납니다.'); };
const integer = (value, max) => Number.isInteger(value) && value >= 0 && value < max;
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));

export function columnAddress(column) {
  if (!integer(column, MAX_COLUMNS)) fail();
  let label = '', n = column + 1;
  while (n) { const digit = (n - 1) % 26; label = String.fromCharCode(65 + digit) + label; n = Math.floor((n - 1) / 26); }
  return label;
}
export function cellAddress(row, column) {
  if (!integer(row, MAX_ROWS)) fail();
  return `${columnAddress(column)}${row + 1}`;
}
export function parseCellAddress(value) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,5})$/.exec(String(value).trim().toUpperCase());
  if (!match) fail();
  let column = 0;
  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]) - 1; column--;
  if (!integer(row, MAX_ROWS) || !integer(column, MAX_COLUMNS)) fail();
  return { row, column };
}
export function intersects(a, b) {
  return a.startRow <= b.endRow && a.endRow >= b.startRow && a.startColumn <= b.endColumn && a.endColumn >= b.startColumn;
}
function bounds(value) {
  const out = { startRow: value?.startRow, endRow: value?.endRow, startColumn: value?.startColumn, endColumn: value?.endColumn };
  if (!integer(out.startRow, MAX_ROWS) || !integer(out.endRow, MAX_ROWS) || !integer(out.startColumn, MAX_COLUMNS) || !integer(out.endColumn, MAX_COLUMNS)
    || out.startRow > out.endRow || out.startColumn > out.endColumn) fail();
  return out;
}
function within(value, source) {
  return value.startRow >= source.startRow && value.endRow <= source.endRow && value.startColumn >= source.startColumn && value.endColumn <= source.endColumn;
}
export function sourceBounds(info) {
  if (!info?.range || !Number.isInteger(info.index) || typeof info.name !== 'string') fail();
  return bounds({ startRow: info.range.s?.r, endRow: info.range.e?.r, startColumn: info.range.s?.c, endColumn: info.range.e?.c });
}
export function selectWorkbookRange(value, info, selectionInfo = {}) {
  const source = sourceBounds(info);
  if (value?.sheetIndex !== undefined && value.sheetIndex !== info.index) fail();
  if (value?.sheetName !== undefined && value.sheetName !== info.name) fail();
  let rect;
  if (typeof value === 'string') {
    const parts = value.split(':');
    if (parts.length > 2) fail();
    const first = parseCellAddress(parts[0]), last = parseCellAddress(parts[1] ?? parts[0]);
    rect = { startRow: Math.min(first.row, last.row), endRow: Math.max(first.row, last.row), startColumn: Math.min(first.column, last.column), endColumn: Math.max(first.column, last.column) };
  } else {
    rect = bounds(value);
    if (value.range !== undefined && value.range !== `${cellAddress(rect.startRow, rect.startColumn)}:${cellAddress(rect.endRow, rect.endColumn)}`) fail();
  }
  if (!within(rect, source)) fail();
  const merges = selectionInfo.merges || [];
  if (merges.length > 5000) fail();
  // A newly included merge can intersect another merge outside the first rectangle.
  // Expand to a fixed point using original, unclipped coordinates from the worker.
  let changed;
  do {
    changed = false;
    for (const raw of merges) {
      const merge = bounds(raw);
      if (!within(merge, source)) fail();
      if (!intersects(rect, merge)) continue;
      const expanded = { startRow: Math.min(rect.startRow, merge.startRow), endRow: Math.max(rect.endRow, merge.endRow), startColumn: Math.min(rect.startColumn, merge.startColumn), endColumn: Math.max(rect.endColumn, merge.endColumn) };
      if (expanded.startRow !== rect.startRow || expanded.endRow !== rect.endRow || expanded.startColumn !== rect.startColumn || expanded.endColumn !== rect.endColumn) { rect = expanded; changed = true; }
    }
  } while (changed);
  const hiddenRows = (selectionInfo.hiddenRows || []).filter(row => row >= rect.startRow && row <= rect.endRow);
  const hiddenColumns = (selectionInfo.hiddenColumns || []).filter(column => column >= rect.startColumn && column <= rect.endColumn);
  const formulaCells = (selectionInfo.formulaCells || []).filter(cell => cell.row >= rect.startRow && cell.row <= rect.endRow && cell.column >= rect.startColumn && cell.column <= rect.endColumn).map(cell => ({ row: cell.row, column: cell.column, cached: cell.cached === true }));
  return { sheetIndex: info.index, sheetName: info.name, range: `${cellAddress(rect.startRow, rect.startColumn)}:${cellAddress(rect.endRow, rect.endColumn)}`,
    ...rect, selectedRows: Array.from({ length: rect.endRow - rect.startRow + 1 }, (_, i) => rect.startRow + i), sourceBounds: source,
    hiddenRows, hiddenColumns, formulaCells, hasUncachedFormulas: formulaCells.some(cell => !cell.cached) };
}
export function selectionFromCorners(anchor, focus, info, selectionInfo) {
  return selectWorkbookRange({ startRow: Math.min(anchor.row, focus.row), endRow: Math.max(anchor.row, focus.row), startColumn: Math.min(anchor.column, focus.column), endColumn: Math.max(anchor.column, focus.column) }, info, selectionInfo);
}
export function selectionSnapshot(value) { return copy(value); }

/* AI references remain separate from a user's accepted rectangular selection. */
export function workbookEvidence(value, metadata) {
  const info = metadata?.sheets?.[value?.sheetIndex];
  if (!Number.isInteger(value?.sheetIndex) || !info || info.index !== value.sheetIndex) fail();
  const source = sourceBounds(info);
  if (!Array.isArray(value.rowIndexes) || !value.rowIndexes.length || value.rowIndexes.length > 5000) fail();
  const rows = new Set();
  for (const row of value.rowIndexes) {
    if (!integer(row, MAX_ROWS) || row < source.startRow || row > source.endRow || rows.has(row)) fail();
    rows.add(row);
  }
  if (value.columnIndex !== undefined && (!integer(value.columnIndex, MAX_COLUMNS)
    || value.columnIndex < source.startColumn || value.columnIndex > source.endColumn)) fail();
  const cells = value.quantityCells ?? [];
  if (!Array.isArray(cells) || cells.length > 5000) fail();
  const addresses = new Set(), quantityCells = [];
  for (const cell of cells) {
    if (!cell || !rows.has(cell.row) || !integer(cell.column, MAX_COLUMNS)
      || cell.column < source.startColumn || cell.column > source.endColumn) fail();
    const address = cellAddress(cell.row, cell.column);
    if (addresses.has(address)) fail();
    addresses.add(address); quantityCells.push({ row: cell.row, column: cell.column, address });
  }
  quantityCells.sort((a, b) => a.row - b.row || a.column - b.column);
  return { sheetIndex: info.index, sheetName: info.name, rowIndexes: [...rows].sort((a, b) => a - b), quantityCells,
    ...(value.columnIndex === undefined ? {} : { columnIndex: value.columnIndex }) };
}
export function evidencePage(value, metadata, pageRows = 100, pageColumns = 20) {
  const evidence = workbookEvidence(value, metadata), source = sourceBounds(metadata.sheets[evidence.sheetIndex]);
  const row = evidence.quantityCells[0]?.row ?? evidence.rowIndexes[0];
  const column = evidence.columnIndex ?? evidence.quantityCells[0]?.column ?? source.startColumn;
  return { sheetIndex: evidence.sheetIndex, rowPage: Math.floor((row - source.startRow) / pageRows), columnPage: Math.floor((column - source.startColumn) / pageColumns) };
}
export function evidenceCellState(evidence, cell) {
  if (!evidence) return { row: false, quantity: false };
  const row = evidence.rowIndexes.some(index => index >= cell.startRow && index <= cell.endRow);
  const quantity = evidence.quantityCells.some(item => item.row >= cell.startRow && item.row <= cell.endRow
    && item.column >= cell.startColumn && item.column <= cell.endColumn);
  return { row, quantity };
}
