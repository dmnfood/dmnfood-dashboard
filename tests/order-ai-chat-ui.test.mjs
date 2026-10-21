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
const customer = { code: '0007', name: '가상 거래처', revision: 1, syncState: 'confirmed' };
const mail = id => ({ id, subject: `${id} 가상 발주` });
function draft(intakeId = 'mail-A', revision = 1) {
    return { id: 'fictional-analysis', intakeId, revision, updatedAt: `fixture-${revision}`, status: 'needs_review', assistantMessage: `${intakeId} 분석 ${revision}`,
        customer: { code: customer.code, name: customer.name, revision: customer.revision }, readyForReview: true, canConfirm: false, questions: [], blockers: [], lines: [], exclusions: [],
        groups: [{ id: 'group-1', productId: 'oil-cn-1_8l', label: '가상 중국산 참기름', quantity: '6', unit: '병', lineIds: ['l1'] },
            { id: 'group-2', productId: 'oil-kr-1_8l', label: '가상 국산 참기름', quantity: '5', unit: '병', lineIds: ['l2'] }] };
}
function harness({ configured = true, respond, evidence = async () => true } = {}) {
    const mount = new UiNode('section'), calls = [], listeners = new Map(), navigator = { onLine: true };
    let catalogCallback, catalogError, active = null;
    const api = async (session, path, options = {}) => {
        const call = { path, options }; calls.push(call);
        if (respond) { const result = respond(path, options, call); if (result !== undefined) return result; }
        if (path === 'status') return { ok: true, configured };
        if (path.startsWith('analysis?')) return { ok: true, analysis: null };
        if (path === 'analysis') {
            active = draft(options.body.intakeId, options.body.expectedRevision + 1);
            return { ok: true, analysis: structuredClone(active) };
        }
        if (path === 'confirm') return { ok: true, analysis: { ...active, status: 'confirmed' } };
        throw new Error(`Unexpected local fixture path: ${path}`);
    };
    const context = vm.createContext({ document: { createElement: tag => new UiNode(tag) }, navigator,
        window: { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name), confirm: () => true },
        AbortController, encodeURIComponent,
        requestOrderAi: api,
        subscribeErpCustomers: (next, error) => { catalogCallback = next; catalogError = error; queueMicrotask(() => next([{ ...customer }], { fromCache: false, hasPendingWrites: false })); return () => {}; } });
    vm.runInContext(`${source.replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '')}\nglobalThis.start = initOrderAiChat;`, context);
    const app = context.start({ user: { uid: 'fictional-local-manager' } }, mount, { openEvidence: evidence });
    return { app, mount, calls, navigator, listeners,
        nodes: predicate => descendants(mount, predicate),
        button: text => descendants(mount, node => node.tagName === 'BUTTON' && node.textContent === text)[0],
        final: () => descendants(mount, node => node.tagName === 'BUTTON' && /최종 확정|확인·확정 완료/.test(node.textContent))[0],
        textarea: () => descendants(mount, node => node.tagName === 'TEXTAREA')[0],
        updateCustomers: (items, metadata = { fromCache: false, hasPendingWrites: false }) => catalogCallback(items, metadata),
        catalogError: () => catalogError(new Error('fictional catalog failure')),
        online(value) { navigator.onLine = value; listeners.get(value ? 'online' : 'offline')?.(); } };
}
async function analyzed(options = {}) {
    const app = harness(options); await settle(); app.app.setMail(mail('mail-A')); await settle(); app.button('발주 분석 시작').click(); await settle(); return app;
}
async function reviewAll(app) {
    const buttons = app.nodes(node => node.tagName === 'BUTTON' && node.textContent === '원본 대조');
    for (const button of buttons) { await button.click(); await settle(); }
}

test('no selected mail cannot start and selecting a mail only loads an existing result', async () => {
    const app = harness(); await settle();
    assert.equal(app.button('발주 분석 시작').disabled, true);
    app.button('발주 분석 시작').click(); assert.equal(app.calls.length, 1);
    app.app.setMail(mail('mail-A')); await settle();
    assert.deepEqual(app.calls.map(call => call.path), ['status', 'analysis?intakeId=mail-A']);
    assert.equal(app.button('발주 분석 시작').disabled, false);
    assert.equal(app.calls.filter(call => call.options.body).length, 0, 'mail navigation never incurs an AI generation request');
    app.app.destroy();
});

