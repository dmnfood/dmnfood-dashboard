const MAILBOX = 'official@dmnfood.co.kr';
const CLIENT_ID = 'kaXX9XpQRZ7ohuKFW1TU';
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
  if (error?.code === 'mail_configuration_required') return '서버 연결 설정이 아직 준비되지 않았습니다. 설정 항목을 저장한 뒤 연결 상태를 다시 확인해 주세요.';
  if (error?.code === 'naverworks_reconnect_required' || error?.code === 'mail_connection_required') return '메일 계정 연결을 다시 확인해야 합니다. 네이버웍스 계정 연결을 진행해 주세요.';
  if (error?.status === 409) return '연결 상태 또는 수집 범위가 변경되었습니다. 연결 상태를 새로 확인해 주세요.';
  if (error?.status === 429) return '요청이 많아 잠시 기다려야 합니다. 잠시 후 다시 시도해 주세요.';
  return '메일 연결 상태를 확인하지 못했습니다. 인터넷 연결과 서버 설정을 확인한 뒤 다시 시도해 주세요.';
}

/** The panel only reads connection metadata on load. Mail collection requires an explicit folder and click. */
export function initMailConnection(session, mount) {
  if (!mount) return () => {};
  const abortController = new AbortController();
  const isAdmin = session?.profile?.role === 'admin';
  let state = null, folders = [], selectedFolder = '', continuation = null, syncResult = null, busy = false, disposed = false;
  let statusError = '', actionMessage = '', actionFailed = false, folderError = '';
  let callbackStatus = '', callbackMessage = '', callbackFailed = false;
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
    result.append(element('strong', partial ? '메일 목록·본문 수집이 진행 중입니다' : '선택한 범위의 메일 목록·본문을 수집했습니다'));
    const stats = element('div', undefined, 'mail-result-stats');
    for (const [label, value] of [['확인한 메일', syncResult.scanned], ['새로 보관', syncResult.collected], ['중복', syncResult.duplicates], ['건너뜀', syncResult.skipped]]) stats.append(element('span', `${label} ${counter(value)}건`));
    result.append(stats);
    const from = formatTime(syncResult.from), to = formatTime(syncResult.to);
    if (from && to) result.append(element('p', `${from} ~ ${to} · 한국 시간`, 'mail-description'));
    result.append(element('p', '보관 상태: 해석 대기. 아직 발주로 확정하거나 상품을 연결하지 않았습니다. 아래 수집된 메일에서 원문을 열 수 있으며, 지원하는 Excel 첨부는 열람할 때 원본을 보관합니다.', 'mail-description'));
    if (partial) result.append(element('p', continuation ? '남은 메일이 있습니다. ‘이어서 수집’을 눌러 같은 기간의 다음 묶음을 가져오세요.' : '전체 범위 수집 완료가 확인되지 않았습니다. 연결 상태를 새로 확인해 주세요.', 'mail-description'));
    parent.append(result);
  }
  function render() {
    if (disposed) return;
    mount.replaceChildren(); mount.setAttribute('aria-busy', String(busy));
    mount.dataset.mode = isAdmin ? 'setup' : 'compact';
    if (!isAdmin) {
      const heading = element('div', undefined, 'mail-heading'), title = element('div');
      title.append(element('h2', '네이버웍스 메일 수집'), element('p', '메일 연결 설정은 관리자가 진행합니다. 수집된 발주는 해석 규칙을 적용한 뒤 확인 대기 목록에 표시됩니다.', 'mail-description'));
      heading.append(title); mount.append(heading); return;
    }
    const heading = element('div', undefined, 'mail-heading'), title = element('div');
    title.append(element('h2', '네이버웍스 메일 연결'), element('p', '먼저 원문을 안전하게 모으고, 거래처별 해석 규칙은 다음 단계에서 정합니다.', 'mail-description'));
    const badge = element('span', statusError ? '상태 확인 필요' : connected() ? '계정 연결 확인' : ready() ? '계정 연결 전' : '설정 준비', 'mail-badge');
    badge.dataset.state = connected() ? 'ready' : 'attention'; heading.append(title, badge); mount.append(heading);
    const statuses = element('div', undefined, 'mail-status-grid');
    statuses.append(statusCard('1 · 서버 설정', !isAdmin ? '관리자 확인 필요' : state ? ready() ? '준비 완료' : '설정 필요' : statusError ? '확인 필요' : '확인 중', '인증 정보와 원문 저장 설정을 확인합니다.'),
      statusCard('2 · 메일 계정', connected() ? '연결 확인' : '연결 전', MAILBOX),
      statusCard('3 · 최근 7일 시험', syncResult ? syncResult.status === 'complete' ? '목록·본문 수집 완료' : '일부 수집 · 계속 필요' : state?.lastSync ? '최근 수집 기록 있음' : '수집 전', '수집 결과는 ‘해석 대기’로 보관합니다.'));
    mount.append(statuses);

    const details = element('details', undefined, 'mail-settings');
    details.open = !ready(); details.append(element('summary', '연결 계정과 서버 설정 확인'));
    const content = element('div', undefined, 'mail-settings-content'), account = element('dl', undefined, 'mail-account');
    for (const [label, value, code] of [['수집 계정', MAILBOX], ['Client ID', CLIENT_ID, true], ['시험 수집 기간', '선택한 메일함의 최근 7일'], ['발주 해석·상품 연결', '규칙 설정 전 · 자동 확정하지 않음']]) {
      account.append(element('dt', label), element('dd', value, code ? 'mail-code' : undefined));
    }
    content.append(account);
    if (!isAdmin) content.append(element('p', '메일 연결 설정과 시험 수집은 관리자 계정에서 진행합니다. 발주 담당자의 확인 화면과는 별도 설정입니다.', 'mail-description'));
    else if (state && !ready()) {
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
    details.append(content); mount.append(details);

    const actions = element('div', undefined, 'mail-actions');
    const refresh = button(busy ? '확인 중…' : '연결 상태 새로 확인', () => refreshStatus()); refresh.disabled = busy || !isAdmin;
    const connect = button(connected() ? '메일 계정 다시 연결' : '네이버웍스 계정 연결', connectAccount, true); connect.disabled = busy || !isAdmin || !ready();
    actions.append(refresh, connect); mount.append(actions);
    if (callbackMessage) {
      const feedback = element('div', callbackMessage, 'mail-message'); feedback.setAttribute('role', callbackFailed ? 'alert' : 'status'); feedback.dataset.error = String(callbackFailed); mount.append(feedback);
    }
    if (statusError || actionMessage) {
      const message = element('div', statusError || actionMessage, 'mail-message'); message.setAttribute('role', statusError || actionFailed ? 'alert' : 'status'); message.dataset.error = String(Boolean(statusError || actionFailed)); mount.append(message);
    }

    const syncArea = element('div', undefined, 'mail-sync-area');
    syncArea.append(element('h3', '최근 7일 메일 목록·본문 시험 수집'), element('p', '수집할 메일함을 직접 선택하세요. 거래처 지정과 발주서 해석은 아직 적용하지 않으므로 선택한 메일함의 해당 기간 메일이 모두 대상입니다. 수집된 메일에서 본문과 지원하는 Excel 첨부를 열람할 수 있습니다. 수집이 발주 확인 완료를 뜻하지 않습니다.', 'mail-description'));
    const label = element('label', '수집할 메일함', 'mail-folder');
    const select = element('select'); select.setAttribute('aria-label', '수집할 메일함');
    const placeholder = element('option', !connected() ? '계정 연결 후 선택할 수 있습니다' : folderError ? '메일함 확인 필요' : folders.length ? '메일함을 선택하세요' : '메일함을 확인하고 있습니다'); placeholder.value = ''; select.append(placeholder);
    for (const folder of folders) { const option = element('option', folder.name); option.value = folder.id; select.append(option); }
    select.value = selectedFolder; select.disabled = busy || !connected() || !folders.length || Boolean(continuation);
    select.addEventListener('change', () => { selectedFolder = select.value; continuation = null; syncResult = null; actionMessage = ''; actionFailed = false; render(); });
    label.append(select); syncArea.append(label);
    if (folderError) { const warning = element('p', folderError, 'mail-message'); warning.setAttribute('role', 'alert'); syncArea.append(warning); }
    const syncActions = element('div', undefined, 'mail-actions');
    const sync = button(busy ? '처리 중…' : continuation ? '이어서 수집' : '선택한 메일함에서 최근 7일 수집', syncMail, true);
    sync.disabled = busy || !isAdmin || !connected() || !selectedFolder || Boolean(folderError); syncActions.append(sync); syncArea.append(syncActions);
    renderResult(syncArea); mount.append(syncArea);
  }

  async function loadFolders() {
    try {
      const data = await request('folders');
      folders = Array.isArray(data.folders) ? data.folders.filter(folder => folder && (typeof folder.id === 'string' || typeof folder.id === 'number') && typeof folder.name === 'string').map(folder => ({ id: String(folder.id), name: folder.name })) : [];
      folderError = folders.length ? '' : '선택할 수 있는 메일함이 없습니다. 연결 계정을 확인해 주세요.';
      if (!folders.some(folder => folder.id === selectedFolder)) { selectedFolder = ''; continuation = null; }
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
    if (busy || !isAdmin || !connected() || !selectedFolder || disposed) return;
    busy = true; actionMessage = ''; actionFailed = false; render();
    try {
      const data = await request('sync', { method: 'POST', body: { folderId: selectedFolder, ...(continuation ? { continuation } : {}) } });
      if (!data.sync || !['complete', 'partial'].includes(data.sync.status)) throw new Error('Invalid collection response');
      syncResult = data.sync;
      continuation = data.sync.status === 'partial' && typeof data.sync.continuation === 'string' && data.sync.continuation ? data.sync.continuation : null;
      actionMessage = data.sync.status === 'partial' ? '이번 묶음의 목록·본문을 보관했습니다. 남은 메일 수집이 필요합니다.' : '선택한 기간의 메일 목록·본문을 보관했습니다. 아래 수집된 메일에서 원문과 Excel 첨부를 확인하세요.';
      window.dispatchEvent?.(new CustomEvent('mail-intakes-updated'));
    } catch (error) { actionMessage = safeError(error); actionFailed = true; }
    finally { busy = false; render(); }
  }

  render();
  if (isAdmin) void refreshStatus();
  return () => { disposed = true; abortController.abort(); };
}
