import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../dashboard/js/order-ai-chat.js', import.meta.url), 'utf8');
class UiNode {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.listeners = new Map(); this.dataset = {}; this._text = ''; this.value = ''; this.disabled = false; this.hidden = false; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    fire(name) { return this.listeners.get(name)?.({ target: this, preventDefault() {} }); }
    click() { if (!this.disabled && !this.hidden) return this.fire('click'); }
}
const descendants = (node, predicate) => [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => descendants(child, predicate))];
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const customer = { id: 'school-fictional-only', name: '가상 거래처', revision: 1, source: 'school_meal', erpCode: null, syncState: 'confirmed' };
const mail = id => ({ id, subject: `${id} 가상 발주` });
function draft(intakeId = 'mail-A', revision = 1) {
    return { id: 'fictional-analysis', intakeId, revision, updatedAt: `fixture-${revision}`, status: 'needs_review', assistantMessage: `${intakeId} 분석 ${revision}`,
        customer: { id: customer.id, name: customer.name, revision: customer.revision, source: 'school_meal', erpCode: null }, readyForReview: true, canConfirm: false, questions: [], blockers: [], lines: [], exclusions: [],
        groups: [{ id: 'group-1', productId: 'oil-cn-1_8l', label: '가상 중국산 참기름', quantity: '6', unit: '병', lineIds: ['l1'] },
            { id: 'group-2', productId: 'oil-kr-1_8l', label: '가상 국산 참기름', quantity: '5', unit: '병', lineIds: ['l2'] }] };
}
function harness({ configured = true, respond, evidence = async () => true, ensure = async () => ({ created: false, revision: 1 }) } = {}) {
    const mount = new UiNode('section'), calls = [], listeners = new Map(), navigator = { onLine: true };
    let catalogCallback, catalogError, active = null, ensureCalls = 0;
    const api = async (session, path, options = {}) => {
        const call = { path, options }; calls.push(call);
        if (respond) { const result = await respond(path, options, call); if (result !== undefined) { if (result.analysis) active = structuredClone(result.analysis); return result; } }
        if (path === 'status') return { ok: true, configured };
        if (path.startsWith('analysis?')) return { ok: true, analysis: null };
        if (path === 'analysis') { active = draft(options.body.intakeId, options.body.expectedRevision + 1); return { ok: true, analysis: structuredClone(active) }; }
        if (path === 'confirm') return { ok: true, analysis: { ...active, status: 'confirmed' } };
        throw new Error(`Unexpected local fixture path: ${path}`);
    };
    const context = vm.createContext({ document: { createElement: tag => new UiNode(tag) }, navigator,
        window: { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name), confirm: () => true },
        AbortController, encodeURIComponent, requestOrderAi: api,
        ensureSchoolMealCompanies: async session => { ensureCalls++; return ensure(session); },
        subscribeSchoolMealCompanies: (next, error) => { catalogCallback = next; catalogError = error; queueMicrotask(() => next([{ ...customer }], { exists: true, revision: 1, fromCache: false, hasPendingWrites: false })); return () => {}; } });
    vm.runInContext(`${source.replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '')}\nglobalThis.start = initOrderAiChat;`, context);
    const app = context.start({ user: { uid: 'fictional-local-manager' } }, mount, { openEvidence: evidence });
    const nodes = predicate => descendants(mount, predicate), button = text => nodes(node => node.tagName === 'BUTTON' && node.textContent === text)[0];
    return { app, mount, calls, navigator, listeners, nodes, button,
        stage: () => nodes(node => node.className === 'order-ai-stage')[0]?.dataset.step,
        final: () => button('발주 확정') || button('발주 확인·확정 완료'),
        textarea: () => nodes(node => node.tagName === 'TEXTAREA')[0],
        ensureCalls: () => ensureCalls,
        updateCustomers: (items, metadata = { exists: true, revision: 1, fromCache: false, hasPendingWrites: false }) => catalogCallback(items, metadata),
        catalogError: () => catalogError(new Error('fictional catalog failure')),
        online(value) { navigator.onLine = value; listeners.get(value ? 'online' : 'offline')?.(); } };
}
async function analyzed(options = {}) {
    const app = harness(options); await settle(); app.app.setMail(mail('mail-A')); await settle(); app.button('발주 분석 시작').click(); await settle(); return app;
}
async function beginReview(app) { if (app.stage() === 'analysis') { app.button('원본 대조 시작')?.click(); await settle(); } }
async function reviewAll(app) {
    await beginReview(app);
    const buttons = app.nodes(node => node.tagName === 'BUTTON' && node.textContent === '원본 대조');
    for (const button of buttons) { button.click(); await settle(); }
}
async function toFinal(app) { app.button('최종 확인으로')?.click(); await settle(); }
const hasReviews = app => app.nodes(node => node.dataset.reviewed === 'true').length;

