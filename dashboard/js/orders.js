import { requireApprovedActiveUser, logoutToLogin } from './firebase-client.js';
import { initOrderNotifications } from './order-notifications.js';
import { initMailConnection } from './mail-connection.js';
import { initMailSourceViewer } from './mail-source-viewer.js';
import { ORDER_CUSTOMER_GROUPS, ORDER_SOURCE_CHANNELS, ORDER_STATUSES, ORDER_DELIVERY_METHODS, ORDER_LIMITS, getApprovalIssues } from './order-request-model.js';
import { createOrderRequest, subscribeOrderRequests, subscribeOrderRequest, updateOrderRequest, reviewOrderRequest } from './order-request-store.js';

const $ = id => document.getElementById(id);
let session, orders = [], currentOrder = null, selectedId = '', unsubscribeDetail, dirty = false, busy = false, conflicting = false, originalTestDraft = null, listConfirmed = false, listFailed = false;
const unsubscribe = [];

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function message(text, error = false) {
  $('orderMessage').textContent = text;
  $('orderMessage').dataset.error = String(error);
  $('orderMessage').hidden = !text;
}
function errorText(error) {
  if (error?.code === 'permission-denied') return '발주함 사용 권한 또는 저장 규칙이 적용되어 있는지 확인해 주세요.';
  if (error?.code === 'unavailable' || navigator.onLine === false) return '연결을 확인하지 못했습니다. 다시 연결된 뒤 처리해 주세요.';
  return error?.message || '처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
}
function formatTime(value) {
  if (!value) return '접수 시각 확인 중';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) : '시각 확인 필요';
}
function labelFor(labels, key) { return labels[key] || key || '확인 전'; }
function badge(text, status) { const node = element('span', text, 'order-badge'); if (status) node.dataset.status = status; return node; }
function canReview(order = currentOrder) { return !!order && ['pending_review', 'needs_information'].includes(order.status); }
function connected(order = currentOrder) { return navigator.onLine !== false && order?.syncState === 'confirmed'; }
function orderLink(id) { return new URL(`/orders?order=${encodeURIComponent(id)}`, window.location.origin).href; }
function allowNavigation() { return !busy && (!dirty || window.confirm('저장하지 않은 변경 내용이 있습니다. 다른 발주를 열까요?')); }

function renderList() {
  const filter = $('orderStatusFilter').value;
  const items = orders.filter(order => filter === 'all' || order.status === filter);
  $('orderCount').textContent = listConfirmed ? `${items.length}건` : listFailed ? '연결 확인 필요' : '서버 확인 중';
  $('orderList').replaceChildren();
  if (!items.length) { $('orderList').append(element('p', listFailed ? '발주 목록에 다시 연결해 주세요.' : listConfirmed ? '해당 상태의 발주가 없습니다.' : '서버에서 최신 발주를 확인하고 있습니다. 아직 0건으로 확정되지 않았습니다.', 'order-empty')); return; }
  for (const order of items) {
    const button = element('button', undefined, 'order-list-item');
    button.type = 'button'; button.setAttribute('aria-current', String(order.id === selectedId));
    button.append(element('strong', order.customerName));
    const meta = element('div', undefined, 'order-list-meta');
    meta.append(badge(labelFor(ORDER_STATUSES, order.status), order.status));
    if (order.isTest) meta.append(badge('테스트'));
    meta.append(element('span', `${labelFor(ORDER_SOURCE_CHANNELS, order.sourceChannel)} · ${formatTime(order.receivedAtIso)}`));
    button.append(meta);
    button.addEventListener('click', () => { if (order.id !== selectedId && allowNavigation()) selectOrder(order.id); });
    $('orderList').append(button);
  }
}

