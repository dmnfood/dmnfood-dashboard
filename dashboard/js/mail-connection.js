const MAILBOX = 'official@dmnfood.co.kr';
const CLIENT_ID = 'kaXX9XpQRZ7ohuKFW1TU';
const SCHOOL_FOLDER_ID = '106';
const SCHOOL_FOLDER_NAME = '학교급식 발주';
const CONFIGURATION_URL = 'https://vercel.com/dmnfoods-projects/dmnfood-dashboard/settings/environment-variables';
const CONFIGURATION_LABELS = {
  NAVERWORKS_CLIENT_ID: '네이버웍스 Client ID',
  NAVERWORKS_CLIENT_SECRET: '네이버웍스 Client Secret',
  NAVERWORKS_REDIRECT_URI: '네이버웍스 인증 복귀 주소',
  NAVERWORKS_MAILBOX: '수집 계정',
  MAIL_TOKEN_ENCRYPTION_KEY: '연결 토큰 암호화 설정',
  MAIL_COLLECTOR_EMAIL: '메일 수집 전용 저장 계정',
  MAIL_COLLECTOR_PASSWORD: '메일 수집 전용 저장 계정 비밀 설정',
};

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, handler, primary = false) {
  const node = element('button', text, `order-button${primary ? ' order-primary' : ''}`);
  node.type = 'button'; node.addEventListener('click', handler); return node;
}
function counter(value) { return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('ko-KR') : '확인 중'; }
function formatTime(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) : '';
}
function safeError(error) {
  if (error?.name === 'AbortError') return '';
  if (error?.status === 401) return '로그인 시간이 만료되었습니다. 다시 로그인한 뒤 연결 상태를 확인해 주세요.';
  if (error?.status === 403) return '메일 연결 설정은 승인된 관리자 계정으로 진행해 주세요.';
  if (error?.code === 'school_mail_folder_unavailable' || error?.code === 'school_mail_folder_required') return '학교급식 발주 메일함의 이름이나 위치를 확인하지 못해 수집을 중단했습니다. 연결 상태를 새로 확인해 주세요.';
  if (error?.code === 'mail_configuration_required') return '서버 연결 설정이 아직 준비되지 않았습니다. 설정 항목을 저장한 뒤 연결 상태를 다시 확인해 주세요.';
  if (error?.code === 'naverworks_reconnect_required' || error?.code === 'mail_connection_required') return '메일 계정 연결을 다시 확인해야 합니다. 네이버웍스 계정 연결을 진행해 주세요.';
  if (error?.status === 409) return '연결 상태 또는 수집 범위가 변경되었습니다. 연결 상태를 새로 확인해 주세요.';
  if (error?.status === 429) return '요청이 많아 잠시 기다려야 합니다. 잠시 후 다시 시도해 주세요.';
  return '메일 연결 상태를 확인하지 못했습니다. 인터넷 연결과 서버 설정을 확인한 뒤 다시 시도해 주세요.';
}

/** Fail closed when the fixed school folder was renamed, duplicated, or replaced. */
export function findSchoolMailFolder(folders) {
  const named = folders.filter(folder => folder?.name === SCHOOL_FOLDER_NAME);
  return named.length === 1 && String(named[0].id) === SCHOOL_FOLDER_ID && folders.filter(folder => String(folder?.id) === SCHOOL_FOLDER_ID).length === 1 ? named[0] : null;
}

