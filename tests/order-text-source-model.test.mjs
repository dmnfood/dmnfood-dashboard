import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createOrderAiTextSource, getOrderAiTextRows } from '../dashboard/js/order-text-source-model.js';
import { ORDER_AI_PRODUCTS, normalizeOrderAiAnalysis, assertOrderAiConfirmation } from '../dashboard/js/order-ai-model.js';
import { createOrderAiWire } from '../lib/server/order-ai-wire.cjs';
const intakeId = 'a'.repeat(64), customerId = 'school-' + 'b'.repeat(24), customer = { id: customerId, name: '가상 업체', revision: 1, source: 'school_meal', erpCode: null };
const digest = text => createHash('sha256').update(text).digest('hex');
const source = text => createOrderAiTextSource({ text, sha256: digest(text), channel: 'kakao' });
function tokensFor(file, rowIndex, value, offset = 0) {
    const row = file.rows.find(item => item.rowIndex === rowIndex), start = file.text.indexOf(value, row.start + offset), end = start + value.length;
    assert.ok(start >= row.start && end <= row.end);
    const s = row.tokens.findIndex(token => token.start === start), e = row.tokens.findIndex(token => token.end === end);
    assert.ok(s >= 0 && e >= s, `test evidence ${value} must use whole original tokens`); return { s, e };
}
function proposal(file, items, excluded = []) {
    return { assistantMessage: '원문과 대조해 주세요.', customerId, questions: [], excludedRows: excluded.length ? [{ r: excluded, x: '제목·안내' }] : [],
        rows: items.map(({ row = 0, product = 4, label = '중국산 참기름 1.8L', quantity = '11', unit = '병', quantityOffset = 0 }) => ({
            r: file.rows.findIndex(item => item.rowIndex === row), d: 'included', x: '', l: [{ p: product, c: [tokensFor(file, row, label)], q: tokensFor(file, row, quantity, quantityOffset), u: tokensFor(file, row, unit, quantityOffset), x: [] }],
        })) };
}
function normalize(file, output) { return normalizeOrderAiAnalysis({ id: 'test-text', intakeId, revision: 1, sourceHash: file.sha256, sources: [file], customers: [customer], output }); }

