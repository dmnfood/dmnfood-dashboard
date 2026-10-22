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
function harness({ configured = true, respond, evidence, confirm = () => true, ensure = async () => ({ created: false, revision: 1 }) } = {}) {
    const mount = new UiNode('section'), calls = [], listeners = new Map(), navigator = { onLine: true };
    let catalogCallback, catalogError, active = null, ensureCalls = 0, cancelCalls = 0; const evidenceCalls = [], evidenceResolvers = [];
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
        window: { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name), confirm },
        AbortController, encodeURIComponent, queueMicrotask, requestOrderAi: api,
        ensureSchoolMealCompanies: async session => { ensureCalls++; return ensure(session); },
        subscribeSchoolMealCompanies: (next, error) => { catalogCallback = next; catalogError = error; queueMicrotask(() => next([{ ...customer }], { exists: true, revision: 1, fromCache: false, hasPendingWrites: false })); return () => {}; } });
    vm.runInContext(`${source.replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '')}\nglobalThis.start = initOrderAiChat;`, context);
    const app = context.start({ user: { uid: 'fictional-local-manager' } }, mount, { openEvidence: args => { evidenceCalls.push(args); if (evidence) return evidence(args); return new Promise(resolve => evidenceResolvers.push(resolve)); }, cancelEvidence: () => { cancelCalls++; } });
    const nodes = predicate => descendants(mount, predicate), button = text => nodes(node => node.tagName === 'BUTTON' && node.textContent === text)[0];
    return { app, mount, calls, navigator, listeners, nodes, button,
        stage: () => nodes(node => node.className === 'order-ai-stage')[0]?.dataset.step,
        final: () => button('발주 확정') || button('발주 확인·확정 완료'),
        textarea: () => nodes(node => node.tagName === 'TEXTAREA')[0],
        ensureCalls: () => ensureCalls, evidenceCalls, finishEvidence: accepted => evidenceResolvers.at(-1)?.(accepted), cancelCalls: () => cancelCalls,
        updateCustomers: (items, metadata = { exists: true, revision: 1, fromCache: false, hasPendingWrites: false }) => catalogCallback(items, metadata),
        catalogError: () => catalogError(new Error('fictional catalog failure')),
        online(value) { navigator.onLine = value; listeners.get(value ? 'online' : 'offline')?.(); } };
}
async function analyzed(options = {}) {
    const app = harness(options); await settle(); await app.app.setMail(mail('mail-A')); app.app.setAutomationState({ intakeId: 'mail-A', state: 'failed' }); app.button('다시 분석').click(); await settle(); return app;
}
async function reviewAll(app) {
    app.finishEvidence(true); await settle();
}
const reviewedCount = app => app.nodes(node => node.dataset.reviewed === 'true').length;

test('only tracked mail waits for background analysis, and failed automatic jobs offer explicit retry', async () => {
    const app = harness(); await settle(); assert.equal(app.button('발주 분석 시작'), undefined);
    await app.app.setMail(mail('mail-A')); assert.ok(app.button('발주 분석 시작'));
    app.app.setAutomationState({ intakeId: 'mail-A', state: 'pending' }); assert.equal(app.button('발주 분석 시작'), undefined); assert.match(app.mount.textContent, /자동 분석을 준비/);
    app.app.setAutomationState({ intakeId: 'mail-A', state: 'running' }); assert.match(app.mount.textContent, /자동 분석하고/);
    app.app.setAutomationState({ intakeId: 'mail-B', state: 'failed' }); assert.equal(app.button('다시 분석'), undefined);
    app.app.setAutomationState({ intakeId: 'mail-A', state: 'failed', message: '가상 분석 오류' }); assert.match(app.mount.textContent, /가상 분석 오류/); assert.ok(app.button('다시 분석'));
    assert.equal(app.calls.filter(call => call.path === 'analysis').length, 0); app.app.destroy();
});

