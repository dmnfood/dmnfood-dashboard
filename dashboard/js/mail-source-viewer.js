const SOURCE_PATH = '/api/naverworks/source';
const ATTACHMENT_PATH = '/api/naverworks/attachment';
const SCHOOL_FOLDER_ID = '106';
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ALLOWED_TAGS = new Set(['P', 'DIV', 'SPAN', 'BR', 'HR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'SMALL', 'SUB', 'SUP', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'TABLE', 'CAPTION', 'COLGROUP', 'COL', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD']);
const DROP_CONTENT = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'APPLET', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'OPTION', 'LINK', 'META', 'BASE']);
const FRAME_STYLE = 'body{margin:0;padding:18px;background:#fff;color:#172033;font:14px/1.7 Arial,sans-serif;overflow-wrap:anywhere}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #d4dbe4;padding:6px 9px;vertical-align:top}th{background:#eef2f6}pre{white-space:pre-wrap}blockquote{margin:10px 0;padding-left:12px;border-left:3px solid #cbd5e1}img{display:none}';

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
  if (error?.status === 413 || error?.code === 'mail_attachment_too_large') return '이 첨부파일은 웹 열람 크기 한도를 초과합니다. 네이버웍스에서 원본을 확인해 주세요.';
  if (error?.status === 422) return '이 첨부파일은 현재 웹 열람을 지원하지 않거나 원문 정보를 확인할 수 없습니다. 네이버웍스에서 확인해 주세요.';
  if (['mail_attachment_changed', 'MAIL_ATTACHMENT_CHANGED'].includes(error?.code)) return '첨부파일의 원본 정보가 일치하지 않아 열람을 중단했습니다. 네이버웍스 원문에서 확인해 주세요.';
  if (['naverworks_reconnect_required', 'mail_connection_required'].includes(error?.code)) return '첨부파일을 가져오려면 관리자가 네이버웍스 연결을 다시 확인해야 합니다.';
  if (error?.status === 429) return '요청이 많습니다. 잠시 후 다시 열어 주세요.';
  return '자료를 불러오지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.';
}
function bodyValue(raw) {
  const value = raw?.mail?.body;
  return typeof value === 'string' ? value : typeof value?.content === 'string' ? value.content : '';
}

/** Parse only in an inert template, then copy allowed content into a new document.
 * Untrusted nodes are never inserted into the app or activated in a live document. */