function field(label, name, value = '', { type = 'text', options, maxLength = 200, disabled = false } = {}) {
  const wrapper = element('label', label);
  const input = element(options ? 'select' : 'input');
  input.name = name; input.dataset.draft = 'true';
  if (options) for (const [key, text] of Object.entries(options)) { const option = element('option', text); option.value = key; input.append(option); }
  else { input.type = type; input.maxLength = maxLength; if (type === 'number') { input.min = '0'; input.max = '1000000'; input.step = 'any'; } }
  input.value = value ?? ''; input.disabled = disabled;
  wrapper.append(input); return wrapper;
}
function markDirty() {
  dirty = true;
  for (const check of $('orderDetail').querySelectorAll('[data-review-check]')) check.checked = false;
  updateActions();
}
function appendLine(line = {}, disabled = false) {
  const container = element('div', undefined, 'order-line');
  const header = element('div', undefined, 'order-line-heading');
  header.append(element('span', '품목'));
  const remove = element('button', '×', 'order-icon-button'); remove.type = 'button'; remove.setAttribute('aria-label', '이 품목 삭제'); remove.disabled = disabled;
  remove.addEventListener('click', () => { container.remove(); markDirty(); updateAddLine(); }); header.append(remove);
  container.append(header, field('품목명', 'productName', line.productName, { disabled, maxLength: 120 }), field('규격·포장 구성', 'specification', line.specification, { disabled, maxLength: 160 }));
  const row = element('div', undefined, 'order-form-grid');
  row.append(field('수량', 'quantity', line.quantity || '', { type: 'number', disabled }), field('단위', 'unit', line.unit, { disabled, maxLength: 20 })); container.append(row);
  container.addEventListener('input', markDirty);
  $('orderLines').append(container);
}
function updateAddLine() {
  const button = $('addOrderLine'); if (!button) return;
  button.disabled = busy || conflicting || !connected() || $('orderLines').children.length >= ORDER_LIMITS.lines;
}
function collectDraft() {
  const form = $('orderDraftForm');
  const value = name => form.elements.namedItem(name)?.value || '';
  return {
    deliveryDate: value('deliveryDate'), deliveryMethod: value('deliveryMethod'), recipientName: value('recipientName'), recipientPhone: value('recipientPhone'), deliveryAddress: value('deliveryAddress'),
    lines: [...$('orderLines').children].map(row => ({ productName: row.querySelector('[name="productName"]').value, specification: row.querySelector('[name="specification"]').value, quantity: Number(row.querySelector('[name="quantity"]').value || 0), unit: row.querySelector('[name="unit"]').value })),
  };
}
function updateActions() {
  if (!currentOrder || !$('approveOrder')) return;
  const checked = [...$('orderDetail').querySelectorAll('[data-review-check]')].every(input => input.checked);
  const issues = getApprovalIssues(currentOrder);
  const unsafe = busy || dirty || conflicting || !connected() || !canReview();
  $('approveOrder').disabled = unsafe || issues.length > 0 || !checked;
  $('requestOrderInfo').disabled = unsafe;
  $('rejectOrder').disabled = unsafe;
  $('saveOrderDraft').disabled = busy || !dirty || conflicting || !connected();
  $('reloadLatestOrder').hidden = !conflicting && connected();
  $('reloadLatestOrder').disabled = busy;
  $('orderSaveHint').textContent = conflicting ? '다른 담당자의 변경을 다시 불러오세요.' : dirty ? '저장한 뒤 원문과 다시 대조해 확정해 주세요.' : !connected() ? '서버 연결 확인 전에는 저장·확정할 수 없습니다.' : '원문과 저장된 내용을 대조해 확인합니다.';
  updateAddLine();
}