/** Connection metadata is read on load; collection always requires a manual click. */
export function initMailConnection(session, mount) {
  if (!mount) return () => {};
  const abortController = new AbortController();
  const isAdmin = session?.profile?.role === 'admin';
  let state = null, folders = [], selectedFolder = '', continuation = null, syncResult = null, busy = false, disposed = false;
  let statusError = '', actionMessage = '', actionFailed = false, folderError = '';
  let callbackStatus = '', callbackMessage = '', callbackFailed = false;
  let settingsTrigger = null;
  const strip = element('div', undefined, 'mail-connection-strip');
  const dialog = isAdmin ? element('dialog', undefined, 'mail-connection-dialog') : null;
  const dialogBody = isAdmin ? element('div', undefined, 'mail-dialog-body') : null;
  let dialogClose = null;
  function closeSettings() {
    if (!dialog?.open) return;
    dialog.close();
    if (!disposed) settingsTrigger?.focus();
  }
  function openSettings() {
    if (disposed || !isAdmin || dialog.open) return;
    dialog.showModal();
    dialogClose.focus();
  }
  const cancelSettings = event => { event.preventDefault(); closeSettings(); };
  const backdropSettings = event => { if (event.target === dialog) closeSettings(); };
  if (dialog) {
    const shell = element('div', undefined, 'mail-dialog-shell');
    const header = element('div', undefined, 'mail-dialog-heading');
    const title = element('h2', '메일 연결 설정');
    title.id = 'mailConnectionDialogTitle';
    dialog.setAttribute('aria-labelledby', title.id);
    dialogClose = button('닫기', closeSettings);
    dialogClose.setAttribute('aria-label', '메일 연결 설정 닫기');
    header.append(title, dialogClose); shell.append(header, dialogBody); dialog.append(shell);
    dialog.addEventListener('cancel', cancelSettings);
    dialog.addEventListener('click', backdropSettings);
  }
  mount.replaceChildren(strip, ...(dialog ? [dialog] : []));
  try {
    const url = new URL(window.location.href);
    const values = url.searchParams.getAll('mail_connection');
    if (values.length === 1 && ['connected', 'error'].includes(values[0])) callbackStatus = values[0];
    if (values.length) {
      url.searchParams.delete('mail_connection');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
  } catch { /* Connection state is verified by the server even if browser history is unavailable. */ }
  if (callbackStatus === 'error') {
    callbackMessage = '메일 계정 연결을 완료하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.';
    callbackFailed = true;
  } else if (callbackStatus === 'connected') {
    callbackMessage = isAdmin ? '메일 계정 연결 결과를 서버에서 확인하고 있습니다.' : '메일 계정 연결 결과는 관리자 계정에서 확인해 주세요.';
    callbackFailed = !isAdmin;
  }

  async function request(path, { method = 'GET', body } = {}) {
    const token = await session.user.getIdToken();
    if (disposed) throw new DOMException('Panel closed', 'AbortError');
    const response = await fetch(`/api/naverworks/${path}`, { method, cache: 'no-store', credentials: 'same-origin',
      signal: abortController.signal, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json().catch(() => ({}));
    if (disposed) throw new DOMException('Panel closed', 'AbortError');
    if (!response.ok || data.ok !== true) {
      const error = new Error('Mail request failed'); error.status = response.status; error.code = data.error?.code || data.code; throw error;
    }
    return data;
  }
  const ready = () => state?.configuration?.ready === true;
  const connected = () => ready() && state?.connection?.connected === true && state.connection.accessStatus === 'mailbox_access_verified' && typeof state.connection.mailbox === 'string' && state.connection.mailbox.toLowerCase() === MAILBOX;

  function statusCard(label, heading, description) {
    const node = element('div', undefined, 'mail-status-card');
    node.append(element('p', label, 'mail-status-label'), element('strong', heading), element('p', description, 'mail-description')); return node;
  }
  function renderResult(parent) {
    if (!syncResult) return;
    const result = element('div', undefined, 'mail-result mail-message');
    const partial = syncResult.status !== 'complete';
    result.append(element('strong', partial ? '학교급식 메일을 일부 가져왔습니다' : '선택한 범위의 학교급식 메일을 가져왔습니다'));
    const stats = element('div', undefined, 'mail-result-stats');
    for (const [label, value] of [['확인한 메일', syncResult.scanned], ['새로 보관', syncResult.collected], ['중복', syncResult.duplicates], ['건너뜀', syncResult.skipped]]) stats.append(element('span', `${label} ${counter(value)}건`));
    result.append(stats);
    const from = formatTime(syncResult.from), to = formatTime(syncResult.to);
    if (from && to) result.append(element('p', `${from} ~ ${to} · 한국 시간`, 'mail-description'));
    result.append(element('p', '보관 상태: 해석 대기. 아직 발주로 확정하거나 상품을 연결하지 않았습니다. 지원하는 Excel 첨부는 열람할 때 원본을 보관합니다.', 'mail-description'));
    if (partial) result.append(element('p', continuation ? '남은 메일이 있습니다. ‘이어서 수집’을 눌러 같은 기간의 다음 묶음을 가져오세요.' : '전체 범위 수집 완료가 확인되지 않았습니다. 연결 상태를 새로 확인해 주세요.', 'mail-description'));
    parent.append(result);
  }
  function render() {
    if (disposed) return;
    const focusRegion = strip.contains(document.activeElement) ? strip : dialog?.open && dialogBody.contains(document.activeElement) ? dialogBody : null;
    const focusAction = focusRegion ? document.activeElement?.dataset?.mailAction : null;
    strip.replaceChildren(); mount.setAttribute('aria-busy', String(busy));
    mount.dataset.mode = 'compact';
    const summary = element('div', undefined, 'mail-strip-summary');
    const identity = element('div', undefined, 'mail-strip-identity');
    identity.append(element('span', '네이버웍스', 'mail-strip-provider'), element('strong', SCHOOL_FOLDER_NAME));
    summary.append(identity);
    strip.append(summary);
    if (!isAdmin) {
      summary.append(element('p', '수집한 메일의 첨부 원본을 확인하세요. 메일 가져오기와 연결 설정은 관리자가 진행합니다.', 'mail-strip-note'));
      if (callbackMessage) {
        const message = element('p', callbackMessage, 'mail-strip-feedback'); message.setAttribute('role', callbackFailed ? 'alert' : 'status'); summary.append(message);
      }
      return;
    }

    const attention = Boolean(statusError || folderError);
    const badge = element('span', attention ? '확인 필요' : !state ? '연결 확인 중' : connected() ? '연결 정상' : ready() ? '연결 필요' : '설정 필요', 'mail-badge');
    badge.dataset.state = connected() && !attention ? 'ready' : !state && !statusError ? 'neutral' : 'attention'; identity.append(badge);
    const schoolSync = syncResult || (state?.lastSync?.folderId === SCHOOL_FOLDER_ID ? state.lastSync : null);
    let recent = '최근 7일 · 버튼을 눌러 메일을 가져옵니다';
    if (schoolSync) {
      const through = formatTime(schoolSync.to);
      recent = schoolSync.status === 'complete' ? `최근 수집 범위 ${through ? `${through}까지` : '확인됨'} · 해석 대기` : continuation ? '일부 수집 · 이어서 가져오기가 필요합니다' : '일부 수집 · 수집 범위 확인이 필요합니다';
    }
    summary.append(element('p', recent, 'mail-strip-note'));
    const actions = element('div', undefined, 'mail-strip-actions');
    const sync = button(busy ? '처리 중…' : continuation ? '이어서 수집' : '메일 가져오기', syncMail, true);
    sync.dataset.mailAction = 'sync';
    // Keep the active action focusable while busy; syncMail's guard prevents repeat requests.
    sync.disabled = !connected() || selectedFolder !== SCHOOL_FOLDER_ID || Boolean(folderError);
    sync.setAttribute('aria-disabled', String(busy || sync.disabled));
    settingsTrigger = button('연결 설정', openSettings);
    settingsTrigger.dataset.mailAction = 'open-settings';
    settingsTrigger.setAttribute('aria-haspopup', 'dialog');
    actions.append(sync, settingsTrigger); strip.append(actions);
    const feedbacks = [callbackMessage && { text: callbackMessage, error: callbackFailed }, (statusError || folderError || actionMessage) && { text: statusError || folderError || actionMessage, error: Boolean(statusError || folderError || actionFailed) }].filter(Boolean);
    for (const feedback of feedbacks) {
      const message = element('div', feedback.text, 'mail-strip-feedback');
      message.setAttribute('role', feedback.error ? 'alert' : 'status'); message.dataset.error = String(feedback.error); strip.append(message);
    }

    dialogBody.replaceChildren();
    const statuses = element('div', undefined, 'mail-status-grid');
    statuses.append(statusCard('서버 설정', state ? ready() ? '준비 완료' : '설정 필요' : statusError ? '확인 필요' : '확인 중', '인증 정보와 원문 저장 설정'),
      statusCard('메일 계정', connected() ? '연결 확인' : '연결 전', MAILBOX),
      statusCard('학교급식 최근 7일', schoolSync ? schoolSync.status === 'complete' ? '수집 범위 확인됨' : '일부 수집 · 계속 필요' : '학교급식 수집 기록 확인 필요', state?.lastSync && state.lastSync.folderId !== SCHOOL_FOLDER_ID && !syncResult ? '다른 메일함의 기존 기록은 ‘전체 수집 메일’에서 확인할 수 있습니다.' : '수집 결과는 ‘해석 대기’로 보관합니다.'));
    dialogBody.append(statuses);

    const details = element('details', undefined, 'mail-settings');
    details.open = !ready(); details.append(element('summary', '연결 계정과 서버 설정 확인'));
    const content = element('div', undefined, 'mail-settings-content'), account = element('dl', undefined, 'mail-account');
    for (const [label, value, code] of [['수집 계정', MAILBOX], ['Client ID', CLIENT_ID, true], ['학교급식 수집 범위', '학교급식 발주 메일함 · 최근 7일'], ['수집 실행 방식', '담당자가 수집 버튼으로 시작 · 상시 자동 수집 미가동'], ['발주 해석·상품 연결', '규칙 설정 전 · 자동 확정하지 않음']]) {
      account.append(element('dt', label), element('dd', value, code ? 'mail-code' : undefined));
    }
    content.append(account);
    if (state && !ready()) {
      content.append(element('p', '서버에 필요한 설정을 먼저 준비해 주세요. 비밀값은 이 화면이나 채팅에 입력하지 않습니다.', 'mail-description'));
      const missing = Array.isArray(state.configuration?.missing) ? state.configuration.missing.filter(key => typeof key === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(key)) : [];
      if (missing.length) {
        const list = element('ul', undefined, 'mail-missing');
        for (const key of missing) list.append(element('li', `${CONFIGURATION_LABELS[key] || '서버 설정 항목'} (${key})`));
        content.append(list);
      }
      const link = element('a', '서버 비밀 설정 열기', 'order-button'); link.href = CONFIGURATION_URL; link.target = '_blank'; link.rel = 'noopener noreferrer';
      content.append(link);
    }
    content.append(element('p', '메일 읽기 전용 연결입니다. 이 단계에서 메일 발송·삭제, ERP 등록·출고는 실행하지 않습니다.', 'mail-description'));
    details.append(content); dialogBody.append(details);

    const setupActions = element('div', undefined, 'mail-actions');
    const refresh = button(busy ? '확인 중…' : '연결 상태 새로 확인', () => refreshStatus()); refresh.disabled = busy; refresh.dataset.mailAction = 'refresh';
    const connect = button(connected() ? '메일 계정 다시 연결' : '네이버웍스 계정 연결', connectAccount, true); connect.disabled = busy || !ready(); connect.dataset.mailAction = 'connect';
    setupActions.append(refresh, connect); dialogBody.append(setupActions);
    for (const feedback of feedbacks) {
      const message = element('div', feedback.text, 'mail-message'); message.setAttribute('role', feedback.error ? 'alert' : 'status'); message.dataset.error = String(feedback.error); dialogBody.append(message);
    }

    const syncArea = element('div', undefined, 'mail-sync-area');
    syncArea.append(element('h3', '메일 가져오기 범위'), element('p', '‘학교급식 발주’ 메일함에서 최근 7일 자료를 가져옵니다. 버튼을 눌러야 실행되며, 상시 자동 수집은 아직 가동하지 않습니다. 수집이 발주 확인 완료를 뜻하지 않습니다.', 'mail-description'));
    const label = element('label', '학교급식 수집 메일함 · 고정', 'mail-folder');
    const select = element('select'); select.setAttribute('aria-label', '학교급식 수집 메일함');
    const option = element('option', selectedFolder ? SCHOOL_FOLDER_NAME : !connected() ? '계정 연결 후 확인합니다' : folderError ? '학교급식 메일함 확인 필요' : '학교급식 메일함 확인 중'); option.value = selectedFolder; select.append(option);
    select.value = selectedFolder; select.disabled = true;
    label.append(select); syncArea.append(label);
    if (folderError) { const warning = element('p', folderError, 'mail-message'); warning.setAttribute('role', 'alert'); syncArea.append(warning); }
    renderResult(syncArea); dialogBody.append(syncArea);
    if (focusAction) {
      const nextFocus = focusRegion.querySelector(`[data-mail-action="${focusAction}"]`);
      if (nextFocus && !nextFocus.disabled) nextFocus.focus();
      else if (focusRegion === dialogBody) dialogClose.focus();
      else settingsTrigger.focus();
    }
  }

  async function loadFolders() {
    try {
      const data = await request('folders');
      folders = Array.isArray(data.folders) ? data.folders.filter(folder => folder && (typeof folder.id === 'string' || typeof folder.id === 'number') && typeof folder.name === 'string').map(folder => ({ id: String(folder.id), name: folder.name })) : [];
      const folder = findSchoolMailFolder(folders), scope = data.schoolScope;
      const verified = folder && scope?.available === true && scope.verified === true && scope.folderId === SCHOOL_FOLDER_ID && scope.folderName === SCHOOL_FOLDER_NAME;
      folderError = verified ? '' : '‘학교급식 발주’ 메일함의 이름과 위치를 확인하지 못했습니다. 이름 변경·중복 여부를 확인해 주세요. 다른 메일함으로 대신 수집하지 않습니다.';
      selectedFolder = verified ? SCHOOL_FOLDER_ID : '';
      if (!verified) continuation = null;
    } catch (error) { folderError = safeError(error); folders = []; selectedFolder = ''; continuation = null; }
  }
  async function refreshStatus() {
    if (busy || !isAdmin || disposed) return;
    busy = true; statusError = ''; render();
    try {
      state = await request('status');
      if (callbackStatus === 'connected') {
        callbackFailed = !connected();
        callbackMessage = connected() ? '지정된 수신 계정의 메일 읽기 연결을 확인했습니다.' : '메일 계정 연결 완료를 확인하지 못했습니다. 지정 계정과 서버 설정을 확인한 뒤 다시 연결해 주세요.';
      }
      if (connected()) await loadFolders();
      else { folders = []; selectedFolder = ''; continuation = null; folderError = ''; }
    } catch (error) {
      state = null; folders = []; selectedFolder = ''; continuation = null; statusError = safeError(error);
      if (callbackStatus === 'connected') { callbackMessage = '메일 계정 연결 완료를 확인하지 못했습니다. 연결 상태를 새로 확인해 주세요.'; callbackFailed = true; }
    }
    finally { busy = false; render(); }
  }
  async function connectAccount() {
    if (busy || !isAdmin || !ready() || disposed) return;
    busy = true; actionMessage = ''; actionFailed = false; render();
    try {
      const data = await request('start', { method: 'POST', body: {} });
      const authorizationUrl = new URL(data.authorizationUrl);
      if (authorizationUrl.protocol !== 'https:' || authorizationUrl.hostname !== 'auth.worksmobile.com' || authorizationUrl.username || authorizationUrl.password) throw new Error('Invalid authorization address');
      if (!disposed) window.location.assign(authorizationUrl.href);
    } catch (error) { actionMessage = safeError(error); actionFailed = true; }
    finally { busy = false; render(); }
  }
  async function syncMail() {
    if (busy || !isAdmin || !connected() || selectedFolder !== SCHOOL_FOLDER_ID || folderError || disposed) return;
    busy = true; actionMessage = ''; actionFailed = false; render();
    try {
      const data = await request('sync', { method: 'POST', body: { folderId: selectedFolder, scope: 'school', ...(continuation ? { continuation } : {}) } });
      if (!data.sync || !['complete', 'partial'].includes(data.sync.status)) throw new Error('Invalid collection response');
      syncResult = data.sync;
      continuation = data.sync.status === 'partial' && typeof data.sync.continuation === 'string' && data.sync.continuation ? data.sync.continuation : null;
      actionMessage = data.sync.status === 'partial' ? '메일을 일부 가져왔습니다. ‘이어서 수집’을 눌러 나머지를 가져오세요.' : '학교급식 메일을 가져왔습니다. 목록에서 첨부 원본을 확인하세요.';
      window.dispatchEvent?.(new CustomEvent('mail-intakes-updated'));
    } catch (error) { actionMessage = safeError(error); actionFailed = true; }
    finally { busy = false; render(); }
  }

  render();
  if (isAdmin) void refreshStatus();
  return () => {
    disposed = true; abortController.abort();
    if (dialog) {
      dialog.removeEventListener('cancel', cancelSettings);
      dialog.removeEventListener('click', backdropSettings);
      if (dialog.open) dialog.close();
      dialog.remove();
    }
  };
}