test('pasted text preserves CRLF, blank lines, tabs and Unicode with original nonempty line positions', () => {
    const text = '📦 가상 업체\r\n\r\n\t중국산 참기름 1.8L 11병\n', file = source(text);
    assert.equal(file.text, text); assert.deepEqual(file.rows.map(row => row.rowIndex), [0, 2]);
    for (const row of file.rows) for (const token of row.tokens) assert.equal(text.slice(token.start, token.end), token.text);
    assert.equal(text.slice(file.rows[1].start, file.rows[1].end), '\t중국산 참기름 1.8L 11병');
    assert.equal(file.kind, 'text'); assert.equal(file.attachmentId, 'text');
    for (const invalid of ['', ' \r\n\t', 'x'.repeat(20001), 'bad\u0000text']) assert.throws(() => getOrderAiTextRows(invalid));
});
test('model selects server token references and exact original quantity and unit are used in canonical analysis', () => {
    const file = source('가상 업체 발주\r\n중국산 참기름 1.8L 11병');
    const wire = createOrderAiWire([file], ORDER_AI_PRODUCTS), output = proposal(file, [{ row: 1 }], [0]), canonical = wire.expand(output), analysis = normalize(file, canonical);
    assert.equal(analysis.readyForReview, true); assert.equal(analysis.groups[0].quantity, '11'); assert.equal(analysis.lines[0].unit, '병');
    const range = canonical.lines[0].source.textRanges.quantity;
    assert.equal(file.text.slice(range.start, range.end), '11'); assert.equal(canonical.lines[0].imageQuantity, null);
    assert.equal(canonical.coverage.length, 2); assert.equal(analysis.sources[0].kind, 'text'); assert.equal(analysis.sources[0].rowCount, 2);
    assert.equal('text' in analysis.sources[0], false, 'raw source is fetched afresh for source review rather than copied into analysis summaries');
    assert.equal('start' in wire.sources[0].rows[1].tokens[0], false, 'the provider selects token IDs without counting raw character offsets');
    const injected = structuredClone(output); injected.rows[0].l[0].quantity = '999'; assert.throws(() => wire.expand(injected));
});
test('joined quantity and unit with no spaces still preserve exact numeric tokens and decimal sums', () => {
    const file = source('중국산참기름1.8L 0.1병씩\n중국산참기름1.8L 0.2병');
    const output = proposal(file, [{ row: 0, label: '중국산참기름1.8L', quantity: '0.1' }, { row: 1, label: '중국산참기름1.8L', quantity: '0.2' }]);
    const analysis = normalize(file, createOrderAiWire([file], ORDER_AI_PRODUCTS).expand(output));
    assert.equal(analysis.readyForReview, true); assert.equal(analysis.groups[0].quantity, '0.3');
});
test('multiple products on one text line retain separate product, quantity and unit ranges', () => {
    const file = source('중국산 참기름 1.8L 11병, 국산 볶음통깨 1kg 2봉'), wire = createOrderAiWire([file], ORDER_AI_PRODUCTS);
    const first = proposal(file, [{}]).rows[0], second = proposal(file, [{ product: 5, label: '국산 볶음통깨 1kg', quantity: '2', unit: '봉', quantityOffset: 20 }]).rows[0];
    first.l.push(second.l[0]); const result = normalize(file, wire.expand({ ...proposal(file, []), rows: [first] }));
    assert.equal(result.readyForReview, true); assert.deepEqual(result.groups.map(group => group.quantity), ['11', '2']);
    assert.deepEqual(result.lines.map(line => line.productId), ['oil-cn-1_8l', 'sesame-kr-1kg']);
});
test('missing, duplicate, invented text rows and cross-row token indexes cannot be stored as complete evidence', () => {
    const file = source('가상 업체\n중국산 참기름 1.8L 11병'), wire = createOrderAiWire([file], ORDER_AI_PRODUCTS), output = proposal(file, [{ row: 1 }], [0]);
    for (const mutate of [value => value.excludedRows = [], value => value.excludedRows[0].r = [1], value => value.excludedRows[0].r = [99], value => value.rows[0].l[0].q = { s: 99, e: 99 }, value => value.rows[0].l[0].c = [{ s: 2, e: 1 }]]) {
        const invalid = structuredClone(output); mutate(invalid); assert.throws(() => wire.expand(invalid));
    }
    const canonical = wire.expand(output); canonical.lines[0].source.textRanges.quantity = { start: 0, end: 1 };
    assert.equal(normalize(file, canonical).readyForReview, false);
});
test('partial numbers, duplicate quantity ranges, detached units and model-supplied quantity overrides stay unresolved', () => {
    const file = source('중국산 참기름 1.8L 11병'), wire = createOrderAiWire([file], ORDER_AI_PRODUCTS), canonical = wire.expand(proposal(file, [{}]));
    const partial = structuredClone(canonical); partial.lines[0].source.textRanges.quantity.end--;
    assert.equal(normalize(file, partial).readyForReview, false);
    const duplicate = structuredClone(canonical); duplicate.lines.push({ ...structuredClone(duplicate.lines[0]), id: 'second' }); duplicate.coverage[0].lineIds.push('second');
    assert.equal(normalize(file, duplicate).lines.every(line => line.issues.some(issue => issue.includes('중복'))), true);
    const wrongSize = structuredClone(canonical), sizeStart = file.text.indexOf('1.8'); wrongSize.lines[0].source.textRanges.quantity = { start: sizeStart, end: sizeStart + 3 };
    assert.equal(normalize(file, wrongSize).readyForReview, false);
    const injected = structuredClone(canonical); injected.lines[0].imageQuantity = '999'; assert.equal(normalize(file, injected).readyForReview, false);
    const missing = structuredClone(canonical); missing.lines[0].source.textRanges.unit = null; assert.equal(normalize(file, missing).readyForReview, false);
});
test('text row metadata cannot change raw provenance and confirmation still requires all excluded rows', () => {
    const file = source('가상 업체\n중국산 참기름 1.8L 11병'), canonical = createOrderAiWire([file], ORDER_AI_PRODUCTS).expand(proposal(file, [{ row: 1 }], [0])), analysis = normalize(file, canonical);
    const forged = structuredClone(file); forged.rows[1].start++; assert.throws(() => normalize(forged, canonical));
    const params = { revision: 1, sourceHash: file.sha256, sources: [file], customers: [customer], reviewedGroupIds: analysis.groups.map(group => group.id) };
    assert.throws(() => assertOrderAiConfirmation(analysis, params));
    assert.equal(assertOrderAiConfirmation(analysis, { ...params, reviewedExclusions: true }), true);
    assert.throws(() => assertOrderAiConfirmation(analysis, { ...params, sourceHash: 'd'.repeat(64), reviewedExclusions: true }));
});
test('negative, signed and range quantities cannot become a positive count by selecting only their digits', () => {
    for (const value of ['-11병', '- 11병', '−11병', '+11병', '2~11병', '2~ 11병', '2～11병', '2–11병']) {
        const file = source(`중국산 참기름 1.8L ${value}`), output = proposal(file, [{}]), canonical = createOrderAiWire([file], ORDER_AI_PRODUCTS).expand(output), analysis = normalize(file, canonical);
        assert.equal(analysis.readyForReview, false, value); assert.equal(analysis.lines[0].quantity, null, value);
    }
});