function renderDetail(order) {
  currentOrder = order; dirty = false; conflicting = false;
  const detail = $('orderDetail'); detail.replaceChildren();
  if (!order) { detail.append(element('div', '발주를 찾을 수 없습니다. 링크를 확인하거나 목록에서 선택해 주세요.', 'order-empty')); return; }
  const header = element('div', undefined, 'order-detail-header');
  const title = element('div'); const badges = element('div', undefined, 'order-badges');
  badges.append(badge(labelFor(ORDER_STATUSES, order.status), order.status), badge(`버전 ${order.revision}`));
  if (order.isTest) badges.append(badge('테스트 발주'));
  title.append(badges, element('h2', order.customerName), element('p', `${labelFor(ORDER_CUSTOMER_GROUPS, order.customerGroup)} · ${labelFor(ORDER_SOURCE_CHANNELS, order.sourceChannel)} · ${formatTime(order.receivedAtIso)}`, 'order-muted'));
  const copy = element('button', '확인 링크 복사', 'order-button'); copy.type = 'button';
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(orderLink(order.id)); message('발주 확인 링크를 복사했습니다. 링크를 열어도 로그인과 담당자 권한 확인이 필요합니다.'); } catch { message(`복사할 발주 확인 주소: ${orderLink(order.id)}`); } });
  header.append(title, copy); detail.append(header);
  const body = element('div', undefined, 'order-detail-body'); const source = element('section', undefined, 'order-original'); source.setAttribute('aria-label', '보존된 발주 원문');
  source.append(element('h3', '받은 원문'), element('p', order.sourceText, 'order-source-text'), element('p', order.sourceReference || '별도 참고 정보 없음', 'order-muted'), element('p', `등록: ${order.createdByName || '담당자'} · 원문은 수정되지 않습니다.`, 'order-muted'));
  const form = element('form'); form.id = 'orderDraftForm'; form.addEventListener('submit', event => { event.preventDefault(); void saveDraft(); });
  const heading = element('div', undefined, 'order-edit-heading'); heading.append(element('h3', '확인할 발주 내용')); form.append(heading);
  const draft = order.draft || {}; const disabled = !connected(order);
  const firstRow = element('div', undefined, 'order-form-grid'); firstRow.append(field('도착·납품 요청일', 'deliveryDate', draft.deliveryDate, { type: 'date', disabled }), field('배송방법', 'deliveryMethod', draft.deliveryMethod || 'undetermined', { options: ORDER_DELIVERY_METHODS, disabled }));
  const secondRow = element('div', undefined, 'order-form-grid'); secondRow.append(field('수령인·담당자', 'recipientName', draft.recipientName, { disabled, maxLength: 120 }), field('연락처', 'recipientPhone', draft.recipientPhone, { type: 'tel', disabled, maxLength: 40 }));
  form.append(firstRow, secondRow, field('납품·배송지', 'deliveryAddress', draft.deliveryAddress, { disabled, maxLength: 500 }));
  const lineHeading = element('div', undefined, 'order-edit-heading'); lineHeading.append(element('h3', `품목·규격·수량 (최대 ${ORDER_LIMITS.lines}개)`));
  const addLine = element('button', '+ 품목 추가', 'order-button'); addLine.type = 'button'; addLine.id = 'addOrderLine'; addLine.addEventListener('click', () => { appendLine(); markDirty(); }); lineHeading.append(addLine);
  const lines = element('div'); lines.id = 'orderLines'; form.append(lineHeading, lines);
  const saveRow = element('div', undefined, 'order-save-row'); const save = element('button', '내용 저장', 'order-button'); save.id = 'saveOrderDraft'; save.type = 'submit'; const saveHint = element('span', '', 'order-muted'); saveHint.id = 'orderSaveHint'; saveRow.append(save, saveHint); form.append(saveRow);
  form.addEventListener('input', markDirty); form.addEventListener('change', markDirty);
  body.append(source, form); detail.append(body);
  for (const line of draft.lines || []) appendLine(line, disabled);
  const review = element('section', undefined, 'order-review'); review.setAttribute('aria-label', '발주 담당자 확인');
  const issues = getApprovalIssues(order);
  if (issues.length) { const warning = element('div', undefined, 'order-issues'); warning.append(element('strong', '확정 전 확인이 필요합니다')); const list = element('ul'); issues.forEach(issue => list.append(element('li', issue))); warning.append(list); review.append(warning); }
  if (['approved', 'rejected'].includes(order.status)) review.append(element('p', `${labelFor(ORDER_STATUSES, order.status)} · ${order.reviewedByName || '담당자'} · ${formatTime(order.reviewedAtIso)}`, 'order-message'));
  if (order.reviewNotes) review.append(element('p', `검토 메모: ${order.reviewNotes}`, 'order-message'));
  const checks = element('div', undefined, 'order-checks');
  for (const [name, text] of [['identity', '거래처와 원문이 이번 발주와 일치합니다.'], ['items', '품목·규격·수량·단위를 원문과 대조했습니다.'], ['delivery', '도착 요청일·배송방법·수령 정보를 확인했습니다.']]) {
    const label = element('label', undefined, 'order-check'); const check = element('input'); check.type = 'checkbox'; check.dataset.reviewCheck = name; check.checked = order.status === 'approved' && order.reviewChecks?.[name] === true; check.disabled = !canReview(order) || !connected(order); check.addEventListener('change', updateActions); label.append(check, element('span', text)); checks.append(label);
  }
  review.append(checks);
  const noteLabel = element('label', '추가 확인·제외 사유 또는 담당자 메모', 'order-decision-note'); const note = element('textarea'); note.id = 'orderReviewNote'; note.rows = 2; note.maxLength = 2000; note.disabled = !canReview(order); noteLabel.append(note); review.append(noteLabel);
  const actions = element('div', undefined, 'order-actions');
  for (const [id, text, status, className] of [['approveOrder', '원문 대조 완료 · 발주 확정', 'approved', 'order-primary'], ['requestOrderInfo', '추가 확인 필요', 'needs_information', ''], ['rejectOrder', '처리 제외', 'rejected', 'order-danger']]) {
    const button = element('button', text, `order-button ${className}`); button.type = 'button'; button.id = id; button.addEventListener('click', () => { void reviewOrder(status); }); actions.append(button);
  }
  review.append(actions, element('p', '이 확인은 수집·정리된 내용이 원문과 일치하는지 발주 담당자가 확정하는 단계입니다. ERP 등록·출고는 아직 자동 실행되지 않으며, 내용이 바뀌면 다시 대조해야 합니다.', 'order-muted'));
  const reload = element('button', '최신 내용 다시 불러오기', 'order-button'); reload.type = 'button'; reload.id = 'reloadLatestOrder';
  reload.addEventListener('click', () => { if (allowNavigation()) selectOrder(selectedId, { replace: true }); }); review.append(reload);
  detail.append(review); updateActions();
}

