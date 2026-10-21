import test from 'node:test';
import assert from 'node:assert/strict';
import { ORDER_AI_PRODUCTS, ORDER_AI_RESPONSE_SCHEMA, normalizeOrderAiQuantity, addOrderAiQuantities,
    normalizeOrderAiAnalysis, assertOrderAiConfirmation } from '../dashboard/js/order-ai-model.js';

const mailHash = 'a'.repeat(64), fileHash = 'b'.repeat(64);
const customer = { code: '0001', name: '가상 거래처', revision: 2 };
const cell = (columnIndex, value, extra = {}) => ({ columnIndex, value, ...extra });
function fixture() {
    const sources = [{ attachmentId: '101', sha256: fileHash, kind: 'workbook', complete: true,
        sheets: [{ sheetIndex: 0, sheetName: '가상 발주', rows: [
            { rowIndex: 0, cells: [cell(0, '품목'), cell(1, '수량'), cell(2, '단위')] },
            { rowIndex: 3, cells: [cell(0, '가상 중국산 참기름 1.8L'), cell(1, '0.1'), cell(2, '병')] },
            { rowIndex: 5, cells: [cell(0, '가상 중국산 참기름 1.8L'), cell(1, 0.2), cell(2, '병')] }
        ] }] }];
    const line = (id, rowIndex) => ({ id, productId: 'oil-cn-1_8l', unit: '병', imageQuantity: null, issues: [],
        source: { attachmentId: '101', sheetIndex: 0, rowIndex, productCells: [`A${rowIndex + 1}`], quantityCell: `B${rowIndex + 1}`,
            unitCell: `C${rowIndex + 1}`, bbox: null } });
    const output = { assistantMessage: '가상 자료를 분석했습니다.', questions: [], customerCode: '0001', lines: [line('line-1', 3), line('line-2', 5)],
        coverage: [
            { attachmentId: '101', sheetIndex: 0, rowIndex: 0, disposition: 'excluded', lineIds: [], reason: '제목 행' },
            { attachmentId: '101', sheetIndex: 0, rowIndex: 3, disposition: 'included', lineIds: ['line-1'], reason: '발주 상품' },
            { attachmentId: '101', sheetIndex: 0, rowIndex: 5, disposition: 'included', lineIds: ['line-2'], reason: '발주 상품' }
        ] };
    return { id: 'analysis-1', intakeId: mailHash, revision: 3, sourceHash: mailHash, sources, customers: [customer], output };
}
const result = mutate => { const input = fixture(); mutate?.(input); return normalizeOrderAiAnalysis(input); };
const codes = analysis => analysis.blockers.map(value => value.code);

test('catalog has exactly the eleven business products, with semantic IDs and no fabricated ERP codes', () => {
    assert.equal(ORDER_AI_PRODUCTS.length, 11);
    assert.equal(new Set(ORDER_AI_PRODUCTS.map(value => value.id)).size, 11);
    assert.equal(ORDER_AI_PRODUCTS.filter(value => value.kind === 'oil').length, 5);
    assert.equal(ORDER_AI_PRODUCTS.filter(value => value.kind === 'sesame').length, 6);
    assert.ok(ORDER_AI_PRODUCTS.every(value => !('erpCode' in value)));
    assert.equal(ORDER_AI_PRODUCTS.find(value => value.id === 'sesame-cn-black-1kg').label, '중국산 볶음통깨_흑임자 1kg');
});

test('model JSON schema is strict at every nested object and nullable fields stay explicit', () => {
    function inspect(schema) {
        if (schema.type === 'object') {
            assert.equal(schema.additionalProperties, false);
            assert.deepEqual(schema.required, Object.keys(schema.properties));
            Object.values(schema.properties).forEach(inspect);
        }
        if (schema.items) inspect(schema.items);
        schema.anyOf?.forEach(inspect);
    }
    inspect(ORDER_AI_RESPONSE_SCHEMA);
    assert.ok(ORDER_AI_RESPONSE_SCHEMA.properties.lines.items.properties.source.required.includes('unitCell'));
});

test('decimal quantities sum exactly without floating point rounding or row counting', () => {
    assert.equal(addOrderAiQuantities(['0.1', '0.2']), '0.3');
    assert.equal(addOrderAiQuantities(['1,234.500', '0002.5', '0.000001']), '1237.000001');
    for (const value of [0, -1, '', null, undefined, true, '2병', '1,23', 'NaN', Infinity, '1e2', '1.0000001', '1000000000000', 0.1 + 0.2]) assert.equal(normalizeOrderAiQuantity(value), null, String(value));
    assert.equal(normalizeOrderAiQuantity(' 0001.23000000 '), '1.23');
    assert.throws(() => addOrderAiQuantities([]));
    assert.throws(() => addOrderAiQuantities(['999999999999', '1']));
});

