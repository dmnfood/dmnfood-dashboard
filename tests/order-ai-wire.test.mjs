import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrderAiWire } from '../lib/server/order-ai-wire.cjs';
import { ORDER_AI_PRODUCTS, normalizeOrderAiAnalysis } from '../dashboard/js/order-ai-model.js';
const hash = 'a'.repeat(64), fileHash = 'b'.repeat(64), customerId = 'school-' + 'c'.repeat(24);
const cell = (columnIndex, value, extra = {}) => ({ columnIndex, value, text: String(value ?? ''), ...extra });
function fixture() {
    const sources = [{ attachmentId: '101', sha256: fileHash, kind: 'workbook', complete: true, fileName: '가상 원본.xlsx', sheets: [
        { sheetIndex: 0, sheetName: '원본', range: { s: { r: 2, c: 2 }, e: { r: 509, c: 7 } }, rows: [
            { rowIndex: 2, cells: [cell(2, '상품'), cell(5, '수량'), cell(6, '단위')] },
            { rowIndex: 7, cells: [cell(2, '중국산 참기름 1.8L'), cell(5, 2), cell(6, '병')] },
            { rowIndex: 8, cells: [cell(3, ' ', { text: '\t' })] },
            { rowIndex: 509, cells: [cell(2, '외국산 참기름 1.8L'), cell(6, '병'), cell(7, '3')] },
        ] },
        { sheetIndex: 2, sheetName: '숨긴 원본', hidden: true, range: { s: { r: 4, c: 21 }, e: { r: 4, c: 30 } }, rows: [
            { rowIndex: 4, cells: [cell(21, '국산 볶음통깨 1kg'), cell(22, '봉'), cell(30, '7')] },
        ] },
    ] }, { attachmentId: '102', sha256: fileHash, kind: 'image', complete: true, fileName: '가상 캡처.png', width: 320, height: 80 }];
    const output = { assistantMessage: '원본 대조를 진행해 주세요.', questions: [], customerId, rows: [
        { r: 0, d: 'excluded', x: '제목 행', l: [] },
        { r: 1, d: 'included', x: '', l: [{ p: 4, c: [2], q: 5, u: 6, x: [] }] },
        { r: 2, d: 'included', x: '', l: [{ p: 4, c: [2], q: 7, u: 6, x: [] }] },
        { r: 3, d: 'included', x: '', l: [{ p: 5, c: [21], q: 30, u: 22, x: [] }] },
        { r: 4, d: 'included', x: '', l: [{ p: 4, n: '11', t: '병', b: { x: 0.01, y: 0.1, width: 0.95, height: 0.8 }, x: [] }] },
    ] };
    return { sources, output };
}
function normalize(sources, output) {
    return normalizeOrderAiAnalysis({ id: 'test-wire', intakeId: hash, sourceHash: hash, revision: 1, sources,
        customers: [{ id: customerId, name: '가상 학교급식 업체', source: 'school_meal', erpCode: null, revision: 1 }], output });
}
test('wire keeps every original cell, all sheets and sparse coordinates while assigning globally unique row IDs', () => {
    const { sources } = fixture(), before = structuredClone(sources), wire = createOrderAiWire(sources, ORDER_AI_PRODUCTS);
    assert.deepEqual(sources, before);
    assert.deepEqual(wire.sources[0].sheets[0].rows.map(row => row.rowId), [0, 1, null, 2]);
    assert.equal(wire.sources[0].sheets[1].rows[0].rowId, 3); assert.equal(wire.sources[1].rowId, 4);
    assert.equal(wire.sources[0].sheets[1].hidden, true);
    for (let s = 0; s < sources[0].sheets.length; s++) for (let r = 0; r < sources[0].sheets[s].rows.length; r++) assert.deepEqual(wire.sources[0].sheets[s].rows[r].cells, sources[0].sheets[s].rows[r].cells);
    wire.sources[0].sheets[0].rows[1].cells[1].value = 999;
    assert.equal(sources[0].sheets[0].rows[1].cells[1].value, 2, 'wire-only clones cannot modify trusted original data');
});
test('compact rows expand into canonical evidence and quantities stay exclusively original workbook cell values', () => {
    const { sources, output } = fixture(), wire = createOrderAiWire(sources, ORDER_AI_PRODUCTS), expanded = wire.expand(output), analysis = normalize(sources, expanded);
    assert.equal(analysis.readyForReview, true);
    assert.equal(expanded.lines[0].id, 'r1-i0'); assert.equal(expanded.lines[0].unit, '병'); assert.equal(expanded.lines[0].imageQuantity, null);
    assert.deepEqual(expanded.lines[0].source, { attachmentId: '101', sheetIndex: 0, rowIndex: 7, productCells: ['C8'], quantityCell: 'F8', unitCell: 'G8', bbox: null });
    assert.deepEqual(expanded.lines[2].source, { attachmentId: '101', sheetIndex: 2, rowIndex: 4, productCells: ['V5'], quantityCell: 'AE5', unitCell: 'W5', bbox: null });
    assert.equal(expanded.lines[3].imageQuantity, '11'); assert.deepEqual(expanded.lines[3].source.bbox, output.rows[4].l[0].b);
    assert.equal(analysis.groups.find(group => group.productId === 'oil-cn-1_8l').quantity, '16');
    assert.equal(analysis.groups.find(group => group.productId === 'sesame-kr-1kg').quantity, '7');
    assert.equal(expanded.coverage.length, 5); assert.equal(expanded.coverage[0].reason, '제목 행');
    const injected = structuredClone(output); injected.rows[1].l[0].quantity = '999'; assert.throws(() => wire.expand(injected));
});
test('unknown, missing, duplicate rows or malformed and cross-row cell references never become implicit coverage', () => {
    const { sources, output } = fixture(), wire = createOrderAiWire(sources, ORDER_AI_PRODUCTS);
    for (const change of [
        value => value.rows.pop(), value => value.rows[4].r = 1, value => value.rows[4].r = 99,
        value => value.rows[1].l[0].q = 'F8', value => value.rows[1].l[0].q = -1,
        value => value.rows[1].l[0].q = 7, // Column H exists only on another row.
        value => value.rows[1].l[0].c = ['C510'], value => value.rows[1].l[0].c = [2, 2],
        value => value.rows[0].x = '', value => value.rows[0].l = structuredClone(value.rows[1].l),
        value => value.rows[4].l = structuredClone(value.rows[1].l), value => value.rows[1].l = structuredClone(value.rows[4].l),
        value => value.rows[1].l[0].p = 99,
    ]) { const invalid = structuredClone(output); change(invalid); assert.throws(() => wire.expand(invalid)); }
    const missing = structuredClone(output); missing.rows[1].d = 'unresolved'; missing.rows[1].x = '상품 구분 확인'; missing.rows[1].l = [];
    const analysis = normalize(sources, wire.expand(missing)); assert.equal(analysis.readyForReview, false); assert.ok(analysis.blockers.some(item => item.code === 'row_unresolved'));
});
test('question IDs and row/item references map deterministically, including image items', () => {
    const { sources, output } = fixture(), wire = createOrderAiWire(sources, ORDER_AI_PRODUCTS);
    output.questions = [{ id: 'q1', text: '원산지를 확인해 주세요.', rowId: 1, itemIndex: 0 }, { id: 'q2', text: '이미지 수량을 확인해 주세요.', rowId: 4, itemIndex: 0 }, { id: 'q3', text: '거래처를 확인해 주세요.', rowId: null, itemIndex: null }];
    const questions = wire.expand(output).questions;
    assert.deepEqual(questions.map(item => item.lineId), ['r1-i0', 'r4-i0', null]); assert.equal(questions[0].text, output.questions[0].text);
    for (const reference of [{ rowId: 99, itemIndex: 0 }, { rowId: 0, itemIndex: 0 }, { rowId: 1, itemIndex: 3 }, { rowId: null, itemIndex: 0 }]) {
        const invalid = structuredClone(output); Object.assign(invalid.questions[0], reference); assert.throws(() => wire.expand(invalid));
    }
    const duplicate = structuredClone(output); duplicate.questions[1].id = duplicate.questions[0].id; assert.throws(() => wire.expand(duplicate));
});
test('wire proposals preserve image uncertainty and invalid boxes for independent normalization to block', () => {
    const { sources, output } = fixture(), wire = createOrderAiWire(sources, ORDER_AI_PRODUCTS);
    output.rows[4].l[0].b.width = 2; assert.equal(normalize(sources, wire.expand(output)).readyForReview, false);
    output.rows[4].l[0].b = null; output.rows[4].l[0].n = null; assert.equal(normalize(sources, wire.expand(output)).readyForReview, false);
    output.rows[1].l[0].q = null; assert.equal(normalize(sources, wire.expand(output)).readyForReview, false);
});
test('reordered compact decisions give exactly the same canonical model output', () => {
    const { sources, output } = fixture(), wire = createOrderAiWire(sources, ORDER_AI_PRODUCTS);
    assert.deepEqual(wire.expand(output), wire.expand({ ...output, rows: output.rows.toReversed() }));
});

