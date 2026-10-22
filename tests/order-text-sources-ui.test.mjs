import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../dashboard/js/order-text-sources.js', import.meta.url), 'utf8');
class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = {}; this.dataset = {}; this.value = ''; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, callback) { this.listeners.set(key, callback); }
  removeEventListener(key) { this.listeners.delete(key); }
  fire(key, event = {}) { return this.listeners.get(key)?.({ preventDefault() {}, ...event }); }
  focus() {}
}
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const nodes = (node, predicate) => [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => nodes(child, predicate))];
const record = (id = 'a'.repeat(64), text = '가상 업체\r\n중국산 참기름 1.8L 11병') => ({ id, text, sha256: 'b'.repeat(64), title: '<img src=x onerror=alert(1)> 가상 업체', channel: 'kakao', createdAt: '2026-10-22T00:00:00Z' });
function imageFile({ name = '발주 캡처.png', type = 'image/png', bytes = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]), size = bytes.length, arrayBuffer } = {}) {
  return { name, type, size, arrayBuffer: arrayBuffer || (async () => Uint8Array.from(bytes).buffer) };
}
const savedImage = (image, channel = 'kakao') => ({ id: 'a'.repeat(64), kind: 'image', ...image, byteLength: Buffer.from(image.contentBase64, 'base64').length, channel, sha256: 'b'.repeat(64), title: '카카오톡 이미지 발주', createdAt: '2026-10-22T00:00:00Z' });
const choose = async (app, file) => { app.fileInput.files = [file]; app.fileInput.fire('change'); await settle(); };
function harness({ respond, respondCleanup, canLeave = () => true, now = () => Date.now() } = {}) {
  const mount = new Node('div'), dialog = new Node('dialog'), form = new Node('form'), addButton = new Node('button'), input = new Node('textarea'), channel = new Node('select'), fileInput = new Node('input'); channel.value = 'kakao';
  const submit = new Node('button'), alert = new Node('p'), close = new Node('button'), cancel = new Node('button');
  const textPanel = new Node('div'), imagePanel = new Node('div'), imagePreview = new Node('div'), imageStatus = new Node('p'), textMode = new Node('button'), imageMode = new Node('button'); textMode.dataset.sourceMode = 'text'; imageMode.dataset.sourceMode = 'image';
  form.elements = { namedItem: name => ({ text: input, channel, imageFile: fileInput })[name] }; form.querySelector = query => ({ '[type="submit"]': submit, '[role="alert"]': alert, '[data-close]': close, '[data-cancel]': cancel,
    '[data-text-panel]': textPanel, '[data-image-panel]': imagePanel, '[data-image-preview]': imagePreview, '[data-image-status]': imageStatus })[query];
  form.querySelectorAll = () => [textMode, imageMode];
  dialog.showModal = () => dialog.open = true; dialog.close = () => dialog.open = false;
  const calls = [], selected = [], starts = [], previews = [], createdUrls = [], revokedUrls = []; let uuids = 0;
  class UiDate extends Date { static now() { return now(); } }
  const context = vm.createContext({ document: { createElement: tag => new Node(tag) }, window: { confirm: () => true }, AbortController, Intl, Date: UiDate, encodeURIComponent,
    Uint8Array, btoa: value => Buffer.from(value, 'binary').toString('base64'), URL: { createObjectURL: value => { const url = `blob:fictional-${createdUrls.length}`; createdUrls.push({ url, value }); return url; }, revokeObjectURL: value => revokedUrls.push(value) },
    crypto: { randomUUID: () => `fictional-request-${++uuids}` }, requestOrderAi: async (session, path, options = {}) => { calls.push({ path, options }); return options.body?.action === 'cleanupExpired' ? await respondCleanup?.(path, options) ?? { ok: true, deletedCount: 0 } : await respond?.(path, options) ?? { ok: true, sources: [] }; } });
  vm.runInContext(`${source.replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '')}\nglobalThis.init = initOrderTextSources;`, context);
  const app = context.init({}, { mount, dialog, form, addButton, canLeave, onSelectStart: value => starts.push(value), onSelect: (value, options) => selected.push({ value, options }), onPreview: value => previews.push(value) });
  return { app, mount, dialog, form, input, channel, fileInput, textPanel, imagePanel, imagePreview, imageStatus, textMode, imageMode, submit, alert, addButton, close, cancel, calls, starts, selected, previews, createdUrls, revokedUrls, uuids: () => uuids,
    button: text => nodes(mount, node => node.tagName === 'BUTTON' && node.textContent === text)[0] };
}
test('text selection loads preserved raw source while readonly preview does not change selection', async () => {
  const item = record(), app = harness({ respond: path => path === 'text-sources' ? { sources: [item] } : { source: item } }); await settle();
  assert.match(app.mount.textContent, /<img src=x/); assert.equal(nodes(app.mount, node => node.tagName === 'IMG').length, 0);
  app.button('원문 보기').fire('click'); assert.equal(app.previews.length, 1); assert.equal(app.selected.length, 0); assert.equal(app.starts.length, 0);
  await app.app.selectSource(item.id); assert.equal('text' in app.selected[0].value.textSource, false); assert.equal(app.selected[0].value.rawStorage.sha256, item.sha256); assert.equal(app.selected[0].options.analyze, false); assert.equal(app.selected[0].value.sourceKind, 'text'); app.app.destroy();
});
test('save preserves exact text, starts one explicit analysis, and ignores repeated submission while pending', async () => {
  let finish;
  const app = harness({ respond: (path, options) => options.body ? new Promise(resolve => finish = () => resolve({ source: record('a'.repeat(64), options.body.text) })) : { sources: [] } }); await settle();
  app.addButton.fire('click'); app.input.value = '📦 가상 업체\r\n\t중국산 참기름 1.8L 11병\n'; const raw = app.input.value;
  const saved = app.form.fire('submit'); await settle(); await app.form.fire('submit'); assert.equal(app.calls.filter(call => call.options.body?.requestId).length, 1);
  assert.equal(app.calls.at(-1).options.body.text, raw); finish(); await saved;
  assert.equal(app.selected.length, 1); assert.equal(app.selected[0].options.analyze, true); assert.equal('text' in app.selected[0].value.textSource, false); assert.equal(app.dialog.open, false); assert.equal(app.input.value, ''); app.app.destroy();
});
test('an uncertain save can retry with the same request ID, while edited content receives a new ID', async () => {
  const app = harness({ respond: (path, options) => { if (options.body) throw new Error('가상 연결 끊김'); return { sources: [] }; } }); await settle(); app.input.value = '원문 11병';
  await app.form.fire('submit'); await app.form.fire('submit'); const first = app.calls.filter(call => call.options.body?.requestId); assert.equal(first[0].options.body.requestId, first[1].options.body.requestId); assert.equal(app.input.value, '원문 11병');
  app.input.value = '수정 원문 12병'; app.input.fire('input'); await app.form.fire('submit'); assert.equal(app.uuids(), 2); app.app.destroy();
});
test('late source responses cannot replace a newer source, and navigation guards prevent new reads', async () => {
  let finish; const a = record(), b = record('c'.repeat(64));
  const app = harness({ respond: path => path === 'text-sources' ? { sources: [a, b] } : path.endsWith(a.id) ? new Promise(resolve => finish = () => resolve({ source: a })) : { source: b } }); await settle();
  const first = app.app.selectSource(a.id); await settle(); await app.app.selectSource(b.id); finish(); await first;
  assert.equal(app.selected.length, 1); assert.equal(app.selected[0].value.id, b.id); app.app.destroy();
  const guarded = harness({ canLeave: () => false }); await settle(); const count = guarded.calls.length; assert.equal(await guarded.app.selectSource(a.id), false); assert.equal(guarded.calls.length, count); guarded.app.destroy();
});
test('a saved source stays visible when an older list request completes', async () => {
  let finishList; const app = harness({ respond: (path, options) => options.body ? { source: record('a'.repeat(64), options.body.text) } : new Promise(resolve => finishList = () => resolve({ sources: [] })) });
  await settle(); app.input.value = '가상 발주 1병'; await app.form.fire('submit'); finishList(); await settle();
  assert.match(app.mount.textContent, /가상 업체/); assert.equal(app.selected.length, 1); app.app.destroy();
});

