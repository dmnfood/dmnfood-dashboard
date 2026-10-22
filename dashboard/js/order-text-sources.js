import { requestOrderAi } from './order-ai-client.js';

const validId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const MAX_IMAGE_BYTES = 600 * 1024;
const hasOriginal = source => source?.kind === 'image' ? typeof source.contentBase64 === 'string' && source.contentBase64.length > 0 : typeof source?.text === 'string';
const sourceMetadata = source => Object.fromEntries(['id', 'kind', 'channel', 'scope', 'sha256', 'title', 'fileName', 'mimeType', 'byteLength', 'createdByUid', 'createdAt', 'expiresAt'].filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
const sourceExpired = source => source.expiresAt != null && (!Number.isFinite(Date.parse(source.expiresAt)) || Date.parse(source.expiresAt) <= Date.now());
const channelLabel = value => value === 'sms' ? '문자' : '카카오톡';
const timeLabel = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) : '';
};
function el(tag, text, cls) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; }
function button(text, action, cls = '') { const node = el('button', text, `order-button ${cls}`); node.type = 'button'; node.addEventListener('click', action); return node; }

/** Adapt a preserved source to the existing source-independent review controller. */
export function textSourceForAnalysis(source) {
  return { id: source.id, sourceKind: source.kind === 'image' ? 'image' : 'text', sourceChannel: source.channel, subject: source.title, receivedAt: source.createdAt,
    rawStorage: { sha256: source.sha256 }, textSource: sourceMetadata(source) };
}

