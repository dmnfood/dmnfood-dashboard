const SOURCE_PATH = '/api/naverworks/source';
const ATTACHMENT_PATH = '/api/naverworks/attachment';
const SCHOOL_FOLDER_ID = '106';
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ANALYSIS_STATES = { pending: '분석 대기', running: '분석 중', ready: '확인 준비', failed: '다시 확인 필요', confirmed: '발주 확정' };

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, handler) {
  const node = element('button', text, 'order-button'); node.type = 'button'; node.addEventListener('click', handler); return node;
}
function sender(value) {
  if (Array.isArray(value)) return value.map(sender).filter(Boolean).join(', ');
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const address = String(value.email || value.emailAddress || value.address || '');
    return value.name ? `${value.name}${address ? ` <${address}>` : ''}` : address;
  }
  return '';
}
function formatTime(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) : '수신 시각 확인 필요';
}
function errorText(error) {
  if (error?.status === 401) return '로그인 시간이 만료되었습니다. 다시 로그인한 뒤 원문을 열어 주세요.';
  if (error?.status === 403) return '메일 원문은 승인된 관리자·매니저 계정으로 열 수 있습니다.';
  if (error?.status === 404) return '보관된 원문이나 첨부파일을 찾을 수 없습니다. 목록을 새로 불러와 주세요.';
  if (error?.status === 413 || error?.code === 'mail_attachment_too_large') return '이 파일은 네이버웍스에서 열어 주세요.';
  if (error?.status === 422) return '이 첨부파일은 현재 웹 열람을 지원하지 않거나 원문 정보를 확인할 수 없습니다. 네이버웍스에서 확인해 주세요.';
  if (['mail_attachment_changed', 'MAIL_ATTACHMENT_CHANGED'].includes(error?.code)) return '첨부파일의 원본 정보가 일치하지 않아 열람을 중단했습니다. 네이버웍스 원문에서 확인해 주세요.';
  if (['naverworks_reconnect_required', 'mail_connection_required'].includes(error?.code)) return '첨부파일을 가져오려면 관리자가 네이버웍스 연결을 다시 확인해야 합니다.';
  if (error?.status === 429) return '요청이 많습니다. 잠시 후 다시 열어 주세요.';
  return '자료를 불러오지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.';
}
/** Build a mail link only from the numeric ID kept with the collected source. */
export function getNaverworksMailUrl(mailId) {
  if (!['string', 'number'].includes(typeof mailId)) return '';
  const id = String(mailId);
  if (!/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) return '';
  return `https://mail.worksmobile.com/read/popup?nMailId=${id}`;
}