test('an image upload preserves original bytes and sends only the selected source while saving controls stay locked', async () => {
  let finish;
  const app = harness({ respond: (path, options) => options.body ? new Promise(resolve => finish = () => resolve({ source: savedImage(options.body.image, options.body.channel) })) : { sources: [] } }); await settle();
  app.addButton.fire('click'); app.input.value = '숨겨도 보존할 텍스트 원문'; const file = imageFile(); await choose(app, file);
  assert.equal(app.input.value, '숨겨도 보존할 텍스트 원문'); assert.equal(app.textPanel.hidden, true); assert.equal(app.imagePanel.hidden, false);
  assert.equal(app.createdUrls[0].value, file, 'preview uses the unchanged original File');
  const saving = app.form.fire('submit'); await settle();
  for (const control of [app.input, app.channel, app.fileInput, app.textMode, app.imageMode, app.submit, app.close, app.cancel]) assert.equal(control.disabled, true);
  await app.form.fire('submit'); const posts = app.calls.filter(call => call.options.body?.requestId); assert.equal(posts.length, 1);
  assert.equal('text' in posts[0].options.body, false); assert.deepEqual(Object.keys(posts[0].options.body.image).sort(), ['contentBase64', 'fileName', 'mimeType']);
  assert.equal(posts[0].options.body.image.contentBase64, Buffer.from(await file.arrayBuffer()).toString('base64'));
  finish(); await saving; assert.equal(app.selected[0].value.sourceKind, 'image'); assert.equal(app.selected[0].options.analyze, true);
  assert.equal('contentBase64' in app.selected[0].value.textSource, false); assert.equal(app.selected[0].value.textSource.byteLength, Buffer.from(posts[0].options.body.image.contentBase64, 'base64').length);
  assert.equal(app.dialog.open, false); assert.equal(app.imagePreview.hidden, true); assert.equal(app.revokedUrls.length, 1); app.app.destroy();
});