export function initOrderTextSources(session, { mount, dialog, form, addButton, canLeave = () => true, onSelectStart, onSelect, onPreview } = {}) {
  let disposed = false, sources = [], selectedId = '', listBusy = false, sourceBusy = false, saving = false, notice = '', failed = false, listGeneration = 0, generation = 0;
  let listController, sourceController, saveController, cleanupController, requestId = '', cleanupBusy = false, cleanupGeneration = 0;
  let inputMode = 'text', imageDraft = null, imageBusy = false, imageVersion = 0, imageUrl = '';
  const list = el('div', null, 'order-text-source-list'), feedback = el('p', '', 'order-text-source-feedback');
  feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  const toolbar = el('div', null, 'order-text-source-toolbar'), refresh = button('목록 새로고침', () => void loadList()), cleanup = button('오래된 원본 정리', () => void cleanupExpired());
  toolbar.setAttribute('aria-label', '직접 추가한 발주 도구'); toolbar.append(refresh, cleanup); mount.replaceChildren(toolbar, feedback, list);
  const input = form.elements.namedItem('text'), channel = form.elements.namedItem('channel'), submit = form.querySelector('[type="submit"]');
  const formError = form.querySelector('[role="alert"]'), close = form.querySelector('[data-close]'), cancel = form.querySelector('[data-cancel]');
  const fileInput = form.elements.namedItem('imageFile'), textPanel = form.querySelector('[data-text-panel]'), imagePanel = form.querySelector('[data-image-panel]');
  const imagePreview = form.querySelector('[data-image-preview]'), imageStatus = form.querySelector('[data-image-status]'), modeButtons = [...form.querySelectorAll('[data-source-mode]')];

  function renderInput() {
    textPanel.hidden = inputMode !== 'text'; imagePanel.hidden = inputMode !== 'image';
    input.required = inputMode === 'text'; input.disabled = saving || inputMode !== 'text';
    fileInput.disabled = saving || imageBusy; channel.disabled = saving; close.disabled = saving; cancel.disabled = saving;
    submit.disabled = saving || inputMode === 'image' && imageBusy;
    for (const control of modeButtons) { control.disabled = saving; control.setAttribute('aria-pressed', String(control.dataset.sourceMode === inputMode)); }
    imageStatus.textContent = imageBusy ? '이미지를 확인하고 있습니다.' : ''; imageStatus.hidden = !imageBusy;
  }
  function releaseImage() {
    imageVersion++; imageDraft = null; imageBusy = false;
    if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = ''; fileInput.value = ''; imagePreview.replaceChildren(); imagePreview.hidden = true;
  }
  function resetDraft() { input.value = ''; requestId = ''; inputMode = 'text'; releaseImage(); renderInput(); }
  function changeMode(mode) {
    if (saving || !['text', 'image'].includes(mode) || mode === inputMode) return;
    inputMode = mode; requestId = ''; formError.hidden = true;
    if (imageBusy) { imageVersion++; imageBusy = false; fileInput.value = ''; }
    renderInput();
  }
  function imageError(message) { formError.textContent = message; formError.hidden = false; }
  async function chooseImage(file) {
    if (saving || disposed) return;
    releaseImage(); const version = imageVersion; inputMode = 'image'; requestId = ''; imageBusy = true; formError.hidden = true; renderInput();
    try {
      const mimeType = file?.type, fileName = file?.name;
      if (!file || !['image/png', 'image/jpeg'].includes(mimeType) || typeof fileName !== 'string' || !fileName || fileName.length > 250 || /[\u0000-\u001f\u007f/\\]/.test(fileName)
        || !(mimeType === 'image/png' ? /\.png$/i : /\.jpe?g$/i).test(fileName)) throw new Error('PNG 또는 JPEG 원본 이미지를 선택해 주세요.');
      if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_IMAGE_BYTES) throw new Error('이 이미지는 저장할 수 없습니다. 필요한 발주 부분만 캡처해 다시 선택해 주세요.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (disposed || version !== imageVersion || inputMode !== 'image') return;
      if (bytes.length !== file.size) throw new Error('이미지 원본을 확인하지 못했습니다. 다시 선택해 주세요.');
      const png = bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) && [73, 72, 68, 82].every((value, index) => bytes[index + 12] === value);
      const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (mimeType === 'image/png' ? !png : !jpeg) throw new Error('이미지의 원본 형식을 확인하지 못했습니다. PNG 또는 JPEG 파일을 다시 선택해 주세요.');
      let binary = ''; for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      imageDraft = { fileName, mimeType, contentBase64: btoa(binary), byteLength: bytes.length };
      imageUrl = URL.createObjectURL(file); const preview = el('img'); preview.src = imageUrl; preview.alt = '추가할 발주 캡처';
      imagePreview.replaceChildren(preview, el('p', fileName)); imagePreview.hidden = false;
    } catch (error) { if (!disposed && version === imageVersion) { imageDraft = null; fileInput.value = ''; imageError(error.message || '이미지를 확인하지 못했습니다. 다시 선택해 주세요.'); } }
    finally { if (!disposed && version === imageVersion) { imageBusy = false; renderInput(); } }
  }
  const modeClicks = modeButtons.map(control => { const action = () => changeMode(control.dataset.sourceMode); control.addEventListener('click', action); return [control, action]; });
  const fileChanged = () => { const files = [...(fileInput.files || [])]; if (files.length === 1) void chooseImage(files[0]); else if (files.length > 1) { releaseImage(); imageError('발주 이미지 한 장을 선택해 주세요.'); renderInput(); } };
  const pasted = event => {
    if (saving) { event.preventDefault(); return; }
    const items = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && item.type?.startsWith('image/'));
    if (!items.length) return;
    event.preventDefault();
    if (items.length !== 1) { releaseImage(); changeMode('image'); imageError('발주 이미지 한 장씩 추가해 주세요.'); renderInput(); return; }
    void chooseImage(items[0].getAsFile());
  };
  fileInput.addEventListener('change', fileChanged); form.addEventListener('paste', pasted); renderInput();

  function render() {
    sources = sources.filter(source => !sourceExpired(source));
    addButton.disabled = saving || cleanupBusy; refresh.disabled = listBusy || cleanupBusy; cleanup.disabled = cleanupBusy || saving;
    feedback.textContent = notice; feedback.hidden = !notice; feedback.dataset.error = String(failed); list.replaceChildren();
    if (!sources.length) list.append(el('p', listBusy ? '발주를 불러오고 있습니다.' : '카톡·문자로 받은 발주를 추가해 주세요.', 'mail-source-empty'));
    for (const source of sources) {
      const row = el('article', null, 'order-text-source-item'); row.dataset.selected = String(source.id === selectedId);
      const select = button('', () => void selectSource(source.id), 'order-text-source-select'); select.setAttribute('aria-current', String(source.id === selectedId));
      select.append(el('strong', source.title || '붙여넣은 발주'), el('span', channelLabel(source.channel), 'order-text-source-channel'), el('span', timeLabel(source.createdAt), 'mail-source-time'));
      const actions = el('div', null, 'order-text-source-actions'), original = button('원문 보기', () => onPreview?.(textSourceForAnalysis(source)));
      original.setAttribute('aria-label', `${source.title || '붙여넣은 발주'} 원문 보기`); actions.append(original); row.append(select, actions); list.append(row);
    }
  }
  async function loadList({ completionNotice = '', completionFailed = false } = {}) {
    if (disposed) return;
    const version = ++listGeneration; listController?.abort(); listController = new AbortController(); listBusy = true; render();
    try {
      const data = await requestOrderAi(session, 'text-sources', { signal: listController.signal });
      if (disposed || version !== listGeneration) return;
      if (!Array.isArray(data.sources) || data.sources.some(source => !validId(source.id))) throw new Error('발주 목록을 확인하지 못했습니다.');
      const selected = sources.find(source => source.id === selectedId && !sourceExpired(source)), available = data.sources.map(sourceMetadata).filter(source => !sourceExpired(source));
      sources = selected && !available.some(source => source.id === selectedId) ? [selected, ...available] : available; notice = completionNotice; failed = completionFailed;
    } catch (error) { if (!disposed && version === listGeneration && error.name !== 'AbortError') { notice = error.message; failed = true; } }
    finally { if (!disposed && version === listGeneration) { listBusy = false; render(); } }
  }
  async function cleanupExpired() {
    if (disposed || cleanupBusy || saving) return false;
    const version = ++cleanupGeneration; cleanupController = new AbortController(); cleanupBusy = true; notice = '오래된 원본을 정리하고 있습니다.'; failed = false; render();
    let completionNotice = '', completionFailed = false;
    try {
      try {
        const data = await requestOrderAi(session, 'text-sources', { body: { action: 'cleanupExpired' }, signal: cleanupController.signal });
        if (disposed || version !== cleanupGeneration) return false;
        if (!Number.isSafeInteger(data.deletedCount) || data.deletedCount < 0 || data.deletedCount > 50) throw new Error('오래된 원본의 정리 결과를 확인하지 못했습니다.');
        completionNotice = `오래된 원본 ${data.deletedCount}건을 정리했습니다.`;
      } catch (error) {
        if (disposed || version !== cleanupGeneration) return false;
        completionNotice = error.message || '오래된 원본을 정리하지 못했습니다.'; completionFailed = true;
      }
      await loadList({ completionNotice, completionFailed });
      return !disposed && version === cleanupGeneration && !completionFailed;
    } finally { if (!disposed && version === cleanupGeneration) { cleanupBusy = false; render(); } }
  }
  async function selectSource(id, { history = 'push', analyze = false, source: loadedSource, checkedNavigation = false } = {}) {
    if (disposed || !validId(id) || !checkedNavigation && !canLeave()) return false;
    const version = ++generation; sourceController?.abort(); const controller = new AbortController(); sourceController = controller;
    selectedId = id; sourceBusy = true; notice = ''; failed = false; onSelectStart?.({ id, history }); render();
    try {
      const source = loadedSource || (await requestOrderAi(session, `text-sources?id=${encodeURIComponent(id)}`, { signal: controller.signal })).source;
      if (disposed || version !== generation) return false;
      if (!source || source.id !== id || !hasOriginal(source) || !/^[a-f0-9]{64}$/.test(source.sha256 || '')) throw new Error('보관된 발주 원문을 확인하지 못했습니다.');
      if (!sources.some(item => item.id === id)) sources.unshift(sourceMetadata(source));
      sourceBusy = false; render();
      await onSelect?.(textSourceForAnalysis(source), { analyze });
      return !disposed && version === generation;
    } catch (error) {
      if (!disposed && version === generation && error.name !== 'AbortError') { notice = error.message; failed = true; render(); }
      return false;
    } finally { if (!disposed && version === generation) sourceBusy = false; }
  }
  function openDialog() {
    if (saving || sourceBusy || !canLeave()) return;
    if (!dialog.open) { formError.hidden = true; dialog.showModal(); (inputMode === 'image' ? fileInput : input).focus(); }
  }
  function closeDialog() {
    if (saving || (input.value.trim() || imageDraft || imageBusy) && !window.confirm('입력한 발주 내용을 닫을까요?')) return;
    dialog.close(); resetDraft();
  }
  const openClick = () => openDialog(), closeClick = () => closeDialog();
  addButton.addEventListener('click', openClick); close.addEventListener('click', closeClick); cancel.addEventListener('click', closeClick);
  const cancelDialog = event => { event.preventDefault(); closeDialog(); }; dialog.addEventListener('cancel', cancelDialog);
  const submitForm = async event => {
    event.preventDefault(); if (saving || !canLeave()) return;
    const text = input.value, image = imageDraft && { ...imageDraft }, selectedChannel = channel.value;
    if (inputMode === 'image' ? !image || imageBusy : !text.trim() || text.length > 20000) { imageError(inputMode === 'image' ? '발주 이미지를 붙여넣거나 선택해 주세요.' : '받은 발주 내용을 붙여넣어 주세요.'); return; }
    if (!requestId) requestId = crypto.randomUUID();
    const payload = inputMode === 'image' ? { requestId, channel: selectedChannel, image: { fileName: image.fileName, mimeType: image.mimeType, contentBase64: image.contentBase64 } } : { requestId, channel: selectedChannel, text };
    saving = true; formError.hidden = true; renderInput(); render();
    saveController = new AbortController();
    try {
      const data = await requestOrderAi(session, 'text-sources', { body: payload, signal: saveController.signal });
      if (disposed) return;
      const matches = payload.image ? data.source?.kind === 'image' && ['fileName', 'mimeType', 'contentBase64'].every(key => data.source[key] === payload.image[key]) && data.source.byteLength === image.byteLength : data.source?.kind !== 'image' && data.source?.text === text;
      if (!validId(data.source?.id) || !matches || data.source.channel !== selectedChannel || !/^[a-f0-9]{64}$/.test(data.source.sha256 || '')) throw new Error('보관된 발주 원문이 입력 내용과 일치하지 않습니다. 다시 확인해 주세요.');
      const source = data.source; dialog.close(); resetDraft();
      listController?.abort(); listGeneration++; listBusy = false;
      sources = [sourceMetadata(source), ...sources.filter(item => item.id !== source.id)]; render();
      await selectSource(source.id, { source, analyze: true, checkedNavigation: true });
    } catch (error) { if (!disposed && error.name !== 'AbortError') { formError.textContent = error.message; formError.hidden = false; } }
    finally { if (!disposed) { saving = false; renderInput(); render(); } }
  };
  form.addEventListener('submit', submitForm);
  // A changed draft must not reuse an idempotency key for different source text.
  const editDraft = () => { if (!saving) requestId = ''; }; input.addEventListener('input', editDraft); channel.addEventListener('change', editDraft);
  void cleanupExpired();
  return {
    selectSource, loadList,
    canLeave() { if (saving || cleanupBusy) { notice = saving ? '발주 원문을 저장하고 분석을 시작하고 있습니다.' : '오래된 원본을 정리하고 있습니다.'; render(); return false; } return true; },
    clearSelection() { generation++; sourceController?.abort(); selectedId = ''; sourceBusy = false; render(); },
    open: openDialog,
    destroy() { disposed = true; generation++; listGeneration++; cleanupGeneration++; listController?.abort(); sourceController?.abort(); saveController?.abort(); cleanupController?.abort(); releaseImage();
      addButton.removeEventListener('click', openClick); close.removeEventListener('click', closeClick); cancel.removeEventListener('click', closeClick); dialog.removeEventListener('cancel', cancelDialog); form.removeEventListener('submit', submitForm); form.removeEventListener('paste', pasted); fileInput.removeEventListener('change', fileChanged); for (const [control, action] of modeClicks) control.removeEventListener('click', action); input.removeEventListener('input', editDraft); channel.removeEventListener('change', editDraft); if (dialog.open) dialog.close(); }
  };
}
