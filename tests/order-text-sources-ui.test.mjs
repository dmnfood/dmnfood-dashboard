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
function harness({ respond, canLeave = () => true } = {}) {
  const mount = new Node('div'), dialog = new Node('dialog'), form = new Node('form'), addButton = new Node('button'), input = new Node('textarea'), channel = new Node('select'), fileInput = new Node('input'); channel.value = 'kakao';
  const submit = new Node('button'), alert = new Node('p'), close = new Node('button'), cancel = new Node('button');
  const textPanel = new Node('div'), imagePanel = new Node('div'), imagePreview = new Node('div'), imageStatus = new Node('p'), textMode = new Node('button'), imageMode = new Node('button'); textMode.dataset.sourceMode = 'text'; imageMode.dataset.sourceMode = 'image';
  form.elements = { namedItem: name => ({ text: input, channel, imageFile: fileInput })[name] }; form.querySelector = query => ({ '[type="submit"]': submit, '[role="alert"]': alert, '[data-close]': close, '[data-cancel]': cancel,
    '[data-text-panel]': textPanel, '[data-image-panel]': imagePanel, '[data-image-preview]': imagePreview, '[data-image-status]': imageStatus })[query];
  form.querySelectorAll = () => [textMode, imageMode];
  dialog.showModal = () => dialog.open = true; dialog.close = () => dialog.open = false;
  const calls = [], selected = [], starts = [], previews = [], createdUrls = [], revokedUrls = []; let uuids = 0;
  const context = vm.createContext({ document: { createElement: tag => new Node(tag) }, window: { confirm: () => true }, AbortController, Intl, Date, encodeURIComponent,
    Uint8Array, btoa: value => Buffer.from(value, 'binary').toString('base64'), URL: { createObjectURL: value => { const url = `blob:fictional-${createdUrls.length}`; createdUrls.push({ url, value }); return url; }, revokeObjectURL: value => revokedUrls.push(value) },
    crypto: { randomUUID: () => `fictional-request-${++uuids}` }, requestOrderAi: async (session, path, options = {}) => { calls.push({ path, options }); return await respond?.(path, options) ?? { ok: true, sources: [] }; } });
  vm.runInContext(`${source.replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '')}\nglobalThis.init = initOrderTextSources;`, context);
  const app = context.init({}, { mount, dialog, form, addButton, canLeave, onSelectStart: value => starts.push(value), onSelect: (value, options) => selected.push({ value, options }), onPreview: value => previews.push(value) });
  return { app, mount, dialog, form, input, channel, fileInput, textPanel, imagePanel, imagePreview, imageStatus, textMode, imageMode, submit, alert, addButton, close, cancel, calls, starts, selected, previews, createdUrls, revokedUrls, uuids: () => uuids,
    button: text => nodes(mount, node => node.tagName === 'BUTTON' && node.textContent === text)[0] };
}
test('text selection loads preserved raw source while readonly preview does not change selection', async () => {
  const item = record(), app = harness({ respond: path => path === 'text-sources' ? { sources: [item] } : { source: item } }); await settle();
  assert.match(app.mount.textContent, /<img src=x/); assert.equal(nodes(app.mount, node => node.tagName === 'IMG').length, 0);
  app.button('원문 보기').fire('click'); assert.equal(app.previews.length, 1); assert.equal(app.selected.length, 0); assert.equal(app.starts.length, 0);
  await app.app.selectSource(item.id); assert.equal(app.selected[0].value.textSource.text, item.text); assert.equal(app.selected[0].options.analyze, false); assert.equal(app.selected[0].value.sourceKind, 'text'); app.app.destroy();
});
test('save preserves exact text, starts one explicit analysis, and ignores repeated submission while pending', async () => {
  let finish;
  const app = harness({ respond: (path, options) => options.body ? new Promise(resolve => finish = () => resolve({ source: record('a'.repeat(64), options.body.text) })) : { sources: [] } }); await settle();
  app.addButton.fire('click'); app.input.value = '📦 가상 업체\r\n\t중국산 참기름 1.8L 11병\n'; const raw = app.input.value;
  const saved = app.form.fire('submit'); await settle(); await app.form.fire('submit'); assert.equal(app.calls.filter(call => call.options.body).length, 1);
  assert.equal(app.calls.at(-1).options.body.text, raw); finish(); await saved;
  assert.equal(app.selected.length, 1); assert.equal(app.selected[0].options.analyze, true); assert.equal(app.selected[0].value.textSource.text, raw); assert.equal(app.dialog.open, false); assert.equal(app.input.value, ''); app.app.destroy();
});
test('an uncertain save can retry with the same request ID, while edited content receives a new ID', async () => {
  const app = harness({ respond: (path, options) => { if (options.body) throw new Error('가상 연결 끊김'); return { sources: [] }; } }); await settle(); app.input.value = '원문 11병';
  await app.form.fire('submit'); await app.form.fire('submit'); const first = app.calls.filter(call => call.options.body); assert.equal(first[0].options.body.requestId, first[1].options.body.requestId); assert.equal(app.input.value, '원문 11병');
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
  await app.form.fire('submit'); const posts = app.calls.filter(call => call.options.body); assert.equal(posts.length, 1);
  assert.equal('text' in posts[0].options.body, false); assert.deepEqual(Object.keys(posts[0].options.body.image).sort(), ['contentBase64', 'fileName', 'mimeType']);
  assert.equal(posts[0].options.body.image.contentBase64, Buffer.from(await file.arrayBuffer()).toString('base64'));
  finish(); await saving; assert.equal(app.selected[0].value.sourceKind, 'image'); assert.equal(app.selected[0].options.analyze, true);
  assert.equal(app.selected[0].value.textSource.contentBase64, posts[0].options.body.image.contentBase64);
  assert.equal(app.dialog.open, false); assert.equal(app.imagePreview.hidden, true); assert.equal(app.revokedUrls.length, 1); app.app.destroy();
});

