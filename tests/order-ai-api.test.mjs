import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createHandler, createOrderAiService, publicRecord } from '../lib/server/order-ai-service.cjs';
import { extractWorkbook, extractMailSources, imageDimensions, LIMITS } from '../lib/server/order-ai-extraction.cjs';
import { createOrderAiStore } from '../lib/server/order-ai-store.cjs';
import { encodeFields } from '../lib/server/mail-integration-store.cjs';
import { ORDER_AI_PRODUCTS } from '../dashboard/js/order-ai-model.js';
import { createOrderAiWire } from '../lib/server/order-ai-wire.cjs';
const intakeId = 'a'.repeat(64), sourceHash = 'b'.repeat(64), sha256 = 'c'.repeat(64);
const XLSX = createRequire(import.meta.url)('../dashboard/vendor/sheetjs/xlsx.full.min.js');
const source = { attachmentId: '12', sha256, kind: 'workbook', complete: true, fileName: '가상.csv', sheets: [{ sheetIndex: 0, sheetName: 'Sheet1', rows: [
    { rowIndex: 0, cells: [{ columnIndex: 0, value: '국산 참기름 1L' }, { columnIndex: 1, value: 2 }, { columnIndex: 2, value: '병' }] },
    { rowIndex: 1, cells: [{ columnIndex: 0, value: '국산 참기름 1L' }, { columnIndex: 1, value: 3 }, { columnIndex: 2, value: '병' }] },
] }] };
const companyName = '가상 거래처', companyId = `school-${createHash('sha256').update(companyName).digest('hex').slice(0, 24)}`;
const customers = [{ id: companyId, name: companyName, revision: 1, source: 'school_meal', erpCode: null }];
const output = () => ({ assistantMessage: '원본의 두 행에서 5병을 확인했습니다. 대조해 주세요.', questions: [], customerId: companyId,
    rows: [0, 1].map(r => ({ r, d: 'included', x: '', l: [{ p: 1, c: [0], q: 1, u: 2, x: [] }] })), excludedRows: [] });
function fixture(options = {}) {
    let record = null, held = false; const calls = [], history = [], diagnostics = [];
    const mail = { id: intakeId, rawStorage: { sha256: sourceHash }, subject: '가상 발주', raw: { attachments: [] } };
    const store = { get: async () => structuredClone(record), customers: async () => structuredClone(customers),
        acquire: async () => { if (held) throw Object.assign(new Error('이미 분석 중입니다.'), { status: 409, code: 'ai_analysis_busy' }); held = true; return {}; },
        release: async () => { held = false; },
        save: async (id, data, old) => { if ((old?.data.revision || 0) !== (record?.data.revision || 0)) throw Object.assign(new Error('stale'), { status: 409 }); if (record) history.push(structuredClone(record.data)); record = { data: { ...structuredClone(data), createdAt: record?.data.createdAt || '2026-10-21T00:00:00Z', updatedAt: `2026-10-21T00:00:${String(data.revision).padStart(2, '0')}Z`, ...(data.status === 'confirmed' ? { confirmedAt: '2026-10-21T00:00:03Z' } : {}) }, version: `v${data.revision}` }; return structuredClone(record); } };
    const service = createOrderAiService({ store, mailService: { source: async () => ({ mail }) }, env: { OPENAI_API_KEY: 'test-key-never-return', OPENAI_ORDER_MODEL: 'test-model', ...options.env },
        extract: options.extract || (async () => ({ sources: [structuredClone(source)], images: [] })), now: options.now || Date.now,
        reportDiagnostic: options.reportDiagnostic || (value => diagnostics.push(value)), fetchImpl: async (url, init) => {
            calls.push({ url, init });
            if (options.provider) return options.provider(url, init);
            return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(options.output || output()) }] }] }));
        } });
    return { service, store, mail, calls, history, diagnostics, mutate: fn => fn(record), get record() { return record; } };
}
const actor = { uid: 'manager', role: 'manager' }, start = { intakeId, expectedRevision: 0 };
async function invokeHandler(handler, request) { const headers = {}; let body = ''; const response = { setHeader: (key, value) => headers[key] = value, end: value => body = value || '' }; await handler(request, response); return { status: response.statusCode, headers, body: JSON.parse(body) }; }
const request = (method = 'POST', body = start) => ({ method, url: '/api/order-ai/analysis', headers: { origin: 'https://dashboard.dmnfood.co.kr', 'content-type': 'application/json', authorization: `Bearer ${'a'.repeat(80)}` }, body });

