import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { getMailAttachmentPolicy, getNaverworksMailUrl } from '../dashboard/js/mail-source-viewer.js';

const ordinary = { attachmentId: '101', filename: '학교급식 발주서.xls', contentType: 'application/vnd.ms-excel', size: 1200 };

test('ordinary Excel and CSV within the archive limit remain available', () => {
    for (const input of [ordinary,
        { ...ordinary, filename: '학교급식 발주서.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        { ...ordinary, filename: '학교급식 발주서.csv', contentType: 'text/plain; charset=utf-8' },
        { ...ordinary, size: 3 * 1024 * 1024, contentType: 'application/octet-stream' },
    ]) assert.equal(getMailAttachmentPolicy(input).restriction, '');
    assert.equal(getMailAttachmentPolicy(ordinary).fileName, ordinary.filename);
});

test('inline and expiring large-file sources cannot start archive downloads', () => {
    for (const input of [
        { ...ordinary, attachmentId: '-1' }, { ...ordinary, attachmentId: '0' },
        { ...ordinary, contentDisposition: 'inline' },
        { ...ordinary, bigFileFid: 'expiration-bound-id' },
        { ...ordinary, bigFileExpireTime: '2026-10-22T00:00:00Z' },
    ]) assert.match(getMailAttachmentPolicy(input).restriction, /본문 이미지·대용량/);
});

test('unsupported types, MIME mismatches, and unverified sizes have visible reasons', () => {
    assert.match(getMailAttachmentPolicy({ ...ordinary, filename: '발주서.pdf', contentType: 'application/pdf' }).restriction, /Excel/);
    assert.match(getMailAttachmentPolicy({ ...ordinary, contentType: 'image/png' }).restriction, /형식이 달라/);
    for (const size of [0, -1, NaN, 1.5, undefined]) assert.match(getMailAttachmentPolicy({ ...ordinary, size }).restriction, /크기/);
    assert.match(getMailAttachmentPolicy({ ...ordinary, size: 3 * 1024 * 1024 + 1 }).restriction, /3 MB/);
    assert.match(getMailAttachmentPolicy({ ...ordinary, filename: '발주\u0000서.xls' }).restriction, /이름/);
});

// A minimal DOM transport harness exercises list/history/request races.
// Workbook rendering is checked separately with its parser and real browsers.
const viewerSource = await readFile(new URL('../dashboard/js/mail-source-viewer.js', import.meta.url), 'utf8');
class UiNode {
    static TEXT_NODE = 3;
    static ELEMENT_NODE = 1;
    constructor(tag) { this.tagName = tag.toUpperCase(); this.nodeType = 1; this.children = []; this.listeners = new Map(); this.attributes = {}; this.dataset = {}; this._text = ''; this.value = ''; if (tag === 'template') this.content = { childNodes: [] }; }
    get childNodes() { return this.children; }
    get innerHTML() { return ''; }
    set innerHTML(value) { if (value) throw new Error('This transport harness does not parse HTML'); }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this._text = ''; this.children = children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] || null; }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    fire(name) { return this.listeners.get(name)?.({ target: this }); }
    scrollIntoView() {}
}
function uiNodes(node, predicate) { return [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => uiNodes(child, predicate))]; }
const settleUi = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
function viewerHarness(respond, href = 'https://dashboard.dmnfood.co.kr/orders', { split = false, onSelectMail } = {}) {
    const calls = [], listeners = new Map(), mount = new UiNode('section'), location = { href, get search() { return new URL(this.href).search; } };
    const history = { state: {}, pushState(state, title, path) { location.href = new URL(path, location.href).href; }, replaceState(state, title, path) { location.href = new URL(path, location.href).href; } };
    const context = vm.createContext({ document: { createElement: tag => new UiNode(tag), createTextNode: value => { const node = new UiNode('#text'); node.nodeType = 3; node.textContent = value; return node; } }, Node: UiNode,
        location, window: { history, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) },
        URL, URLSearchParams, AbortController, DOMException, Intl, Date,
        fetch: async (path, settings) => { calls.push({ path, settings }); const body = await respond(new URL(path, location.href), settings); return { ok: true, status: 200, json: async () => body }; },
    });
    vm.runInContext(`${viewerSource.replace(/^export /gm, '')}\nglobalThis.startViewer = initMailSourceViewer`, context);
    const listMount = new UiNode('aside'), detailMount = new UiNode('section'), toolbarMount = new UiNode('div'), staticHeader = new UiNode('h2');
    staticHeader.textContent = '발주함'; detailMount.setAttribute('role', 'tabpanel'); detailMount.setAttribute('aria-labelledby', 'mailOriginalTab');
    if (split) mount.append(staticHeader, toolbarMount, listMount, detailMount);
    const cleanup = context.startViewer({ user: { getIdToken: async () => 'fictional-ui-token' } }, mount, { ...(split ? { listMount, detailMount, toolbarMount } : {}), onSelectMail });
    return { calls, mount, listMount, detailMount, toolbarMount, staticHeader, cleanup, location, listeners, select: () => uiNodes(mount, node => node.tagName === 'SELECT')[0] };
}
const scoped = (folderId, mails, nextCursor = null) => ({ ok: true, scope: { folderId }, mails, nextCursor });
const mailSummary = (id, folderId = '106') => ({ id, folderId, subject: id, from: 'fictional@example.test', receivedAt: '2026-10-21T01:00:00Z' });

