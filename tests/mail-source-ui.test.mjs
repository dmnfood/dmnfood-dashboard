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
    assert.match(getMailAttachmentPolicy({ ...ordinary, filename: '발주서.pdf', contentType: 'application/pdf' }).restriction, /네이버웍스/);
    assert.match(getMailAttachmentPolicy({ ...ordinary, contentType: 'image/png' }).restriction, /형식이 달라/);
    for (const size of [0, -1, NaN, 1.5, undefined]) assert.match(getMailAttachmentPolicy({ ...ordinary, size }).restriction, /크기/);
    assert.match(getMailAttachmentPolicy({ ...ordinary, size: 3 * 1024 * 1024 + 1 }).restriction, /네이버웍스/);
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
    showModal() { this.open = true; }
    close() { this.open = false; }
    remove() { this.removed = true; }
    focus() { this.focused = true; }
    scrollIntoView() {}
}
function uiNodes(node, predicate) { return [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => uiNodes(child, predicate))]; }
const settleUi = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
function viewerHarness(respond, href = 'https://dashboard.dmnfood.co.kr/orders', { split = false, summaryOnly = false, manageHistory = false, omitDetailMount = false, onSelectMail, onBeforeSelectMail, onWorkbookClosed, onMailLoaded, onPreviewAttachment, onHistoryChange } = {}) {
    const calls = [], listeners = new Map(), mount = new UiNode('section'), body = new UiNode('body'), location = { href, get search() { return new URL(this.href).search; } };
    const history = { state: {}, pushState(state, title, path) { location.href = new URL(path, location.href).href; }, replaceState(state, title, path) { location.href = new URL(path, location.href).href; } };
    const context = vm.createContext({ document: { body, createElement: tag => new UiNode(tag), createTextNode: value => { const node = new UiNode('#text'); node.nodeType = 3; node.textContent = value; return node; } }, Node: UiNode,
        location, window: { history, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) },
        URL, URLSearchParams, AbortController, DOMException, Intl, Date,
        fetch: async (path, settings) => { calls.push({ path, settings }); const body = await respond(new URL(path, location.href), settings); return { ok: true, status: 200, json: async () => body }; },
    });
    vm.runInContext(`${viewerSource.replace(/^export /gm, '')}\nglobalThis.startViewer = initMailSourceViewer`, context);
    const listMount = new UiNode('aside'), detailMount = new UiNode('section'), toolbarMount = new UiNode('div'), staticHeader = new UiNode('h2');
    staticHeader.textContent = '발주함'; detailMount.setAttribute('role', 'tabpanel'); detailMount.setAttribute('aria-labelledby', 'mailOriginalTab');
    if (split) mount.append(staticHeader, toolbarMount, listMount, ...(omitDetailMount ? [] : [detailMount]));
    const cleanup = context.startViewer({ user: { getIdToken: async () => 'fictional-ui-token' } }, mount, { ...(split ? { listMount, ...(omitDetailMount ? {} : { detailMount }), toolbarMount } : {}), summaryOnly, manageHistory, onSelectMail, onBeforeSelectMail, onWorkbookClosed, onMailLoaded, onPreviewAttachment, onHistoryChange });
    return { calls, mount, body, listMount, detailMount, toolbarMount, staticHeader, cleanup, location, listeners, select: () => uiNodes(mount, node => node.tagName === 'SELECT')[0] };
}
const scoped = (folderId, mails, nextCursor = null) => ({ ok: true, scope: { folderId }, mails, nextCursor });
const mailSummary = (id, folderId = '106') => ({ id, folderId, subject: id, from: 'fictional@example.test', receivedAt: '2026-10-21T01:00:00Z' });