test('missing server configuration disables explicit start without pretending AI is connected', async () => {
    const app = harness({ configured: false }); await settle(); app.app.setMail(mail('mail-A')); await settle();
    assert.equal(app.button('발주 분석 시작').disabled, true); app.button('발주 분석 시작').click();
    assert.equal(app.calls.filter(call => call.path === 'analysis').length, 0);
    assert.match(app.mount.textContent, /AI 연결 설정/); app.app.destroy();
});

test('only explicit start issues the analysis request with the selected mail and fresh revision', async () => {
    const app = await analyzed();
    assert.equal(app.calls.filter(call => call.path === 'analysis').length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(app.calls.find(call => call.path === 'analysis').options.body)), { intakeId: 'mail-A', expectedRevision: 0 });
    assert.match(app.mount.textContent, /mail-A 분석 1/); assert.equal(app.final().disabled, true); app.app.destroy();
});

test('a stale stored-result response cannot replace the newly selected mail', async () => {
    let finishOld;
    const app = harness({ respond: path => path === 'analysis?intakeId=mail-A' ? new Promise(resolve => { finishOld = resolve; })
        : path === 'analysis?intakeId=mail-B' ? { ok: true, analysis: draft('mail-B') } : undefined });
    await settle(); app.app.setMail(mail('mail-A')); await settle(); app.app.setMail(mail('mail-B')); await settle();
    finishOld({ ok: true, analysis: draft('mail-A') }); await settle();
    assert.match(app.mount.textContent, /mail-B 분석 1/); assert.doesNotMatch(app.mount.textContent, /mail-A 분석/);
    assert.equal(app.calls.find(call => call.path === 'analysis?intakeId=mail-A').options.signal.aborted, true); app.app.destroy();
});

test('a stale ongoing analysis is ignored after navigation even if its provider ignores abort', async () => {
    let finishOld;
    const app = harness({ respond: (path, options) => path === 'analysis' ? new Promise(resolve => { finishOld = resolve; }) : undefined });
    await settle(); app.app.setMail(mail('mail-A')); await settle(); app.button('발주 분석 시작').click(); await settle();
    app.app.setMail(mail('mail-B')); await settle(); finishOld({ ok: true, analysis: draft('mail-A') }); await settle();
    assert.doesNotMatch(app.mount.textContent, /mail-A 분석/); assert.equal(app.button('발주 분석 시작').hidden, false);
    assert.equal(app.calls.find(call => call.path === 'analysis').options.signal.aborted, true); app.app.destroy();
});

test('every group must be explicitly reviewed and the customer must match the current confirmed catalog', async () => {
    const app = await analyzed();
    assert.equal(app.final().disabled, true);
    await app.button('원본 대조').click(); await settle(); assert.equal(app.final().disabled, true);
    await app.button('원본 대조').click(); await settle(); assert.equal(app.final().disabled, false);
    app.updateCustomers([{ ...customer, revision: 2 }]); assert.equal(app.final().disabled, true);
    app.updateCustomers([{ ...customer }], { fromCache: true, hasPendingWrites: false }); assert.equal(app.final().disabled, true);
    app.updateCustomers([{ ...customer }]); assert.equal(app.final().disabled, true);
    await reviewAll(app); assert.equal(app.final().disabled, false);
    app.catalogError(); assert.equal(app.final().disabled, true); app.app.destroy();
});

test('a positive chat reply creates a new analysis version and never confirms the prior one', async () => {
    const app = await analyzed(); await reviewAll(app); assert.equal(app.final().disabled, false);
    app.textarea().value = '좋아'; app.nodes(node => node.tagName === 'FORM')[0].fire('submit'); await settle();
    assert.equal(app.calls.filter(call => call.path === 'confirm').length, 0);
    const request = app.calls.filter(call => call.path === 'analysis').at(-1);
    assert.equal(request.options.body.message, '좋아'); assert.equal(request.options.body.expectedRevision, 1);
    assert.match(app.mount.textContent, /mail-A 분석 2/); assert.equal(app.final().disabled, true);
    assert.equal(app.nodes(node => node.dataset.reviewed === 'true').length, 0); app.app.destroy();
});