test('Excel quantity comes exclusively from the original quantity cell and all rows are accounted for', () => {
    const analysis = result();
    assert.equal(analysis.readyForReview, true); assert.equal(analysis.canConfirm, false);
    assert.deepEqual(analysis.groups.map(value => [value.quantity, value.unit, value.lineIds]), [['0.3', '병', ['line-1', 'line-2']]]);
    assert.equal(analysis.lines[0].source.rowIndex, 3);
    assert.equal(analysis.exclusions.length, 1);
    assert.deepEqual(analysis.customer, customer);
    assert.equal(analysis.sources[0].sheets[0].rowCount, 3);
    assert.ok(!('rows' in analysis.sources[0].sheets[0]), 'persisted source manifest does not duplicate raw cells');
});

test('fabricated output quantities and model-injected totals never enter calculation', () => {
    assert.throws(() => result(input => { input.output.lines[0].quantity = '999'; }), /분석 행/);
    assert.throws(() => result(input => { input.output.total = '999'; }), /응답 형식/);
    const analysis = result(input => { input.output.lines[0].imageQuantity = '999'; });
    assert.equal(analysis.readyForReview, false);
    assert.equal(analysis.lines[0].quantity, '0.1');
});

test('unknown, fabricated or cross-row source cells block approval', () => {
    for (const mutate of [
        input => { input.output.lines[0].source.attachmentId = '999'; },
        input => { input.output.lines[0].source.sheetIndex = 1; },
        input => { input.output.lines[0].source.rowIndex = 99; },
        input => { input.output.lines[0].source.quantityCell = 'B6'; },
        input => { input.output.lines[0].source.quantityCell = 'D4'; },
        input => { input.output.lines[0].source.productCells = ['A6']; },
        input => { input.output.lines[0].source.quantityCell = '=B4'; }
    ]) {
        const analysis = result(mutate); assert.equal(analysis.readyForReview, false); assert.ok(analysis.blockers.length);
    }
});

test('duplicate quantity cell marks every duplicated line unresolved, not just the last one', () => {
    const analysis = result(input => {
        const duplicate = structuredClone(input.output.lines[0]); duplicate.id = 'line-3';
        input.output.lines.push(duplicate); input.output.coverage[1].lineIds.push('line-3');
    });
    assert.equal(analysis.readyForReview, false);
    for (const id of ['line-1', 'line-3']) assert.ok(analysis.lines.find(value => value.id === id).blockers.some(message => /중복/.test(message)));
    assert.deepEqual(analysis.groups[0].lineIds, ['line-2']);
});

test('missing, duplicate, invented, mismatched and unresolved coverage all block final review', () => {
    for (const [mutate, expected] of [
        [input => { input.output.coverage.pop(); }, 'row_uncovered'],
        [input => { input.output.coverage.push(structuredClone(input.output.coverage[0])); }, 'coverage_duplicate'],
        [input => { input.output.coverage.push({ ...input.output.coverage[0], rowIndex: 99 }); }, 'coverage_source_missing'],
        [input => { input.output.coverage[1].lineIds = ['line-2']; }, 'coverage_line_mismatch'],
        [input => { input.output.coverage[1].disposition = 'excluded'; }, 'invalid_exclusion'],
        [input => { input.output.coverage[1].disposition = 'unresolved'; }, 'row_unresolved'],
        [input => { input.output.coverage[0].reason = ''; }, 'invalid_exclusion']
    ]) {
        const analysis = result(mutate); assert.equal(analysis.readyForReview, false); assert.ok(codes(analysis).includes(expected), expected);
    }
});

test('positive numeric quantities, formula caches and units are validated separately', () => {
    for (const value of [-1, 0, '11병', false, null, 0.30000000000000004]) {
        assert.equal(result(input => { input.sources[0].sheets[0].rows[1].cells[1].value = value; }).readyForReview, false);
    }
    assert.equal(result(input => { Object.assign(input.sources[0].sheets[0].rows[1].cells[1], { formula: 'SUM(B1:B3)', hasCachedValue: false }); }).readyForReview, false);
    assert.equal(result(input => { Object.assign(input.sources[0].sheets[0].rows[1].cells[1], { formula: 'SUM(B1:B3)', hasCachedValue: true }); }).readyForReview, true);
    assert.equal(result(input => { input.output.lines[0].unit = '개'; }).readyForReview, false);
    assert.equal(result(input => { input.output.lines[0].unit = 'kg'; input.sources[0].sheets[0].rows[1].cells[2].value = 'kg'; }).readyForReview, false);
});