test('older and outside-scope untracked mail keep a manual analysis action instead of waiting forever', async () => {
    for (const source of [{ ...mail('old-mail'), receivedAt: '2025-01-01T00:00:00Z', folderId: '106' }, { ...mail('outside-mail'), folderId: '1' }]) {
        const app = harness(); await settle(); await app.app.setMail(source); assert.equal(app.button('발주 분석 시작').disabled, false); assert.doesNotMatch(app.mount.textContent, /자동 분석을 준비/);
        assert.equal(app.calls.filter(call => call.path === 'analysis').length, 0); app.button('발주 분석 시작').click(); await settle(); assert.equal(app.calls.find(call => call.path === 'analysis').options.body.intakeId, source.id); app.app.destroy();
    }
});

test('three cards separate company, inline source and final action without extra product or exclusion controls', async () => {
    const app = await analyzed(); assert.equal(app.ensureCalls(), 1);
    assert.equal(app.nodes(node => node.tagName === 'ARTICLE' && node.className.includes('order-ai-review-card')).length, 3);
    assert.equal(app.nodes(node => node.className?.includes('order-ai-review-product')).length, 0);
    assert.ok(app.button('맞아요')); assert.ok(app.final()); assert.equal(app.final().disabled, true);
    assert.equal(app.nodes(node => node.className === 'order-ai-inline-evidence').length, 1);
    assert.equal(app.evidenceCalls.length, 1); assert.equal(app.evidenceCalls[0].mount.className, 'order-ai-inline-evidence');
    assert.equal(app.evidenceCalls[0].reviewAll, true);
    assert.equal(app.button('원본 대조 시작'), undefined); assert.equal(app.button('최종 확인으로'), undefined);
    assert.equal(app.nodes(node => node.tagName === 'BUTTON' && node.className.includes('order-ai-step')).length, 0);
    assert.equal(app.textarea(), undefined); assert.equal(app.nodes(node => node.tagName === 'DETAILS').length, 0); app.app.destroy();
});

test('confirming the proposed company is local, keeps the inline viewer and never calls AI or final confirmation', async () => {
    const app = await analyzed(), target = app.evidenceCalls[0].mount, before = app.calls.length;
    app.button('맞아요').click(); await settle(); assert.ok(app.button('업체 확인 완료'));
    assert.equal(app.calls.length, before); assert.equal(app.evidenceCalls.length, 1); assert.equal(app.evidenceCalls[0].mount, target); assert.equal(app.stage(), 'review');
    assert.equal(app.final().disabled, true); app.app.destroy();
});

test('all original groups and the company must be checked before the one final action enables', async () => {
    const app = await analyzed(); app.finishEvidence(true); await settle(); assert.equal(reviewedCount(app), 1);
    assert.equal(app.evidenceCalls.length, 1); assert.equal(app.final().disabled, true);
    app.button('맞아요').click(); await settle(); assert.equal(app.final().disabled, false); assert.equal(app.stage(), 'final');
    assert.equal(app.calls.filter(call => call.path === 'confirm').length, 0);
    app.final().click(); await settle(); assert.equal(app.final().disabled, true);
    const request = app.calls.find(call => call.path === 'confirm'); assert.deepEqual(Array.from(request.options.body.reviewedGroupIds), ['group-1', 'group-2']); assert.equal(request.options.body.reviewedExclusions, true);
    assert.match(app.mount.textContent, /원본 대조와 확정 기록을 저장/); app.app.destroy();
});

test('one whole-original review covers included products and excluded context without a separate exclusion action', async () => {
    const app = await analyzed({ respond: (path, options) => {
        if (path === 'analysis') { const value = draft(options.body.intakeId); value.exclusions = [{ attachmentId: '101', sheetIndex: 0, rowIndex: 0, reason: '가상 제목 행' }]; return { ok: true, analysis: value }; }
    } });
    app.button('맞아요').click(); assert.equal(app.final().disabled, true); assert.equal(app.evidenceCalls[0].reviewAll, true);
    assert.equal(app.button('제외한 행'), undefined); app.finishEvidence(true); await settle();
    assert.equal(app.evidenceCalls.length, 1); assert.equal(app.final().disabled, false); app.final().click(); await settle(); assert.equal(app.calls.find(call => call.path === 'confirm').options.body.reviewedExclusions, true); app.app.destroy();
});