test('offline transition clears prior reviews and reconnecting requires fresh source checks', async () => {
    const app = await analyzed(); await reviewAll(app); assert.equal(app.final().disabled, false);
    app.online(false); assert.equal(app.final().disabled, true);
    app.online(true); assert.equal(app.final().disabled, true);
    assert.equal(app.nodes(node => node.dataset.reviewed === 'true').length, 0); app.app.destroy();
});

test('a source dialog opened before going offline cannot restore stale review checks', async () => {
    let finishEvidence;
    const app = await analyzed({ evidence: () => new Promise(resolve => { finishEvidence = resolve; }) });
    const pending = app.button('원본 대조').click(); app.online(false); finishEvidence(true); await pending; await settle(); app.online(true);
    assert.equal(app.nodes(node => node.dataset.reviewed === 'true').length, 0); assert.equal(app.final().disabled, true); app.app.destroy();
});

test('disconnecting and reconnecting while a source dialog is open also invalidates its pending acceptance', async () => {
    let finishEvidence;
    const app = await analyzed({ evidence: () => new Promise(resolve => { finishEvidence = resolve; }) });
    const pending = app.button('원본 대조').click(); app.online(false); app.online(true); finishEvidence(true); await pending; await settle();
    assert.equal(app.nodes(node => node.dataset.reviewed === 'true').length, 0); app.app.destroy();
});

test('a catalog change and reversal during an open source dialog cannot restore its pending review', async () => {
    let finishEvidence;
    const app = await analyzed({ evidence: () => new Promise(resolve => { finishEvidence = resolve; }) });
    const pending = app.button('원본 대조').click();
    app.updateCustomers([{ ...customer, revision: 2 }]); app.updateCustomers([{ ...customer }]);
    finishEvidence(true); await pending; await settle();
    assert.equal(app.nodes(node => node.dataset.reviewed === 'true').length, 0); assert.equal(app.final().disabled, true); app.app.destroy();
});

test('excluded source rows need a separate explicit review and its proof is sent with final confirmation', async () => {
    const app = await analyzed({ respond: (path, options) => {
        if (path === 'analysis') { const analysis = draft(options.body.intakeId); analysis.exclusions = [{ attachmentId: '101', sheetIndex: 0, rowIndex: 0, reason: '가상 제목 행' }]; return { ok: true, analysis }; }
    } });
    await reviewAll(app); assert.equal(app.final().disabled, true);
    await app.button('제외한 행 원본 확인').click(); await settle(); assert.equal(app.final().disabled, false);
    app.final().click(); await settle(); const request = app.calls.find(call => call.path === 'confirm');
    assert.equal(request.options.body.reviewedExclusions, true);
    assert.deepEqual(Array.from(request.options.body.reviewedGroupIds), ['group-1', 'group-2']); app.app.destroy();
});

test('analysis errors preserve the prior result but a failed confirmation clears all review checks', async () => {
    const app = await analyzed({ respond: path => path === 'confirm' ? Promise.reject(new Error('최신 분석을 확인하세요.')) : undefined });
    await reviewAll(app); assert.equal(app.final().disabled, false); app.final().click(); await settle();
    assert.match(app.mount.textContent, /최신 분석을 확인하세요/); assert.equal(app.final().disabled, true);
    assert.equal(app.nodes(node => node.dataset.reviewed === 'true').length, 0); app.app.destroy();
});

test('a review dialog for an old analysis cannot mark a newer mail or revision reviewed', async () => {
    let finishEvidence;
    const app = await analyzed({ evidence: () => new Promise(resolve => { finishEvidence = resolve; }) });
    const pending = app.button('원본 대조').click(); app.app.setMail(mail('mail-B')); await settle();
    app.button('발주 분석 시작').click(); await settle(); finishEvidence(true); await pending; await settle();
    assert.match(app.mount.textContent, /mail-B 분석/); assert.equal(app.nodes(node => node.dataset.reviewed === 'true').length, 0); app.app.destroy();
});