test('pasted image switches input mode without overwriting text and explicit text mode sends no image', async () => {
  const app = harness({ respond: (path, options) => options.body ? { source: record('a'.repeat(64), options.body.text) } : { sources: [] } }); await settle();
  app.input.value = '📦 원본 텍스트\r\n중국산 참기름 11병'; const raw = app.input.value; let prevented = false;
  app.form.fire('paste', { preventDefault: () => prevented = true, clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => imageFile() }] } }); await settle();
  assert.equal(prevented, true); assert.equal(app.imagePanel.hidden, false); assert.equal(app.input.value, raw);
  app.textMode.fire('click'); assert.equal(app.imagePanel.hidden, true); assert.equal(app.textPanel.hidden, false); await app.form.fire('submit');
  const body = app.calls.find(call => call.options.body?.requestId).options.body; assert.equal(body.text, raw); assert.equal('image' in body, false); app.app.destroy();
});

test('uncertain image saves reuse the request ID and mode or channel changes reset it without losing original drafts', async () => {
  const app = harness({ respond: (path, options) => { if (options.body) throw new Error('응답 확인 불가'); return { sources: [] }; } }); await settle();
  app.input.value = '보존할 텍스트'; await choose(app, imageFile()); await app.form.fire('submit'); await app.form.fire('submit');
  const posts = () => app.calls.filter(call => call.options.body?.requestId).map(call => call.options.body);
  assert.equal(posts()[0].requestId, posts()[1].requestId); assert.equal(app.imagePreview.hidden, false); assert.equal(app.input.value, '보존할 텍스트');
  app.textMode.fire('click'); app.imageMode.fire('click'); await app.form.fire('submit'); assert.notEqual(posts()[2].requestId, posts()[1].requestId);
  app.channel.value = 'sms'; app.channel.fire('change'); await app.form.fire('submit'); assert.notEqual(posts()[3].requestId, posts()[2].requestId);
  assert.equal(posts()[3].channel, 'sms'); assert.equal(posts()[3].image.contentBase64, posts()[0].image.contentBase64); app.app.destroy();
});