test('no selected mail has no start action; selecting a mail only loads an existing result', async () => {
    const app = harness(); await settle(); assert.equal(app.button('발주 분석 시작'), undefined); assert.equal(app.calls.length, 1);
    app.app.setMail(mail('mail-A')); await settle(); assert.deepEqual(app.calls.map(call => call.path), ['status', 'analysis?intakeId=mail-A']);
    assert.equal(app.button('발주 분석 시작').disabled, false); assert.equal(app.calls.filter(call => call.options.body).length, 0); assert.equal(app.stage(), 'analysis'); app.app.destroy();
});

test('missing server configuration disables explicit start without pretending AI is connected', async () => {
    const app = harness({ configured: false }); await settle(); app.app.setMail(mail('mail-A')); await settle();
    assert.equal(app.button('발주 분석 시작').disabled, true); app.button('발주 분석 시작').click(); assert.equal(app.calls.filter(call => call.path === 'analysis').length, 0);
    assert.match(app.mount.textContent, /AI 연결 설정/); app.app.destroy();
});

test('successful analysis waits for explicit review navigation and only one procedural stage exists', async () => {
    const app = await analyzed(); assert.equal(app.ensureCalls(), 1); assert.equal(app.calls.filter(call => call.path === 'analysis').length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(app.calls.find(call => call.path === 'analysis').options.body)), { intakeId: 'mail-A', expectedRevision: 0 });
    assert.equal(app.stage(), 'analysis'); assert.match(app.mount.textContent, /mail-A 분석 1/); assert.equal(app.nodes(node => node.className === 'order-ai-stage').length, 1);
    assert.equal(app.final(), undefined); assert.equal(app.button('원본 대조'), undefined); await beginReview(app);
    assert.equal(app.stage(), 'review'); assert.equal(app.button('답변 보내기'), undefined); assert.equal(app.final(), undefined); app.app.destroy();
});

test('current questions are compact and deduplicated while earlier conversation stays collapsed', async () => {
    const app = await analyzed({ respond: (path, options) => {
        if (path !== 'analysis') return; const analysis = draft(options.body.intakeId); analysis.readyForReview = false;
        analysis.questions = [{ text: '원산지를 확인해 주세요.' }]; analysis.blockers = [{ message: '원산지를 확인해 주세요.' }];
        analysis.conversation = [{ role: 'assistant', content: '이전 분석' }, { role: 'user', content: '이전 답변' }, { role: 'assistant', content: analysis.assistantMessage }]; return { ok: true, analysis };
    } });
    const pending = app.nodes(node => node.className === 'order-ai-pending')[0], history = app.nodes(node => node.className === 'order-ai-history')[0];
    assert.equal(descendants(pending, node => node.tagName === 'LI').length, 1); assert.ok(history); assert.notEqual(history.open, true); assert.match(history.textContent, /이전 분석/);
    assert.equal(app.button('원본 대조 시작').disabled, true); app.app.destroy();
});

test('unresolved analysis cannot bypass review or final gates through the step header', async () => {
    let evidenceCalls = 0;
    const app = await analyzed({ evidence: () => { evidenceCalls++; return true; }, respond: (path, options) => {
        if (path !== 'analysis') return; const analysis = draft(options.body.intakeId); analysis.readyForReview = false; analysis.blockers = [{ message: '상품 확인 필요' }]; return { ok: true, analysis };
    } });
    for (const text of ['원본 대조', '최종 확인']) {
        const step = app.nodes(node => node.tagName === 'BUTTON' && node.className.includes('order-ai-step') && node.textContent.endsWith(text))[0];
        assert.equal(step.disabled, true); step.fire('click'); assert.equal(app.stage(), 'analysis');
    }
    assert.equal(evidenceCalls, 0); assert.equal(app.final(), undefined); app.app.destroy();
});

test('a stale stored-result response cannot replace the newly selected mail', async () => {
    let finishOld;
    const app = harness({ respond: path => path === 'analysis?intakeId=mail-A' ? new Promise(resolve => { finishOld = resolve; }) : path === 'analysis?intakeId=mail-B' ? { ok: true, analysis: draft('mail-B') } : undefined });
    await settle(); app.app.setMail(mail('mail-A')); await settle(); app.app.setMail(mail('mail-B')); await settle(); finishOld({ ok: true, analysis: draft('mail-A') }); await settle();
    assert.match(app.mount.textContent, /mail-B 분석 1/); assert.doesNotMatch(app.mount.textContent, /mail-A 분석/); assert.equal(app.calls.find(call => call.path === 'analysis?intakeId=mail-A').options.signal.aborted, true); app.app.destroy();
});