function attachmentInfo(value, index) {
  return { id: String(value?.attachmentId ?? value?.id ?? ''), fileName: String(value?.filename ?? value?.fileName ?? value?.name ?? `첨부파일 ${index + 1}`), mimeType: String(value?.mimeType ?? value?.contentType ?? ''), size: Number(value?.size ?? value?.fileSize ?? value?.byteLength ?? 0), inline: String(value?.contentDisposition || '').toLowerCase() === 'inline', bigFile: Boolean(value?.bigFileFid || value?.bigFileExpireTime) };
}
function attachmentRestriction(info) {
  if (info.inline || info.bigFile || !/^[1-9][0-9]{0,18}$/.test(info.id)) return '본문 이미지·대용량 링크 첨부는 네이버웍스 원문에서 확인해 주세요.';
  const extension = info.fileName.toLowerCase().match(/\.(xlsx|xls|csv|png|jpe?g)$/)?.[1];
  if (!extension) return '이 파일은 네이버웍스에서 열어 주세요.';
  if (!info.fileName || info.fileName.length > 250 || /[\u0000-\u001f\u007f]/.test(info.fileName)) return '첨부파일 이름을 확인할 수 없습니다. 네이버웍스 원문에서 확인해 주세요.';
  if (!Number.isSafeInteger(info.size) || info.size < 1) return '원문 첨부파일의 크기를 확인할 수 없습니다. 네이버웍스 원문에서 확인해 주세요.';
  if (info.size > MAX_ATTACHMENT_BYTES) return '이 파일은 네이버웍스에서 열어 주세요.';
  const mimeType = info.mimeType.split(';')[0].trim().toLowerCase();
  const expected = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
  if (mimeType && !['application/octet-stream', 'binary/octet-stream', expected[extension], ...(extension === 'csv' ? ['text/plain', 'application/vnd.ms-excel'] : [])].includes(mimeType)) return '파일 확장자와 첨부 형식이 달라 별도 확인이 필요합니다.';
  return '';
}
/** Mirrors the supported archive boundary so unavailable files have an explanation before a request. */
export function getMailAttachmentPolicy(value, index = 0) {
  const info = attachmentInfo(value, index);
  return { ...info, restriction: attachmentRestriction(info) };
}
function decodeAttachment(value) {
  const encoded = value?.contentBase64;
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Invalid attachment content');
  const binary = atob(encoded);
  if (!binary.length || binary.length > MAX_ATTACHMENT_BYTES || value.byteLength !== binary.length) throw new Error('Invalid attachment size');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function initMailSourceViewer(session, mount, options = {}) {
  if (!mount) return () => {};
  let disposed = false, mails = [], nextCursor = null, selectedId = '', currentMail = null, listBusy = false, listError = '', detailBusy = false, detailError = '', detailVersion = 0, listVersion = 0, attachmentVersion = 0;
  let listController, detailController, attachmentController, previewController, workbookCleanup, previewVersion = 0, filePicker, pickerBody, pickerTrigger;
  let listScope = new URLSearchParams(location.search).get('mail_scope') === 'all' ? 'all' : 'school';
  const splitMode = Boolean(options.listMount && options.toolbarMount && (options.detailMount || options.summaryOnly));
  const blobUrls = new Set();
  const analysisStates = new Map(), analysisStatusNodes = new Map();
  const heading = element('div', undefined, 'mail-source-heading'), intro = element('div');
  intro.append(element('h2', '첨부 원본 확인'));
  heading.append(intro);
  const refresh = button('목록 새로고침', () => void loadList());
  const scopeRow = element('div', undefined, 'mail-source-scope-row'), scopeLabel = element('label', '메일 목록 범위', 'mail-source-scope-label');
  const scopeSelect = element('select'); scopeSelect.setAttribute('aria-label', '메일 목록 범위');
  for (const [value, name] of [['school', '학교급식 발주'], ['all', '전체 수집 메일']]) { const option = element('option', name); option.value = value; scopeSelect.append(option); }
  scopeSelect.value = listScope; scopeLabel.append(scopeSelect);
  scopeRow.append(scopeLabel, refresh);
  scopeSelect.addEventListener('change', () => {
    const scope = scopeSelect.value === 'all' ? 'all' : 'school';
    if (scope === listScope) return;
    listScope = scope; mails = []; nextCursor = null;
    const url = new URL(location.href); if (scope === 'all') url.searchParams.set('mail_scope', 'all'); else url.searchParams.delete('mail_scope');
    window.history.pushState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    options.onHistoryChange?.();
    void loadList();
  });
  const feedback = element('p', '', 'mail-source-feedback'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); feedback.hidden = true;
  const layout = element('div', undefined, 'mail-source-layout'), listSection = element('section', undefined, 'mail-source-list-panel'); listSection.setAttribute('aria-label', '수집 메일 목록');
  const list = element('div', undefined, 'mail-source-list'), more = button('메일 더 불러오기', () => void loadList(true)); more.hidden = true;
  listSection.append(list, more);
  const detail = element('section', undefined, 'mail-source-detail'); detail.setAttribute('aria-label', '첨부 원본 확인');
  if (splitMode) {
    options.toolbarMount.replaceChildren(scopeRow, feedback);
    options.listMount.replaceChildren(listSection);
    options.detailMount?.replaceChildren(detail);
  } else {
    layout.append(listSection, detail); mount.replaceChildren(heading, scopeRow, feedback, layout);
  }

  function cleanupAttachment() {
    attachmentVersion += 1; attachmentController?.abort(); attachmentController = null;
    workbookCleanup?.(); workbookCleanup = undefined;
    options.onWorkbookClosed?.();
    for (const url of blobUrls) URL.revokeObjectURL(url); blobUrls.clear();
  }
  async function request(path, controller, body) {
    const token = await session.user.getIdToken();
    if (disposed || controller.signal.aborted) throw new DOMException('Viewer closed', 'AbortError');
    const response = await fetch(path, { method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true) { const error = new Error('Mail source request failed'); error.status = response.status; error.code = data.error?.code || data.code; throw error; }
    return data;
  }
  function closeFilePicker() {
    if (filePicker?.open) filePicker.close();
    pickerTrigger?.focus?.(); pickerTrigger = null;
  }
  function cancelFilePreview() { previewVersion += 1; previewController?.abort(); previewController = null; closeFilePicker(); }
  function showFilePicker(mail, attachments, trigger) {
    if (!filePicker) {
      filePicker = element('dialog', undefined, 'order-dialog mail-source-file-picker'); filePicker.setAttribute('aria-label', '첨부파일');
      const header = element('div', undefined, 'order-dialog-header'); header.append(element('h2', '첨부파일'), button('닫기', closeFilePicker));
      pickerBody = element('div', undefined, 'mail-source-file-picker-body');
      filePicker.append(header, pickerBody); document.body.append(filePicker);
      filePicker.addEventListener('cancel', event => { event.preventDefault(); closeFilePicker(); });
    }
    pickerBody.replaceChildren(); pickerTrigger = trigger;
    if (!attachments.length) pickerBody.append(element('p', '첨부파일이 없습니다.', 'mail-source-muted'));
    for (const attachment of attachments) {
      const row = element('div', undefined, 'mail-source-file-choice');
      const open = button(attachment.fileName, () => { closeFilePicker(); previewFile(mail, attachment); }); open.disabled = Boolean(attachment.restriction);
      row.append(open); if (attachment.restriction) row.append(element('p', attachment.restriction, 'mail-source-muted'));
      pickerBody.append(row);
    }
    filePicker.showModal();
  }
  function previewFile(mail, attachment) {
    Promise.resolve(options.onPreviewAttachment?.(attachment, { mail })).catch(error => {
      if (!disposed) { feedback.textContent = errorText(error); feedback.hidden = false; }
    });
  }
  async function previewMailAttachments(mail, trigger) {
    previewController?.abort(); const version = ++previewVersion, controller = new AbortController(); previewController = controller;
    trigger.disabled = true; trigger.setAttribute('aria-busy', 'true');
    try {
      const source = currentMail?.id === mail.id ? currentMail : (await request(`${SOURCE_PATH}?intakeId=${encodeURIComponent(mail.id)}`, controller)).mail;
      if (disposed || version !== previewVersion) return;
      if (!source || source.id !== mail.id || !source.raw) throw new Error('Invalid mail source');
      const attachments = (Array.isArray(source.raw.attachments) ? source.raw.attachments : []).map(getMailAttachmentPolicy);
      if (attachments.length === 1 && !attachments[0].restriction) previewFile(source, attachments[0]);
      else showFilePicker(source, attachments, trigger);
    } catch (error) {
      if (!disposed && version === previewVersion && error.name !== 'AbortError') { feedback.textContent = errorText(error); feedback.hidden = false; }
    } finally {
      if (!disposed) { trigger.disabled = false; trigger.setAttribute('aria-busy', 'false'); }
    }
  }
  function updateAnalysisStatus(id, node) {
    const status = analysisStates.get(id);
    node.hidden = !status;
    if (!status) return;
    node.textContent = ANALYSIS_STATES[status.state]; node.dataset.state = status.state;
    node.title = status.message || node.textContent;
  }
  function setAnalysisStates(items) {
    if (disposed || !Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item.intakeId !== 'string' || !SOURCE_ID.test(item.intakeId) || !Object.hasOwn(ANALYSIS_STATES, item.state)) continue;
      if (analysisStates.get(item.intakeId)?.state === 'confirmed' && item.state !== 'confirmed') continue;
      analysisStates.set(item.intakeId, { state: item.state, message: typeof item.message === 'string' ? item.message.trim().slice(0, 240) : '' });
      const node = analysisStatusNodes.get(item.intakeId);
      if (node) updateAnalysisStatus(item.intakeId, node);
    }
  }
  function renderList() {
    scopeSelect.value = listScope;
    scopeSelect.title = listScope === 'school' ? '수집 당시 학교급식 발주 메일함에서 확인한 자료' : '전체 보관 메일';
    refresh.disabled = listBusy; more.disabled = listBusy; more.hidden = !nextCursor;
    listSection.setAttribute('aria-busy', String(listBusy)); list.replaceChildren(); analysisStatusNodes.clear();
    if (!mails.length) list.append(element('p', listBusy ? '수집한 메일을 불러오고 있습니다.' : listError ? '메일 목록 확인이 필요합니다.' : listScope === 'school' ? '아직 수집한 메일이 없습니다. 메일을 가져온 뒤 확인해 주세요.' : '아직 보관된 메일이 없습니다. 메일 수집 후 목록을 새로고침해 주세요.', 'mail-source-empty'));
    const outsideMail = currentMail && !mails.some(mail => mail.id === currentMail.id) ? currentMail : null;
    for (const mail of [...(outsideMail ? [outsideMail] : []), ...mails]) {
      const item = element('article', undefined, 'mail-source-item'); item.setAttribute('aria-current', String(mail.id === selectedId)); item.dataset.intakeId = mail.id;
      if (mail === outsideMail) item.append(element('p', listBusy ? '현재 선택한 메일' : '현재 선택한 메일 · 목록 범위 밖', 'mail-source-outside-scope'));
      const select = element('button', undefined, 'mail-source-select'); select.type = 'button'; select.setAttribute('aria-current', String(mail.id === selectedId));
      select.append(element('strong', mail.subject || '(제목 없음)'), element('span', sender(mail.from) || '발신자 확인 필요', 'mail-source-sender'), element('span', formatTime(mail.receivedAt), 'mail-source-time'));
      const analysisStatus = element('span', undefined, 'mail-source-analysis-status');
      analysisStatusNodes.set(mail.id, analysisStatus); updateAnalysisStatus(mail.id, analysisStatus); select.append(analysisStatus);
      select.addEventListener('click', () => void selectMail(mail.id)); item.append(select);
      if (options.summaryOnly || options.onPreviewAttachment) {
        const actions = element('div', undefined, 'mail-source-item-actions'), mailUrl = getNaverworksMailUrl(mail.mailId ?? (currentMail?.id === mail.id ? currentMail.raw?.mail?.mailId : null));
        const openMail = mailUrl ? element('a', '네이버웍스 ↗', 'mail-source-item-action') : element('button', '네이버웍스 ↗', 'mail-source-item-action');
        if (mailUrl) { openMail.href = mailUrl; openMail.target = '_blank'; openMail.rel = 'noopener noreferrer'; }
        else { openMail.type = 'button'; openMail.disabled = true; openMail.title = '메일 원문 주소를 확인할 수 없습니다.'; }
        openMail.setAttribute('aria-label', `네이버웍스에서 ${mail.subject || '제목 없는'} 메일 열기`);
        const files = button('첨부파일', () => void previewMailAttachments(mail, files)); files.className = 'mail-source-item-action';
        files.setAttribute('aria-label', `첨부파일 · ${mail.subject || '제목 없음'}`); files.disabled = mail.attachmentCount === 0;
        if (files.disabled) files.title = '첨부파일이 없습니다.';
        actions.append(openMail, files); item.append(actions);
      }
      list.append(item);
    }
    feedback.textContent = listError || detailError; feedback.hidden = !feedback.textContent;
  }
  function renderDetail() {
    detail.setAttribute('aria-busy', String(detailBusy)); detail.replaceChildren();
    if (options.summaryOnly) { detail.hidden = true; feedback.textContent = detailError || listError; feedback.hidden = !feedback.textContent; return; }
    if (detailBusy || detailError || !currentMail) { detail.append(element('p', detailBusy ? '첨부 원본을 불러오고 있습니다.' : detailError || '왼쪽에서 메일을 선택하면 첨부 원본을 확인할 수 있습니다.', 'mail-source-empty')); return; }
    const mail = currentMail, rawMail = mail.raw?.mail || {}, header = element('div', undefined, 'mail-source-detail-heading');
    header.append(element('span', '해석 대기', 'mail-source-badge'), element('h3', mail.subject || rawMail.subject || '(제목 없음)'));
    const metadata = element('dl', undefined, 'mail-source-meta');
    for (const [label, value] of [['보낸 사람', sender(mail.from || rawMail.from) || '확인 필요'], ['받은 시각', formatTime(mail.receivedAt)]]) metadata.append(element('dt', label), element('dd', value));
    header.append(metadata);
    const headerActions = element('div', undefined, 'mail-source-detail-actions');
    const mailUrl = getNaverworksMailUrl(mail.mailId ?? rawMail.mailId);
    if (mailUrl) {
      const openMail = element('a', '네이버웍스에서 메일 열기 ↗', 'order-button');
      openMail.href = mailUrl; openMail.target = '_blank'; openMail.rel = 'noopener noreferrer';
      headerActions.append(openMail);
    }
    const copy = button('확인 링크 복사', async () => {
      const url = new URL(location.href); url.searchParams.set('mail', selectedId);
      try { await navigator.clipboard.writeText(url.href); feedback.textContent = '첨부 원본 확인 링크를 복사했습니다.'; }
      catch { feedback.textContent = `첨부 원본 확인 주소: ${url.href}`; }
      feedback.hidden = false;
    }); headerActions.append(copy); header.append(headerActions); detail.append(header);
    const attachments = (Array.isArray(mail.raw?.attachments) ? mail.raw.attachments : []).map(getMailAttachmentPolicy);
    const attachmentSection = element('section', undefined, 'mail-source-attachments'); attachmentSection.setAttribute('aria-label', '메일 첨부파일'); attachmentSection.append(element('h4', '첨부 원본'));
    const preview = element('div', undefined, 'mail-source-attachment-preview'); preview.setAttribute('aria-live', 'polite');
    if (!attachments.length) attachmentSection.append(element('p', '첨부파일이 없는 메일입니다. 발주 내용은 네이버웍스에서 확인해 주세요.', 'mail-source-muted'));
    for (const attachment of attachments) {
      const row = element('div', undefined, 'mail-source-attachment-row'), info = element('div');
      info.append(element('strong', attachment.fileName), element('span', attachment.size > 0 ? `${(attachment.size / 1024).toLocaleString('ko-KR', { maximumFractionDigits: 1 })} KB` : '크기 확인 전', 'mail-source-muted')); row.append(info);
      const actions = element('div', undefined, 'mail-source-attachment-actions');
      const restriction = attachment.restriction, isWorkbook = /\.(xlsx|xls|csv)$/i.test(attachment.fileName);
      if (restriction) info.append(element('span', restriction, 'mail-source-muted'));
      if (isWorkbook) { const open = button(/\.csv$/i.test(attachment.fileName) ? 'CSV 열람' : 'Excel 열람', () => void openAttachment(attachment, preview, false)); open.disabled = Boolean(restriction); actions.append(open); }
      const download = button('원본 다운로드', () => void openAttachment(attachment, preview, true)); download.disabled = Boolean(restriction); actions.append(download);
      row.append(actions); attachmentSection.append(row);
    }
    attachmentSection.append(preview); detail.append(attachmentSection);
  }
  async function openAttachment(info, preview, downloadOnly) {
    if (attachmentRestriction(info)) return;
    if (options.onBeforeOpenAttachment?.() === false) return;
    const sourceId = selectedId;
    cleanupAttachment(); const version = attachmentVersion, controller = new AbortController(); attachmentController = controller;
    preview.replaceChildren(element('p', '파일을 여는 중…', 'mail-source-muted')); preview.setAttribute('aria-busy', 'true');
    try {
      const data = await request(ATTACHMENT_PATH, controller, { intakeId: sourceId, attachmentId: info.id });
      if (disposed || version !== attachmentVersion || sourceId !== selectedId) return;
      const attachment = data.attachment, bytes = decodeAttachment(attachment);
      if (attachment.id !== info.id) throw new Error('Attachment identity mismatch');
      if (!/^[a-f0-9]{64}$/.test(attachment.sha256 || '')) throw new Error('Attachment hash missing');
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
      if (digest !== attachment.sha256) throw new Error('Attachment integrity mismatch');
      if (disposed || version !== attachmentVersion || sourceId !== selectedId) return;
      const fileName = String(attachment.fileName || info.fileName);
      preview.replaceChildren();
      if (downloadOnly) {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })); blobUrls.add(url);
        const download = element('a'); download.href = url; download.download = fileName.replace(/[\u0000-\u001f/\\]/g, '_'); download.hidden = true;
        preview.append(download); download.click(); download.remove(); return;
      }
      const workbookMount = element('div'); preview.append(workbookMount);
      const { renderMailWorkbook } = await import('./mail-workbook-preview.js');
      if (disposed || version !== attachmentVersion || sourceId !== selectedId) return;
      const cleanup = await renderMailWorkbook({ mount: workbookMount, bytes, fileName, signal: controller.signal,
        ...(options.onSelectionChange ? { selectionEnabled: false, onSelectionChange: value => {
          if (!disposed && version === attachmentVersion && sourceId === selectedId) options.onSelectionChange(value);
        } } : {}) });
      if (disposed || version !== attachmentVersion || sourceId !== selectedId) cleanup?.(); else {
        workbookCleanup = cleanup;
        options.onWorkbookOpened?.({ mail: currentMail, attachment, workbook: cleanup });
      }
    } catch (error) {
      if (!disposed && version === attachmentVersion && error.name !== 'AbortError') { const warning = element('p', errorText(error), 'mail-source-error'); warning.setAttribute('role', 'alert'); preview.replaceChildren(warning); }
    } finally { if (!disposed && version === attachmentVersion) preview.setAttribute('aria-busy', 'false'); }
  }
  async function selectMail(id, { history = 'push', scroll = true, checkedNavigation = false } = {}) {
    if (disposed || !checkedNavigation && options.onBeforeSelectMail?.() === false) return;
    cancelFilePreview();
    if (!SOURCE_ID.test(id)) { detailController?.abort(); detailVersion += 1; cleanupAttachment(); selectedId = ''; detailError = '메일 열람 링크가 올바르지 않습니다.'; currentMail = null; detailBusy = false; options.onSelectMail?.({ id: '', mail: null, history }); renderList(); renderDetail(); return; }
    detailController?.abort(); cleanupAttachment(); const version = ++detailVersion, controller = new AbortController(); detailController = controller;
    selectedId = id; currentMail = null; detailBusy = true; detailError = '';
    if (history) { const url = new URL(location.href); url.searchParams.set('mail', id); window.history[history === 'replace' ? 'replaceState' : 'pushState'](window.history.state, '', `${url.pathname}${url.search}${url.hash}`); options.onHistoryChange?.(); }
    options.onSelectMail?.({ id, mail: mails.find(mail => mail.id === id), history });
    renderList(); renderDetail();
    try {
      const data = await request(`${SOURCE_PATH}?intakeId=${encodeURIComponent(id)}`, controller);
      if (disposed || version !== detailVersion) return;
      if (!data.mail || data.mail.id !== id || !data.mail.raw) throw new Error('Invalid mail source');
      currentMail = data.mail;
      options.onMailLoaded?.(currentMail);
    } catch (error) { if (!disposed && version === detailVersion && error.name !== 'AbortError') detailError = errorText(error); }
    finally { if (!disposed && version === detailVersion) { detailBusy = false; renderList(); renderDetail(); if (scroll && !options.summaryOnly && (!splitMode || window.matchMedia?.('(max-width: 720px)')?.matches)) detail.scrollIntoView({ block: 'start', behavior: 'auto' }); } }
  }
  async function loadList(append = false) {
    if (disposed || (append && (listBusy || !nextCursor))) return;
    listController?.abort(); const version = ++listVersion, controller = new AbortController(); listController = controller; const cursor = append ? nextCursor : null, folderId = listScope === 'school' ? SCHOOL_FOLDER_ID : null;
    listBusy = true; listError = ''; renderList();
    try {
      const params = new URLSearchParams(); if (folderId) params.set('folderId', folderId); if (cursor) params.set('cursor', cursor);
      const data = await request(`${SOURCE_PATH}${params.size ? `?${params}` : ''}`, controller);
      if (disposed || version !== listVersion) return;
      if (!Array.isArray(data.mails) || data.scope?.folderId !== folderId || data.mails.some(mail => !mail || !SOURCE_ID.test(mail.id) || (folderId && mail.folderId !== folderId))) throw new Error('Invalid mail list scope');
      const records = data.mails.filter(mail => mail && SOURCE_ID.test(mail.id));
      mails = [...new Map([...(append ? mails : []), ...records].map(mail => [mail.id, mail])).values()];
      nextCursor = typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null;
      try { Promise.resolve(options.onListLoaded?.(records)).catch(() => {}); } catch { /* Supplementary status loading must not block the mail list. */ }
    } catch (error) { if (!disposed && version === listVersion && error.name !== 'AbortError') listError = errorText(error); }
    finally { if (!disposed && version === listVersion) { listBusy = false; renderList(); } }
  }
  function clearSelection({ history = 'push', checkedNavigation = false } = {}) {
    if (disposed || !checkedNavigation && options.onBeforeSelectMail?.() === false) return false;
    detailController?.abort(); detailVersion += 1; cleanupAttachment(); cancelFilePreview();
    selectedId = ''; currentMail = null; detailBusy = false; detailError = '';
    if (history) { const url = new URL(location.href); url.searchParams.delete('mail'); window.history[history === 'replace' ? 'replaceState' : 'pushState'](window.history.state, '', `${url.pathname}${url.search}${url.hash}`); options.onHistoryChange?.(); }
    options.onSelectMail?.({ id: '', mail: null, history }); renderList(); renderDetail(); return true;
  }
  function onPopState() {
    if (disposed) return;
    const requestedId = new URLSearchParams(location.search).get('mail') || '';
    if (requestedId !== selectedId && options.onBeforeSelectMail?.() === false) {
      const url = new URL(location.href); if (selectedId) url.searchParams.set('mail', selectedId); else url.searchParams.delete('mail');
      if (listScope === 'all') url.searchParams.set('mail_scope', 'all'); else url.searchParams.delete('mail_scope');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`); return;
    }
    const scope = new URLSearchParams(location.search).get('mail_scope') === 'all' ? 'all' : 'school';
    if (scope !== listScope) { listScope = scope; mails = []; nextCursor = null; void loadList(); }
    const id = new URLSearchParams(location.search).get('mail') || '';
    if (id === selectedId) return;
    if (id) void selectMail(id, { history: false, checkedNavigation: true });
    else clearSelection({ history: false, checkedNavigation: true });
  }
  const onMailCollected = () => { if (!disposed) void loadList(); };
  if (!options.manageHistory) window.addEventListener('popstate', onPopState);
  window.addEventListener('mail-intakes-updated', onMailCollected);
  renderList(); renderDetail(); void loadList();
  const requested = new URLSearchParams(location.search).get('mail');
  if (requested) void selectMail(requested, { history: false });
  const dispose = () => { disposed = true; analysisStates.clear(); analysisStatusNodes.clear(); listVersion += 1; detailVersion += 1; listController?.abort(); detailController?.abort(); cancelFilePreview(); cleanupAttachment(); filePicker?.remove(); window.removeEventListener('popstate', onPopState); window.removeEventListener('mail-intakes-updated', onMailCollected); };
  dispose.clearSelection = clearSelection;
  dispose.selectMail = selectMail;
  dispose.syncHistory = onPopState;
  dispose.setAnalysisStates = setAnalysisStates;
  return dispose;
}