function selectOrder(id, { replace = false } = {}) {
  unsubscribeDetail?.(); selectedId = id; currentOrder = null; dirty = false; conflicting = false;
  let firstResult = true;
  const url = new URL(window.location.href); if (id) url.searchParams.set('order', id); else url.searchParams.delete('order');
  window.history[replace ? 'replaceState' : 'pushState']({}, '', url.pathname + url.search);
  renderList();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) { renderDetail(null); return; }
  $('orderDetail').replaceChildren(element('div', '선택한 발주를 불러오고 있습니다.', 'order-empty'));
  unsubscribeDetail = subscribeOrderRequest(id, order => {
    if (busy && currentOrder && order?.id === currentOrder.id) return;
    if (dirty && order && currentOrder && (order.revision !== currentOrder.revision || order.status !== currentOrder.status || order.updatedAtIso !== currentOrder.updatedAtIso)) {
      conflicting = true; message('다른 담당자가 이 발주를 변경했습니다. 현재 링크를 다시 열어 최신 내용으로 확인해 주세요.', true); updateActions(); return;
    }
    if (dirty && order && currentOrder && order.revision === currentOrder.revision && order.status === currentOrder.status) { currentOrder = order; updateActions(); return; }
    renderDetail(order);
    if (firstResult && order && window.matchMedia('(max-width: 720px)').matches) {
      $('orderDetail').scrollIntoView({ block: 'start', behavior: 'auto' });
    }
    firstResult = false;
  }, error => { message(errorText(error), true); currentOrder = currentOrder ? { ...currentOrder, syncState: 'cached' } : null; updateActions(); });
}
async function saveDraft() {
  if (busy || !dirty || conflicting || !connected()) return;
  const id = selectedId, revision = currentOrder.revision, expectedUpdatedAtIso = currentOrder.updatedAtIso, draft = collectDraft();
  busy = true; updateActions();
  try { await updateOrderRequest(id, revision, { draft, expectedUpdatedAtIso }, session); dirty = false; conflicting = false; message('수정 내용을 저장했습니다. 원문과 다시 대조한 뒤 확정해 주세요.'); selectOrder(id, { replace: true }); }
  catch (error) { conflicting = /다른 담당자|최신 내용/.test(errorText(error)); message(errorText(error), true); }
  finally { busy = false; updateActions(); }
}
async function reviewOrder(status) {
  if (busy || dirty || conflicting || !connected() || !canReview()) return;
  const reviewNotes = $('orderReviewNote').value.trim();
  if (status !== 'approved' && !reviewNotes) { message('추가 확인 또는 처리 제외 사유를 입력해 주세요.', true); $('orderReviewNote').focus(); return; }
  const reviewChecks = Object.fromEntries([...$('orderDetail').querySelectorAll('[data-review-check]')].map(check => [check.dataset.reviewCheck, check.checked]));
  if (status === 'approved' && (getApprovalIssues(currentOrder).length || !Object.values(reviewChecks).every(Boolean))) return;
  busy = true; updateActions();
  try { await reviewOrderRequest(selectedId, currentOrder.revision, { status, reviewNotes, reviewChecks, expectedStatus: currentOrder.status, expectedUpdatedAtIso: currentOrder.updatedAtIso }, session); message(status === 'approved' ? '담당자의 원문 대조를 완료하고 이 버전의 발주를 확정했습니다. ERP 등록·출고는 아직 연결되지 않았습니다.' : status === 'needs_information' ? '추가 확인이 필요한 발주로 표시했습니다.' : '처리 대상에서 제외했습니다. 원문과 사유는 보존됩니다.'); selectOrder(selectedId, { replace: true }); }
  catch (error) { conflicting = /다른 담당자|최신 내용/.test(errorText(error)); message(errorText(error), true); }
  finally { busy = false; updateActions(); }
}