test('cancelled source evidence cannot count as a review', async () => {
    const app = await analyzed(); app.button('맞아요').click(); app.finishEvidence(false); await settle();
    assert.equal(reviewedCount(app), 0); assert.equal(app.final().disabled, true); app.app.destroy();
});

test('questions are deduplicated and the editor appears only through the top correction button', async () => {
    const app = await analyzed({ respond: (path, options) => {
        if (path === 'analysis') return { ok: true, analysis: { ...draft(options.body.intakeId), readyForReview: false, questions: [{ text: '원산지 확인 필요' }], blockers: [{ message: '원산지 확인 필요' }] } };
    } });
    const pending = app.nodes(node => node.className === 'order-ai-pending')[0]; assert.equal(descendants(pending, node => node.tagName === 'LI').length, 1);
    assert.equal(app.textarea(), undefined); assert.equal(app.evidenceCalls.length, 0); assert.equal(app.final().disabled, true);
    app.button('수정').click(); assert.ok(app.textarea()); assert.ok(app.nodes(node => node.tagName === 'SELECT')[0]);
    app.button('수정 닫기').click(); assert.equal(app.textarea(), undefined); app.app.destroy();
});

test('a correction creates a new version and clears company and original review checks without confirming', async () => {
    const app = await analyzed(); app.button('맞아요').click(); await reviewAll(app); assert.equal(app.final().disabled, false);
    app.button('수정').click(); app.textarea().value = '좋아'; app.nodes(node => node.tagName === 'FORM')[0].fire('submit'); await settle();
    const request = app.calls.filter(call => call.path === 'analysis').at(-1); assert.equal(request.options.body.message, '좋아'); assert.equal(request.options.body.expectedRevision, 1); assert.equal(request.options.body.expectedUpdatedAt, 'fixture-1');
    assert.equal(reviewedCount(app), 0); assert.ok(app.button('맞아요')); assert.equal(app.final().disabled, true); assert.equal(app.calls.filter(call => call.path === 'confirm').length, 0);
    assert.equal(app.textarea(), undefined); app.app.destroy();
});

test('an open or unsent correction cannot accidentally finalize the old analysis', async () => {
    const app = await analyzed(); app.button('맞아요').click(); await reviewAll(app); assert.equal(app.final().disabled, false);
    app.button('수정').click(); assert.equal(app.final().disabled, true); app.textarea().value = '아직 보내지 않은 수정'; app.button('수정 닫기').click(); assert.equal(app.final().disabled, true);
    app.final().fire('click'); await settle(); assert.equal(app.calls.filter(call => call.path === 'confirm').length, 0); assert.match(app.mount.textContent, /작성 중인 수정 내용을/);
    app.button('수정').click(); app.textarea().value = ''; app.button('수정 닫기').click(); assert.equal(app.final().disabled, false); app.app.destroy();
});

test('choosing a different weekly company sends its internal ID and clears checks; choosing the same one costs no analysis', async () => {
    const other = { ...customer, id: 'school-another', name: '다른 가상 업체' }, app = await analyzed(); app.updateCustomers([{ ...customer }, other]); app.button('맞아요').click(); app.button('수정').click();
    let select = app.nodes(node => node.tagName === 'SELECT')[0], before = app.calls.filter(call => call.path === 'analysis').length; select.value = customer.id; select.fire('change'); await settle(); assert.equal(app.calls.filter(call => call.path === 'analysis').length, before);
    select = app.nodes(node => node.tagName === 'SELECT')[0]; select.value = other.id; select.fire('change'); await settle();
    const request = app.calls.filter(call => call.path === 'analysis').at(-1); assert.equal(request.options.body.customerId, other.id); assert.equal(Object.hasOwn(request.options.body, 'customerCode'), false); assert.ok(app.button('맞아요')); assert.equal(reviewedCount(app), 0); app.app.destroy();
});