test('source viewer starts in school scope and clears its folder-bound cursor when switching to all mail', async () => {
    const app = viewerHarness(url => url.searchParams.get('folderId') === '106' ? scoped('106', [mailSummary('school-first')], 'school-cursor') : scoped(null, [mailSummary('other-history', '0')]));
    await settleUi();
    assert.equal(app.calls[0].path, '/api/naverworks/source?folderId=106');
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
    uiNodes(app.listMount, node => node.className === 'mail-source-select')[0].fire('click'); await settleUi();
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

test('cancelled mail history navigation restores the active source URL without fetching or closing its work', async () => {
    let allowNavigation = true, prompts = 0, closed = 0, loaded = 0;
    const selected = [];
    const app = viewerHarness(url => url.searchParams.has('intakeId') ? { ok: true, mail: {
        ...mailSummary(url.searchParams.get('intakeId')), subject: '현재 범위가 저장된 원본', raw: { mail: {}, attachments: [ordinary] },
    } } : scoped('106', [mailSummary('active-source'), mailSummary('other-source')]),
    'https://dashboard.dmnfood.co.kr/orders?order=retained-order&mail=active-source', {
        split: true, onBeforeSelectMail: () => { prompts++; return allowNavigation; },
        onSelectMail: value => selected.push(value), onWorkbookClosed: () => closed++, onMailLoaded: () => loaded++,
    });
    await settleUi();
    const before = { requests: app.calls.length, closed, loaded, selected: selected.length, prompts, detail: app.detailMount.children[0], content: app.detailMount.textContent };
    allowNavigation = false;
    for (const next of [
        'https://dashboard.dmnfood.co.kr/orders?order=retained-order&mail=other-source#review',
        'https://dashboard.dmnfood.co.kr/orders?order=retained-order#review',
    ]) {
        app.location.href = next; app.listeners.get('popstate')(); await settleUi();
        const restored = new URL(app.location.href);
        assert.equal(restored.searchParams.get('mail'), 'active-source'); assert.equal(restored.searchParams.get('order'), 'retained-order'); assert.equal(restored.hash, '#review');
        assert.equal(app.calls.length, before.requests); assert.equal(closed, before.closed); assert.equal(loaded, before.loaded); assert.equal(selected.length, before.selected);
        assert.equal(app.detailMount.children[0], before.detail); assert.equal(app.detailMount.textContent, before.content);
    }
    assert.equal(prompts, before.prompts + 2, 'each cancelled attempt asks only once');
    app.cleanup();
});

test('allowed history switches ask once and carry the active source lifecycle through other and empty mail IDs', async () => {
    let prompts = 0, closed = 0;
    const selected = [], loaded = [];
    const app = viewerHarness(url => url.searchParams.has('intakeId') ? { ok: true, mail: {
        ...mailSummary(url.searchParams.get('intakeId')), raw: { mail: {}, attachments: [ordinary] },
    } } : scoped('106', [mailSummary('first-source'), mailSummary('second-source')]),
    'https://dashboard.dmnfood.co.kr/orders?mail=first-source', {
        onBeforeSelectMail: () => { prompts++; return true; }, onSelectMail: value => selected.push(value.id),
        onWorkbookClosed: () => closed++, onMailLoaded: value => loaded.push(value.id),
    });
    await settleUi();
    const before = { requests: app.calls.length, prompts, closed };
    app.location.href = 'https://dashboard.dmnfood.co.kr/orders?mail=second-source'; app.listeners.get('popstate')(); await settleUi();
    assert.equal(prompts, before.prompts + 1, 'selectMail must not prompt again after history guard already allowed it');
    assert.equal(closed, before.closed + 1); assert.equal(app.calls.length, before.requests + 1); assert.equal(app.calls.at(-1).path, '/api/naverworks/source?intakeId=second-source');
    assert.deepEqual(selected, ['first-source', 'second-source']); assert.deepEqual(loaded, ['first-source', 'second-source']);
    app.location.href = 'https://dashboard.dmnfood.co.kr/orders'; app.listeners.get('popstate')(); await settleUi();
    assert.equal(prompts, before.prompts + 2); assert.equal(closed, before.closed + 2); assert.equal(app.calls.length, before.requests + 1, 'clearing the mail does not fetch another source');
    assert.deepEqual(selected, ['first-source', 'second-source', '']); assert.match(app.mount.textContent, /왼쪽에서 메일을 선택/);
    app.listeners.get('popstate')(); await settleUi(); assert.equal(prompts, before.prompts + 2, 'unchanged history does not prompt');
    app.cleanup();
});

test('compact mail cards keep source actions on the left and omit duplicated details and attachment names', async () => {
    const summary = { ...mailSummary('compact-mail'), mailId: '5928', attachmentCount: 1 };
    const app = viewerHarness(url => url.searchParams.has('intakeId') ? { ok: true, mail: { ...summary, raw: { mail: {}, attachments: [ordinary] } } } : scoped('106', [summary]),
        'https://dashboard.dmnfood.co.kr/orders?mail=compact-mail', { split: true, summaryOnly: true });
    await settleUi();
    assert.equal(app.detailMount.textContent, '');
    assert.doesNotMatch(app.mount.textContent, /원본 보관|확인 링크 복사|보낸 사람|받은 시각|학교급식 발주서\.xls/);
    const card = uiNodes(app.listMount, node => node.className === 'mail-source-item')[0];
    assert.equal(card.tagName, 'ARTICLE');
    const select = uiNodes(card, node => node.className === 'mail-source-select')[0];
    assert.equal(uiNodes(select, node => ['A', 'BUTTON'].includes(node.tagName)).length, 1, 'selection button contains no nested action controls');
    const link = uiNodes(card, node => node.tagName === 'A')[0];
    assert.equal(link.textContent, '네이버웍스 ↗'); assert.equal(link.href, getNaverworksMailUrl(5928));
    assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener noreferrer');
    assert.equal(uiNodes(card, node => node.tagName === 'BUTTON' && node.textContent === '첨부파일').length, 1);
    app.cleanup();
});

test('opening an unselected mail attachment passes its own source without changing the active analysis or URL', async () => {
    const selections = [], loaded = [], previews = [];
    const summaries = ['active-mail', 'other-mail'].map((id, index) => ({ ...mailSummary(id), mailId: String(5928 + index), attachmentCount: 1 }));
    const app = viewerHarness(url => url.searchParams.has('intakeId') ? { ok: true, mail: { ...summaries.find(mail => mail.id === url.searchParams.get('intakeId')), raw: { mail: {}, attachments: [ordinary] } } } : scoped('106', summaries),
        'https://dashboard.dmnfood.co.kr/orders?mail=active-mail', { split: true, summaryOnly: true, onSelectMail: value => selections.push(value.id), onMailLoaded: value => loaded.push(value.id), onPreviewAttachment: (attachment, context) => previews.push({ attachment, mail: context.mail }) });
    await settleUi(); const before = app.location.href;
    uiNodes(app.listMount, node => node.tagName === 'BUTTON' && node.textContent === '첨부파일')[1].fire('click'); await settleUi();
    assert.deepEqual(selections, ['active-mail']); assert.deepEqual(loaded, ['active-mail']); assert.equal(app.location.href, before);
    assert.equal(previews.length, 1); assert.equal(previews[0].mail.id, 'other-mail'); assert.equal(previews[0].attachment.id, '101');
    assert.equal(app.calls.at(-1).path, '/api/naverworks/source?intakeId=other-mail');
    assert.equal(app.calls.filter(call => call.path.includes('/attachment')).length, 0, 'original bytes remain the existing evidence viewer responsibility');
    app.cleanup();
});

test('multiple attachments use a separate chooser and close it before opening the requested original', async () => {
    const previews = [], second = { ...ordinary, attachmentId: '102', filename: '다음 원본.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    const summary = { ...mailSummary('multi-mail'), mailId: '5928', attachmentCount: 3 };
    const app = viewerHarness(url => url.searchParams.has('intakeId') ? { ok: true, mail: { ...summary, raw: { mail: {}, attachments: [ordinary, second, { ...ordinary, attachmentId: '103', filename: '별도 확인.pdf', contentType: 'application/pdf' }] } } } : scoped('106', [summary]),
        'https://dashboard.dmnfood.co.kr/orders', { split: true, summaryOnly: true, onPreviewAttachment: (attachment, context) => previews.push({ attachment, sourceId: context.mail.id, pickerOpen: uiNodes(app.body, node => node.tagName === 'DIALOG')[0].open }) });
    await settleUi(); uiNodes(app.listMount, node => node.tagName === 'BUTTON' && node.textContent === '첨부파일')[0].fire('click'); await settleUi();
    assert.doesNotMatch(app.listMount.textContent, /학교급식 발주서|다음 원본|별도 확인/);
    const picker = uiNodes(app.body, node => node.tagName === 'DIALOG')[0]; assert.equal(picker.open, true);
    const choices = uiNodes(picker, node => node.tagName === 'BUTTON');
    assert.equal(choices.find(node => node.textContent === '별도 확인.pdf').disabled, true);
    choices.find(node => node.textContent === second.filename).fire('click');
    assert.equal(previews.length, 1); assert.equal(previews[0].attachment.id, '102'); assert.equal(previews[0].sourceId, 'multi-mail'); assert.equal(previews[0].pickerOpen, false);
    assert.equal(new URL(app.location.href).searchParams.has('mail'), false);
    app.cleanup();
});

test('late attachment metadata cannot reopen a previous source after mail selection or disposal', async () => {
    for (const dispose of [false, true]) {
        let finishPreview; const previews = [], summaries = ['active-mail', 'slow-mail'].map(id => ({ ...mailSummary(id), mailId: '5928', attachmentCount: 1 }));
        const source = id => ({ ok: true, mail: { ...summaries.find(mail => mail.id === id), raw: { mail: {}, attachments: [ordinary] } } });
        const app = viewerHarness(url => !url.searchParams.has('intakeId') ? scoped('106', summaries) : url.searchParams.get('intakeId') === 'slow-mail' ? new Promise(resolve => { finishPreview = resolve; }) : source('active-mail'),
            'https://dashboard.dmnfood.co.kr/orders', { split: true, summaryOnly: true, onPreviewAttachment: value => previews.push(value) });
        await settleUi(); uiNodes(app.listMount, node => node.tagName === 'BUTTON' && node.textContent === '첨부파일')[1].fire('click'); await settleUi();
        const pending = app.calls.at(-1);
        if (dispose) app.cleanup(); else { uiNodes(app.listMount, node => node.className === 'mail-source-select')[0].fire('click'); await settleUi(); }
        assert.equal(pending.settings.signal.aborted, true);
        finishPreview(source('slow-mail')); await settleUi(); assert.equal(previews.length, 0); assert.equal(uiNodes(app.body, node => node.tagName === 'DIALOG').length, 0);
        if (!dispose) app.cleanup();
    }
});

test('a selected source outside the current list stays visible with actions and clearing respects the navigation guard', async () => {
    let allowed = true; const selected = [];
    const app = viewerHarness(url => url.searchParams.has('intakeId') ? { ok: true, mail: { ...mailSummary('outside-mail', '0'), mailId: '5928', raw: { mail: {}, attachments: [ordinary] } } } : scoped('106', [mailSummary('inside-mail')]),
        'https://dashboard.dmnfood.co.kr/orders?mail=outside-mail', { split: true, summaryOnly: true, onBeforeSelectMail: () => allowed, onSelectMail: value => selected.push(value.id) });
    await settleUi(); assert.match(app.listMount.textContent, /현재 선택한 메일 · 목록 범위 밖/);
    assert.match(app.listMount.textContent, /outside-mail/); assert.equal(app.detailMount.textContent, '');
    allowed = false; assert.equal(app.cleanup.clearSelection(), false); assert.equal(new URL(app.location.href).searchParams.get('mail'), 'outside-mail');
    allowed = true; assert.equal(app.cleanup.clearSelection(), true); assert.equal(new URL(app.location.href).searchParams.has('mail'), false);
    assert.deepEqual(selected, ['outside-mail', '']); assert.doesNotMatch(app.listMount.textContent, /outside-mail|목록 범위 밖/);
    app.cleanup();
});

test('a parent can own shared-source history while mail selection and compact mounts remain available', async () => {
    const selected = [];
    const app = viewerHarness(url => url.searchParams.has('intakeId') ? { ok: true, mail: { ...mailSummary(url.searchParams.get('intakeId')), mailId: '5928', raw: { mail: {}, attachments: [ordinary] } } } : scoped('106', [mailSummary('first-mail'), mailSummary('second-mail')]),
        'https://dashboard.dmnfood.co.kr/orders?mail=first-mail', { split: true, summaryOnly: true, manageHistory: true, omitDetailMount: true, onSelectMail: value => selected.push(value.id) });
    await settleUi();
    assert.deepEqual(selected, ['first-mail']); assert.equal(app.listeners.has('popstate'), false);
    assert.equal(app.mount.children[0], app.staticHeader); assert.equal(app.detailMount.textContent, '');
    app.location.href = 'https://dashboard.dmnfood.co.kr/orders?mail=second-mail';
    await app.cleanup.selectMail('second-mail', { history: false, checkedNavigation: true });
    assert.deepEqual(selected, ['first-mail', 'second-mail']);
    assert.equal(app.cleanup.clearSelection({ history: false, checkedNavigation: true }), true); assert.deepEqual(selected, ['first-mail', 'second-mail', '']);
    const before = app.calls.length; app.cleanup(); await app.cleanup.selectMail('first-mail');
    assert.equal(app.calls.length, before, 'disposed parent callbacks cannot issue another source request');
});

test('parent history synchronization restores both mail scope and the selected source', async () => {
    const selected = [];
    const app = viewerHarness(url => url.searchParams.has('intakeId') ? { ok: true, mail: { ...mailSummary(url.searchParams.get('intakeId')), raw: { mail: {}, attachments: [] } } } : scoped(url.searchParams.get('folderId'), [mailSummary('school-mail')]),
        'https://dashboard.dmnfood.co.kr/orders?mail=school-mail', { split: true, summaryOnly: true, manageHistory: true, onSelectMail: value => selected.push(value.id) });
    await settleUi(); assert.equal(app.select().value, 'school'); assert.equal(app.listeners.has('popstate'), false);
    app.location.href = 'https://dashboard.dmnfood.co.kr/orders?mail=outside-mail&mail_scope=all';
    app.cleanup.syncHistory(); await settleUi();
    assert.equal(app.select().value, 'all'); assert.equal(app.calls.some(call => call.path === '/api/naverworks/source'), true);
    assert.deepEqual(selected, ['school-mail', 'outside-mail']);
    app.location.href = 'https://dashboard.dmnfood.co.kr/orders?mail=school-mail';
    app.cleanup.syncHistory(); await settleUi();
    assert.equal(app.select().value, 'school'); assert.equal(app.calls.at(-1).path, '/api/naverworks/source?intakeId=school-mail');
    assert.deepEqual(selected, ['school-mail', 'outside-mail', 'school-mail']);
    app.cleanup();
});

test('scope, selection and clear URL changes notify the parent after the resulting URL is available', async () => {
    const changed = [];
    const app = viewerHarness(url => url.searchParams.has('intakeId') ? { ok: true, mail: { ...mailSummary('selected-mail'), raw: { mail: {}, attachments: [] } } } : scoped(url.searchParams.get('folderId'), [mailSummary('selected-mail')]),
        'https://dashboard.dmnfood.co.kr/orders', { split: true, summaryOnly: true, manageHistory: true, onHistoryChange: () => changed.push(new URL(app.location.href).search) });
    await settleUi(); assert.deepEqual(changed, []);
    app.select().value = 'all'; app.select().fire('change'); await settleUi();
    assert.deepEqual(changed, ['?mail_scope=all']);
    await app.cleanup.selectMail('selected-mail');
    assert.deepEqual(changed, ['?mail_scope=all', '?mail_scope=all&mail=selected-mail']);
    assert.equal(app.cleanup.clearSelection({ history: 'replace' }), true);
    assert.deepEqual(changed, ['?mail_scope=all', '?mail_scope=all&mail=selected-mail', '?mail_scope=all']);
    await app.cleanup.selectMail('selected-mail', { history: false }); app.cleanup.clearSelection({ history: false });
    assert.equal(changed.length, 3, 'parent-owned navigation does not create duplicate history notifications');
    app.cleanup();
});
