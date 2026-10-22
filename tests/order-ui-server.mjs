// LOCAL BROWSER VERIFICATION ONLY. This server deliberately supplies fictional
// auth/data transports, binds loopback, and serves an exact UI-file allowlist.
// Never deploy it or include it in production routing.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { normalizeOrderAiAnalysis, assertOrderAiConfirmation } from '../dashboard/js/order-ai-model.js';
import { buildSchoolMealCompanies } from '../dashboard/js/school-meal-company-model.js';
import { createOrderAiTextSource } from '../dashboard/js/order-text-source-model.js';
import { ORDER_AI_PRODUCTS } from '../dashboard/js/order-ai-model.js';
import {
    assertOrderRevision, buildOrderReview, emptyReviewChecks, normalizeOrderDraft,
    validateOrderDraft, validateOrderInput,
} from '../dashboard/js/order-request-model.js';

const HOST = '127.0.0.1', PORT = 4175;
const require = createRequire(import.meta.url);
const { extractWorkbook, imageDimensions } = require('../lib/server/order-ai-extraction.cjs');
const { createOrderAiWire } = require('../lib/server/order-ai-wire.cjs');
const { buildTextSource, SOURCE_RETENTION_MS } = require('../lib/server/order-text-source.cjs');
const base = new URL('../', import.meta.url);
const orders = new Map(), streams = new Set(), orderAiAnalyses = new Map(), textSourceFixtures = new Map();
const actor = { uid: 'fictional-local-manager', name: '가상 검증 담당자' };
const uiFiles = new Set([
    '/dashboard/home.html', '/dashboard/orders.html', '/dashboard/js/orders.js',
    '/dashboard/js/order-notifications.js', '/dashboard/js/order-notification-utils.js',
    '/dashboard/js/order-request-model.js', '/dashboard/js/haccp-navigation.js', '/dashboard/style.css',
    '/dashboard/js/mail-connection.js', '/dashboard/css/mail-connection.css',
    '/dashboard/js/mail-source-viewer.js', '/dashboard/css/mail-source-viewer.css',
    '/dashboard/js/mail-workbook-preview.js', '/dashboard/js/mail-workbook-worker.js',
    '/dashboard/js/mail-workbook-model.js', '/dashboard/css/mail-workbook-preview.css',
    '/dashboard/js/mail-workbook-selection.js',
    '/dashboard/js/mail-preparation-ui.js', '/dashboard/js/mail-preparation-model.js', '/dashboard/css/mail-preparation.css',
    '/dashboard/js/order-ai-client.js', '/dashboard/js/order-ai-chat.js', '/dashboard/js/order-ai-evidence.js',
    '/dashboard/js/order-ai-model.js', '/dashboard/css/order-ai-chat.css', '/dashboard/css/order-ai-evidence.css', '/dashboard/js/order-ai-background.js',
    '/dashboard/js/order-confirmed-list.js', '/dashboard/css/order-confirmed-list.css',
    '/dashboard/js/order-text-source-model.js', '/dashboard/js/order-text-sources.js',
    '/dashboard/js/school-meal-company-model.js',
    '/dashboard/js/erp-customer-model.js', '/dashboard/js/erp-customer-import.js',
    '/dashboard/js/erp-customer-settings.js', '/dashboard/css/erp-customer-settings.css',
    '/dashboard/vendor/sheetjs/xlsx.full.min.js',
    '/dashboard/css/user-management.css',
    '/dashboard/css/orders.css', '/dashboard/css/order-notifications.css',
]);
const fixtures = new Map([
    ['/dashboard/js/firebase-client.js', 'order-ui-auth.js'],
    ['/dashboard/js/users.js', 'order-ui-users.js'],
    ['/dashboard/js/order-request-store.js', 'order-ui-store.js'],
    ['/dashboard/js/erp-customer-store.js', 'order-ui-erp-customers.js'],
    ['/dashboard/js/mail-preparation-store.js', 'order-ui-mail-preparation.js'],
    ['/dashboard/js/school-meal-company-store.js', 'order-ui-school-meal-companies.js'],
    ['/__order_ui/transport.js', 'order-ui-transport.js'],
    ['/__order_ui/firestore.js', 'order-ui-firestore.js'],
]);
const headers = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; img-src 'self' data: blob:; base-uri 'none'; frame-ancestors 'none'",
};
const timestamp = () => ({ seconds: Date.now() / 1000 });
const schoolScope = { folderId: '106', folderName: '학교급식 발주', available: null, verified: false, collectionMode: 'manual', automatic: false };
const SCHOOL_MAIL_ID = createHash('sha256').update('fictional-school-mail').digest('hex');
const SAFETY_MAIL_ID = createHash('sha256').update('fictional-mail-safety').digest('hex');
const TITLE_MAIL_ID = createHash('sha256').update('fictional-mail-title-only').digest('hex');
const mailFixtures = [
    { id: SCHOOL_MAIL_ID, subject: '[가상 자료] 학교급식 발주서 열람 시험', from: { name: '가상 급식 거래처', email: 'school@example.test' }, receivedAt: '2026-10-21T01:00:00.000Z', collectedAt: '2026-10-21T01:01:00.000Z', folderId: '0', processingStatus: 'pending_interpretation',
        raw: { mail: { mailId: 'fixture-1', subject: '[가상 자료] 학교급식 발주서 열람 시험', body: '<p>가상 학교급식 발주서입니다.</p><p>첨부 Excel의 상품명·수량·일정을 원문으로 확인해 주세요.</p><table><tr><th>안내</th><th>상태</th></tr><tr><td>실제 발주가 아닙니다</td><td>해석 대기</td></tr></table>', from: { name: '가상 급식 거래처', email: 'school@example.test' } }, attachments: [{ attachmentId: '101', filename: '가상 학교급식 발주서.xls', contentType: 'application/vnd.ms-excel', size: (await readFile(new URL('fixtures/mail-workbooks/sample-school-order.xls', import.meta.url))).length }, { attachmentId: '102', filename: '가상 참고 이미지.png', contentType: 'image/png', size: 100 }, { attachmentId: '103', filename: '가상 대용량 발주서.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 4 * 1024 * 1024 }] } },
    { id: SAFETY_MAIL_ID, subject: '[가상 자료] 본문 안전 표시 시험', from: { email: 'safety@example.test' }, receivedAt: '2026-10-20T01:00:00.000Z', collectedAt: '2026-10-20T01:01:00.000Z', processingStatus: 'pending_interpretation',
        raw: { mail: { mailId: 'fixture-2', body: '<div onclick="alert(1)" style="background:url(https://example.invalid/mail-css)">안전한 본문 텍스트</div><img src="https://example.invalid/mail-image" onerror="alert(1)" alt="외부 이미지 차단"><script>window.parent.__mailInjected=true</script><iframe src="https://example.invalid/mail-frame"></iframe><form action="https://example.invalid/mail-form"><input value="차단"></form><a href="javascript:alert(1)">외부 링크는 텍스트로 표시</a><svg><a href="https://example.invalid/mail-svg">SVG</a></svg><table><tr><td colspan="2" background="https://example.invalid/mail-bg">보존되는 표</td></tr></table>' }, attachments: [] } },
    { id: TITLE_MAIL_ID, subject: '[가상 자료] 예시 참기름 1.8L 2병', from: 'title@example.test', receivedAt: '2026-10-19T01:00:00.000Z', collectedAt: '2026-10-19T01:01:00.000Z', processingStatus: 'pending_interpretation', raw: { mail: { mailId: 'fixture-3', body: '' }, attachments: [] } },
];
for (const mail of mailFixtures) {
    mail.schemaVersion = 1; mail.account = 'official@dmnfood.co.kr';
    mail.mailId = String(900001 + mailFixtures.indexOf(mail));
    mail.rawStorage = { sha256: createHash('sha256').update(JSON.stringify(mail.raw)).digest('hex') };
}
// An intentionally fictional weekly-company catalog used only on loopback.
// This internal selection ID is never an ERP customer code.
const orderAiCustomerId = `school-${createHash('sha256').update('가상 급식 거래처'.normalize('NFKC')).digest('hex').slice(0, 24)}`;
let schoolCompanyCatalog = { schemaVersion: 1, revision: 1, companies: [{ id: orderAiCustomerId, name: '가상 급식 거래처' }] };
const orderAiCustomers = () => schoolCompanyCatalog.companies.map(item => ({ ...item, revision: schoolCompanyCatalog.revision, source: 'school_meal', erpCode: null }));
const orderAiBytes = await readFile(new URL('fixtures/mail-workbooks/sample-school-order.xls', import.meta.url));
const orderAiParsed = await extractWorkbook(orderAiBytes, '가상 학교급식 발주서.xls');
const orderAiSources = [{ attachmentId: '101', sha256: createHash('sha256').update(orderAiBytes).digest('hex'),
    fileName: '가상 학교급식 발주서.xls', kind: 'workbook', complete: true, sheets: orderAiParsed.sheets }];
function orderAiProposal(blocked, customerId) {
    const included = [2, 3, 4, 5, 6], lineIds = new Map();
    const lines = [...included, ...(blocked ? [7] : [])].map(rowIndex => {
        const id = `fictional-line-${rowIndex + 1}`; lineIds.set(rowIndex, id);
        return { id, productId: rowIndex === 7 ? null : [2, 3, 5].includes(rowIndex) ? 'oil-cn-1_8l' : 'oil-kr-1_8l',
            unit: '병', imageQuantity: null, issues: rowIndex === 7 ? ['들기름은 회사 상품 목록에 없습니다. 처리 여부를 확인해 주세요.'] : [],
            source: { attachmentId: '101', sheetIndex: 0, rowIndex, productCells: [`C${rowIndex + 1}`],
                quantityCell: `D${rowIndex + 1}`, unitCell: `E${rowIndex + 1}`, bbox: null } };
    });
    return { assistantMessage: blocked
        ? '가상 검증: 중국산 참기름 1.8L 6병과 국산 참기름 1.8L 5병을 찾았습니다. 들기름 2병은 회사 상품 목록에 없어 확인이 필요합니다. 실제 AI 호출이나 ERP 등록은 실행하지 않습니다.'
        : '가상 검증: 중국산 참기름 1.8L 6병과 국산 참기름 1.8L 5병입니다. 회사 상품 목록에 없는 들기름 2병은 제외했습니다. 실제 AI 호출이나 ERP 등록은 실행하지 않습니다.',
        questions: blocked ? [{ id: 'fictional-question-1', text: '회사 상품 목록에 없는 들기름 2병을 제외할까요?', lineId: 'fictional-line-8' }] : [],
        customerId, lines,
        coverage: orderAiSources[0].sheets[0].rows.map(({ rowIndex }) => ({ attachmentId: '101', sheetIndex: 0, rowIndex,
            disposition: lineIds.has(rowIndex) ? rowIndex === 7 ? 'unresolved' : 'included' : 'excluded',
            lineIds: lineIds.has(rowIndex) ? [lineIds.get(rowIndex)] : [], reason: rowIndex < 2 ? '제목과 열 제목'
                : rowIndex === 8 ? '원본 합계이며 중복 합산하지 않음' : rowIndex === 7 ? '회사 상품 목록에 없는 가상 들기름'
                    : '발주 행의 원본 수량 합산' })) };
}
function createOrderAiFixture(input, scenario, old) {
    if (['text', 'image'].includes(input.sourceKind)) return createTextAiFixture(input, old);
    if (input.intakeId !== SCHOOL_MAIL_ID) throw new Error('이 가상 메일에는 분석할 발주 첨부가 없습니다.');
    if (input.expectedRevision !== (old?.revision || 0) || old?.status === 'confirmed') throw new Error('가상 분석의 최신 버전을 다시 불러와 주세요.');
    const customers = orderAiCustomers(), selectedId = input.customerId || old?.customer?.id || customers[0]?.id || null;
    if (selectedId && !customers.some(item => item.id === selectedId)) throw new Error('가상 주간현황표 업체 목록에서 다시 선택해 주세요.');
    const blocked = scenario === 'blocked' && !/제외/.test(input.message || '');
    const normalized = normalizeOrderAiAnalysis({ id: 'fictional-analysis', intakeId: input.intakeId, revision: (old?.revision || 0) + 1,
        sourceHash: mailFixtures[0].rawStorage.sha256, sources: orderAiSources, customers, output: orderAiProposal(blocked, selectedId) });
    const conversation = [...(old?.conversation || []), ...(input.message ? [{ role: 'user', content: String(input.message) }] : []),
        { role: 'assistant', content: normalized.assistantMessage }];
    return { ...normalized, conversation, mode: 'fictional_local_only', updatedAt: new Date().toISOString() };
}
// Deterministic fictional input only; this fixture never calls a model.
function createTextAiFixture(input, old) {
    const record = textSourceFixtures.get(input.intakeId);
    if (!record || input.expectedRevision !== (old?.revision || 0)) throw new Error('가상 텍스트 발주를 다시 선택해 주세요.');
    if (record.kind === 'image') {
        const dimensions = imageDimensions(Buffer.from(record.contentBase64, 'base64'), record.mimeType);
        const source = { attachmentId: 'message-image', kind: 'image', complete: true, fileName: record.fileName, sha256: record.sha256, ...dimensions };
        const lines = ['2', '1'].map((quantity, index) => ({ id: `fictional-image-${index}`, productId: 'oil-cn-1_8l', unit: '병', imageQuantity: quantity, issues: [],
            source: { attachmentId: source.attachmentId, sheetIndex: null, rowIndex: null, productCells: [], quantityCell: null, unitCell: null, bbox: { x: .35, y: index ? .48 : .38, width: .55, height: .13 } } }));
        const output = { assistantMessage: '가상 검증: 이미지 화면 시험용 2병·1병 결과입니다. 실제 AI 호출은 하지 않습니다.', questions: [], customerId: orderAiCustomers()[0]?.id || null, lines,
            coverage: [{ attachmentId: source.attachmentId, sheetIndex: null, rowIndex: null, disposition: 'included', lineIds: lines.map(line => line.id), reason: '' }] };
        const analysis = normalizeOrderAiAnalysis({ id: 'fictional-image-analysis', intakeId: input.intakeId, revision: (old?.revision || 0) + 1, sourceHash: record.sha256, sources: [source], customers: orderAiCustomers(), output });
        return { ...analysis, conversation: [{ role: 'assistant', content: output.assistantMessage }], mode: 'fictional_local_only', updatedAt: new Date().toISOString() };
    }
    const file = createOrderAiTextSource(record), wire = createOrderAiWire([file], ORDER_AI_PRODUCTS), rows = [];
    for (const row of wire.sources[0].rows) {
        const unit = row.tokens.findLastIndex(token => token.text === '병'), quantity = unit - 1;
        if (row.text.includes('중국산') && row.text.includes('참기름') && unit > 0 && /^\d+(?:\.\d+)?$/.test(row.tokens[quantity]?.text || '')) rows.push({ r: row.rowId, d: 'included', x: '', l: [{ p: 4, c: [{ s: 0, e: quantity - 1 }], q: { s: quantity, e: quantity }, u: { s: unit, e: unit }, x: [] }] });
        else rows.push({ r: row.rowId, d: 'excluded', x: '가상 업체 제목', l: [] });
    }
    const output = wire.expand({ assistantMessage: '가상 검증: 붙여넣은 원문의 수량을 합산했습니다. 실제 AI 호출은 하지 않습니다.', questions: [], customerId: orderAiCustomers()[0]?.id || null, rows, excludedRows: [] });
    const analysis = normalizeOrderAiAnalysis({ id: 'fictional-text-analysis', intakeId: input.intakeId, revision: (old?.revision || 0) + 1, sourceHash: record.sha256, sources: [file], customers: orderAiCustomers(), output });
    return { ...analysis, conversation: [{ role: 'assistant', content: output.assistantMessage }], mode: 'fictional_local_only', updatedAt: new Date().toISOString() };
}
const state = () => [...orders.values()].sort((a, b) => b.createdAt.seconds - a.createdAt.seconds);
const snapshot = () => `data: ${JSON.stringify(state())}\n\n`;
function broadcast() { for (const stream of streams) stream.write(snapshot()); }
function reply(res, status, value, type = 'application/json; charset=utf-8', additionalHeaders = {}) {
    res.writeHead(status, { ...headers, 'Content-Type': type, ...additionalHeaders });
    res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}
function failIf(errors) { if (errors.length) throw new Error(errors.join('\n')); }
function applyAction(action) {
    if (action.type === 'create') {
        if (action.input?.isTest !== true) throw new Error('로컬 검증에서는 테스트 표시가 있는 가상 발주만 등록할 수 있습니다.');
        const input = action.input;
        const values = { customerName: String(input.customerName || '').trim(), customerGroup: input.customerGroup,
            sourceChannel: input.sourceChannel, sourceText: String(input.sourceText || '').trim(),
            sourceReference: String(input.sourceReference || '').trim(), isTest: true, draft: normalizeOrderDraft(input.draft) };
        failIf(validateOrderInput(values));
        const id = `local-test-${randomUUID()}`, now = timestamp();
        orders.set(id, { schemaVersion: 1, id, ...values, revision: 1, status: 'pending_review',
            createdByUid: actor.uid, createdByName: actor.name, receivedAt: now, createdAt: now, updatedAt: now,
            reviewNotes: '', reviewChecks: emptyReviewChecks(), reviewedByUid: '', reviewedByName: '', reviewedAt: null, approvedRevision: 0 });
        return { id, revision: 1, status: 'pending_review' };
    }
    const existing = orders.get(action.id);
    if (!existing) throw new Error('발주를 찾을 수 없습니다.');
    assertOrderRevision(existing, action.expectedRevision);
    if (action.type === 'update') {
        const draft = normalizeOrderDraft(action.input?.draft || action.input);
        failIf(validateOrderDraft(draft));
        orders.set(action.id, { ...existing, draft, revision: action.expectedRevision + 1, status: 'pending_review',
            updatedAt: timestamp(), reviewNotes: '', reviewChecks: emptyReviewChecks(), reviewedByUid: '', reviewedByName: '', reviewedAt: null, approvedRevision: 0 });
    } else if (action.type === 'review') {
        const review = buildOrderReview(existing, action.expectedRevision, action.decision, actor);
        orders.set(action.id, { ...existing, ...review, reviewedAt: timestamp(), updatedAt: timestamp() });
    } else throw new Error('지원하지 않는 로컬 검증 동작입니다.');
    const updated = orders.get(action.id);
    return { id: action.id, revision: updated.revision, status: updated.status };
}
async function readAction(req) {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 131072) throw new Error('요청 크기가 너무 큽니다.');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (req, res) => {
    const localOrigin = `http://${req.headers.host}`;
    if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)
        || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))
        || (req.headers.origin && req.headers.origin !== localOrigin)) return reply(res, 403, { error: 'Loopback verification only.' });
    const url = new URL(req.url, localOrigin);
    try {
        if (url.pathname === '/__order_ui/school-companies') {
            if (req.headers.authorization !== 'Bearer fictional-local-token-not-a-firebase-credential') return reply(res, 401, { ok: false });
            if (req.method === 'GET') return reply(res, 200, { ok: true, catalog: schoolCompanyCatalog, mode: 'fictional_local_only' });
            if (req.method !== 'POST' || req.headers.origin !== localOrigin || !req.headers['content-type']?.startsWith('application/json')) return reply(res, 405, { ok: false });
            const input = await readAction(req);
            if (input.expectedRevision !== schoolCompanyCatalog.revision) throw new Error('가상 업체 목록의 최신 버전을 불러와 주세요.');
            const companies = await buildSchoolMealCompanies(input.names);
            if (JSON.stringify(companies) !== JSON.stringify(schoolCompanyCatalog.companies)) schoolCompanyCatalog = { schemaVersion: 1, revision: schoolCompanyCatalog.revision + 1, companies };
            return reply(res, 200, { ok: true, catalog: schoolCompanyCatalog, mode: 'fictional_local_only' });
        }
        if (url.pathname.startsWith('/api/order-ai/')) {
            if (req.headers.authorization !== 'Bearer fictional-local-token-not-a-firebase-credential') return reply(res, 401, { ok: false });
            const referer = new URL(req.headers.referer || localOrigin), scenario = referer.searchParams.get('orderAiScenario') || 'valid';
            if (referer.origin !== localOrigin) return reply(res, 403, { ok: false });
            if (url.pathname.endsWith('/background')) {
                if (req.method === 'GET') return reply(res, 200, { ok: true, items: mailFixtures.map(mail => {
                    const saved = orderAiAnalyses.get(`${scenario}:${mail.id}`);
                    return { intakeId: mail.id, state: saved?.status === 'confirmed' ? 'confirmed' : saved ? 'ready' : mail.id === SCHOOL_MAIL_ID ? 'pending' : 'failed',
                        ...(saved ? { revision: saved.revision, confirmedAt: saved.confirmedAt } : mail.id !== SCHOOL_MAIL_ID ? { message: '가상 검증: 발주 첨부가 없는 자료입니다.' } : {}) };
                }), nextCursor: null, mode: 'fictional_local_only' });
                if (req.method !== 'POST' || req.headers.origin !== localOrigin) return reply(res, 405, { ok: false });
                const input = await readAction(req);
                if (input.action === 'sync') return reply(res, 200, { ok: true, sync: { status: 'complete', collected: 0, continuation: null }, mode: 'fictional_local_only' });
                if (input.action !== 'analyze' || input.intakeId !== SCHOOL_MAIL_ID) return reply(res, 400, { ok: false, message: '가상 자동 분석 대상을 확인해 주세요.' });
                if (scenario === 'unconfigured') return reply(res, 503, { ok: false, message: '가상 AI 연결이 꺼져 있습니다.' });
                const key = `${scenario}:${input.intakeId}`;
                if (!orderAiAnalyses.has(key)) orderAiAnalyses.set(key, createOrderAiFixture({ intakeId: input.intakeId, expectedRevision: 0 }, scenario, null));
                const saved = orderAiAnalyses.get(key);
                return reply(res, 200, { ok: true, intakeId: input.intakeId, state: saved.status === 'confirmed' ? 'confirmed' : 'ready', revision: saved.revision, confirmedAt: saved.confirmedAt, mode: 'fictional_local_only' });
            }
            if (url.pathname.endsWith('/text-sources')) {
                if (req.method === 'GET') {
                    const id = url.searchParams.get('id');
                    if (id) { const source = textSourceFixtures.get(id); return reply(res, source && Date.parse(source.expiresAt) > Date.now() ? 200 : 404, source && Date.parse(source.expiresAt) > Date.now() ? { ok: true, source } : { ok: false, message: '가상 원문의 보관 기간이 끝났거나 원문이 없습니다.' }); }
                    return reply(res, 200, { ok: true, sources: [...textSourceFixtures.values()].filter(source => Date.parse(source.expiresAt) > Date.now()).toReversed().map(({ text, contentBase64, ...summary }) => summary) });
                }
                if (req.method !== 'POST' || req.headers.origin !== localOrigin) return reply(res, 405, { ok: false });
                const sourceInput = await readAction(req);
                if (sourceInput.action === 'cleanupExpired') { let deletedCount = 0; for (const [id, source] of textSourceFixtures) { if (deletedCount < 50 && Date.parse(source.expiresAt) <= Date.now()) { textSourceFixtures.delete(id); deletedCount++; } } return reply(res, 200, { ok: true, deletedCount, mode: 'fictional_local_only' }); }
                const built = buildTextSource(sourceInput, actor.uid), existed = textSourceFixtures.get(built.id), createdMs = Date.now();
                const source = existed || { id: built.id, ...built.data, createdAt: new Date(createdMs).toISOString(), expiresAt: new Date(createdMs + SOURCE_RETENTION_MS).toISOString() };
                if (existed && existed.sha256 !== built.data.sha256) throw new Error('가상 요청 ID 충돌');
                textSourceFixtures.set(built.id, source); return reply(res, 200, { ok: true, source, created: !existed, mode: 'fictional_local_only' });
            }
            if (url.pathname.endsWith('/status') && req.method === 'GET') return reply(res, 200, { ok: true,
                configured: scenario !== 'unconfigured', mode: 'fictional_local_only', message: '로컬 가상 검증이며 실제 OpenAI에 연결하지 않습니다.' });
            const key = `${scenario}:${url.searchParams.get('intakeId')}`;
            if (url.pathname.endsWith('/analysis') && req.method === 'GET' && url.searchParams.get('list') === 'confirmed') {
                const records = [...orderAiAnalyses.entries()].filter(([id, analysis]) => id.startsWith(`${scenario}:`) && analysis.status === 'confirmed')
                    .map(([, analysis]) => ({ intakeId: analysis.intakeId, sourceKind: textSourceFixtures.get(analysis.intakeId)?.kind || 'mail', sourceHash: analysis.sourceHash,
                        revision: analysis.revision, confirmedRevision: analysis.confirmedRevision, confirmedAt: analysis.confirmedAt, confirmedByUid: analysis.confirmedByUid,
                        customer: analysis.customer, groups: analysis.groups.map(({ id, productId, label, quantity, unit }) => ({ id, productId, label, quantity, unit })),
                        lineCount: new Set(analysis.groups.flatMap(group => group.lineIds)).size }))
                    .sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt) || b.intakeId.localeCompare(a.intakeId));
                return reply(res, 200, { ok: true, records: records.slice(0, 25), nextCursor: null, mode: 'fictional_local_only' });
            }
            if (url.pathname.endsWith('/analysis') && req.method === 'GET') return reply(res, 200, { ok: true, analysis: orderAiAnalyses.get(key) || null, mode: 'fictional_local_only' });
            if (req.method !== 'POST' || req.headers.origin !== localOrigin || !req.headers['content-type']?.startsWith('application/json')) return reply(res, 405, { ok: false });
            if (scenario === 'unconfigured') return reply(res, 503, { ok: false, message: '가상 AI 연결이 꺼져 있습니다.', mode: 'fictional_local_only' });
            const input = await readAction(req), writeKey = `${scenario}:${input.intakeId}`, previous = orderAiAnalyses.get(writeKey);
            if (url.pathname.endsWith('/analysis')) {
                if (input.action === 'refresh-customer') {
                    const latest = orderAiCustomers().find(item => item.id === previous?.customer?.id);
                    if (!previous || latest?.name !== previous.customer.name || previous.revision !== input.expectedRevision || previous.updatedAt !== input.expectedUpdatedAt || previous.status === 'confirmed') return reply(res, 409, { ok: false, message: '가상 업체 정보를 다시 선택해 주세요.' });
                    const analysis = previous.customer.revision === latest.revision ? previous : { ...previous, revision: previous.revision + 1, updatedAt: new Date().toISOString(), customer: { ...previous.customer, revision: latest.revision } };
                    orderAiAnalyses.set(writeKey, analysis); return reply(res, 200, { ok: true, analysis, mode: 'fictional_local_only' });
                }
                const analysis = createOrderAiFixture(input, scenario, previous); orderAiAnalyses.set(writeKey, analysis);
                return reply(res, 200, { ok: true, analysis, mode: 'fictional_local_only' });
            }
            if (url.pathname.endsWith('/confirm')) {
                if (!previous || previous.updatedAt !== input.expectedUpdatedAt) throw new Error('가상 분석의 최신 버전을 다시 대조해 주세요.');
                const text = ['text', 'image'].includes(input.sourceKind) ? textSourceFixtures.get(input.intakeId) : null;
                const manualSources = text?.kind === 'image' ? [{ attachmentId: 'message-image', kind: 'image', complete: true, fileName: text.fileName, sha256: text.sha256, ...imageDimensions(Buffer.from(text.contentBase64, 'base64'), text.mimeType) }] : text ? [createOrderAiTextSource(text)] : null;
                assertOrderAiConfirmation(previous, { revision: input.expectedRevision, sourceHash: text?.sha256 || mailFixtures[0].rawStorage.sha256,
                    sources: manualSources || orderAiSources, customers: orderAiCustomers(), reviewedGroupIds: input.reviewedGroupIds,
                    reviewedExclusions: input.reviewedExclusions });
                const analysis = { ...previous, status: 'confirmed', revision: previous.revision + 1, confirmedRevision: previous.revision,
                    reviewedGroupIds: [...input.reviewedGroupIds], reviewedExclusions: input.reviewedExclusions === true,
                    confirmedByUid: actor.uid, confirmedAt: new Date().toISOString() };
                orderAiAnalyses.set(writeKey, analysis); return reply(res, 200, { ok: true, analysis, mode: 'fictional_local_only' });
            }
            return reply(res, 404, { ok: false, message: '가상 분석 경로가 없습니다.' });
        }
        if (url.pathname === '/api/ecount/login' && req.method === 'POST') {
            if (req.headers.authorization !== 'Bearer fictional-local-token-not-a-firebase-credential') return reply(res, 401, { ok: false });
            return reply(res, 503, { ok: false, hasSession: false, code: 'fictional_local_only', mode: 'fictional_local_only', message: '로컬 가상 검증에서는 실제 Ecount에 연결하지 않습니다.' });
        }
        if (url.pathname.startsWith('/api/naverworks/')) {
            if (req.headers.authorization !== 'Bearer fictional-local-token-not-a-firebase-credential') return reply(res, 401, { ok: false });
            const referer = new URL(req.headers.referer || localOrigin);
            if (referer.origin !== localOrigin) return reply(res, 403, { ok: false });
            if (url.pathname.endsWith('/source') && req.method === 'GET') {
                if (referer.searchParams.get('mailSourceScenario') === 'failure') return reply(res, 503, { ok: false });
                const intakeId = url.searchParams.get('intakeId');
                if (intakeId) {
                    const original = mailFixtures.find(record => record.id === intakeId);
                    const mail = original ? structuredClone(original) : null;
                    if (mail && referer.searchParams.get('mailBodyScenario') === 'deep') mail.raw.mail.body = `${'<div>'.repeat(100)}가상 복잡한 본문${'</div>'.repeat(100)}`;
                    if (mail && referer.searchParams.get('mailBodyScenario') === 'large') mail.raw.mail.body = `<p>${'가상 본문 '.repeat(180000)}</p>`;
                    return reply(res, mail ? 200 : 404, mail ? { ok: true, mail } : { ok: false });
                }
                const folderId = url.searchParams.get('folderId'), cursor = url.searchParams.get('cursor');
                if (folderId && folderId !== '106') return reply(res, 400, { ok: false });
                const nextToken = folderId ? 'fictional-school-page-2' : 'fictional-mail-page-2';
                if (cursor && cursor !== nextToken) return reply(res, 400, { ok: false });
                const records = referer.searchParams.get('mailSourceScenario') === 'empty' ? [] : folderId ? mailFixtures.filter(mail => mail.id !== TITLE_MAIL_ID) : mailFixtures;
                const offset = cursor ? 2 : 0;
                return reply(res, 200, { ok: true, mails: records.slice(offset, offset + 2).map(({ raw, ...summary }) => ({ ...summary, ...(folderId ? { folderId, observedAt: '2026-10-21T02:00:00.000Z' } : {}) })), nextCursor: records.length > offset + 2 ? nextToken : null, scope: { folderId }, schoolScope });
            }
            if (url.pathname.endsWith('/attachment') && req.method === 'POST' && req.headers.origin === localOrigin && req.headers['content-type']?.startsWith('application/json')) {
                const input = await readAction(req);
                if (input.intakeId !== SCHOOL_MAIL_ID || input.attachmentId !== '101') return reply(res, 404, { ok: false });
                const bytes = await readFile(new URL('fixtures/mail-workbooks/sample-school-order.xls', import.meta.url));
                return reply(res, 200, { ok: true, attachment: { id: '101', fileName: '가상 학교급식 발주서.xls', mimeType: 'application/vnd.ms-excel', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: bytes.toString('base64') } });
            }
            if (referer.searchParams.get('verificationRole') !== 'admin') return reply(res, 403, { ok: false });
            const connected = referer.searchParams.get('mailScenario') === 'connected';
            if (url.pathname.endsWith('/status') && req.method === 'GET') return reply(res, 200, {
                ok: true, configuration: { ready: connected, missing: connected ? [] : ['NAVERWORKS_CLIENT_SECRET', 'MAIL_TOKEN_ENCRYPTION_KEY', 'MAIL_COLLECTOR_EMAIL', 'MAIL_COLLECTOR_PASSWORD'] },
                connection: { connected, accessStatus: connected ? 'mailbox_access_verified' : 'not_connected', mailbox: 'official@dmnfood.co.kr' },
                schoolScope,
            });
            if (url.pathname.endsWith('/folders') && req.method === 'GET') {
                const scenario = referer.searchParams.get('schoolFolderScenario');
                const folders = scenario === 'missing' ? [{ id: '0', name: '받은메일함' }] : scenario === 'renamed' ? [{ id: '106', name: '이름이 변경된 메일함' }] : scenario === 'duplicate' ? [{ id: '106', name: '학교급식 발주' }, { id: '107', name: '학교급식 발주' }] : [{ id: '0', name: '받은메일함' }, { id: '106', name: '학교급식 발주' }];
                return reply(res, 200, { ok: true, folders, schoolScope: { ...schoolScope, available: !scenario, verified: true } });
            }
            if (url.pathname.endsWith('/sync') && req.method === 'POST' && connected && req.headers.origin === localOrigin && req.headers['content-type']?.startsWith('application/json')) {
                const input = await readAction(req);
                if (input.folderId !== '106' || input.scope !== 'school') return reply(res, 400, { ok: false });
                if (referer.searchParams.get('schoolFolderScenario')) return reply(res, 409, { ok: false, error: { code: 'school_mail_folder_unavailable' } });
                const complete = input.continuation === 'fictional-local-continuation';
                return reply(res, 200, { ok: true, sync: { status: complete ? 'complete' : 'partial', continuation: complete ? null : 'fictional-local-continuation',
                    scanned: complete ? 20 : 10, collected: complete ? 3 : 2, duplicates: 0, skipped: complete ? 17 : 8,
                    from: new Date(Date.now() - 7 * 86400000).toISOString(), to: new Date().toISOString(), mode: 'fictional_local_only',
                } });
            }
            return reply(res, 503, { ok: false, error: { code: 'configuration_required' } });
        }
        if (url.pathname === '/__order_ui/events' && req.method === 'GET') {
            res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
            streams.add(res); res.write(snapshot());
            req.on('close', () => streams.delete(res));
            return;
        }
        if (url.pathname === '/__order_ui/state' && req.method === 'GET') return reply(res, 200, state());
        if (url.pathname === '/__order_ui/action' && req.method === 'POST') {
            if (req.headers.origin !== localOrigin || !req.headers['content-type']?.startsWith('application/json')) return reply(res, 403, { error: 'Same-origin JSON requests only.' });
            const result = applyAction(await readAction(req));
            broadcast(); return reply(res, 200, result);
        }
        if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, { error: 'Method not allowed.' });
        if (url.pathname === '/') { res.writeHead(302, { ...headers, Location: '/orders' }); res.end(); return; }
        if (url.pathname === '/favicon.ico') { res.writeHead(204, headers); res.end(); return; }
        if (fixtures.has(url.pathname)) {
            const contents = await readFile(new URL(`fixtures/${fixtures.get(url.pathname)}`, import.meta.url), 'utf8');
            return reply(res, 200, contents, 'text/javascript; charset=utf-8');
        }
        const path = url.pathname === '/home' ? '/dashboard/home.html' : url.pathname === '/orders' ? '/dashboard/orders.html' : url.pathname;
        if (!uiFiles.has(path)) return reply(res, 404, { error: 'This local harness serves only the dashboard home and order UI.' });
        let contents = await readFile(new URL(path.slice(1), base), 'utf8');
        if (path === '/dashboard/js/order-notifications.js') contents = contents.replaceAll('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js', '/__order_ui/firestore.js');
        if (path === '/dashboard/style.css') contents = contents.replace(/^@import[^\r\n]+[\r\n]*/gm, '');
        const pageHeaders = {};
        if (path === '/dashboard/home.html') {
            // Authorize the existing page's exact inline module without allowing
            // arbitrary inline scripts or any remote code in this local harness.
            // HTML parsing normalizes CRLF/CR line endings before CSP hashing.
            const scriptHashes = [...contents.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
                .map(([, script]) => `'sha256-${createHash('sha256').update(script.replace(/\r\n?/g, '\n')).digest('base64')}'`);
            pageHeaders['Content-Security-Policy'] = headers['Content-Security-Policy']
                .replace("script-src 'self';", `script-src 'self' ${scriptHashes.join(' ')};`);
        }
        return reply(res, 200, contents, path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', pageHeaders);
    } catch (error) { reply(res, 400, { error: error.message || 'Local verification failed.' }); }
});
server.listen(PORT, HOST, () => console.info(`LOCAL FICTIONAL DATA ONLY: http://${HOST}:${PORT}/home → /orders (empty in-memory store; no Firebase or credentials)`));
function stop() { for (const stream of streams) stream.end(); server.close(); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
