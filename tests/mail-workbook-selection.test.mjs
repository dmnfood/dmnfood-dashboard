import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { cellAddress, parseCellAddress, selectWorkbookRange, selectionFromCorners, selectionSnapshot, intersects } from '../dashboard/js/mail-workbook-selection.js';

const require = createRequire(import.meta.url), XLSX = require('../dashboard/vendor/sheetjs/xlsx.full.min.js');
const Model = require('../dashboard/js/mail-workbook-model.js');
const workerSource = readFileSync(new URL('../dashboard/js/mail-workbook-worker.js', import.meta.url), 'utf8');
const info = { index: 0, name: '발주 원본', range: { s: { r: 2, c: 2 }, e: { r: 204, c: 24 } } };

test('reverse pointer corners retain original row and column coordinates, including non-A1 sheet starts', () => {
  const chosen = selectionFromCorners({ row: 104, column: 21 }, { row: 3, column: 3 }, info, {});
  assert.equal(chosen.range, 'D4:V105');
  assert.deepEqual([chosen.startRow, chosen.endRow, chosen.startColumn, chosen.endColumn], [3, 104, 3, 21]);
  assert.equal(chosen.selectedRows.length, 102); assert.equal(chosen.selectedRows[0], 3); assert.equal(chosen.selectedRows.at(-1), 104);
  assert.deepEqual(chosen.sourceBounds, { startRow: 2, endRow: 204, startColumn: 2, endColumn: 24 });
  assert.deepEqual(parseCellAddress(' amj100000 '), { row: 99999, column: 1023 });
  assert.equal(cellAddress(99999, 1023), 'AMJ100000');
});

test('range validation rejects out-of-source addresses, changed sheets and unsafe bounds without clamping', () => {
  for (const range of ['A1:D4', 'D4:Z206', 'A0', 'A-1', 'A1:B2:C3', 'ANK1', 'C100001', 'C03', 'C3!D4']) assert.throws(() => selectWorkbookRange(range, info));
  for (const value of [
    { sheetIndex: 1, startRow: 3, endRow: 4, startColumn: 3, endColumn: 4 },
    { sheetName: '다른 시트', startRow: 3, endRow: 4, startColumn: 3, endColumn: 4 },
    { startRow: 3.1, endRow: 4, startColumn: 3, endColumn: 4 },
    { startRow: 5, endRow: 4, startColumn: 3, endColumn: 4 },
    { range: 'D4:F5', startRow: 3, endRow: 4, startColumn: 3, endColumn: 4 },
  ]) assert.throws(() => selectWorkbookRange(value, info));
  assert.throws(() => selectWorkbookRange('C3', { ...info, range: null }));
});

test('full original merges expand transitively across row and column pages, independent of merge order', () => {
  const merges = [
    { startRow: 90, endRow: 110, startColumn: 20, endColumn: 21 },
    { startRow: 102, endRow: 102, startColumn: 19, endColumn: 22 },
    { startRow: 95, endRow: 96, startColumn: 19, endColumn: 20 },
  ];
  const chosen = selectWorkbookRange('T96', info, { merges });
  assert.equal(chosen.range, 'T91:W111');
  assert.equal(chosen.startRow, 90); assert.equal(chosen.endRow, 110);
  assert.deepEqual(selectWorkbookRange('T96', info, { merges: merges.toReversed() }), chosen);
});

test('paging highlights only the intersection while the full selected range remains intact', () => {
  const selected = selectWorkbookRange('D99:V104', info);
  assert.equal(intersects(selected, { startRow: 99, endRow: 99, startColumn: 3, endColumn: 3 }), true);
  assert.equal(intersects(selected, { startRow: 103, endRow: 103, startColumn: 21, endColumn: 21 }), true);
  assert.equal(intersects(selected, { startRow: 104, endRow: 104, startColumn: 21, endColumn: 21 }), false);
  assert.equal(selected.range, 'D99:V104');
});

test('hidden coordinates and formula caches are explicit provenance, never inferred quantities', () => {
  const chosen = selectWorkbookRange('D4:F8', info, { hiddenRows: [2, 4, 8], hiddenColumns: [2, 4, 8], formulaCells: [
    { row: 3, column: 4, cached: true }, { row: 6, column: 5, cached: false }, { row: 10, column: 3, cached: false },
  ] });
  assert.deepEqual(chosen.hiddenRows, [4]); assert.deepEqual(chosen.hiddenColumns, [4]);
  assert.deepEqual(chosen.formulaCells, [{ row: 3, column: 4, cached: true }, { row: 6, column: 5, cached: false }]);
  assert.equal(chosen.hasUncachedFormulas, true);
  assert.equal(Object.hasOwn(chosen, 'quantity'), false);
  const snapshot = selectionSnapshot(chosen); snapshot.selectedRows[0] = 99; snapshot.sourceBounds.startRow = 99;
  assert.equal(chosen.selectedRows[0], 3); assert.equal(chosen.sourceBounds.startRow, 2);
});

test('selectionInfo worker exposes complete source merges and formula-cache provenance without changing cells', async () => {
  const original = { SheetNames: ['발주 원본'], Sheets: { '발주 원본': {
    '!ref': 'C3:Y205', C3: { t: 's', v: '원본 값' }, D4: { t: 'n', f: 'SUM(D5:D6)', v: 3 }, E5: { t: 'n', f: 'SUM(E6:E7)' },
    Y205: { t: 'n', v: 7 }, '!merges': [{ s: { r: 98, c: 18 }, e: { r: 104, c: 22 } }],
    '!rows': Array.from({ length: 205 }, (_, r) => ({ hidden: r === 101 })), '!cols': Array.from({ length: 25 }, (_, c) => ({ hidden: c === 20 })),
  } } };
  const bytes = new Uint8Array(XLSX.write(original, { type: 'buffer', bookType: 'xlsx', compression: true })), before = bytes.slice(), sent = [];
  const context = { self: { postMessage: data => sent.push(data) }, importScripts() {}, MailWorkbookModel: Model, XLSX, TextDecoder, Uint8Array, ArrayBuffer, Blob, DecompressionStream };
  runInNewContext(workerSource, context);
  await context.self.onmessage({ data: { id: 1, type: 'open', bytes, fileName: '가상 발주.xlsx' } });
  await context.self.onmessage({ data: { id: 2, type: 'selectionInfo', sheetIndex: 0 } });
  const result = sent[1].result;
  assert.equal(sent[1].error, undefined); assert.deepEqual(result.merges, [{ startRow: 98, endRow: 104, startColumn: 18, endColumn: 22 }]);
  assert.deepEqual(result.hiddenRows, [101]); assert.deepEqual(result.hiddenColumns, [20]);
  assert.deepEqual(result.formulaCells, [{ row: 3, column: 3, cached: true }, { row: 4, column: 4, cached: false }]);
  const chosen = selectWorkbookRange('T100', sent[0].result.sheets[0], result);
  assert.equal(chosen.range, 'S99:W105');
  assert.deepEqual(Buffer.from(bytes), Buffer.from(before));
  await context.self.onmessage({ data: { id: 3, type: 'selectionInfo', sheetIndex: 4 } });
  assert.match(sent[2].error, /시트를 찾을 수 없습니다/);
});