test('500 explicitly excluded numbered template rows keep full canonical coverage beside one actual order', () => {
    const sources = [{ attachmentId: '101', kind: 'workbook', sha256: fileHash, complete: true, sheets: [{ sheetIndex: 0, sheetName: '가상 양식', rows: [
        { rowIndex: 7, cells: [cell(4, '참기름'), cell(5, '중국산 1.80L'), cell(6, '병'), cell(7, 1)] },
        ...Array.from({ length: 500 }, (_, index) => ({ rowIndex: index + 8, cells: [cell(0, index + 2)] })),
    ] }] }];
    const wire = createOrderAiWire(sources, ORDER_AI_PRODUCTS), reason = '번호만 채워진 양식 행이며 발주 내용이 없음';
    const order = { r: 0, d: 'included', x: '', l: [{ p: 4, c: [4, 5], q: 7, u: 6, x: [] }] };
    const grouped = { assistantMessage: '원본 대조를 진행해 주세요.', questions: [], customerId, rows: [order], excludedRows: [{ r: Array.from({ length: 500 }, (_, index) => index + 1), x: reason }] };
    const individual = { assistantMessage: grouped.assistantMessage, questions: [], customerId,
        rows: [order, ...grouped.excludedRows[0].r.map(r => ({ r, d: 'excluded', x: reason, l: [] }))] };
    const expanded = wire.expand(grouped), analysis = normalize(sources, expanded);
    assert.deepEqual(expanded, wire.expand(individual)); assert.equal(expanded.coverage.length, 501);
    assert.equal(expanded.coverage.filter(row => row.disposition === 'excluded').length, 500);
    assert.equal(expanded.lines.length, 1); assert.equal(expanded.lines[0].source.quantityCell, 'H8'); assert.equal(analysis.groups[0].quantity, '1');
    assert.equal(analysis.exclusions.length, 500); assert.equal(analysis.readyForReview, true);
    assert.equal(wire.sources[0].sheets[0].rows.length, 501, 'no numbered source row is prefiltered');
    const reordered = { ...grouped, excludedRows: [
        { r: grouped.excludedRows[0].r.slice(250).toReversed(), x: reason }, { r: grouped.excludedRows[0].r.slice(0, 250).toReversed(), x: reason },
    ] };
    assert.deepEqual(wire.expand(reordered), expanded);
    assert.ok(Buffer.byteLength(JSON.stringify(grouped)) < Buffer.byteLength(JSON.stringify(individual)) * 0.1, 'shared exclusion reasons reduce repetition; all row IDs remain explicit');
});