test('status and loading analysis never invoke AI or expose a secret', async () => {
    const f = fixture(); assert.deepEqual(f.service.configuration(), { configured: true, model: 'test-model' });
    assert.deepEqual(await f.service.read(intakeId), { ok: true, analysis: null }); assert.equal(f.calls.length, 0);
    assert.equal(JSON.stringify(f.service.configuration()).includes('test-key-never-return'), false);
});
test('response identifies legacy ERP versus school-roster analyses without changing stored evidence or requiring a selected company', () => {
    for (const [modelOutput, expected] of [[{ customerCode: null }, 'erp'], [{ customerCode: '0007' }, 'erp'], [{ customerId: null }, 'school_meal'], [{ customerId: companyId }, 'school_meal']]) {
        const record = { data: { analysis: { revision: 1, customer: null, questions: [{ id: 'question-1', text: '원래 질문', lineId: null }], groups: [{ id: 'group-1', quantity: '5' }] }, modelOutput, revision: 1, status: 'needs_review' } };
        const before = structuredClone(record), dto = publicRecord(record);
        assert.equal(dto.customerCatalogSource, expected); assert.deepEqual(dto.questions, before.data.analysis.questions); assert.deepEqual(dto.groups, before.data.analysis.groups);
        assert.equal(dto.customer, null); assert.deepEqual(record, before); assert.equal('customerCatalogSource' in record.data.analysis, false);
    }
});
test('provider receives strict schema, complete sources, no store or tools and a bounded request', async () => {
    const f = fixture(), result = await f.service.analyze(start, actor), payload = JSON.parse(f.calls[0].init.body);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, 'https://api.openai.com/v1/responses'); assert.equal(f.calls[0].init.redirect, 'error');
    assert.equal(payload.store, false); assert.equal(payload.model, 'test-model'); assert.equal(payload.max_output_tokens, 16000);
    assert.deepEqual(payload.text.format.schema, createOrderAiWire([source], ORDER_AI_PRODUCTS).schema); assert.equal(payload.text.format.strict, true); assert.equal('tools' in payload, false);
    const input = JSON.parse(payload.input[0].content[0].text); assert.deepEqual(input.sources[0].sheets[0].rows.map(row => row.rowId), [0, 1]);
    assert.equal('rowId' in source.sheets[0].rows[0], false, 'wire IDs never change the original source');
    assert.equal(result.analysis.groups[0].quantity, '5'); assert.equal(result.analysis.canConfirm, false); assert.equal(result.analysis.status, 'needs_review'); assert.equal(result.analysis.revision, 1);
    assert.equal(f.record.data.modelOutput.lines.length, 2); assert.equal(result.analysis.conversation.length, 2);
});
test('missing API setting, stale revision, unknown customer and invalid input cause no provider charge', async () => {
    const f = fixture({ env: { OPENAI_API_KEY: '' } }); await assert.rejects(f.service.analyze(start, actor), { code: 'ai_configuration_required' }); assert.equal(f.calls.length, 0);
    const g = fixture();
    for (const input of [{ ...start, expectedRevision: 1 }, { ...start, customerId: 'school-' + 'f'.repeat(24) }, { ...start, customerCode: '0007' }, { ...start, message: '' }, { ...start, prompt: 'injected' }]) await assert.rejects(g.service.analyze(input, actor));
    assert.equal(g.calls.length, 0);
    const missing = fixture(); missing.store.customers = async () => [];
    await assert.rejects(missing.service.analyze(start, actor), { code: 'ai_customer_catalog_required' }); assert.equal(missing.calls.length, 0);
});
test('new analysis uses only the canonical school roster and never treats an internal ID as an ERP code', async () => {
    const catalog = { schemaVersion: 1, revision: 4, companies: [{ id: companyId, name: companyName }] }, paths = [];
    const store = createOrderAiStore({ token: 'user-token', fetchImpl: async url => { paths.push(String(url)); return new Response(JSON.stringify({ fields: encodeFields(catalog) })); } });
    const records = await store.customers();
    assert.deepEqual(records, [{ id: companyId, name: companyName, revision: 4, source: 'school_meal', erpCode: null }]);
    assert.ok(paths.every(path => path.endsWith('/settings/schoolMealCompanies'))); assert.equal('code' in records[0], false);
    for (const companies of [[{ id: 'invented', name: companyName }], [{ id: companyId, name: ` ${companyName}` }], [{ id: companyId, name: companyName }, { id: companyId, name: companyName }]]) {
        const malformed = createOrderAiStore({ token: 'user-token', fetchImpl: async () => new Response(JSON.stringify({ fields: encodeFields({ ...catalog, companies }) })) });
        await assert.rejects(malformed.customers(), { code: 'ai_customer_catalog_invalid' });
    }
    const missing = createOrderAiStore({ token: 'user-token', fetchImpl: async () => new Response('{}', { status: 404 }) });
    assert.deepEqual(await missing.customers(), []);
});
test('repeat clicks cannot run concurrent analysis or silently charge a stale follow-up', async () => {
    let complete; const pending = new Promise(resolve => complete = resolve);
    const f = fixture({ provider: async () => { await pending; return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output()) }] }] })); } });
    const first = f.service.analyze(start, actor); await new Promise(resolve => setTimeout(resolve, 5));
    await assert.rejects(f.service.analyze(start, actor), { code: 'ai_analysis_busy' }); complete(); await first;
    await assert.rejects(f.service.analyze(start, actor), { code: 'ai_revision_conflict' }); assert.equal(f.calls.length, 1);
});
test('timeout, HTTP failure, refusal, incomplete and malformed AI responses do not save or retry', async () => {
    for (const provider of [async () => { throw new Error('secret provider details'); }, async () => new Response('private detail', { status: 429 }),
        async () => new Response(JSON.stringify({ status: 'incomplete', output: [] })), async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'private detail' }] }] })), async () => new Response('invalid json')]) {
        const f = fixture({ provider }); await assert.rejects(f.service.analyze(start, actor)); assert.equal(f.record, null); assert.equal(f.calls.length, 1);
    }
});
test('untrusted math is recomputed from exact original values; malformed output never becomes a draft', async () => {
    const invalid = output(); invalid.rows[0].l[0].quantity = '999';
    const f = fixture({ output: invalid }); await assert.rejects(f.service.analyze(start, actor), { code: 'ai_analysis_invalid' }); assert.equal(f.record, null);
});
test('compact provider rows expand to original cells and only canonical evidence is persisted', async () => {
    const original = structuredClone(source); original.sheets[0].rows = [7, 511].map((rowIndex, index) => ({ rowIndex, cells: [
        { columnIndex: 4, value: '국산 참기름 1L' }, { columnIndex: 6, value: '병' }, { columnIndex: 7, value: index + 1 },
    ] }));
    const candidate = output(); for (const row of candidate.rows) Object.assign(row.l[0], { c: [4], q: 7, u: 6 });
    const f = fixture({ output: candidate, extract: async () => ({ sources: [structuredClone(original)], images: [] }) });
    const result = await f.service.analyze(start, actor);
    assert.equal(result.analysis.groups[0].quantity, '3');
    assert.deepEqual(result.analysis.lines.map(line => line.source.quantityCell), ['H8', 'H512']);
    assert.deepEqual(result.analysis.lines.map(line => line.source.productCells), [['E8'], ['E512']]);
    assert.deepEqual(result.analysis.lines.map(line => line.source.unitCell), ['G8', 'G512']);
    assert.equal('rows' in f.record.data.modelOutput, false); assert.equal(f.record.data.modelOutput.coverage.length, 2); assert.equal(f.calls.length, 1);
    assert.equal('rowId' in original.sheets[0].rows[0], false);
});
test('grouped template exclusions preserve all 512 source rows and still require explicit human exclusion review', async () => {
    const original = structuredClone(source);
    original.sheets[0].rows.push(...Array.from({ length: 510 }, (_, index) => ({ rowIndex: index + 2, cells: [{ columnIndex: 0, value: index + 3 }] })));
    const candidate = output(); candidate.excludedRows = [{ r: Array.from({ length: 510 }, (_, index) => index + 2), x: '발주 내용 없이 서식 번호만 있는 행' }];
    const f = fixture({ output: candidate, extract: async () => ({ sources: [structuredClone(original)], images: [] }) });
    const first = await f.service.analyze(start, actor);
    assert.equal(first.analysis.groups[0].quantity, '5'); assert.equal(first.analysis.coverage.length, 512); assert.equal(first.analysis.exclusions.length, 510);
    assert.equal(f.record.data.modelOutput.coverage.length, 512); assert.equal('excludedRows' in f.record.data.modelOutput, false);
    const proof = { intakeId, expectedRevision: 1, reviewedGroupIds: first.analysis.groups.map(group => group.id) };
    await assert.rejects(f.service.confirm(proof, actor), { code: 'ai_confirmation_blocked' });
    const confirmed = await f.service.confirm({ ...proof, reviewedExclusions: true }, actor);
    assert.equal(confirmed.analysis.status, 'confirmed'); assert.equal(confirmed.analysis.exclusions.length, 510); assert.equal(f.calls.length, 1);
});
test('human confirmation revalidates original and customer, requires every group and never calls AI or ERP', async () => {
    const f = fixture(), first = await f.service.analyze(start, actor), group = first.analysis.groups[0].id;
    await assert.rejects(f.service.confirm({ intakeId, expectedRevision: 1, reviewedGroupIds: [] }, actor), { code: 'ai_confirmation_blocked' });
    const result = await f.service.confirm({ intakeId, expectedRevision: 1, expectedUpdatedAt: first.analysis.updatedAt, reviewedGroupIds: [group] }, actor);
    assert.equal(result.analysis.status, 'confirmed'); assert.equal(result.analysis.confirmedRevision, 1); assert.equal(result.analysis.revision, 2);
    assert.equal(result.analysis.confirmedByUid, 'manager'); assert.deepEqual(result.analysis.groups, first.analysis.groups); assert.equal(f.history.length, 1); assert.equal(f.calls.length, 1);
    await assert.rejects(f.service.analyze({ intakeId, expectedRevision: 2, message: '다시' }, actor), { code: 'ai_already_confirmed' }); assert.equal(f.calls.length, 1);
});
test('existing mail analysis and confirmation never depend on pasted-source permissions or lookup', async () => {
    const f = fixture(); let textLookups = 0;
    f.store.textSource = async () => { textLookups++; throw new Error('new collection must not be queried for mail'); };
    const first = await f.service.analyze(start, actor);
    await f.service.confirm({ intakeId, expectedRevision: 1, reviewedGroupIds: first.analysis.groups.map(group => group.id) }, actor);
    assert.equal(textLookups, 0); assert.equal(f.calls.length, 1);
});
test('modified stored totals or source hash cannot be confirmed', async () => {
    const f = fixture(), result = await f.service.analyze(start, actor), group = result.analysis.groups[0].id;
    f.mutate(record => record.data.analysis.groups[0].quantity = '999');
    await assert.rejects(f.service.confirm({ intakeId, expectedRevision: 1, reviewedGroupIds: [group] }, actor), { code: 'ai_confirmation_blocked' });
    const g = fixture(), second = await g.service.analyze(start, actor); g.mail.rawStorage.sha256 = 'd'.repeat(64);
    await assert.rejects(g.service.confirm({ intakeId, expectedRevision: 1, reviewedGroupIds: second.analysis.groups.map(value => value.id) }, actor), { code: 'ai_confirmation_blocked' });
});
test('excluded source rows need separate human evidence review before confirmation', async () => {
    const candidate = output(); candidate.rows[0] = { r: 0, d: 'excluded', x: '담당자가 별도로 대조할 행', l: [] };
    const f = fixture({ output: candidate }), result = await f.service.analyze(start, actor), reviewedGroupIds = result.analysis.groups.map(value => value.id);
    assert.equal(result.analysis.exclusions.length, 1);
    await assert.rejects(f.service.confirm({ intakeId, expectedRevision: 1, reviewedGroupIds }, actor), { code: 'ai_confirmation_blocked' });
    const confirmed = await f.service.confirm({ intakeId, expectedRevision: 1, reviewedGroupIds, reviewedExclusions: true }, actor);
    assert.equal(confirmed.analysis.reviewedExclusions, true);
});
test('follow-up explicitly invokes one new analysis and archives exact prior revision', async () => {
    const f = fixture(); await f.service.analyze(start, actor); const previous = structuredClone(f.record.data);
    const second = await f.service.analyze({ intakeId, expectedRevision: 1, message: '업체는 가상 거래처입니다.', customerId: companyId }, actor);
    assert.equal(second.analysis.revision, 2); assert.equal(second.analysis.conversation.length, 4); assert.equal(f.calls.length, 2);
    assert.deepEqual(f.history[0], previous);
    assert.equal(f.history[0].revision, 1);
});
test('an existing analysis without a company can continue using a selected weekly company without an ERP code', async () => {
    const candidate = { ...output(), customerId: null }, f = fixture({ output: candidate });
    const first = await f.service.analyze(start, actor); assert.equal(first.analysis.customer, null); assert.equal(first.analysis.readyForReview, false);
    const second = await f.service.analyze({ intakeId, expectedRevision: 1, customerId: companyId, message: '선택한 학교급식 업체입니다.' }, actor);
    assert.deepEqual(second.analysis.customer, customers[0]); assert.equal(second.analysis.readyForReview, true); assert.equal(second.analysis.revision, 2);
    assert.equal(second.analysis.customer.erpCode, null); assert.equal('code' in second.analysis.customer, false); assert.equal(f.history[0].analysis.customer, null);
});
test('handlers require approved role, same origin JSON and safe request size without invoking provider', async () => {
    for (const [authorize, req, expected] of [
        [async () => { throw Object.assign(new Error('로그인 필요'), { status: 401 }); }, request(), 401],
        [async () => ({ uid: 'worker', role: 'worker' }), request(), 403],
        [async () => actor, { ...request(), headers: { origin: 'https://evil.invalid', 'content-type': 'application/json' } }, 403],
        [async () => actor, { ...request(), headers: { origin: 'https://dashboard.dmnfood.co.kr', 'content-type': 'text/plain' } }, 415],
        [async () => actor, request('POST', { ...start, message: 'x'.repeat(17000) }), 413],
    ]) { const f = fixture(), result = await invokeHandler(createHandler('analysis', { authorize, service: f.service }), req); assert.equal(result.status, expected); assert.equal(f.calls.length, 0); }
    assert.equal((await invokeHandler(createHandler('status', { authorize: async () => actor, service: fixture().service }), request('DELETE'))).status, 405);
});
test('provider diagnostics expose only status and allowlisted category/code, never raw response or key', async () => {
    for (const [code, status, category] of [['invalid_api_key', 401, 'authentication'], ['insufficient_quota', 429, 'billing'], ['model_not_found', 404, 'model'], ['unexpected-private-code', 500, 'unavailable']]) {
        const f = fixture({ provider: async () => new Response(JSON.stringify({ error: { code, message: 'private-provider-text sk-secret-fake', request: 'sensitive request body' } }), { status }) });
        const response = await invokeHandler(createHandler('analysis', { authorize: async () => actor, service: f.service }), request());
        assert.equal(response.body.providerStatus, status); assert.equal(response.body.providerCategory, category);
        assert.equal(response.body.providerCode, code === 'unexpected-private-code' ? undefined : code);
        assert.doesNotMatch(JSON.stringify(response.body), /private-provider-text|sk-secret-fake|sensitive request|test-key-never-return|unexpected-private-code/);
        assert.equal(f.calls.length, 1); assert.equal(f.record, null);
    }
});
test('request deadlines and other network failures have distinct safe error responses and never retry', async () => {
    for (const [name, expectedCode, expectedStatus, kind] of [['TimeoutError', 'ai_provider_timeout', 504, 'deadline'], ['AbortError', 'ai_provider_timeout', 504, 'deadline'], ['TypeError', 'ai_provider_connection_failed', 502, 'network']]) {
        let clock = 0;
        const problem = Object.assign(new Error('private transport message sk-hidden'), { name, cause: Object.assign(new Error('private cause'), { code: 'ECONNRESET' }) });
        const f = fixture({ now: () => { const value = clock; clock += 120000; return value; }, provider: async () => { throw problem; } });
        const response = await invokeHandler(createHandler('analysis', { authorize: async () => actor, service: f.service }), request());
        assert.equal(response.status, expectedStatus); assert.equal(response.body.code, expectedCode); assert.equal(response.body.providerFailureKind, kind);
        assert.equal(response.body.providerStage, 'provider_fetch'); assert.equal(response.body.durationMs, 120000);
        assert.match(response.body.message, /자동으로 재요청하지 않았습니다/);
        assert.equal(f.calls.length, 1); assert.equal(f.record, null); assert.equal(f.diagnostics.length, 1);
        assert.equal(f.diagnostics[0].transportCode, 'ECONNRESET'); assert.equal(f.diagnostics[0].failureKind, kind);
        assert.doesNotMatch(JSON.stringify({ body: response.body, diagnostics: f.diagnostics }), /private transport|private cause|sk-hidden|test-key-never-return/);
    }
});
test('server transport diagnostics contain counts and sizes but no source text, addresses, file names, or unknown errors', async () => {
    const problem = Object.assign(new Error('SECRET_ERROR_BODY'), { name: 'SECRET_ERROR_NAME', code: 'SECRET_CODE', cause: { code: 'SECRET_CAUSE' } });
    let clock = 500;
    const f = fixture({ now: () => { const value = clock; clock += 1500; return value; }, provider: async () => { throw problem; } });
    f.mail.subject = 'SECRET_SUBJECT'; f.mail.from = { name: 'SECRET_SENDER', email: 'secret@example.invalid' };
    await assert.rejects(f.service.analyze(start, actor), { code: 'ai_provider_connection_failed' });
    const diagnostic = f.diagnostics[0];
    assert.equal(diagnostic.event, 'order_ai_provider_transport_failure'); assert.equal(diagnostic.stage, 'provider_fetch'); assert.equal(diagnostic.durationMs, 1500);
    assert.equal(diagnostic.intakeHash, intakeId.slice(0, 12)); assert.equal(diagnostic.intakeHash.length, 12);
    assert.equal(diagnostic.sourceCount, 1); assert.equal(diagnostic.workbookCount, 1); assert.equal(diagnostic.imageCount, 0); assert.equal(diagnostic.sheetCount, 1); assert.equal(diagnostic.rowCount, 2); assert.equal(diagnostic.cellCount, 6);
    assert.equal(diagnostic.sourceContextBytes, Buffer.byteLength(JSON.stringify([source]))); assert.ok(diagnostic.requestBytes > diagnostic.inputBytes); assert.ok(diagnostic.inputBytes > diagnostic.sourceContextBytes);
    assert.equal(diagnostic.timeoutMs, 120000); assert.equal(diagnostic.maxOutputTokens, 16000); assert.equal(diagnostic.errorName, 'Error'); assert.equal('transportCode' in diagnostic, false);
    assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET_|secret@example|가상 거래처|가상\.csv|국산 참기름|test-key-never-return/);
});
test('response stream failures retain their body stage and cannot save or trigger a retry', async () => {
    for (const [name, code] of [['AbortError', 'ai_provider_timeout'], ['TypeError', 'ai_provider_connection_failed']]) {
        const problem = Object.assign(new Error('private stream failure'), { name });
        const f = fixture({ provider: async () => new Response(new ReadableStream({ start(controller) { controller.error(problem); } })) });
        await assert.rejects(f.service.analyze(start, actor), { code, providerStage: 'provider_body' });
        assert.equal(f.diagnostics[0].stage, 'provider_body'); assert.equal(f.calls.length, 1); assert.equal(f.record, null);
    }
});
test('diagnostic output failures cannot replace the transport error or change retry behavior', async () => {
    const f = fixture({ reportDiagnostic: () => { throw new Error('logger unavailable'); }, provider: async () => { throw new TypeError('network unavailable'); } });
    await assert.rejects(f.service.analyze(start, actor), { code: 'ai_provider_connection_failed' }); assert.equal(f.calls.length, 1); assert.equal(f.record, null);
});
test('source extraction reads every nonempty row with original coordinates, including distant rows and all sheets', async () => {
    const parsed = await extractWorkbook(Buffer.from('상품,수량,단위\n국산 참기름 1L,2,병\n\n중국산 참기름 1L,3,병'), 'test.csv');
    assert.deepEqual(parsed.sheets[0].rows.map(row => row.rowIndex), [0, 1, 3]); assert.equal(parsed.sheets[0].rows[2].cells[1].value, '3');
    const xls = readFileSync(new URL('./fixtures/mail-workbooks/sample-school-order.xls', import.meta.url));
    assert.ok((await extractWorkbook(xls, '가상.xls')).sheets.length >= 1);
    const workbook = XLSX.utils.book_new(), distant = XLSX.utils.aoa_to_sheet([['상품', '수량', '단위']]);
    distant.A1005 = { t: 's', v: '중국산 참기름 1.8L' }; distant.B1005 = { t: 'n', v: 11 }; distant.C1005 = { t: 's', v: '병' }; distant['!ref'] = 'A1:C1005';
    XLSX.utils.book_append_sheet(workbook, distant, '첫째'); XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['국산 참기름 1L', 2, '병']]), '둘째');
    const actualXlsx = await extractWorkbook(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }), '가상.xlsx');
    assert.equal(actualXlsx.sheets.length, 2); assert.equal(actualXlsx.sheets[0].rows[1].rowIndex, 1004);
    assert.equal(actualXlsx.sheets[0].rows[1].cells[1].value, 11); assert.deepEqual(actualXlsx.sheets[0].range, { s: { c: 0, r: 0 }, e: { c: 2, r: 1004 } });
});
test('source extraction fails closed above limits and detects archive hash changes', async () => {
    await assert.rejects(extractWorkbook(Buffer.from(Array.from({ length: LIMITS.rows + 1 }, () => '국산 참기름,2,병').join('\n')), 'test.csv'), { code: 'ai_context_too_large' });
    const mail = { id: intakeId, raw: { attachments: [{ attachmentId: 12 }] } };
    await assert.rejects(extractMailSources(mail, { attachment: async () => ({ attachment: { id: '12', byteLength: 1, sha256: 'd'.repeat(64), contentBase64: 'YQ==', mimeType: 'text/csv', fileName: 'a.csv' } }) }), { code: 'ai_source_changed' });
    await assert.rejects(extractMailSources({ id: intakeId, raw: { attachments: [] } }, {}), { code: 'ai_attachment_required' });
});
test('image dimensions are signature checked and pixel count is bounded', () => {
    const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.write('IHDR', 12); png.writeUInt32BE(329, 16); png.writeUInt32BE(74, 20);
    assert.deepEqual(imageDimensions(png, 'image/png'), { width: 329, height: 74 }); png.writeUInt32BE(999999, 16); assert.throws(() => imageDimensions(png, 'image/png'));
    assert.throws(() => imageDimensions(Buffer.from('<svg>'), 'image/png'));
});
test('REST store uses user token, conflict preconditions and preserves timestamp wire types in immutable history', async () => {
    const calls = [], old = { data: { revision: 1 }, version: '2026-10-21T00:00:00Z', fields: { revision: { integerValue: '1' }, createdAt: { timestampValue: '2026-10-21T00:00:00Z' } } };
    const store = createOrderAiStore({ token: 'user-token', fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(String(url).endsWith(':commit') ? { commitTime: '2026-10-21T00:00:01Z' } : { fields: { revision: { integerValue: '2' } }, updateTime: '2026-10-21T00:00:01Z' })); } });
    await store.save(intakeId, { revision: 2, status: 'needs_review', updatedByUid: 'manager' }, old);
    const writes = JSON.parse(calls[0].init.body).writes; assert.equal(calls[0].init.headers.Authorization, 'Bearer user-token'); assert.deepEqual(writes[0].currentDocument, { updateTime: old.version });
    assert.deepEqual(writes[1].currentDocument, { exists: false }); assert.deepEqual(writes[1].update.fields.record.mapValue.fields, old.fields); assert.deepEqual(writes[0].update.fields.createdAt, old.fields.createdAt);
});