export function prepareMailBody(rawBody) {
  const original = String(rawBody || '');
  if (original.length > 1024 * 1024) throw new RangeError('Mail body is too large to format safely');
  const template = document.createElement('template'); template.innerHTML = original;
  const pending = [...template.content.childNodes].map(node => ({ node, depth: 1 }));
  let visited = 0;
  while (pending.length) {
    const { node, depth } = pending.pop();
    if (++visited > 30000 || depth > 80) throw new RangeError('Mail body structure exceeds safe formatting limits');
    for (const child of node.childNodes) pending.push({ node: child, depth: depth + 1 });
  }
  const safe = document.createElement('div');
  function copy(source, destination) {
    if (source.nodeType === Node.TEXT_NODE) { destination.append(document.createTextNode(source.textContent)); return; }
    if (source.nodeType !== Node.ELEMENT_NODE || DROP_CONTENT.has(source.tagName)) return;
    if (source.tagName === 'IMG') {
      if (source.getAttribute('alt')) destination.append(document.createTextNode(`[이미지: ${source.getAttribute('alt')}]`));
      return;
    }
    const target = ALLOWED_TAGS.has(source.tagName) ? document.createElement(source.tagName.toLowerCase()) : destination;
    if (target !== destination) {
      for (const name of ['colspan', 'rowspan']) {
        const value = source.getAttribute(name);
        if (['TD', 'TH'].includes(source.tagName) && /^\d{1,3}$/.test(value || '') && Number(value) > 0 && Number(value) <= 100) target.setAttribute(name, value);
      }
      if (source.tagName === 'TH') target.setAttribute('scope', source.getAttribute('scope') === 'row' ? 'row' : 'col');
      const align = source.getAttribute('align');
      if (['left', 'center', 'right'].includes(align)) target.style.textAlign = align;
      destination.append(target);
    }
    for (const child of source.childNodes) copy(child, target);
  }
  for (const child of template.content.childNodes) copy(child, safe);
  const plain = [];
  function text(node) {
    if (node.nodeType === Node.TEXT_NODE) { plain.push(node.textContent); return; }
    if (['BR', 'HR'].includes(node.tagName)) plain.push('\n');
    for (const child of node.childNodes) text(child);
    if (['P', 'DIV', 'TR', 'LI', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'PRE'].includes(node.tagName)) plain.push('\n');
    else if (['TD', 'TH'].includes(node.tagName)) plain.push('\t');
  }
  text(safe);
  const csp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
  return { html: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>${FRAME_STYLE}</style></head><body>${safe.innerHTML}</body></html>`, text: plain.join('').trim() };
}

function attachmentInfo(value, index) {
  return { id: String(value?.attachmentId ?? value?.id ?? ''), fileName: String(value?.filename ?? value?.fileName ?? value?.name ?? `첨부파일 ${index + 1}`), mimeType: String(value?.mimeType ?? value?.contentType ?? ''), size: Number(value?.size ?? value?.fileSize ?? value?.byteLength ?? 0), inline: String(value?.contentDisposition || '').toLowerCase() === 'inline', bigFile: Boolean(value?.bigFileFid || value?.bigFileExpireTime) };
}
function attachmentRestriction(info) {
  if (info.inline || info.bigFile || !/^[1-9][0-9]{0,18}$/.test(info.id)) return '본문 이미지·대용량 링크 첨부는 네이버웍스 원문에서 확인해 주세요.';
  const extension = info.fileName.toLowerCase().match(/\.(xlsx|xls|csv)$/)?.[1];
  if (!extension) return '현재 Excel(.xlsx, .xls)과 CSV만 웹 열람·보관을 지원합니다.';
  if (!info.fileName || info.fileName.length > 250 || /[\u0000-\u001f\u007f]/.test(info.fileName)) return '첨부파일 이름을 확인할 수 없습니다. 네이버웍스 원문에서 확인해 주세요.';
  if (!Number.isSafeInteger(info.size) || info.size < 1) return '원문 첨부파일의 크기를 확인할 수 없습니다. 네이버웍스 원문에서 확인해 주세요.';
  if (info.size > MAX_ATTACHMENT_BYTES) return '3 MB를 초과하는 파일은 네이버웍스 원문에서 확인해 주세요.';
  const mimeType = info.mimeType.split(';')[0].trim().toLowerCase();
  const expected = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', csv: 'text/csv' };
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

export function initMailSourceViewer(session, mount) {
  if (!mount) return () => {};
  let disposed = false, mails = [], nextCursor = null, selectedId = '', currentMail = null, listBusy = false, listError = '', detailBusy = false, detailError = '', detailVersion = 0, listVersion = 0, attachmentVersion = 0;
  let listController, detailController, attachmentController, workbookCleanup;
  let listScope = new URLSearchParams(location.search).get('mail_scope') === 'all' ? 'all' : 'school';
  const blobUrls = new Set();
  const heading = element('div', undefined, 'mail-source-heading'), intro = element('div');
  intro.append(element('p', '자동 수집 자료 · 읽기 전용', 'order-eyebrow'), element('h2', '수집한 메일 원본'), element('p', '보관된 본문과 첨부 Excel을 확인합니다. 현재는 해석 대기이며 발주 승인·ERP 등록은 실행되지 않습니다.', 'mail-source-muted'));
  const refresh = button('메일 목록 새로고침', () => void loadList()); heading.append(intro, refresh);
  const scopeRow = element('div', undefined, 'mail-source-scope-row'), scopeLabel = element('label', '메일 보기 범위', 'mail-source-scope-label');
  const scopeSelect = element('select'); scopeSelect.setAttribute('aria-label', '메일 보기 범위');
  for (const [value, name] of [['school', '학교급식 발주'], ['all', '전체 수집 메일']]) { const option = element('option', name); option.value = value; scopeSelect.append(option); }
  scopeSelect.value = listScope; scopeLabel.append(scopeSelect);
  const scopeNote = element('p', '', 'mail-source-muted'); scopeRow.append(scopeLabel, scopeNote);
  scopeSelect.addEventListener('change', () => {
    const scope = scopeSelect.value === 'all' ? 'all' : 'school';
    if (scope === listScope) return;
    listScope = scope; mails = []; nextCursor = null;
    const url = new URL(location.href); if (scope === 'all') url.searchParams.set('mail_scope', 'all'); else url.searchParams.delete('mail_scope');
    window.history.pushState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    void loadList();
  });
  const feedback = element('p', '', 'mail-source-feedback'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); feedback.hidden = true;
  const layout = element('div', undefined, 'mail-source-layout'), listSection = element('section', undefined, 'mail-source-list-panel'); listSection.setAttribute('aria-label', '수집 메일 목록');
  const list = element('div', undefined, 'mail-source-list'), more = button('메일 더 불러오기', () => void loadList(true)); more.hidden = true;
  listSection.append(list, more);
  const detail = element('section', undefined, 'mail-source-detail'); detail.setAttribute('aria-label', '선택한 메일 원문');
  layout.append(listSection, detail); mount.replaceChildren(heading, scopeRow, feedback, layout);

  function cleanupAttachment() {
    attachmentVersion += 1; attachmentController?.abort(); attachmentController = null;
    workbookCleanup?.(); workbookCleanup = undefined;
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
  function renderList() {
    scopeSelect.value = listScope;
    scopeNote.textContent = listScope === 'school' ? '수집할 때 ‘학교급식 발주’ 메일함에서 확인한 자료입니다. 해석 대기 상태이며 상시 자동 수집은 아직 가동하지 않습니다.' : '지금까지 보관한 모든 메일입니다. 학교급식 외 자료도 포함될 수 있습니다. 목록 범위를 바꿔도 현재 열람 중인 원문은 유지됩니다.';
    refresh.disabled = listBusy; more.disabled = listBusy; more.hidden = !nextCursor;
    listSection.setAttribute('aria-busy', String(listBusy)); list.replaceChildren();
    if (!mails.length) list.append(element('p', listBusy ? '수집한 메일을 불러오고 있습니다.' : listError ? '메일 목록 확인이 필요합니다.' : listScope === 'school' ? '아직 이 메일함에서 수집한 자료가 없습니다. ‘학교급식 발주 최근 7일 수집’을 실행한 뒤 확인해 주세요.' : '아직 보관된 메일이 없습니다. 메일 수집 후 목록을 새로고침해 주세요.', 'mail-source-empty'));
    for (const mail of mails) {
      const item = element('button', undefined, 'mail-source-item'); item.type = 'button'; item.setAttribute('aria-current', String(mail.id === selectedId));
      item.append(element('strong', mail.subject || '(제목 없음)'), element('span', sender(mail.from) || '발신자 확인 필요', 'mail-source-sender'), element('span', formatTime(mail.receivedAt), 'mail-source-time'), element('span', '해석 대기', 'mail-source-badge'));
      item.addEventListener('click', () => void selectMail(mail.id)); list.append(item);
    }
    feedback.textContent = listError; feedback.hidden = !listError;
  }
  function renderDetail() {
    detail.setAttribute('aria-busy', String(detailBusy)); detail.replaceChildren();
    if (detailBusy || detailError || !currentMail) { detail.append(element('p', detailBusy ? '보관된 메일 원문을 불러오고 있습니다.' : detailError || '목록에서 메일을 선택하면 보관한 원문과 첨부파일을 볼 수 있습니다.', 'mail-source-empty')); return; }
    const mail = currentMail, rawMail = mail.raw?.mail || {}, header = element('div', undefined, 'mail-source-detail-heading');
    header.append(element('span', '해석 대기 · 원본 열람', 'mail-source-badge'), element('h3', mail.subject || rawMail.subject || '(제목 없음)'));
    const metadata = element('dl', undefined, 'mail-source-meta');
    for (const [label, value] of [['보낸 사람', sender(mail.from || rawMail.from) || '확인 필요'], ['받은 시각', `${formatTime(mail.receivedAt)} · 한국 시간`], ['보관 시각', `${formatTime(mail.collectedAt)} · 한국 시간`]]) metadata.append(element('dt', label), element('dd', value));
    header.append(metadata);
    const copy = button('원문 링크 복사', async () => {
      const url = new URL(location.href); url.searchParams.set('mail', selectedId);
      try { await navigator.clipboard.writeText(url.href); feedback.textContent = '이 메일의 원문 열람 링크를 복사했습니다. 로그인과 담당자 권한이 필요합니다.'; }
      catch { feedback.textContent = `원문 열람 주소: ${url.href}`; }
      feedback.hidden = false;
    }); header.append(copy); detail.append(header);
    const rawBody = bodyValue(mail.raw);
    let body;
    try { body = prepareMailBody(rawBody); }
    catch { body = { html: null, text: rawBody, formatError: true }; }
    const bodySection = element('section', undefined, 'mail-source-body'); bodySection.setAttribute('aria-label', '보관된 메일 본문');
    bodySection.append(element('h4', '메일 본문'), element('p', '안전한 원문 보기: 외부 이미지·링크·실행 기능을 차단해 표시합니다. 발주 내용은 자동 확정하지 않습니다.', 'mail-source-muted'));
    if (body.formatError) {
      bodySection.append(element('p', '본문의 서식이 크거나 복잡해 원본 HTML을 텍스트로 표시합니다. 원문은 생략하지 않았으며 첨부파일은 아래에서 열 수 있습니다.', 'mail-source-error'), element('pre', body.text, 'mail-source-plain'));
    } else if (body.text) {
      const tabs = element('div', undefined, 'mail-source-tabs'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', '메일 본문 표시 방식');
      const frame = element('iframe', undefined, 'mail-source-frame'); frame.title = '보관된 메일 본문 원문'; frame.setAttribute('sandbox', ''); frame.referrerPolicy = 'no-referrer'; frame.srcdoc = body.html;
      const plain = element('pre', body.text, 'mail-source-plain'); plain.hidden = true;
      const formatted = button('서식으로 보기', () => setMode(false)), plainButton = button('텍스트로 보기', () => setMode(true));
      function setMode(textOnly) { frame.hidden = textOnly; plain.hidden = !textOnly; formatted.setAttribute('aria-pressed', String(!textOnly)); plainButton.setAttribute('aria-pressed', String(textOnly)); }
      setMode(false); tabs.append(formatted, plainButton); bodySection.append(tabs, frame, plain);
    } else bodySection.append(element('p', '표시할 본문 텍스트가 없습니다. 이미지로 된 내용은 네이버웍스 원문에서 확인해 주세요. 제목과 첨부파일도 함께 확인해 주세요.', 'mail-source-muted'));
    detail.append(bodySection);
    const attachmentSection = element('section', undefined, 'mail-source-attachments'); attachmentSection.setAttribute('aria-label', '메일 첨부파일'); attachmentSection.append(element('h4', '첨부파일'));
    const attachments = (Array.isArray(mail.raw?.attachments) ? mail.raw.attachments : []).map(getMailAttachmentPolicy);
    const preview = element('div', undefined, 'mail-source-attachment-preview'); preview.setAttribute('aria-live', 'polite');
    if (!attachments.length) attachmentSection.append(element('p', '보관된 첨부파일 정보가 없습니다.', 'mail-source-muted'));
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
    attachmentSection.append(element('p', '열람·다운로드를 선택하면 네이버웍스의 파일을 서버에 원본 그대로 보관한 뒤 이 기기에 표시합니다. 현재 지원 범위는 3 MB 이하의 일반 Excel·CSV 첨부입니다. 상품 연결·수량 합산은 아직 수행하지 않습니다.', 'mail-source-muted'), preview); detail.append(attachmentSection);
  }
  async function openAttachment(info, preview, downloadOnly) {
    if (attachmentRestriction(info)) return;
    const sourceId = selectedId;
    cleanupAttachment(); const version = attachmentVersion, controller = new AbortController(); attachmentController = controller;
    preview.replaceChildren(element('p', `${info.fileName} 파일을 가져오고 있습니다.`, 'mail-source-muted')); preview.setAttribute('aria-busy', 'true');
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
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })); blobUrls.add(url);
      const download = element('a', '원본 파일 저장', 'order-button'); download.href = url; download.download = fileName.replace(/[\u0000-\u001f/\\]/g, '_');
      preview.replaceChildren(element('p', `${fileName} · 원본 일치 확인 완료 (SHA-256)`, 'mail-source-muted'), download);
      if (downloadOnly) { download.click(); return; }
      const workbookMount = element('div'); preview.append(workbookMount);
      const { renderMailWorkbook } = await import('./mail-workbook-preview.js');
      if (disposed || version !== attachmentVersion || sourceId !== selectedId) return;
      const cleanup = await renderMailWorkbook({ mount: workbookMount, bytes, fileName, signal: controller.signal });
      if (disposed || version !== attachmentVersion || sourceId !== selectedId) cleanup?.(); else workbookCleanup = cleanup;
    } catch (error) {
      if (!disposed && version === attachmentVersion && error.name !== 'AbortError') { const warning = element('p', errorText(error), 'mail-source-error'); warning.setAttribute('role', 'alert'); preview.replaceChildren(warning); }
    } finally { if (!disposed && version === attachmentVersion) preview.setAttribute('aria-busy', 'false'); }
  }
  async function selectMail(id, { history = 'push', scroll = true } = {}) {
    if (!SOURCE_ID.test(id)) { detailController?.abort(); detailVersion += 1; cleanupAttachment(); selectedId = ''; detailError = '메일 열람 링크가 올바르지 않습니다.'; currentMail = null; detailBusy = false; renderList(); renderDetail(); return; }
    detailController?.abort(); cleanupAttachment(); const version = ++detailVersion, controller = new AbortController(); detailController = controller;
    selectedId = id; currentMail = null; detailBusy = true; detailError = '';
    if (history) { const url = new URL(location.href); url.searchParams.set('mail', id); window.history[history === 'replace' ? 'replaceState' : 'pushState'](window.history.state, '', `${url.pathname}${url.search}${url.hash}`); }
    renderList(); renderDetail();
    try {
      const data = await request(`${SOURCE_PATH}?intakeId=${encodeURIComponent(id)}`, controller);
      if (disposed || version !== detailVersion) return;
      if (!data.mail || data.mail.id !== id || !data.mail.raw) throw new Error('Invalid mail source');
      currentMail = data.mail;
    } catch (error) { if (!disposed && version === detailVersion && error.name !== 'AbortError') detailError = errorText(error); }
    finally { if (!disposed && version === detailVersion) { detailBusy = false; renderDetail(); if (scroll) detail.scrollIntoView({ block: 'start', behavior: 'auto' }); } }
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
    } catch (error) { if (!disposed && version === listVersion && error.name !== 'AbortError') listError = errorText(error); }
    finally { if (!disposed && version === listVersion) { listBusy = false; renderList(); } }
  }
  function onPopState() {
    const scope = new URLSearchParams(location.search).get('mail_scope') === 'all' ? 'all' : 'school';
    if (scope !== listScope) { listScope = scope; mails = []; nextCursor = null; void loadList(); }
    const id = new URLSearchParams(location.search).get('mail') || '';
    if (id === selectedId) return;
    if (id) void selectMail(id, { history: false });
    else { detailController?.abort(); detailVersion += 1; cleanupAttachment(); selectedId = ''; currentMail = null; detailBusy = false; detailError = ''; renderList(); renderDetail(); }
  }
  const onMailCollected = () => { if (!disposed) void loadList(); };
  window.addEventListener('popstate', onPopState);
  window.addEventListener('mail-intakes-updated', onMailCollected);
  renderList(); renderDetail(); void loadList();
  const requested = new URLSearchParams(location.search).get('mail');
  if (requested) void selectMail(requested, { history: false });
  return () => { disposed = true; listVersion += 1; detailVersion += 1; listController?.abort(); detailController?.abort(); cleanupAttachment(); window.removeEventListener('popstate', onPopState); window.removeEventListener('mail-intakes-updated', onMailCollected); };
}