test('source viewer starts in school scope and clears its folder-bound cursor when switching to all mail', async () => {
    const app = viewerHarness(url => url.searchParams.get('folderId') === '106' ? scoped('106', [mailSummary('school-first')], 'school-cursor') : scoped(null, [mailSummary('other-history', '0')]));
    await settleUi();
    assert.equal(app.calls[0].path, '/api/naverworks/source?folderId=106');
    assert.match(app.mount.textContent, /수집할 때 ‘학교급식 발주’ 메일함에서 확인한 자료/);
    app.select().value = 'all'; app.select().fire('change'); await settleUi();
    assert.equal(app.calls.at(-1).path, '/api/naverworks/source');
    assert.match(app.location.search, /mail_scope=all/);
    assert.match(app.mount.textContent, /other-history/);
    assert.doesNotMatch(app.mount.textContent, /school-first/);
    app.cleanup();
});

test('outside-school mail deep links remain selected when a school or all-mail list is loaded', async () => {
    const app = viewerHarness(url => url.searchParams.has('intakeId') ? { ok: true, mail: { ...mailSummary('outside-mail', '0'), subject: '링크로 선택한 기존 원문', raw: { mail: { body: '' }, attachments: [] } } } : scoped(url.searchParams.get('folderId'), [mailSummary('school-first')]), 'https://dashboard.dmnfood.co.kr/orders?order=existing-order&mail=outside-mail');
    await settleUi();
    assert.match(app.mount.textContent, /링크로 선택한 기존 원문/);
    app.select().value = 'all'; app.select().fire('change'); await settleUi();
    assert.match(app.mount.textContent, /링크로 선택한 기존 원문/);
    assert.equal(app.calls.filter(call => call.path.includes('intakeId=')).length, 1);
    const url = new URL(app.location.href);
    assert.equal(url.searchParams.get('mail'), 'outside-mail');
    assert.equal(url.searchParams.get('order'), 'existing-order');
    app.cleanup();
});

test('a slow previous-school response cannot replace a newer all-mail selection', async () => {
    let finishSchool;
    const app = viewerHarness(url => url.searchParams.has('folderId') ? new Promise(resolve => { finishSchool = resolve; }) : scoped(null, [mailSummary('all-mail-result', '0')]));
    await settleUi();
    app.select().value = 'all'; app.select().fire('change'); await settleUi();
    assert.equal(app.calls[0].settings.signal.aborted, true);
    finishSchool(scoped('106', [mailSummary('stale-school-result')])); await settleUi();
    assert.match(app.mount.textContent, /all-mail-result/);
    assert.doesNotMatch(app.mount.textContent, /stale-school-result/);
    app.cleanup();
});

test('school list rejects an unscoped or wrong-folder response instead of showing unrelated mail', async () => {
    for (const reply of [scoped(null, [mailSummary('unrelated-inbox', '0')]), scoped('106', [mailSummary('unrelated-inbox', '0')])]) {
        const app = viewerHarness(() => reply); await settleUi();
        assert.match(app.mount.textContent, /메일 목록 확인이 필요합니다/);
        assert.doesNotMatch(app.mount.textContent, /unrelated-inbox/);
        app.cleanup();
    }
});


test('NAVER mail links use the fixed mail host and only canonical safe numeric source IDs', () => {
    for (const id of ['5928', 5928, 1, String(Number.MAX_SAFE_INTEGER)]) {
        assert.equal(getNaverworksMailUrl(id), `https://mail.worksmobile.com/read/popup?nMailId=${id}`);
    }
    for (const id of [undefined, null, {}, [], true, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
        '', '0', '05928', ' 5928', '5928 ', '5e3', '5928&url=https://evil.example', 'https://evil.example', 'javascript:alert(1)', '9007199254740992']) {
        assert.equal(getNaverworksMailUrl(id), '', String(id));
    }
});