test('an unrelated catalog revision refreshes the unchanged company metadata without another AI analysis', async () => {
    const latest = { ...customer, revision: 2 }, old = draft('mail-A', 7);
    const app = harness({ respond: (path, options) => path.startsWith('analysis?') ? { ok: true, analysis: old }
        : path === 'analysis' ? { ok: true, analysis: { ...draft(options.body.intakeId, 8), customer: { ...old.customer, revision: latest.revision } } } : undefined });
    await settle(); app.updateCustomers([latest]); await app.app.setMail(mail('mail-A')); await settle();
    assert.doesNotMatch(app.mount.textContent, /업체 정보 확인 필요|업체 정보가 변경되었습니다/); assert.equal(app.button('맞아요').disabled, false); assert.equal(app.final().disabled, true);
    const requests = app.calls.filter(call => call.path === 'analysis'); assert.equal(requests.length, 1); assert.equal(requests[0].options.body.action, 'refresh-customer');
    app.final().fire('click'); await settle(); assert.equal(app.calls.filter(call => call.path === 'confirm').length, 0);
    const request = requests[0]; assert.equal(Object.hasOwn(request.options.body, 'customerId'), false); assert.equal(request.options.body.expectedRevision, 7); assert.equal(request.options.body.expectedUpdatedAt, 'fixture-7'); assert.equal(Object.hasOwn(request.options.body, 'message'), false);
    assert.doesNotMatch(app.mount.textContent, /업체 정보가 변경되었습니다/); assert.equal(app.button('맞아요').disabled, false); assert.equal(reviewedCount(app), 0); assert.equal(app.final().disabled, true);
    app.button('맞아요').click(); await reviewAll(app); assert.equal(app.final().disabled, false); app.app.destroy();
});

test('a removed company asks for a new selection and cannot offer a same-ID refresh or final confirmation', async () => {
    const app = harness({ respond: path => path.startsWith('analysis?') ? { ok: true, analysis: draft() } : undefined });
    await settle(); app.updateCustomers([{ ...customer, id: 'school-another', name: '다른 가상 업체' }]); await app.app.setMail(mail('mail-A'));
    assert.match(app.mount.textContent, /학교급식 업체를 선택/); assert.equal(app.button('맞아요').disabled, true); assert.equal(app.final().disabled, true);
    app.button('수정').click(); assert.equal(app.button('업체 정보 새로고침'), undefined); assert.equal(app.nodes(node => node.tagName === 'SELECT')[0].value, ''); assert.equal(app.calls.filter(call => call.path === 'analysis').length, 0); app.app.destroy();
});

test('renamed company identities need an explicit selection and are never silently refreshed', async () => {
    const app = harness({ respond: path => path.startsWith('analysis?') ? { ok: true, analysis: draft() } : undefined });
    await settle(); app.updateCustomers([{ ...customer, name: '별도 등록 업체', revision: 2 }]); await app.app.setMail(mail('mail-A')); await settle();
    assert.equal(app.calls.filter(call => call.options.body).length, 0); assert.equal(app.button('맞아요').disabled, true);
    app.button('수정').click(); const select = app.nodes(node => node.tagName === 'SELECT')[0]; assert.equal(select.value, ''); select.value = customer.id; select.fire('change'); await settle();
    const request = app.calls.find(call => call.options.body); assert.equal(request.options.body.customerId, customer.id); assert.equal(request.options.body.action, undefined); app.app.destroy();
});

test('uncertain metadata refresh stops automatically and permits only an explicit retry', async () => {
    const app = harness({ respond: (path, options) => path.startsWith('analysis?') ? { ok: true, analysis: draft() } : path === 'analysis' ? Promise.reject(new Error('가상 목록 연결 실패')) : undefined });
    await settle(); app.updateCustomers([{ ...customer, revision: 2 }]); await app.app.setMail(mail('mail-A')); await settle(); await settle();
    assert.equal(app.calls.filter(call => call.options.body?.action === 'refresh-customer').length, 1); assert.equal(app.final().disabled, true); assert.match(app.mount.textContent, /목록 연결 실패/);
    app.updateCustomers([{ ...customer, revision: 2 }]); await settle(); assert.equal(app.calls.filter(call => call.options.body).length, 1);
    app.button('업체 정보 새로고침').click(); await settle(); assert.equal(app.calls.filter(call => call.options.body?.action === 'refresh-customer').length, 2); app.app.destroy();
});