test('invalid, missing and multiple pasted images never submit an old or partial image', async () => {
  const app = harness(); await settle(); app.imageMode.fire('click'); await app.form.fire('submit'); assert.equal(app.calls.filter(call => call.options.body?.requestId).length, 0);
  for (const file of [imageFile({ type: 'image/svg+xml', name: '발주.svg' }), imageFile({ size: 600 * 1024 + 1 }), imageFile({ name: '../원본.png' }), imageFile({ bytes: Uint8Array.from([1,2,3,4]) }), imageFile({ size: 1 })]) {
    await choose(app, file); await app.form.fire('submit'); assert.equal(app.calls.filter(call => call.options.body?.requestId).length, 0); assert.equal(app.alert.hidden, false);
  }
  await choose(app, imageFile()); app.form.fire('paste', { clipboardData: { items: [1, 2].map(() => ({ kind: 'file', type: 'image/png', getAsFile: () => imageFile() })) } }); await settle();
  assert.equal(app.imagePreview.hidden, true); await app.form.fire('submit'); assert.equal(app.calls.filter(call => call.options.body?.requestId).length, 0); app.app.destroy();
});

test('late File reads cannot replace a newer image, reopen a cancelled draft or change text mode', async () => {
  let finish;
  const slow = imageFile({ name: '이전.png', arrayBuffer: () => new Promise(resolve => finish = async () => resolve(await imageFile().arrayBuffer())) });
  const app = harness(); await settle(); app.fileInput.files = [slow]; app.fileInput.fire('change'); await settle(); await choose(app, imageFile({ name: '현재.png' }));
  await finish(); await settle(); assert.match(app.imagePreview.textContent, /현재.png/); assert.doesNotMatch(app.imagePreview.textContent, /이전.png/); assert.equal(app.createdUrls.length, 1);
  app.fileInput.files = [slow]; app.fileInput.fire('change'); await settle(); app.textMode.fire('click'); await finish(); await settle(); assert.equal(app.imagePanel.hidden, true); assert.equal(app.imagePreview.hidden, true);
  app.addButton.fire('click'); app.fileInput.files = [slow]; app.fileInput.fire('change'); await settle(); app.cancel.fire('click'); await finish(); await settle(); assert.equal(app.dialog.open, false); assert.equal(app.createdUrls.length, 1); app.app.destroy();
});

test('an image response mismatch preserves the draft and blocks analysis instead of accepting different bytes', async () => {
  const app = harness({ respond: (path, options) => options.body ? { source: savedImage({ ...options.body.image, contentBase64: 'AAAA' }) } : { sources: [] } }); await settle();
  app.addButton.fire('click'); await choose(app, imageFile()); await app.form.fire('submit');
  assert.equal(app.selected.length, 0); assert.equal(app.dialog.open, true); assert.equal(app.imagePreview.hidden, false); assert.match(app.alert.textContent, /일치하지 않습니다/);
  await app.form.fire('submit'); const posts = app.calls.filter(call => call.options.body?.requestId); assert.equal(posts[0].options.body.requestId, posts[1].options.body.requestId); app.app.destroy();
});

test('stored image metadata previews without selecting and full original detail resumes the common analysis flow', async () => {
  const image = savedImage({ fileName: '발주.png', mimeType: 'image/png', contentBase64: Buffer.from(await imageFile().arrayBuffer()).toString('base64') }), summary = { ...image }; delete summary.contentBase64;
  const app = harness({ respond: path => path === 'text-sources' ? { sources: [summary] } : { source: image } }); await settle(); app.button('원문 보기').fire('click');
  assert.equal(app.previews[0].sourceKind, 'image'); assert.equal(app.selected.length, 0); await app.app.selectSource(image.id);
  assert.equal(app.selected[0].value.sourceKind, 'image'); assert.equal('contentBase64' in app.selected[0].value.textSource, false); assert.equal(app.selected[0].value.textSource.fileName, image.fileName); app.app.destroy();
});

test('preview URLs are revoked on replacement, cancellation and destroy, including pending reads', async () => {
  const app = harness(); await settle(); await choose(app, imageFile()); const first = app.createdUrls[0].url;
  await choose(app, imageFile({ name: '다음.png' })); assert.equal(app.revokedUrls.includes(first), true);
  app.addButton.fire('click'); app.cancel.fire('click'); assert.equal(app.revokedUrls.length, 2); await choose(app, imageFile()); app.app.destroy(); assert.equal(app.revokedUrls.length, 3);
  assert.equal(app.form.listeners.has('paste'), false); assert.equal(app.fileInput.listeners.has('change'), false);
});