test('split mounts preserve the surrounding card and render attachments without any mail body DOM', async () => {
    const hostileBody = '<script>HOSTILE_SCRIPT_SENTINEL</script><img src="https://external.example/pixel"><div>'.repeat(100) + 'PRIVATE_BODY_SENTINEL';
    const selected = [];
    const app = viewerHarness(url => url.searchParams.has('intakeId') ? { ok: true, mail: {
        ...mailSummary('school-original'), mailId: '5928', raw: { mail: { body: { content: hostileBody } }, attachments: [ordinary] },
    } } : scoped('106', [mailSummary('school-original')]), 'https://dashboard.dmnfood.co.kr/orders?order=retained-order&view=processing', { split: true, onSelectMail: value => selected.push({ ...value, mailInUrl: new URL(app.location.href).searchParams.get('mail') }) });
    await settleUi();
    assert.equal(app.mount.children[0], app.staticHeader);
    assert.equal(app.staticHeader.textContent, '발주함');
    assert.equal(uiNodes(app.toolbarMount, node => node.tagName === 'H2').length, 0);
    assert.equal(uiNodes(app.listMount, node => node.className === 'mail-source-item').length, 1);
    uiNodes(app.listMount, node => node.className === 'mail-source-item')[0].fire('click'); await settleUi();
    assert.equal(selected.length, 1);
    assert.equal(selected[0].id, 'school-original');
    assert.equal(selected[0].history, 'push');
    assert.equal(selected[0].mailInUrl, 'school-original', 'selection updates its history entry before a parent tab callback changes it');
    assert.equal(selected[0].mail.subject, 'school-original');
    assert.equal(selected[0].mail.raw, undefined);
    assert.equal(app.detailMount.getAttribute('role'), 'tabpanel');
    assert.equal(app.detailMount.getAttribute('aria-labelledby'), 'mailOriginalTab');
    assert.match(app.detailMount.textContent, /학교급식 발주서.xls/);
    assert.match(app.detailMount.textContent, /Excel 열람/);
    assert.doesNotMatch(app.detailMount.textContent, /PRIVATE_BODY_SENTINEL|HOSTILE_SCRIPT_SENTINEL|서식으로 보기|텍스트로 보기/);
    assert.equal(uiNodes(app.detailMount, node => ['IFRAME', 'PRE', 'TEMPLATE', 'SCRIPT', 'IMG'].includes(node.tagName)).length, 0);
    const openMail = uiNodes(app.detailMount, node => node.tagName === 'A' && node.href?.includes('worksmobile.com'))[0];
    assert.equal(openMail.href, 'https://mail.worksmobile.com/read/popup?nMailId=5928');
    assert.equal(openMail.target, '_blank');
    assert.equal(openMail.rel, 'noopener noreferrer');
    assert.equal(new URL(app.location.href).searchParams.get('order'), 'retained-order');
    assert.equal(new URL(app.location.href).searchParams.get('view'), 'processing');
    assert.equal(app.calls.filter(call => call.path.includes('/attachment')).length, 0, 'selecting a mail must not fetch its attachment');
    app.listeners.get('mail-intakes-updated')(); await settleUi();
    assert.equal(selected.length, 1, 'list refresh must not switch the active processing tab');
    app.cleanup();
});

test('deep links and browser history notify selection intent once while invalid IDs never form external links', async () => {
    const selected = [];
    const app = viewerHarness(url => url.searchParams.has('intakeId') ? { ok: true, mail: {
        ...mailSummary(url.searchParams.get('intakeId')), mailId: '5928&redirect=https://external.example', raw: { mail: { body: '<p>HIDDEN_MAIL_BODY</p>' }, attachments: [] },
    } } : scoped('106', []), 'https://dashboard.dmnfood.co.kr/orders?order=existing&mail=first-original', { onSelectMail: value => selected.push(value) });
    await settleUi();
    assert.equal(selected.length, 1); assert.equal(selected[0].id, 'first-original'); assert.equal(selected[0].history, false);
    assert.equal(uiNodes(app.mount, node => node.tagName === 'A').length, 0);
    assert.doesNotMatch(app.mount.textContent, /HIDDEN_MAIL_BODY/);
    assert.match(app.mount.textContent, /첨부파일이 없는 메일/);
    app.location.href = 'https://dashboard.dmnfood.co.kr/orders?order=existing&mail=second-original';
    app.listeners.get('popstate')(); await settleUi();
    assert.equal(selected.length, 2); assert.equal(selected[1].id, 'second-original'); assert.equal(selected[1].history, false);
    app.listeners.get('popstate')(); await settleUi();
    assert.equal(selected.length, 2, 'unchanged selection does not notify again');
    app.cleanup();
});