test('navigation during delayed catalog initialization cannot start analysis for the former mail', async () => {
    let finishEnsure; const app = harness({ ensure: () => new Promise(resolve => { finishEnsure = resolve; }) });
    await settle(); app.app.setMail(mail('mail-A')); await settle(); app.button('발주 분석 시작').click(); await settle();
    app.app.setMail(mail('mail-B')); await settle(); finishEnsure({ created: false, revision: 1 }); await settle();
    assert.equal(app.calls.filter(call => call.path === 'analysis').length, 0, 'old catalog preparation must not incur an AI request');
    assert.equal(app.stage(), 'analysis'); assert.equal(app.button('발주 분석 시작').disabled, false); app.app.destroy();
});

test('a stale ongoing analysis is ignored after navigation even if its provider ignores abort', async () => {
    let finishOld; const app = harness({ respond: path => path === 'analysis' ? new Promise(resolve => { finishOld = resolve; }) : undefined });
    await settle(); app.app.setMail(mail('mail-A')); await settle(); app.button('발주 분석 시작').click(); await settle(); app.app.setMail(mail('mail-B')); await settle(); finishOld({ ok: true, analysis: draft('mail-A') }); await settle();
    assert.doesNotMatch(app.mount.textContent, /mail-A 분석/); assert.equal(app.button('발주 분석 시작').disabled, false); assert.equal(app.calls.find(call => call.path === 'analysis').options.signal.aborted, true); app.app.destroy();
});

test('every group must be reviewed before final and changing the current catalog invalidates progress', async () => {
    const app = await analyzed(); await beginReview(app); assert.equal(app.button('최종 확인으로').disabled, true);
    app.button('원본 대조').click(); await settle(); assert.equal(app.button('최종 확인으로').disabled, true); app.button('원본 대조').click(); await settle(); assert.equal(app.button('최종 확인으로').disabled, false);
    app.updateCustomers([{ ...customer, revision: 2 }]); assert.equal(app.stage(), 'analysis'); assert.equal(app.button('원본 대조 시작').disabled, true);
    app.updateCustomers([{ ...customer }], { exists: true, fromCache: true, hasPendingWrites: false }); assert.equal(app.button('원본 대조 시작').disabled, true);
    app.updateCustomers([{ ...customer }]); await beginReview(app); assert.equal(hasReviews(app), 0); assert.equal(app.button('최종 확인으로').disabled, true);
    await reviewAll(app); assert.equal(app.button('최종 확인으로').disabled, false); app.catalogError(); assert.equal(app.stage(), 'analysis'); app.app.destroy();
});

test('entering the final summary never confirms automatically, and navigating back preserves valid checks', async () => {
    const app = await analyzed(); await reviewAll(app); await toFinal(app); assert.equal(app.stage(), 'final'); assert.equal(app.final().disabled, false); assert.equal(app.calls.filter(call => call.path === 'confirm').length, 0);
    assert.equal(app.button('원본 대조'), undefined); assert.equal(app.button('답변 보내기'), undefined); assert.match(app.mount.textContent, /6 병/); assert.match(app.mount.textContent, /5 병/); assert.match(app.mount.textContent, /ERP 판매 입력은 후속/);
    app.button('원본 대조로 돌아가기').click(); await settle(); assert.equal(app.stage(), 'review'); assert.equal(hasReviews(app), 2); assert.equal(app.button('최종 확인으로').disabled, false); app.app.destroy();
});

test('a positive correction reply creates a new analysis version, clears reviews, and never confirms', async () => {
    const app = await analyzed(); await reviewAll(app); app.button('분석 내용 수정').click(); await settle(); app.textarea().value = '좋아'; app.nodes(node => node.tagName === 'FORM')[0].fire('submit'); await settle();
    assert.equal(app.calls.filter(call => call.path === 'confirm').length, 0); const request = app.calls.filter(call => call.path === 'analysis').at(-1); assert.equal(request.options.body.message, '좋아'); assert.equal(request.options.body.expectedRevision, 1);
    assert.equal(app.stage(), 'analysis'); assert.match(app.mount.textContent, /mail-A 분석 2/); await beginReview(app); assert.equal(hasReviews(app), 0); assert.equal(app.button('최종 확인으로').disabled, true); app.app.destroy();
});

test('selecting a weekly company sends its internal ID without inventing an ERP customer code', async () => {
    const app = await analyzed(); const select = app.nodes(node => node.tagName === 'SELECT')[0]; select.value = customer.id; select.fire('change'); await settle();
    const request = app.calls.filter(call => call.path === 'analysis').at(-1); assert.equal(request.options.body.customerId, customer.id); assert.equal(Object.hasOwn(request.options.body, 'customerCode'), false); assert.equal(app.stage(), 'analysis'); app.app.destroy();
});