test('the image byte boundary is preserved exactly without resizing or truncation', async () => {
  const bytes = new Uint8Array(600 * 1024); bytes.set(new Uint8Array(await imageFile().arrayBuffer())); bytes[bytes.length - 1] = 29;
  const app = harness({ respond: (path, options) => options.body ? { source: savedImage(options.body.image) } : { sources: [] } }); await settle(); await choose(app, imageFile({ bytes })); await app.form.fire('submit');
  const image = app.calls.find(call => call.options.body?.requestId)?.options.body.image; assert.ok(image);
  const sent = Buffer.from(image.contentBase64, 'base64'); assert.equal(sent.length, bytes.length); assert.equal(sent.at(-1), 29); assert.deepEqual(sent, Buffer.from(bytes)); app.app.destroy();
});

test('list and analysis adapters retain metadata without accumulating raw text or image payloads', async () => {
  const text = { ...record(), text: 'PRIVATE_RAW_TEXT', contentBase64: 'PRIVATE_EXTRA_BASE64', raw: { private: true }, expiresAt: '2099-01-01T00:00:00Z' };
  const image = { ...savedImage({ fileName: '발주.png', mimeType: 'image/png', contentBase64: 'PRIVATE_IMAGE_BASE64' }), id: 'c'.repeat(64), expiresAt: text.expiresAt };
  const app = harness({ respond: path => path === 'text-sources' ? { sources: [text, image] } : { source: text } }); await settle();
  const originals = nodes(app.mount, node => node.tagName === 'BUTTON' && node.textContent === '원문 보기'); originals[0].fire('click'); originals[1].fire('click');
  for (const preview of app.previews) { assert.equal('text' in preview.textSource, false); assert.equal('contentBase64' in preview.textSource, false); assert.equal('raw' in preview.textSource, false); assert.equal(preview.textSource.expiresAt, text.expiresAt); }
  assert.equal(app.previews[1].textSource.fileName, image.fileName); await app.app.selectSource(text.id);
  assert.doesNotMatch(JSON.stringify(app.selected), /PRIVATE_RAW_TEXT|PRIVATE_EXTRA_BASE64|PRIVATE_IMAGE_BASE64/); app.app.destroy();
});

test('a selected source outside the newest list is retained until expiration and is then removed', async () => {
  let clock = Date.parse('2026-10-22T00:00:00Z'); const item = { ...record(), expiresAt: new Date(clock + 1000).toISOString() };
  const app = harness({ now: () => clock, respond: path => path === 'text-sources' ? { sources: [] } : { source: item } }); await settle();
  await app.app.selectSource(item.id); await app.app.loadList(); assert.match(app.mount.textContent, /가상 업체/);
  clock += 1000; await app.app.loadList(); assert.doesNotMatch(app.mount.textContent, /가상 업체/); assert.equal(app.selected.length, 1, 'expiry does not silently start or approve another analysis'); app.app.destroy();
});

test('expired list rows are omitted and the source API retention message is displayed unchanged', async () => {
  const message = '원문 보관 기간(30일)이 지나 더 이상 열람할 수 없습니다.', item = { ...record(), expiresAt: '2000-01-01T00:00:00Z' };
  const app = harness({ respond: path => { if (path === 'text-sources') return { sources: [item] }; throw new Error(message); } }); await settle();
  assert.doesNotMatch(app.mount.textContent, /가상 업체/); assert.equal(await app.app.selectSource(item.id), false); assert.match(app.mount.textContent, /원문 보관 기간\(30일\)이 지나 더 이상 열람할 수 없습니다\./); assert.equal(app.selected.length, 0); app.app.destroy();
  const html = await readFile(new URL('../dashboard/orders.html', import.meta.url), 'utf8'); assert.match(html, /원문·사진은 30일 후 열람이 종료되며, 발주함 접속 시 정리됩니다\./);
});