test('grouped exclusions cannot hide missing, duplicate, unknown, ambiguous or included row decisions', () => {
    const { sources, output } = fixture(), wire = createOrderAiWire(sources, ORDER_AI_PRODUCTS);
    const grouped = { ...output, rows: output.rows.slice(1), excludedRows: [{ r: [0], x: '제목 행' }] };
    assert.deepEqual(wire.expand(grouped), wire.expand(output));
    for (const change of [
        value => value.excludedRows[0].r = [], value => value.excludedRows[0].r = [99], value => value.excludedRows[0].r = [0.5],
        value => value.excludedRows[0].r = ['0'], value => value.excludedRows[0].r = [null], value => value.excludedRows[0].r = [0, 0],
        value => value.excludedRows[0].r = [1], value => value.excludedRows.push({ r: [0], x: '중복 그룹' }),
        value => value.excludedRows[0].x = ' ', value => value.excludedRows[0].d = 'included',
        value => value.excludedRows[0].l = output.rows[1].l, value => value.rows.pop(),
    ]) { const invalid = structuredClone(grouped); change(invalid); assert.throws(() => wire.expand(invalid)); }
    const mixed = { ...output, rows: [output.rows[0], output.rows[1]], excludedRows: [{ r: [2, 3, 4], x: '가상 제외 확인' }] };
    assert.equal(wire.expand(mixed).coverage.length, 5, 'individual exclusions remain compatible with grouped explicit IDs');
});
test('500 original order rows stay complete with a materially smaller provider response, measured in UTF-8 bytes', () => {
    const sources = [{ attachmentId: '101', kind: 'workbook', sha256: fileHash, complete: true, sheets: [{ sheetIndex: 0, sheetName: '대량 가상 원본', rows: Array.from({ length: 500 }, (_, index) => ({ rowIndex: index + 7, cells: [cell(4, '중국산 참기름 1.8L'), cell(6, '병'), cell(7, 1)] })) }] }];
    const wire = createOrderAiWire(sources, ORDER_AI_PRODUCTS), output = { assistantMessage: '원본 대조를 진행해 주세요.', questions: [], customerId,
        rows: Array.from({ length: 500 }, (_, r) => ({ r, d: 'included', x: '', l: [{ p: 4, c: [4], q: 7, u: 6, x: [] }] })) };
    const expanded = wire.expand(output), analysis = normalize(sources, expanded);
    assert.equal(expanded.lines.length, 500); assert.equal(expanded.coverage.length, 500); assert.equal(analysis.groups[0].quantity, '500');
    const compactBytes = Buffer.byteLength(JSON.stringify(output)), canonicalBytes = Buffer.byteLength(JSON.stringify(expanded));
    assert.ok(compactBytes < canonicalBytes * 0.3, `${compactBytes} compact bytes / ${canonicalBytes} canonical bytes; this is not a latency or token claim`);
});
test('wire schema keeps every object strict and distinguishes workbook cell references from image readings', () => {
    const { sources } = fixture(), wire = createOrderAiWire(sources, ORDER_AI_PRODUCTS);
    function inspect(value) { if (value.type === 'object') { assert.equal(value.additionalProperties, false); assert.deepEqual(value.required, Object.keys(value.properties)); Object.values(value.properties).forEach(inspect); } if (value.items) inspect(value.items); value.anyOf?.forEach(inspect); }
    inspect(wire.schema);
    const [workbook, image] = wire.schema.properties.rows.items.properties.l.items.anyOf;
    assert.equal(Object.hasOwn(workbook.properties, 'quantity'), false); assert.equal(Object.hasOwn(workbook.properties, 'n'), false); assert.equal(Object.hasOwn(image.properties, 'n'), true);
    assert.match(wire.instructions, /columnIndex/); assert.match(wire.instructions, /정확히 한 번/);
    assert.equal(wire.schema.required.includes('excludedRows'), true); assert.deepEqual(wire.schema.properties.excludedRows.items.required, ['r', 'x']);
});