test('offline transition leaves the final summary and requires fresh review after reconnecting', async () => {
    const app = await analyzed(); await reviewAll(app); await toFinal(app); app.online(false); assert.equal(app.stage(), 'analysis'); assert.equal(app.final(), undefined); app.online(true); await beginReview(app);
    assert.equal(hasReviews(app), 0); assert.equal(app.button('최종 확인으로').disabled, true); app.app.destroy();
});

test('disconnecting and reconnecting while a source dialog is open invalidates its pending acceptance', async () => {
    let finishEvidence; const app = await analyzed({ evidence: () => new Promise(resolve => { finishEvidence = resolve; }) }); await beginReview(app);
    app.button('원본 대조').click(); app.online(false); app.online(true); finishEvidence(true); await settle(); await beginReview(app); assert.equal(hasReviews(app), 0); assert.equal(app.button('최종 확인으로').disabled, true); app.app.destroy();
});

test('a catalog change and reversal during an open source dialog cannot restore its pending review', async () => {
    let finishEvidence; const app = await analyzed({ evidence: () => new Promise(resolve => { finishEvidence = resolve; }) }); await beginReview(app);
    app.button('원본 대조').click(); app.updateCustomers([{ ...customer, revision: 2 }]); app.updateCustomers([{ ...customer }]); finishEvidence(true); await settle(); await beginReview(app);
    assert.equal(hasReviews(app), 0); assert.equal(app.button('최종 확인으로').disabled, true); app.app.destroy();
});

test('unchanged catalog snapshots do not discard already completed source reviews', async () => {
    const app = await analyzed(); await reviewAll(app); app.updateCustomers([{ ...customer }]); assert.equal(app.stage(), 'review'); assert.equal(hasReviews(app), 2); assert.equal(app.button('최종 확인으로').disabled, false); app.app.destroy();
});

test('excluded rows need a separate review and explicit proof is sent only from final confirmation', async () => {
    const app = await analyzed({ respond: (path, options) => {
        if (path === 'analysis') { const analysis = draft(options.body.intakeId); analysis.exclusions = [{ attachmentId: '101', sheetIndex: 0, rowIndex: 0, reason: '가상 제목 행' }]; return { ok: true, analysis }; }
    } });
    await reviewAll(app); assert.equal(app.button('최종 확인으로').disabled, true); assert.match(app.mount.textContent, /2 \/ 3 확인/); app.button('제외한 행 원본 확인').click(); await settle(); assert.equal(app.button('최종 확인으로').disabled, false); await toFinal(app);
    assert.equal(app.calls.filter(call => call.path === 'confirm').length, 0); app.final().click(); await settle(); const request = app.calls.find(call => call.path === 'confirm'); assert.equal(request.options.body.reviewedExclusions, true); assert.deepEqual(Array.from(request.options.body.reviewedGroupIds), ['group-1', 'group-2']);
    assert.equal(app.stage(), 'final'); assert.equal(app.final().disabled, true); app.app.destroy();
});

test('failed final confirmation clears source checks and returns to analysis', async () => {
    const app = await analyzed({ respond: path => path === 'confirm' ? Promise.reject(new Error('최신 분석을 확인하세요.')) : undefined }); await reviewAll(app); await toFinal(app); app.final().click(); await settle();
    assert.match(app.mount.textContent, /최신 분석을 확인하세요/); assert.equal(app.stage(), 'analysis'); await beginReview(app); assert.equal(hasReviews(app), 0); assert.equal(app.button('최종 확인으로').disabled, true); app.app.destroy();
});

test('a source dialog for an old mail cannot review the newly selected analysis', async () => {
    let finishEvidence; const app = await analyzed({ evidence: () => new Promise(resolve => { finishEvidence = resolve; }) }); await beginReview(app);
    app.button('원본 대조').click(); app.app.setMail(mail('mail-B')); await settle(); app.button('발주 분석 시작').click(); await settle(); finishEvidence(true); await settle(); assert.match(app.mount.textContent, /mail-B 분석/); await beginReview(app); assert.equal(hasReviews(app), 0); app.app.destroy();
});

test('loading a confirmed record opens a read-only final summary without another analysis request', async () => {
    const app = harness({ respond: path => path.startsWith('analysis?') ? { ok: true, analysis: { ...draft(), status: 'confirmed' } } : undefined }); await settle(); app.app.setMail(mail('mail-A')); await settle();
    assert.equal(app.stage(), 'final'); assert.equal(app.final().disabled, true); assert.equal(app.button('답변 보내기'), undefined); assert.equal(app.calls.filter(call => call.options.body).length, 0); assert.match(app.mount.textContent, /원본 대조와 확정 기록을 저장/); app.app.destroy();
});