test('initial cleanup runs once before loading active sources and a zero count is a normal completion', async () => {
  let finish;
  const app = harness({ respondCleanup: () => new Promise(resolve => finish = resolve), respond: () => ({ sources: [record()] }) }); await settle();
  assert.equal(app.calls.length, 1); assert.equal(app.calls[0].options.body.action, 'cleanupExpired'); assert.equal(app.button('오래된 원본 정리').disabled, true);
  assert.equal(app.button('목록 새로고침').disabled, true); assert.equal(app.addButton.disabled, true); assert.equal(app.app.canLeave(), false);
  finish({ deletedCount: 0 }); await settle();
  assert.equal(app.calls.length, 2); assert.equal(app.calls[1].options.body, undefined); assert.match(app.mount.textContent, /오래된 원본 0건을 정리했습니다\./);
  assert.match(app.mount.textContent, /가상 업체/); assert.equal(app.app.canLeave(), true); assert.equal(app.starts.length, 0); assert.equal(app.selected.length, 0); app.app.destroy();
});

test('cleanup failures still load active sources and retain only an error notice', async () => {
  const message = '보관 기간이 지난 원문 정리에 실패했습니다.';
  const app = harness({ respondCleanup: () => { throw new Error(message); }, respond: () => ({ sources: [record()] }) }); await settle();
  assert.equal(app.calls.length, 2); assert.match(app.mount.textContent, /가상 업체/); assert.equal(app.button('오래된 원본 정리').disabled, false);
  const feedback = nodes(app.mount, node => node.className === 'order-text-source-feedback')[0]; assert.equal(feedback.textContent, message); assert.equal(feedback.dataset.error, 'true'); assert.equal(app.app.canLeave(), true); app.app.destroy();
});

test('manual cleanup uses server count, suppresses duplicate requests and refreshes without changing source selection', async () => {
  let rounds = 0, finishManual; const item = { ...record(), expiresAt: '2099-01-01T00:00:00Z' };
  const app = harness({ respondCleanup: () => ++rounds === 1 ? { deletedCount: 0 } : new Promise(resolve => finishManual = resolve), respond: path => path === 'text-sources' ? { sources: [] } : { source: item } }); await settle();
  await app.app.selectSource(item.id); const beforeSelected = app.selected.length;
  app.button('오래된 원본 정리').fire('click'); await settle(); app.button('오래된 원본 정리').fire('click'); await settle(); assert.equal(rounds, 2); assert.equal(app.app.canLeave(), false);
  finishManual({ deletedCount: 3 }); await settle();
  assert.match(app.mount.textContent, /오래된 원본 3건을 정리했습니다\./); assert.match(app.mount.textContent, /가상 업체/); assert.equal(app.selected.length, beforeSelected); assert.equal(app.starts.length, 1);
  const cleanupCalls = app.calls.filter(call => call.options.body?.action === 'cleanupExpired'); assert.equal(cleanupCalls.length, 2);
  assert.deepEqual(Object.keys(cleanupCalls[1].options.body), ['action']); assert.equal(app.calls.at(-1).options.body, undefined); app.app.destroy();
});

test('destroy aborts cleanup and a late completion cannot issue a list read or source callback', async () => {
  let finish;
  const app = harness({ respondCleanup: () => new Promise(resolve => finish = resolve) }); await settle();
  const pending = app.calls[0]; app.app.destroy(); assert.equal(pending.options.signal.aborted, true);
  finish({ deletedCount: 2 }); await settle(); assert.equal(app.calls.length, 1); assert.equal(app.starts.length, 0); assert.equal(app.selected.length, 0); await app.app.loadList(); assert.equal(app.calls.length, 1);
});

test('malformed cleanup counts never become success notices and do not prevent active-source reads', async () => {
  for (const deletedCount of [-1, 51, 0.5, '2']) {
    const app = harness({ respondCleanup: () => ({ deletedCount }), respond: () => ({ sources: [record()] }) }); await settle();
    assert.match(app.mount.textContent, /정리 결과를 확인하지 못했습니다/); assert.match(app.mount.textContent, /가상 업체/); assert.equal(app.calls.length, 2); app.app.destroy();
  }
});