function testDeliveryDate() {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(Date.now() + 2 * 86400000));
  const find = type => parts.find(part => part.type === type).value;
  return `${find('year')}-${find('month')}-${find('day')}`;
}
function openCreate(isTest = false) {
  if (!allowNavigation()) return;
  const form = $('createOrderForm'); form.reset(); $('createOrderError').hidden = true; originalTestDraft = null;
  $('createOrderTitle').textContent = isTest ? '가상 발주로 확인 흐름을 테스트하세요' : '수집 누락 건을 수동으로 보완하세요';
  $('submitCreateOrder').textContent = isTest ? '테스트 발주 만들기' : '보완 등록하고 확인';
  if (isTest) {
    form.elements.customerName.value = '알림 확인용 예시 거래처'; form.elements.customerGroup.value = 'other'; form.elements.sourceChannel.value = 'manual'; form.elements.isTest.checked = true;
    form.elements.sourceText.value = '알림 테스트용 가상 발주입니다. 예시 참기름 180ml 2박스, 지정일에 직접 수령합니다. 실제 출고하지 않습니다.';
    form.elements.sourceReference.value = '웹앱 알림·확인 링크 동작 테스트';
    originalTestDraft = { deliveryDate: testDeliveryDate(), deliveryMethod: 'pickup', recipientName: '테스트 담당자', recipientPhone: '000-0000-0000', deliveryAddress: '', lines: [{ productName: '예시 참기름', specification: '180ml · 가상 상품', quantity: 2, unit: '박스' }] };
  }
  $('createOrderDialog').showModal(); form.elements.customerName.focus();
}
for (const id of ['closeCreateOrder', 'cancelCreateOrder']) $(id).addEventListener('click', () => $('createOrderDialog').close());
$('newOrderButton').addEventListener('click', () => openCreate());
$('testOrderButton').addEventListener('click', () => openCreate(true));
$('orderStatusFilter').addEventListener('change', renderList);
$('createOrderForm').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const form = event.currentTarget, data = new FormData(form), isTest = data.get('isTest') === 'on';
  if (originalTestDraft && !isTest) { $('createOrderError').textContent = '가상 발주는 테스트 표시를 유지해야 합니다. 실제 발주는 새로 등록해 주세요.'; $('createOrderError').hidden = false; return; }
  busy = true; $('submitCreateOrder').disabled = true; $('createOrderError').hidden = true;
  try {
    const created = await createOrderRequest({ customerName: data.get('customerName'), customerGroup: data.get('customerGroup'), sourceChannel: data.get('sourceChannel'), sourceReference: data.get('sourceReference'), sourceText: data.get('sourceText'), isTest, draft: originalTestDraft || {} }, session);
    $('createOrderDialog').close(); $('orderStatusFilter').value = 'pending_review'; message(isTest ? '가상 발주를 만들었습니다. 발주 담당자의 원문 대조·확정 흐름을 테스트할 수 있습니다.' : '수동 보완 건을 등록했습니다. 발주 담당자가 원문과 대조해 확정해 주세요.'); selectOrder(created.id);
  } catch (error) { $('createOrderError').textContent = errorText(error); $('createOrderError').hidden = false; }
  finally { busy = false; $('submitCreateOrder').disabled = false; updateActions(); }
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('popstate', () => { if (!allowNavigation()) { const url = new URL(window.location.href); url.searchParams.set('order', selectedId); window.history.pushState({}, '', url.pathname + url.search); return; } selectOrder(new URLSearchParams(location.search).get('order') || '', { replace: true }); });
window.addEventListener('offline', () => { listConfirmed = false; renderList(); message('인터넷 연결이 끊겼습니다. 서버에 다시 연결된 뒤 저장·확정해 주세요.', true); updateActions(); });
window.addEventListener('online', () => { message('다시 연결 중입니다. 최신 발주 내용을 확인해 주세요.'); if (selectedId && !dirty) selectOrder(selectedId, { replace: true }); });
window.addEventListener('pagehide', event => { if (!event.persisted) { unsubscribeDetail?.(); unsubscribe.forEach(stop => stop?.()); } });
$('orderLogoutButton')?.addEventListener('click', async () => {
  if (busy || !window.confirm(dirty ? '저장하지 않은 변경 내용이 있습니다. 저장하지 않고 로그아웃할까요?' : '로그아웃 하시겠습니까?')) return;
  const wasDirty = dirty;
  dirty = false;
  try { await logoutToLogin({ page: 'orders' }); }
  catch (error) { dirty = wasDirty; message(errorText(error), true); }
});