test('pasted image switches input mode without overwriting text and explicit text mode sends no image', async () => {
  const app = harness({ respond: (path, options) => options.body ? { source: record('a'.repeat(64), options.body.text) } : { sources: [] } }); await settle();
  app.input.value = '📦 원본 텍스트\r\n중국산 참기름 11병'; const raw = app.input.value; let prevented = false;
  app.form.fire('paste', { preventDefault: () => prevented = true, clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => imageFile() }] } }); await settle();
  assert.equal(prevented, true); assert.equal(app.imagePanel.hidden, false); assert.equal(app.input.value, raw);
  app.textMode.fire('click'); assert.equal(app.imagePanel.hidden, true); assert.equal(app.textPanel.hidden, false); await app.form.fire('submit');
  const body = app.calls.find(call => call.options.body).options.body; assert.equal(body.text, raw); assert.equal('image' in body, false); app.app.destroy();
});

test('uncertain image saves reuse the request ID and mode or channel changes reset it without losing original drafts', async () => {
  const app = harness({ respond: (path, options) => { if (options.body) throw new Error('응답 확인 불가'); return { sources: [] }; } }); await settle();
  app.input.value = '보존할 텍스트'; await choose(app, imageFile()); await app.form.fire('submit'); await app.form.fire('submit');
  const posts = () => app.calls.filter(call => call.options.body).map(call => call.options.body);
  assert.equal(posts()[0].requestId, posts()[1].requestId); assert.equal(app.imagePreview.hidden, false); assert.equal(app.input.value, '보존할 텍스트');
  app.textMode.fire('click'); app.imageMode.fire('click'); await app.form.fire('submit'); assert.notEqual(posts()[2].requestId, posts()[1].requestId);
  app.channel.value = 'sms'; app.channel.fire('change'); await app.form.fire('submit'); assert.notEqual(posts()[3].requestId, posts()[2].requestId);
  assert.equal(posts()[3].channel, 'sms'); assert.equal(posts()[3].image.contentBase64, posts()[0].image.contentBase64); app.app.destroy();
});

test('invalid, missing and multiple pasted images never submit an old or partial image', async () => {
  const app = harness(); await settle(); app.imageMode.fire('click'); await app.form.fire('submit'); assert.equal(app.calls.filter(call => call.options.body).length, 0);
  for (const file of [imageFile({ type: 'image/svg+xml', name: '발주.svg' }), imageFile({ size: 600 * 1024 + 1 }), imageFile({ name: '../원본.png' }), imageFile({ bytes: Uint8Array.from([1,2,3,4]) }), imageFile({ size: 1 })]) {
    await choose(app, file); await app.form.fire('submit'); assert.equal(app.calls.filter(call => call.options.body).length, 0); assert.equal(app.alert.hidden, false);
  }
  await choose(app, imageFile()); app.form.fire('paste', { clipboardData: { items: [1, 2].map(() => ({ kind: 'file', type: 'image/png', getAsFile: () => imageFile() })) } }); await settle();
  assert.equal(app.imagePreview.hidden, true); await app.form.fire('submit'); assert.equal(app.calls.filter(call => call.options.body).length, 0); app.app.destroy();
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
  await app.form.fire('submit'); const posts = app.calls.filter(call => call.options.body); assert.equal(posts[0].options.body.requestId, posts[1].options.body.requestId); app.app.destroy();
});

test('stored image metadata previews without selecting and full original detail resumes the common analysis flow', async () => {
  const image = savedImage({ fileName: '발주.png', mimeType: 'image/png', contentBase64: Buffer.from(await imageFile().arrayBuffer()).toString('base64') }), summary = { ...image }; delete summary.contentBase64;
  const app = harness({ respond: path => path === 'text-sources' ? { sources: [summary] } : { source: image } }); await settle(); app.button('원문 보기').fire('click');
  assert.equal(app.previews[0].sourceKind, 'image'); assert.equal(app.selected.length, 0); await app.app.selectSource(image.id);
  assert.equal(app.selected[0].value.sourceKind, 'image'); assert.equal(app.selected[0].value.textSource.contentBase64, image.contentBase64); app.app.destroy();
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
  const image = app.calls.find(call => call.options.body)?.options.body.image; assert.ok(image);
  const sent = Buffer.from(image.contentBase64, 'base64'); assert.equal(sent.length, bytes.length); assert.equal(sent.at(-1), 29); assert.deepEqual(sent, Buffer.from(bytes)); app.app.destroy();
});
