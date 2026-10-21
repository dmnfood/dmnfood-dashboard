import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeErpCustomer, validateErpCustomer, parseCustomerCsv, planCustomerImport } from '../dashboard/js/erp-customer-model.js';
import { readErpCustomerFile } from '../dashboard/js/erp-customer-import.js';

test('customer codes remain exact strings and never lose leading zeroes', () => {
    assert.deepEqual(normalizeErpCustomer({ code: ' 00123 ', name: ' 동방 ' }), { code: '00123', name: '동방' });
    for (const code of ['00123', 'A-0001', '거래처01']) assert.deepEqual(validateErpCustomer({ code, name: '같은 이름' }), []);
    for (const code of [123, '', '.', '..', '__reserved__', 'a/b', 'a b', 'a\n', 'a'.repeat(101)]) assert.ok(validateErpCustomer({ code, name: '이름' }).length);
    for (const name of ['', ' ', '이름\n', 'a'.repeat(201)]) assert.ok(validateErpCustomer({ code: '0001', name }).length);
});

test('CSV parser preserves quoted comma, literal quotes and zeroes, rejects broken quoting', () => {
    const rows = parseCustomerCsv('\ufeff거래처코드,거래처명\r\n00123,"동방, 급식"\r\n00045,"신대동 ""유통"""\r\n');
    assert.deepEqual(rows, [['거래처코드', '거래처명'], ['00123', '동방, 급식'], ['00045', '신대동 "유통"']]);
    assert.deepEqual(parseCustomerCsv('CODE\tNAME\n0001\t동방', { delimiter: '\t' }), [['CODE', 'NAME'], ['0001', '동방']]);
    for (const text of ['CODE,NAME\n1,"미완성', 'CODE,NAME\n1,"닫힘"oops', 'CODE,NAME\n1,따"옴표']) assert.throws(() => parseCustomerCsv(text), /따옴표/);
});

test('CSV and TSV use one fixed delimiter and never truncate a customer name at the other delimiter', async () => {
    const tsv = 'CODE\tNAME\n0001\t가상,유통';
    assert.deepEqual(parseCustomerCsv(tsv, { delimiter: '\t' }), [['CODE', 'NAME'], ['0001', '가상,유통']]);
    const tsvFile = await readErpCustomerFile(file('거래처.tsv', new TextEncoder().encode(tsv)));
    assert.equal(planCustomerImport(tsvFile.rows).entries[0].name, '가상,유통');
    const csv = 'CODE,NAME\n0001,가상\t유통';
    assert.deepEqual(parseCustomerCsv(csv), [['CODE', 'NAME'], ['0001', '가상\t유통']]);
    const csvFile = await readErpCustomerFile(file('거래처.csv', new TextEncoder().encode(csv)));
    assert.equal(csvFile.rows[1][1], '가상\t유통');
    assert.throws(() => planCustomerImport(csvFile.rows), /거래처명/);
    assert.throws(() => parseCustomerCsv('CODE;NAME', { delimiter: ';' }), /구분자/);
});

test('import requires explicit unique headers and exact unique code, never guesses customer similarity', () => {
    const existing = [{ code: '0001', name: '동방', revision: 2, updatedAtIso: '2026-10-21T00:00:00Z' }, { code: '0002', name: '신대동', revision: 1 }];
    const plan = planCustomerImport([['거래처명', '거래처코드'], ['동방', '0001'], ['신대동 유통', '0002'], ['동방', '0003']], existing);
    assert.equal(plan.creates, 1); assert.equal(plan.updates, 1); assert.equal(plan.unchanged, 1);
    assert.equal(plan.entries[1].previousName, '신대동'); assert.equal(plan.entries[1].expectedRevision, 1);
    assert.equal(plan.entries[2].action, 'create'); assert.equal(plan.entries[2].code, '0003');
    for (const rows of [ [['번호', '이름'], ['001', '동방']], [['CODE', 'CODE', 'NAME'], ['001', '002', '동방']], [['CODE', 'NAME'], ['001', '동방'], ['001', '동방']], [['CODE', 'NAME'], [123, '동방']], [['CODE', 'NAME'], ['001', '']] ]) assert.throws(() => planCustomerImport(rows));
    assert.throws(() => planCustomerImport([['CODE', 'NAME'], ...Array.from({ length: 201 }, (_, i) => [String(i), '동방'])]), /200개/);
    assert.equal(planCustomerImport([['CODE', 'NAME'], ...Array.from({ length: 200 }, (_, i) => [String(i), '동방'])]).entries.length, 200);
});

function file(name, bytes) { return { name, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }; }
function workerHarness({ info = {}, row, merge = false, formula = false } = {}) {
    const calls = []; let terminated = 0;
    class FakeWorker {
        postMessage(message) {
            calls.push(message);
            queueMicrotask(() => this.onmessage({ data: { id: message.id, result: message.type === 'open' ? { sheets: [{ name: '거래처', range: { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } }, rows: 2, columns: 2, ...info }] }
                : { merges: merge ? [{}] : [], rows: [{ cells: [{ text: '거래처코드' }, { text: '거래처명' }] }, { cells: row || [{ text: '00123', formula: formula ? 'A3' : '' }, { text: '동방' }] }] } } }));
        }
        terminate() { terminated++; }
    }
    return { WorkerClass: FakeWorker, calls, terminated: () => terminated };
}
test('Excel import uses isolated bounded worker and exact displayed code text', async () => {
    const harness = workerHarness(), original = new Uint8Array([1, 2, 3]);
    const parsed = await readErpCustomerFile(file('거래처.xlsx', original), harness);
    assert.deepEqual(parsed.rows, [['거래처코드', '거래처명'], ['00123', '동방']]);
    assert.equal(planCustomerImport(parsed.rows).entries[0].code, '00123');
    assert.equal(harness.calls[0].type, 'open'); assert.equal(harness.calls[1].sheetIndex, 0); assert.equal(harness.terminated(), 1);
});
test('imports reject hidden/merged/formula sources and large inputs without truncation', async () => {
    for (const [options, pattern] of [[{ info: { hiddenRows: 1 } }, /숨겨진/], [{ info: { columns: 21 } }, /별도 파일/], [{ info: { range: { s: { r: 0 }, e: { r: 1000 } } } }, /별도 파일/], [{ merge: true }, /병합/], [{ formula: true }, /수식/]]) {
        const harness = workerHarness(options); await assert.rejects(() => readErpCustomerFile(file('거래처.xlsx', new Uint8Array([1])), harness), pattern); assert.equal(harness.terminated(), 1);
    }
    await assert.rejects(() => readErpCustomerFile({ name: 'too-big.xlsx', size: 3145729 }), /파일/);
    await assert.rejects(() => readErpCustomerFile(file('wrong.pdf', new Uint8Array([1]))), /Excel/);
});
test('CSV upload preserves literal values and honors cancellation', async () => {
    const parsed = await readErpCustomerFile(file('거래처.csv', new TextEncoder().encode('CODE,NAME\n0001,동방')));
    assert.equal(parsed.rows[1][0], '0001');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => readErpCustomerFile(file('거래처.csv', new Uint8Array([1])), { signal: controller.signal }), { name: 'AbortError' });
});