requireApprovedActiveUser().then(approvedSession => {
  if (!approvedSession) return;
  session = approvedSession;
  $('authLoading').hidden = true; $('ordersApp').hidden = false;
  $('orderUserName').textContent = session.profile.displayName || session.profile.employeeName || '사용자';
  if (!['manager', 'admin'].includes(session.profile.role)) { $('orderAccessDenied').hidden = false; $('orderWorkspace').hidden = true; $('newOrderButton').hidden = true; $('testOrderButton').hidden = true; return; }
  unsubscribe.push(initMailConnection(session, $('mailConnectionMount')));
  unsubscribe.push(initMailSourceViewer(session, $('mailSourceMount')));
  const notifications = initOrderNotifications({ ...session, mount: $('orderNotificationMount') }); unsubscribe.push(() => notifications?.destroy());
  const requestedId = new URLSearchParams(window.location.search).get('order');
  if (requestedId) selectOrder(requestedId, { replace: true });
  unsubscribe.push(subscribeOrderRequests((records, metadata = { fromCache: false, hasPendingWrites: false }) => {
    listConfirmed = !metadata.fromCache && !metadata.hasPendingWrites && navigator.onLine !== false; listFailed = false;
    orders = records; renderList();
    if (!selectedId && orders.length && !new URLSearchParams(location.search).has('mail')) selectOrder(orders.find(order => order.status === 'pending_review')?.id || orders[0].id, { replace: true });
  }, error => { listConfirmed = false; listFailed = true; renderList(); message(errorText(error), true); }));
});