test('unit groups never silently merge different original count units', () => {
    const analysis = result(input => { input.output.lines[1].unit = '개'; input.sources[0].sheets[0].rows[2].cells[2].value = '개'; });
    assert.equal(analysis.readyForReview, true);
    assert.deepEqual(analysis.groups.map(value => [value.quantity, value.unit]), [['0.1', '병'], ['0.2', '개']]);
});

test('known customer codes are exact strings, unknown or ambiguous codes cannot be fabricated', () => {
    for (const mutate of [
        input => { input.output.customerCode = null; }, input => { input.output.customerCode = '1'; },
        input => { input.output.customerCode = 'imaginary'; }, input => { input.customers.push({ ...customer }); }
    ]) assert.ok(codes(result(mutate)).includes('customer_required'));
    assert.equal(result().customer.code, '0001');
});

test('origin and product kind contradictions stay unresolved, domestic processing does not mean Korean origin', () => {
    for (const text of ['국산 중국산 참기름 1.8L', '국산 참기름 1.8L', '중국산 볶음통깨 1kg']) {
        assert.equal(result(input => { input.sources[0].sheets[0].rows[1].cells[0].value = text; }).readyForReview, false);
    }
    for (const text of ['국내가공/중국산 참기름 1.8L', '외국산 참기름 1.8kg']) {
        assert.equal(result(input => { input.sources[0].sheets[0].rows[1].cells[0].value = text; }).readyForReview, true);
    }
});

test('model uncertainty and unanswered questions are preserved and cannot be silently approved', () => {
    const analysis = result(input => {
        input.output.lines[0].issues = ['식품설명의 원산지를 확인해 주세요.'];
        input.output.questions = [{ id: 'question-1', text: '납품일을 확인해 주세요.', lineId: null }];
    });
    assert.equal(analysis.readyForReview, false);
    assert.equal(analysis.questions[0].text, '납품일을 확인해 주세요.');
    assert.ok(codes(analysis).includes('question_unanswered'));
    assert.ok(analysis.lines[0].blockers.includes('식품설명의 원산지를 확인해 주세요.'));
    assert.throws(() => result(input => { input.output.questions = [{ id: 'q', text: '질문', lineId: 'fabricated' }]; }));
});

test('null or unknown product remains visible for the human, never assigned a fallback product', () => {
    for (const productId of [null, 'made-up-product']) {
        const analysis = result(input => { input.output.lines[0].productId = productId; });
        assert.equal(analysis.lines.length, 2); assert.equal(analysis.lines[0].productId, null);
        assert.equal(analysis.readyForReview, false);
    }
});

test('incomplete extraction always blocks, and malformed trusted source contexts are rejected', () => {
    for (const value of [false, undefined]) assert.ok(codes(result(input => { input.sources[0].complete = value; })).includes('source_incomplete'));
    for (const mutate of [
        input => { input.sources[0].sha256 = 'wrong'; }, input => { input.sources.push(structuredClone(input.sources[0])); },
        input => { input.sources[0].sheets[0].rows.push(structuredClone(input.sources[0].sheets[0].rows[1])); },
        input => { input.sources[0].sheets[0].rows[1].cells.push(cell(1, '10')); },
        input => { input.sourceHash = 'wrong'; }
    ]) assert.throws(() => result(mutate));
});

test('source manifests preserve validated original sheet bounds and bounded file names without inventing A1', () => {
    const analysis = result(input => {
        input.sources[0].fileName = '가상 원본.xls';
        input.sources[0].sheets[0].range = { s: { r: 0, c: 0 }, e: { r: 8, c: 4 } };
    });
    assert.equal(analysis.sources[0].fileName, '가상 원본.xls');
    assert.deepEqual(analysis.sources[0].sheets[0].range, { s: { r: 0, c: 0 }, e: { r: 8, c: 4 } });
    assert.ok(!('range' in result().sources[0].sheets[0]));
    assert.throws(() => result(input => { input.sources[0].sheets[0].range = { s: { r: 4, c: 0 }, e: { r: 8, c: 4 } }; }), /시트 범위/);
    assert.throws(() => result(input => { input.sources[0].sheets[0].range = { s: { r: 0, c: 0 }, e: { r: 8, c: 1024 } }; }), /시트 범위/);
});