test('an unrelated company addition at the same active identity does not reset current human checks', async () => {
    const app = await analyzed(); app.button('맞아요').click(); await reviewAll(app); const before = app.evidenceCalls.length;
    app.updateCustomers([{ ...customer }, { ...customer, id: 'school-other', name: '다른 가상 회사' }]); await settle();
    assert.ok(app.button('업체 확인 완료')); assert.equal(app.final().disabled, false); assert.equal(app.evidenceCalls.length, before); assert.equal(app.calls.filter(call => call.options.body?.action === 'refresh-customer').length, 0); app.app.destroy();
});

test('catalog changes invalidate company and source checks, including a reversal during pending evidence', async () => {
    const app = await analyzed(); app.button('맞아요').click(); const stale = app.evidenceCalls[0]; app.updateCustomers([{ ...customer, revision: 2 }]); app.updateCustomers([{ ...customer }]); app.finishEvidence(true); await settle();
    assert.equal(reviewedCount(app), 0, 'the cancelled first promise must not restore its review after catalog reversal');
    assert.ok(app.button('맞아요')); assert.equal(app.final().disabled, true); assert.notEqual(app.evidenceCalls.at(-1).mount, stale.mount); app.app.destroy();
});

test('an unchanged catalog snapshot preserves checked groups and the active original view', async () => {
    const app = await analyzed(); app.button('맞아요').click(); app.finishEvidence(true); await settle(); const before = app.evidenceCalls.length, view = app.evidenceCalls.at(-1).mount;
    app.updateCustomers([{ ...customer }]); await settle(); assert.equal(reviewedCount(app), 1); assert.ok(app.button('업체 확인 완료')); assert.equal(app.evidenceCalls.length, before); assert.equal(app.evidenceCalls.at(-1).mount, view); app.app.destroy();
});

test('offline and reconnect clear checks and reject acceptance from the formerly open source', async () => {
    let resolveOld; const app = await analyzed({ evidence: () => new Promise(resolve => { resolveOld ||= resolve; }) }); app.button('맞아요').click(); app.online(false); app.online(true); resolveOld(true); await settle();
    assert.equal(reviewedCount(app), 0); assert.ok(app.button('맞아요')); assert.equal(app.final().disabled, true); app.app.destroy();
});

test('late evidence for a former source cannot check the newly selected analysis', async () => {
    let resolveOld; const app = await analyzed({ evidence: () => new Promise(resolve => { resolveOld ||= resolve; }) }); app.button('맞아요').click();
    await app.app.setSource({ id: 'text-B', sourceKind: 'text' }, { analyze: true }); resolveOld(true); await settle();
    assert.equal(app.evidenceCalls.at(-1).mail.id, 'text-B'); assert.equal(reviewedCount(app), 0); assert.ok(app.button('맞아요')); app.app.destroy();
});

test('failed confirmation clears both local gates and leaves the same review card available', async () => {
    const app = await analyzed({ respond: path => path === 'confirm' ? Promise.reject(new Error('최신 분석을 확인하세요.')) : undefined }); app.button('맞아요').click(); await reviewAll(app); app.final().click(); await settle();
    assert.match(app.mount.textContent, /최신 분석을 확인하세요/); assert.equal(app.nodes(node => node.tagName === 'ARTICLE' && node.className.includes('order-ai-review-card')).length, 3); assert.equal(reviewedCount(app), 0); assert.ok(app.button('맞아요')); assert.equal(app.final().disabled, true); app.app.destroy();
});

