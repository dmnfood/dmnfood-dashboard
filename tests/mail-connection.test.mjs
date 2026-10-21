import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../dashboard/js/mail-connection.js', import.meta.url), 'utf8');

class Node {
  constructor(tag, document = null) { this.tagName = tag; this.document = document; this.parentNode = null; this.children = []; this.listeners = new Map(); this.attributes = {}; this.dataset = {}; this.disabled = false; this.value = ''; this._text = ''; this.open = false; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { for (const child of children) child.parentNode = this; this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; for (const child of this.children) child.parentNode = null; this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  removeEventListener(name, handler) { if (this.listeners.get(name) === handler) this.listeners.delete(name); }
  async fire(name, values = {}) { return this.listeners.get(name)?.({ target: this, preventDefault() {}, ...values }); }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  querySelector(selector) { const action = selector.match(/^\[data-mail-action="([a-z-]+)"\]$/)?.[1]; return action ? findAll(this, child => child.dataset.mailAction === action)[0] || null : null; }
  focus() { if (this.document) this.document.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get('close')?.({ target: this }); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
}
function findAll(node, predicate) { return [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => findAll(child, predicate))]; }
function findButton(mount, text) {
  const button = findAll(mount, node => node.tagName === 'button' && node.textContent === text)[0];
  assert.ok(button, `Missing button: ${text}`); return button;
}
const settled = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const configured = (connection = {}) => ({ ok: true, configuration: { ready: true, missing: [] },
  connection: { connected: true, mailbox: 'official@dmnfood.co.kr', accessStatus: 'mailbox_access_verified', ...connection },
  pilot: { days: 7, mode: 'raw_mail_only', interpretationReady: false }, lastSync: null });
const schoolFolders = folders => ({ ok: true, folders, schoolScope: { folderId: '106', folderName: '학교급식 발주', available: true, verified: true, collectionMode: 'manual', automatic: false } });

function panel({ role = 'admin', responses, url = 'https://dashboard.dmnfood.co.kr/orders' } = {}) {
  const calls = [], navigations = [], historyReplacements = [];
  const document = { activeElement: null, createElement: tag => new Node(tag, document) }, mount = new Node('section', document);
  const context = vm.createContext({ document, window: { location: { href: url, assign: url => navigations.push(url) }, history: { state: { selected: true }, replaceState: (state, title, path) => historyReplacements.push({ state, title, path }) } },
    AbortController, DOMException, URL, Intl, Date,
    fetch: async (path, settings) => {
      calls.push({ path, settings });
      const result = await responses(path, settings, calls);
      return { ok: result.status ? result.status >= 200 && result.status < 300 : true, status: result.status || 200, json: async () => result.body || result };
    },
  });
  vm.runInContext(`${source.replace(/^export /gm, '')}\nglobalThis.startPanel = initMailConnection;`, context);
  const cleanup = context.startPanel({ profile: { role }, user: { getIdToken: async () => 'firebase-user-token' } }, mount);
  return { mount, calls, navigations, historyReplacements, cleanup, document };
}

test('manager panel stays compact without asserting unknown status, exposing setup details or calling APIs', async () => {
  const app = panel({ role: 'manager', responses: () => { throw new Error('Must not request'); } });
  await settled();
  assert.equal(app.calls.length, 0);
  assert.equal(app.mount.dataset.mode, 'compact');
  assert.equal(findAll(app.mount, node => ['button', 'select', 'details', 'input', 'textarea', 'dl'].includes(node.tagName)).length, 0);
  assert.match(app.mount.textContent, /메일 가져오기와 연결 설정은 관리자가 진행합니다/);
  assert.match(app.mount.textContent, /학교급식 발주/);
  assert.doesNotMatch(app.mount.textContent, /연결 전|수집 전|Client ID|kaXX9XpQRZ7ohuKFW1TU|설정 필요/);
  app.cleanup();
});

test('missing configuration blocks OAuth and sync even if a disabled button event is dispatched', async () => {
  const app = panel({ responses: () => ({ ok: true, configuration: { ready: false, missing: ['NAVERWORKS_CLIENT_SECRET', 'MAIL_TOKEN_ENCRYPTION_KEY'] }, connection: { connected: false } }) });
  await settled();
  assert.deepEqual(app.calls.map(call => call.path), ['/api/naverworks/status']);
  assert.equal(findButton(app.mount, '네이버웍스 계정 연결').disabled, true);
  assert.equal(findButton(app.mount, '메일 가져오기').disabled, true);
  await findButton(app.mount, '네이버웍스 계정 연결').fire('click');
  await findButton(app.mount, '메일 가져오기').fire('click');
  assert.equal(app.calls.length, 1);
  assert.equal(findAll(app.mount, node => node.tagName === 'input' || node.tagName === 'textarea').length, 0);
  app.cleanup();
});

for (const [label, connection] of [['unverified mailbox', { accessStatus: null }], ['different account', { mailbox: 'other@example.com' }]]) {
  test(`${label} cannot list folders or collect mail`, async () => {
    const app = panel({ responses: () => configured(connection) });
    await settled();
    assert.deepEqual(app.calls.map(call => call.path), ['/api/naverworks/status']);
    assert.equal(findButton(app.mount, '메일 가져오기').disabled, true);
    await findButton(app.mount, '메일 가져오기').fire('click');
    assert.equal(app.calls.length, 1);
    app.cleanup();
  });
}

test('verified school folder is locked and collection only starts on click; continuation preserves school scope', async () => {
  let batches = 0;
  const app = panel({ responses: path => {
    if (path.endsWith('/status')) return configured();
    if (path.endsWith('/folders')) return schoolFolders([{ id: '0', name: '받은메일함' }, { id: '106', name: '학교급식 발주' }]);
    if (path.endsWith('/sync')) return { ok: true, sync: { status: ++batches === 1 ? 'partial' : 'complete', scanned: 20, collected: 18, duplicates: 2, skipped: 0,
      from: '2026-10-14T01:00:00Z', to: '2026-10-21T01:00:00Z', continuation: batches === 1 ? 'opaque-signed-continuation' : null, attachmentHandling: 'metadata_only', interpretationReady: false } };
    throw new Error(`Unexpected request: ${path}`);
  } });
  await settled();
  assert.deepEqual(app.calls.map(call => call.path), ['/api/naverworks/status', '/api/naverworks/folders']);
  assert.equal(findButton(app.mount, '메일 가져오기').disabled, false);
  const select = findAll(app.mount, node => node.tagName === 'select')[0];
  assert.equal(select.value, '106'); assert.equal(select.disabled, true);
  assert.equal(batches, 0);
  await findButton(app.mount, '메일 가져오기').fire('click');
  assert.equal(batches, 1);
  assert.equal(findButton(app.mount, '이어서 수집').disabled, false);
  assert.match(app.mount.textContent, /일부 수집 · 계속 필요/);
  assert.equal(findAll(app.mount, node => node.tagName === 'select')[0].disabled, true);
  assert.deepEqual(JSON.parse(app.calls.at(-1).settings.body), { folderId: '106', scope: 'school' });
  await findButton(app.mount, '이어서 수집').fire('click');
  assert.deepEqual(JSON.parse(app.calls.at(-1).settings.body), { folderId: '106', scope: 'school', continuation: 'opaque-signed-continuation' });
  assert.match(app.mount.textContent, /수집 범위 확인됨/);
  assert.match(app.mount.textContent, /해석 대기/);
  assert.match(app.mount.textContent, /지원하는 Excel 첨부는 열람할 때 원본을 보관/);
  assert.ok(app.calls.every(call => call.settings.headers.Authorization === 'Bearer firebase-user-token'));
  assert.ok(app.calls.every(call => !call.path.includes('firebase-user-token')));
  app.cleanup();
});

for (const [label, folders] of [
  ['missing', [{ id: '0', name: '받은메일함' }]],
  ['renamed', [{ id: '106', name: '다른 이름' }]],
  ['replacement ID', [{ id: '107', name: '학교급식 발주' }]],
  ['duplicate name', [{ id: '106', name: '학교급식 발주' }, { id: '107', name: '학교급식 발주' }]],
  ['duplicate ID', [{ id: '106', name: '학교급식 발주' }, { id: '106', name: '다른 이름' }]],
]) {
  test(`school collection never falls back to another folder when the fixed folder is ${label}`, async () => {
    const app = panel({ responses: path => path.endsWith('/status') ? configured() : schoolFolders(folders) });
    await settled();
    assert.equal(findButton(app.mount, '메일 가져오기').disabled, true);
    assert.equal(findAll(app.mount, node => node.tagName === 'select')[0].value, '');
    assert.match(app.mount.textContent, /다른 메일함으로 대신 수집하지 않습니다/);
    await findButton(app.mount, '메일 가져오기').fire('click');
    assert.equal(app.calls.length, 2);
    app.cleanup();
  });
}

test('provider folder list alone cannot enable school sync without verified school scope', async () => {
  const app = panel({ responses: path => path.endsWith('/status') ? configured() : { ok: true, folders: [{ id: '106', name: '학교급식 발주' }] } });
  await settled();
  assert.equal(findButton(app.mount, '메일 가져오기').disabled, true);
  app.cleanup();
});

test('earlier inbox collection never implies the school folder has been collected', async () => {
  const app = panel({ responses: path => path.endsWith('/status') ? { ...configured(), lastSync: { folderId: '0', status: 'complete' } } : schoolFolders([{ id: '106', name: '학교급식 발주' }]) });
  await settled();
  assert.match(app.mount.textContent, /학교급식 수집 기록 확인 필요/);
  assert.match(app.mount.textContent, /다른 메일함의 기존 기록/);
  assert.doesNotMatch(app.mount.textContent, /학교급식 최근 수집 기록 있음/);
  app.cleanup();
});

test('unexpected OAuth host is blocked and never navigates the user', async () => {
  const app = panel({ responses: path => path.endsWith('/status') ? configured({ connected: false }) : { ok: true, authorizationUrl: 'https://auth.worksmobile.com.evil.example/authorize' } });
  await settled();
  await findButton(app.mount, '네이버웍스 계정 연결').fire('click');
  assert.deepEqual(app.navigations, []);
  assert.equal(app.calls.at(-1).path, '/api/naverworks/start');
  app.cleanup();
});

test('closing the panel aborts outstanding requests and cannot repaint an inactive page', async () => {
  let resolveStatus;
  const app = panel({ responses: () => new Promise(resolve => { resolveStatus = resolve; }) });
  await settled();
  await findButton(app.mount, '연결 설정').fire('click');
  const dialog = findAll(app.mount, node => node.tagName === 'dialog')[0];
  assert.equal(dialog.open, true);
  app.cleanup();
  const before = app.mount.textContent;
  assert.equal(dialog.open, false);
  assert.equal(dialog.listeners.size, 0);
  assert.equal(findAll(app.mount, node => node.tagName === 'dialog').length, 0);
  assert.equal(app.calls[0].settings.signal.aborted, true);
  resolveStatus(configured({ connected: false }));
  await settled();
  assert.equal(app.mount.textContent, before);
});

test('setup stays in a separate dialog that survives async status updates and restores focus on Escape or backdrop', async () => {
  let resolveStatus;
  const app = panel({ responses: path => path.endsWith('/status') ? new Promise(resolve => { resolveStatus = resolve; }) : schoolFolders([{ id: '106', name: '학교급식 발주' }]) });
  await settled();
  const strip = app.mount.children[0], dialog = findAll(app.mount, node => node.tagName === 'dialog')[0];
  assert.equal(dialog.open, false);
  assert.doesNotMatch(strip.textContent, /Client ID|kaXX9XpQRZ7ohuKFW1TU|서버 설정/);
  assert.match(dialog.textContent, /Client ID/);
  await findButton(app.mount, '연결 설정').fire('click');
  assert.equal(dialog.open, true);
  assert.equal(app.document.activeElement.textContent, '닫기');
  resolveStatus(configured());
  await settled();
  assert.equal(findAll(app.mount, node => node.tagName === 'dialog')[0], dialog);
  assert.equal(dialog.open, true);
  assert.match(strip.textContent, /연결 정상/);
  let prevented = false;
  await dialog.fire('cancel', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(dialog.open, false);
  assert.equal(app.document.activeElement, findButton(app.mount, '연결 설정'));
  await findButton(app.mount, '연결 설정').fire('click');
  await dialog.fire('click', { target: findButton(app.mount, '닫기') });
  assert.equal(dialog.open, true);
  await dialog.fire('click');
  assert.equal(dialog.open, false);
  assert.equal(app.document.activeElement, findButton(app.mount, '연결 설정'));
  app.cleanup();
});

test('closing settings retains continuation and collection feedback remains visible in the strip', async () => {
  let batches = 0;
  const app = panel({ responses: path => {
    if (path.endsWith('/status')) return configured();
    if (path.endsWith('/folders')) return schoolFolders([{ id: '106', name: '학교급식 발주' }]);
    return { ok: true, sync: { status: ++batches === 1 ? 'partial' : 'complete', continuation: batches === 1 ? 'signed-next-batch' : null } };
  } });
  await settled();
  await findButton(app.mount, '메일 가져오기').fire('click');
  await findButton(app.mount, '연결 설정').fire('click');
  await findButton(app.mount, '닫기').fire('click');
  assert.match(app.mount.children[0].textContent, /메일을 일부 가져왔습니다/);
  await findButton(app.mount, '이어서 수집').fire('click');
  assert.deepEqual(JSON.parse(app.calls.at(-1).settings.body), { folderId: '106', scope: 'school', continuation: 'signed-next-batch' });
  assert.match(app.mount.children[0].textContent, /학교급식 메일을 가져왔습니다/);
  app.cleanup();
});

test('connection failure stays visible outside the closed settings dialog', async () => {
  const app = panel({ responses: () => ({ status: 503, body: { ok: false } }) });
  await settled();
  const strip = app.mount.children[0], dialog = findAll(app.mount, node => node.tagName === 'dialog')[0];
  assert.equal(dialog.open, false);
  assert.match(strip.textContent, /연결 상태를 확인하지 못했습니다/);
  assert.match(dialog.textContent, /연결 상태를 확인하지 못했습니다/);
  app.cleanup();
});

test('keyboard focus stays on the collection action across busy, continuation and completion without duplicate requests', async () => {
  let resolveBatch;
  const app = panel({ responses: path => {
    if (path.endsWith('/status')) return configured();
    if (path.endsWith('/folders')) return schoolFolders([{ id: '106', name: '학교급식 발주' }]);
    return new Promise(resolve => { resolveBatch = resolve; });
  } });
  await settled();
  findButton(app.mount, '메일 가져오기').focus();
  const first = findButton(app.mount, '메일 가져오기').fire('click');
  await settled();
  assert.equal(app.document.activeElement, findButton(app.mount, '처리 중…'));
  assert.equal(app.document.activeElement.attributes['aria-disabled'], 'true');
  await app.document.activeElement.fire('click');
  assert.equal(app.calls.filter(call => call.path.endsWith('/sync')).length, 1);
  resolveBatch({ ok: true, sync: { status: 'partial', continuation: 'signed-next-batch' } });
  await first;
  assert.equal(app.document.activeElement, findButton(app.mount, '이어서 수집'));
  const second = app.document.activeElement.fire('click');
  await settled();
  assert.equal(app.document.activeElement, findButton(app.mount, '처리 중…'));
  resolveBatch({ ok: true, sync: { status: 'complete' } });
  await second;
  assert.equal(app.document.activeElement, findButton(app.mount, '메일 가져오기'));
  const third = app.document.activeElement.fire('click');
  await settled();
  findButton(app.mount, '연결 설정').focus();
  resolveBatch({ ok: true, sync: { status: 'complete' } });
  await third;
  assert.equal(app.document.activeElement, findButton(app.mount, '연결 설정'));
  assert.equal(findAll(app.mount, node => node.tagName === 'dialog')[0].open, false);
  app.cleanup();
});

test('OAuth error callback shows safe feedback and removes only its status query', async () => {
  const app = panel({ url: 'https://dashboard.dmnfood.co.kr/orders?order=order-123&mail_connection=error#detail', responses: () => configured({ connected: false }) });
  await settled();
  assert.match(app.mount.textContent, /메일 계정 연결을 완료하지 못했습니다/);
  assert.equal(app.historyReplacements[0].path, '/orders?order=order-123#detail');
  assert.equal(app.historyReplacements[0].state.selected, true);
  assert.deepEqual(app.navigations, []);
  app.cleanup();
});

for (const [label, connection] of [['not connected', { connected: false }], ['wrong account', { mailbox: 'someone@example.com' }], ['unverified access', { accessStatus: null }]]) {
  test(`connected OAuth query alone cannot report success for ${label}`, async () => {
    const app = panel({ url: 'https://dashboard.dmnfood.co.kr/orders?mail_connection=connected', responses: () => configured(connection) });
    assert.doesNotMatch(app.mount.textContent, /메일 읽기 연결을 확인했습니다/);
    await settled();
    assert.match(app.mount.textContent, /메일 계정 연결 완료를 확인하지 못했습니다/);
    assert.doesNotMatch(app.mount.textContent, /메일 읽기 연결을 확인했습니다/);
    assert.equal(app.calls.length, 1);
    app.cleanup();
  });
}

test('connected OAuth callback reports success only after the actual account and access status are verified', async () => {
  let resolveStatus;
  const app = panel({ url: 'https://dashboard.dmnfood.co.kr/orders?mail_connection=connected&order=order-456', responses: path => path.endsWith('/status') ? new Promise(resolve => { resolveStatus = resolve; }) : { ok: true, folders: [{ id: '0', name: '받은메일함' }] } });
  await settled();
  assert.doesNotMatch(app.mount.textContent, /메일 읽기 연결을 확인했습니다/);
  resolveStatus(configured());
  await settled();
  assert.match(app.mount.textContent, /지정된 수신 계정의 메일 읽기 연결을 확인했습니다/);
  assert.equal(app.historyReplacements[0].path, '/orders?order=order-456');
  assert.deepEqual(app.calls.map(call => call.path), ['/api/naverworks/status', '/api/naverworks/folders']);
  app.cleanup();
});

test('duplicate or unknown callback values are ignored without reflecting their contents', async () => {
  const app = panel({ url: 'https://dashboard.dmnfood.co.kr/orders?mail_connection=connected&mail_connection=secret-error-detail', responses: () => configured({ connected: false }) });
  await settled();
  assert.doesNotMatch(app.mount.textContent, /secret-error-detail|메일 읽기 연결을 확인했습니다|메일 계정 연결 완료를 확인하지 못했습니다/);
  assert.equal(app.historyReplacements[0].path, '/orders');
  app.cleanup();
});