function imageFixture() {
    return { id: 'image-analysis', intakeId: mailHash, revision: 1, sourceHash: mailHash, customers: [customer],
        sources: [{ attachmentId: '102', sha256: fileHash, kind: 'image', complete: true, width: 400, height: 100 }],
        output: { assistantMessage: '가상 캡처를 확인해 주세요.', questions: [], customerCode: '0001', lines: [
            { id: 'image-line-1', productId: 'oil-cn-1_8l', unit: '병', imageQuantity: '11', issues: [], source: {
                attachmentId: '102', sheetIndex: null, rowIndex: null, productCells: [], quantityCell: null, unitCell: null,
                bbox: { x: 0.01, y: 0.2, width: 0.97, height: 0.3 } } }
        ], coverage: [{ attachmentId: '102', sheetIndex: null, rowIndex: null, disposition: 'included', lineIds: ['image-line-1'], reason: '이미지 발주 내용' }] } };
}
test('headerless image proposals retain normalized bounding evidence and still require human review', () => {
    const analysis = normalizeOrderAiAnalysis(imageFixture());
    assert.equal(analysis.readyForReview, true); assert.equal(analysis.canConfirm, false);
    assert.equal(analysis.groups[0].quantity, '11');
    assert.deepEqual(analysis.lines[0].source.bbox, { x: 0.01, y: 0.2, width: 0.97, height: 0.3 });
    for (const box of [null, { x: -0.1, y: 0, width: 0.2, height: 0.2 }, { x: 0.9, y: 0, width: 0.2, height: 0.2 }, { x: 0, y: 0, width: 0, height: 0.2 }]) {
        const input = imageFixture(); input.output.lines[0].source.bbox = box;
        assert.equal(normalizeOrderAiAnalysis(input).readyForReview, false);
    }
});

test('duplicate image evidence cannot multiply the same visible quantity', () => {
    const input = imageFixture(), duplicate = structuredClone(input.output.lines[0]);
    duplicate.id = 'image-line-2'; input.output.lines.push(duplicate); input.output.coverage[0].lineIds.push(duplicate.id);
    const analysis = normalizeOrderAiAnalysis(input);
    assert.equal(analysis.readyForReview, false);
    assert.ok(analysis.lines.every(line => line.blockers.some(message => /中複|중복/.test(message))));
    assert.equal(analysis.groups.length, 0);
});

test('untrusted nested evidence objects have bounded exact shapes', () => {
    const input = imageFixture(); input.output.lines[0].source.bbox.extra = 'untrusted';
    assert.throws(() => normalizeOrderAiAnalysis(input), /분석 행/);
    assert.throws(() => result(value => { value.output.lines[0].source.productCells = ['A'.repeat(1000)]; }), /분석 행/);
});

test('confirmation binds explicit reviewed groups to original file hashes, analysis revision and customer revision', () => {
    const input = fixture(), analysis = normalizeOrderAiAnalysis(input);
    const confirmation = { revision: 3, sourceHash: mailHash, sources: input.sources, customers: input.customers,
        reviewedGroupIds: analysis.groups.map(value => value.id), reviewedExclusions: true };
    assert.equal(assertOrderAiConfirmation(analysis, confirmation), true);
    for (const mutate of [
        value => { value.revision = 2; }, value => { value.sourceHash = 'c'.repeat(64); },
        value => { value.sources[0].sha256 = 'd'.repeat(64); }, value => { value.sources[0].complete = false; },
        value => { value.sources.push({ ...value.sources[0], attachmentId: '999' }); },
        value => { value.customers[0].revision++; }, value => { value.customers[0].name = '이름 변경'; },
        value => { value.reviewedGroupIds = []; }, value => { value.reviewedGroupIds.push(value.reviewedGroupIds[0]); },
        value => { value.reviewedGroupIds = ['invented-group']; }
    ]) {
        const changed = structuredClone(confirmation); mutate(changed);
        assert.throws(() => assertOrderAiConfirmation(analysis, changed));
    }
    assert.throws(() => assertOrderAiConfirmation({ ...analysis, readyForReview: false }, confirmation));
    assert.throws(() => assertOrderAiConfirmation(analysis, { ...confirmation, reviewedExclusions: false }), /제외한 원본/);
    assert.throws(() => assertOrderAiConfirmation(analysis, { ...confirmation, reviewedExclusions: undefined }), /제외한 원본/);
    assert.equal(assertOrderAiConfirmation({ ...analysis, exclusions: [] }, { ...confirmation, reviewedExclusions: false }), true);
});