test('background completion loads an untouched empty view without another paid analysis', async () => {
    let saved = null; const app = harness({ respond: path => path.startsWith('analysis?') ? { ok: true, analysis: saved } : undefined }); await settle(); await app.app.setMail(mail('mail-A')); saved = draft();
    await app.app.refreshAnalysis({ revision: 1 }); await settle(); assert.ok(app.button('맞아요')); assert.equal(app.evidenceCalls.length, 1); assert.equal(app.calls.filter(call => call.path === 'analysis').length, 0); app.app.destroy();
});

test('same or older background revisions avoid fetching or disturbing ongoing original review', async () => {
    const app = await analyzed(), before = app.calls.length, view = app.evidenceCalls[0].mount; app.button('맞아요').click();
    await app.app.refreshAnalysis({ revision: 1 }); await app.app.refreshAnalysis({ revision: 0 }); assert.equal(app.calls.length, before); assert.equal(app.evidenceCalls.length, 1); assert.equal(app.evidenceCalls[0].mount, view); assert.ok(app.button('업체 확인 완료')); app.app.destroy();
});

test('new background results do not overwrite an editor, original view or local review; replacement requires an explicit action', async () => {
    let saved = null; const app = await analyzed({ respond: path => path.startsWith('analysis?') ? { ok: true, analysis: saved } : undefined }); app.button('맞아요').click(); app.finishEvidence(true); await settle(); app.button('수정').click(); app.textarea().value = '작성 중인 내용';
    const view = app.evidenceCalls.at(-1).mount; saved = draft('mail-A', 2); await app.app.refreshAnalysis({ revision: 2 }); await settle();
    assert.equal(app.textarea().value, '작성 중인 내용'); assert.equal(reviewedCount(app), 1); assert.ok(app.button('업체 확인 완료')); assert.equal(app.evidenceCalls.at(-1).mount, view); assert.ok(app.button('불러오기')); assert.equal(app.final().disabled, true);
    app.button('불러오기').click(); await settle(); assert.equal(reviewedCount(app), 0); assert.ok(app.button('맞아요')); assert.equal(app.textarea(), undefined); assert.equal(app.button('불러오기'), undefined); app.app.destroy();
});

test('declining replacement keeps the pending saved result and current source checks', async () => {
    let saved = null; const app = await analyzed({ confirm: () => false, respond: path => path.startsWith('analysis?') ? { ok: true, analysis: saved } : undefined }); app.button('맞아요').click(); saved = draft('mail-A', 2); await app.app.refreshAnalysis({ revision: 2 });
    const before = app.calls.length; app.button('불러오기').click(); await settle(); assert.equal(app.calls.length, before); assert.ok(app.button('불러오기')); assert.ok(app.button('업체 확인 완료')); app.app.destroy();
});

test('a stale background result cannot replace a correction saved while it was loading', async () => {
    let finishRead, reads = 0; const app = await analyzed({ respond: path => {
        if (path.startsWith('analysis?') && ++reads > 1) return new Promise(resolve => { finishRead = resolve; });
    } });
    const refreshing = app.app.refreshAnalysis({ revision: 2 }); app.button('수정').click(); app.textarea().value = '수정'; app.nodes(node => node.tagName === 'FORM')[0].fire('submit'); await settle();
    finishRead({ ok: true, analysis: draft('mail-A', 9) }); await refreshing; await settle(); assert.equal(app.button('불러오기'), undefined); assert.equal(app.evidenceCalls.at(-1).analysis.revision, 2); app.app.destroy();
});

test('confirmed records stay read-only within the same card and never migrate or reanalyze', async () => {
    const app = harness({ respond: path => path.startsWith('analysis?') ? { ok: true, analysis: { ...draft(), customerCatalogSource: 'erp', status: 'confirmed' } } : undefined }); await settle(); await app.app.setMail(mail('mail-A'));
    assert.equal(app.final().disabled, true); assert.equal(app.button('맞아요'), undefined); assert.equal(app.button('수정'), undefined); assert.equal(app.textarea(), undefined); assert.equal(app.calls.filter(call => call.options.body).length, 0); assert.equal(app.evidenceCalls[0].reviewAll, true); assert.equal(app.evidenceCalls[0].analysis.groups[0].quantity, '6'); assert.match(app.mount.textContent, /원본 대조와 확정 기록을 저장/); app.app.destroy();
});

test('legacy drafts require an explicit migration and cannot confirm against the obsolete catalog', async () => {
    const app = harness({ respond: (path, options) => path.startsWith('analysis?') ? { ok: true, analysis: { ...draft('mail-A', 7), customerCatalogSource: 'erp', questions: [{ text: 'ERP 코드 입력' }] } }
        : path === 'analysis' ? { ok: true, analysis: draft(options.body.intakeId, 8) } : undefined }); await settle(); await app.app.setMail(mail('mail-A'));
    assert.equal(app.evidenceCalls.length, 0); assert.equal(app.button('맞아요').disabled, true); assert.equal(app.final().disabled, true); assert.doesNotMatch(app.mount.textContent, /ERP 코드 입력/);
    app.button('업체 목록으로 다시 분석').click(); await settle(); assert.equal(app.calls.find(call => call.path === 'analysis').options.body.expectedRevision, 7); assert.ok(app.button('맞아요')); app.app.destroy();
});

test('text and image source kinds survive automatic analysis and explicit final confirmation', async () => {
    for (const sourceKind of ['text', 'image']) {
        const app = harness(); await settle(); await app.app.setSource({ id: sourceKind + '-A', sourceKind }, { analyze: true });
        assert.equal(app.calls.find(call => call.path === 'analysis').options.body.sourceKind, sourceKind);
        app.button('맞아요').click(); await reviewAll(app); app.final().click(); await settle(); assert.equal(app.calls.find(call => call.path === 'confirm').options.body.sourceKind, sourceKind); app.app.destroy();
    }
});

test('reopening an analyzed manual source never silently incurs another analysis', async () => {
    const app = harness({ respond: path => path.startsWith('analysis?') ? { ok: true, analysis: draft('text-A') } : undefined }); await settle();
    await app.app.setSource({ id: 'text-A', sourceKind: 'text' }, { analyze: true }); assert.equal(app.calls.filter(call => call.path === 'analysis').length, 0); app.app.destroy();
});

test('delayed readiness and stored responses cannot overwrite a later source selection', async () => {
    let finishStatus; const app = harness({ respond: path => path === 'status' ? new Promise(resolve => { finishStatus = resolve; }) : undefined });
    const first = app.app.setSource({ id: 'text-A', sourceKind: 'text' }, { analyze: true }); const second = app.app.setMail(mail('mail-B')); finishStatus({ ok: true, configured: true }); await first; await second; await settle();
    assert.equal(app.calls.filter(call => call.path === 'analysis').length, 0); assert.equal(app.calls.some(call => call.path === 'analysis?intakeId=text-A'), false); assert.ok(app.button('발주 분석 시작')); app.app.destroy();
});

test('missing server configuration disables manual analysis and does not fake connection readiness', async () => {
    const app = harness({ configured: false }); await settle(); await app.app.setSource({ id: 'text-A', sourceKind: 'text' });
    assert.equal(app.button('발주 분석 시작').disabled, true); assert.match(app.mount.textContent, /AI 연결 설정/); assert.equal(app.calls.filter(call => call.path === 'analysis').length, 0); app.app.destroy();
});

test('source switches during delayed catalog preparation cannot start an old paid analysis', async () => {
    let finishEnsure; const app = harness({ ensure: () => new Promise(resolve => { finishEnsure = resolve; }) }); await settle(); await app.app.setSource({ id: 'text-A', sourceKind: 'text' }); app.button('발주 분석 시작').click(); await settle();
    await app.app.setMail(mail('mail-B')); finishEnsure({ created: false, revision: 1 }); await settle(); assert.equal(app.calls.filter(call => call.path === 'analysis').length, 0); assert.equal(app.evidenceCalls.length, 0); app.app.destroy();
});
