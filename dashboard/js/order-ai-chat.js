import { requestOrderAi } from './order-ai-client.js';
import { subscribeSchoolMealCompanies, ensureSchoolMealCompanies } from './school-meal-company-store.js';

function el(tag, text, cls) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; }
function button(text, action, cls = '') { const node = el('button', text, `order-button ${cls}`); node.type = 'button'; node.addEventListener('click', action); return node; }
const confirmed = value => ['confirmed', 'approved'].includes(value?.status);
const customerId = value => value?.id || value?.code;
const groupLabel = group => group.label || group.productLabel || group.productId || '상품 확인 필요';
const STEPS = [{ id: 'analysis', label: '분석 확인' }, { id: 'review', label: '원본 대조' }, { id: 'final', label: '최종 확인' }];

export function initOrderAiChat(session, mount, { openEvidence, previewAttachment } = {}) {
  let mail = null, analysis = null, generation = 0, busy = false, loading = false, disposed = false, configured = false, connectionReady = false;
  let controller, customers = [], catalogConfirmed = false, catalogKey = '', reviewed = new Set(), reviewEpoch = 0, notice = '', error = false, step = 'analysis', initializingCatalog = false;
  const progress = el('nav', null, 'order-ai-steps'); progress.setAttribute('aria-label', '발주 처리 순서');
  const feedback = el('p', '', 'order-ai-feedback'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  const panel = el('section', null, 'order-ai-stage'); panel.setAttribute('aria-label', '발주 처리');
  const form = el('form', null, 'order-ai-composer'), label = el('label', '추가 확인 또는 수정 내용');
  const input = el('textarea'); input.rows = 2; input.maxLength = 2000; input.placeholder = '예: 이 상품은 중국산 참기름 1.8L입니다.'; input.setAttribute('aria-label', '발주 분석 답변'); label.append(input);
  const send = el('button', '답변 보내기', 'order-button order-primary'); send.type = 'submit'; form.append(label, send);
  mount.replaceChildren(progress, feedback, panel);
  function clearReviews() { reviewEpoch++; reviewed.clear(); if (!confirmed(analysis)) step = 'analysis'; }
  function customerCurrent(value = analysis) { const latest = customers.find(item => customerId(item) === customerId(value?.customer)); return catalogConfirmed && latest && latest.name === value?.customer?.name && latest.revision === value?.customer?.revision; }
  function reviewReady() { return analysis?.customerCatalogSource !== 'erp' && !!analysis?.readyForReview && !!analysis.groups?.length && !!customerCurrent(); }
  function allReviewed() { return !!analysis?.groups?.length && analysis.groups.every(group => reviewed.has(group.id || group.productId)) && (!analysis.exclusions?.length || reviewed.has('__excluded__')); }
  function changeStep(next) {
    if (busy || loading || !analysis) return;
    if (confirmed(analysis)) { step = 'final'; render(); return; }
    if (next === 'review' && !reviewReady() || next === 'final' && (!reviewReady() || !allReviewed())) return;
    step = next; render(); panel.scrollTop = 0;
  }
  function history() {
    const items = (analysis?.conversation || []).filter(item => ['user', 'assistant'].includes(item.role) && typeof item.content === 'string'); if (items.length < 3) return null;
    const details = el('details', null, 'order-ai-history'); details.append(el('summary', '분석 기록'));
    for (const item of items) { const entry = el('div'); entry.append(el('strong', item.role === 'user' ? '담당자' : '발주 도우미'), el('p', item.content)); details.append(entry); } return details;
  }
  function renderCustomer(locked) {
    const row = el('div', null, 'order-ai-customer'); row.append(el('strong', '학교급식 업체'));
    if (confirmed(analysis) || step === 'final') row.append(el('span', analysis.customer?.name || '업체 확인 필요'));
    else {
      const select = el('select'); select.setAttribute('aria-label', '분석 거래처 선택');
      const placeholder = el('option', !catalogConfirmed ? '업체 목록 확인 중' : customers.length ? '업체를 선택하세요' : '학교급식 업체 목록을 확인해 주세요'); placeholder.value = ''; select.append(placeholder);
      for (const item of customers) { const option = el('option', item.name); option.value = customerId(item); select.append(option); }
      select.value = customerCurrent() ? customerId(analysis.customer) : ''; select.disabled = locked || !catalogConfirmed;
      select.addEventListener('change', () => { const item = customers.find(item => customerId(item) === select.value); if (item) void analyze({ message: `이번 발주의 업체를 ${item.name}으로 지정합니다.`, customerId: customerId(item) }); }); row.append(select);
    } return row;
  }
  function productTable() {
    const table = el('table', null, 'order-ai-summary-table'), head = el('thead'), header = el('tr'); header.append(el('th', '상품'), el('th', '합계')); if (confirmed(analysis)) header.append(el('th', '원본')); head.append(header);
    const body = el('tbody'); for (const group of analysis.groups || []) { const row = el('tr'); row.append(el('td', groupLabel(group)), el('td', `${group.quantity} ${group.unit || ''}`)); if (confirmed(analysis)) { const cell = el('td'); cell.append(button('원본 보기', () => void reviewGroup(group))); row.append(cell); } body.append(row); } table.append(head, body); return table;
  }
  async function reviewGroup(group, exclusions = false) {
    if (busy || loading || navigator.onLine === false) return;
    const token = generation, epoch = reviewEpoch, version = analysis.revision, active = analysis;
    const accepted = await openEvidence?.({ mail, analysis: active, group, ...(exclusions ? { exclusions: true } : {}) });
    if (!disposed && token === generation && epoch === reviewEpoch && analysis?.revision === version && accepted && navigator.onLine !== false && customerCurrent(active) && !confirmed(analysis)) { reviewed.add(exclusions ? '__excluded__' : group.id || group.productId); render(); }
  }
  function render() {
    progress.replaceChildren(); panel.replaceChildren();
    const locked = busy || loading || !mail || !connectionReady || !configured || navigator.onLine === false;
    if (confirmed(analysis)) step = 'final';
    if (step !== 'analysis' && !confirmed(analysis) && !reviewReady()) step = 'analysis';
    if (step === 'final' && !confirmed(analysis) && !allReviewed()) step = 'review';
    panel.dataset.step = step;
    const currentIndex = STEPS.findIndex(item => item.id === step);
    for (const [index, item] of STEPS.entries()) {
      const node = button('', () => changeStep(item.id), 'order-ai-step'); node.append(el('span', String(index + 1), 'order-ai-step-number'), el('span', item.label)); node.setAttribute('aria-current', item.id === step ? 'step' : 'false'); node.dataset.completed = String(index < currentIndex || confirmed(analysis));
      node.disabled = busy || loading || !analysis || confirmed(analysis) || item.id === 'review' && !reviewReady() || item.id === 'final' && (!reviewReady() || !allReviewed()); progress.append(node);
    }
    feedback.textContent = notice || (!connectionReady ? 'AI 연결을 확인하고 있습니다.' : !configured ? 'AI 연결 설정을 확인해 주세요.' : ''); feedback.dataset.error = String(error); feedback.hidden = !feedback.textContent; input.disabled = locked; send.disabled = locked;
    if (!mail || loading || busy || !analysis) {
      const saving = busy && step === 'final';
      const state = el('div', null, 'order-ai-empty'); state.append(el('span', busy || loading ? '진행 중' : '시작하기', 'order-ai-kicker'), el('h2', !mail ? '발주 메일을 선택하세요' : loading ? '저장된 분석을 확인하고 있습니다' : saving ? '발주 확인을 저장하고 있습니다' : busy ? '첨부파일을 분석하고 있습니다' : '발주 분석을 시작할까요?'));
      state.append(el('p', !mail ? '왼쪽 목록에서 확인할 발주를 선택해 주세요.' : saving ? '원본 대조와 확정 기록을 저장합니다.' : busy ? '업체와 상품·수량을 정리한 뒤 확인할 내용을 보여드립니다.' : 'AI가 업체와 상품·수량을 정리합니다. 원본 대조 후 직접 확정하세요.'));
      if (!busy && !loading && mail) { const start = button('발주 분석 시작', () => void analyze(), 'order-primary'); start.disabled = locked; state.append(start); }
      if (error && !busy && !loading && mail) state.append(button('저장된 분석 불러오기', () => void loadAnalysis())); panel.append(state); return;
    }
    const groups = analysis.groups || [], exclusions = analysis.exclusions || [];
    if (step === 'analysis') {
      const heading = el('div', null, 'order-ai-stage-heading'); heading.append(el('span', 'STEP 1', 'order-ai-kicker'), el('h2', '분석 내용을 확인하세요'), el('p', `${groups.length}개 상품 · 발주 항목 ${analysis.lines?.length || 0}개`)); panel.append(heading);
      const legacy = analysis.customerCatalogSource === 'erp';
      if (legacy || analysis.assistantMessage) panel.append(el('p', legacy ? '학교급식 주간현황표의 업체 목록으로 다시 분석해 주세요. 기존 상품·수량과 원본을 이어서 확인합니다.' : analysis.assistantMessage, 'order-ai-current-summary'));
      panel.append(renderCustomer(locked));
      const messages = legacy ? [] : [...(analysis.questions || []).map(item => typeof item === 'string' ? item : item.text || item.message), ...(analysis.blockers || []).map(item => typeof item === 'string' ? item : item.message || item.reason)].filter(Boolean), pending = [...new Set(messages)];
      if (pending.length) { const box = el('div', null, 'order-ai-pending'); box.append(el('strong', '확인할 내용')); const list = el('ul'); for (const text of pending) list.append(el('li', text)); box.append(list); panel.append(box, form); }
      else { const correction = el('details', null, 'order-ai-correction'); correction.append(el('summary', '분석 내용에 수정이 필요해요'), form); panel.append(correction); }
      const footer = el('div', null, 'order-ai-stage-footer'), next = button(legacy ? '업체 목록으로 다시 분석' : '원본 대조 시작', () => legacy ? void analyze() : changeStep('review'), 'order-primary'); next.disabled = locked || (legacy ? !catalogConfirmed : !reviewReady()); const reload = button('저장된 분석 불러오기', () => void loadAnalysis()); reload.disabled = busy || loading; footer.append(reload, next); panel.append(footer);
      const records = history(); if (records) panel.append(records);
    } else if (step === 'review') {
      const total = groups.length + (exclusions.length ? 1 : 0), checked = groups.filter(group => reviewed.has(group.id || group.productId)).length + (exclusions.length && reviewed.has('__excluded__') ? 1 : 0);
      const heading = el('div', null, 'order-ai-stage-heading'); heading.append(el('span', 'STEP 2', 'order-ai-kicker'), el('h2', '원본과 하나씩 대조하세요'), el('p', '같은 상품의 원본 행과 수량을 함께 보여드립니다.'), el('span', `${checked} / ${total} 확인`, 'order-ai-review-progress')); panel.append(heading);
      for (const [index, group] of groups.entries()) { const done = reviewed.has(group.id || group.productId), row = el('div', null, 'order-ai-product'); row.dataset.reviewed = String(done); const text = el('div'); text.append(el('span', `상품 ${index + 1}`, 'order-ai-kicker'), el('strong', groupLabel(group)), el('span', `${group.quantity} ${group.unit || ''}`, 'order-ai-quantity')); const review = button(done ? '대조 완료 · 원본 보기' : '원본 대조', () => void reviewGroup(group)); review.disabled = locked; row.append(text, review); panel.append(row); }
      if (exclusions.length) { const row = el('div', null, 'order-ai-exclusions'), group = { id: '__excluded__', label: `제외한 원본 ${exclusions.length}개 행`, quantity: '해당 없음', unit: '', lineIds: [] }; row.append(el('p', `제외한 행 ${exclusions.length}개 · 제목, 합계 등 발주에 포함하지 않은 내용`)); const review = button(reviewed.has('__excluded__') ? '제외한 행 확인 완료 · 원본 보기' : '제외한 행 원본 확인', () => void reviewGroup(group, true)); review.disabled = locked; row.append(review); panel.append(row); }
      const footer = el('div', null, 'order-ai-stage-footer'), next = button('최종 확인으로', () => changeStep('final'), 'order-primary'); next.disabled = locked || !allReviewed(); footer.append(button('분석 내용 수정', () => changeStep('analysis')), next); panel.append(footer);
    } else {
      const done = confirmed(analysis), heading = el('div', null, 'order-ai-stage-heading'); heading.append(el('span', done ? '확정 완료' : 'STEP 3', 'order-ai-kicker'), el('h2', done ? '발주 확인을 마쳤습니다' : '최종 발주 내용을 확인하세요')); panel.append(heading, renderCustomer(true), productTable()); panel.append(el('p', `상품 ${groups.length}개 · 제외한 행 ${exclusions.length}개 · 원본 대조 ${done || allReviewed() ? '완료' : '필요'}`, 'order-ai-note'));
      const footer = el('div', null, 'order-ai-stage-footer'); if (!done) footer.append(button('원본 대조로 돌아가기', () => changeStep('review'))); const finalize = button(done ? '발주 확인·확정 완료' : '발주 확정', () => void confirmAnalysis(), 'order-primary'); finalize.disabled = locked || done || !reviewReady() || !allReviewed(); footer.append(finalize); panel.append(footer, el('p', done ? '원본 대조와 확정 기록을 저장했습니다.' : '이 분석 결과를 확정합니다. ERP 판매 입력은 후속 연결 단계입니다.', 'order-ai-note'));
    }
  }
  async function loadAnalysis() {
    if (!mail || busy) return; controller?.abort(); controller = new AbortController(); const token = ++generation, id = mail.id; clearReviews(); loading = true; notice = ''; error = false; render();
    try { const data = await requestOrderAi(session, `analysis?intakeId=${encodeURIComponent(id)}`, { signal: controller.signal }); if (disposed || generation !== token || mail?.id !== id) return; analysis = data.analysis || null; clearReviews(); }
    catch (e) { if (!disposed && generation === token && e.name !== 'AbortError') { notice = e.message; error = true; } }
    finally { if (!disposed && generation === token) { loading = false; render(); } }
  }
  async function analyze({ message = '', customerId: selectedCustomerId } = {}) {
    if (!mail || busy || loading || !configured || !connectionReady || confirmed(analysis) || navigator.onLine === false) return;
    const token = generation, id = mail.id, revision = analysis?.revision || 0; controller?.abort(); const requestController = new AbortController(); controller = requestController; clearReviews(); busy = true; notice = ''; error = false; render();
    try { await ensureSchoolMealCompanies(session); if (disposed || token !== generation || mail?.id !== id || requestController.signal.aborted) return; const data = await requestOrderAi(session, 'analysis', { body: { intakeId: id, expectedRevision: revision, ...(message ? { message } : {}), ...(selectedCustomerId ? { customerId: selectedCustomerId } : {}) }, signal: requestController.signal }); if (disposed || token !== generation || mail?.id !== id) return; analysis = data.analysis; clearReviews(); input.value = ''; }
    catch (e) { if (!disposed && token === generation && e.name !== 'AbortError') { notice = e.message; error = true; } }
    finally { if (!disposed && token === generation) { busy = false; render(); panel.scrollTop = 0; } }
  }
  async function confirmAnalysis() {
    if (!analysis || step !== 'final' || busy || loading || confirmed(analysis) || navigator.onLine === false || !reviewReady() || !allReviewed()) return;
    const token = generation, id = mail.id; busy = true; notice = ''; error = false; render();
    try { const data = await requestOrderAi(session, 'confirm', { body: { intakeId: id, expectedRevision: analysis.revision, expectedUpdatedAt: analysis.updatedAt, reviewedGroupIds: analysis.groups.map(group => group.id || group.productId), reviewedExclusions: !analysis.exclusions?.length || reviewed.has('__excluded__') }, signal: controller.signal }); if (disposed || generation !== token || mail?.id !== id) return; analysis = data.analysis; step = 'final'; notice = '원본 대조와 최종 확정을 저장했습니다.'; }
    catch (e) { if (!disposed && generation === token && e.name !== 'AbortError') { notice = e.message; error = true; clearReviews(); } }
    finally { if (!disposed && generation === token) { busy = false; render(); } }
  }
  form.addEventListener('submit', event => { event.preventDefault(); const message = input.value.trim(); if (message) void analyze({ message }); });
  const stopCustomers = subscribeSchoolMealCompanies((items, metadata = {}) => { const nextConfirmed = !metadata.fromCache && !metadata.hasPendingWrites && metadata.exists !== false, key = JSON.stringify(items.map(item => [customerId(item), item.name, item.revision])); if (key !== catalogKey || nextConfirmed !== catalogConfirmed) clearReviews(); customers = items; catalogKey = key; catalogConfirmed = nextConfirmed;
    if (metadata.exists === false && !metadata.fromCache && !metadata.hasPendingWrites && !initializingCatalog) { initializingCatalog = true; ensureSchoolMealCompanies(session).catch(e => { if (!disposed) { notice = e.message; error = true; render(); } }); } render();
  }, e => { clearReviews(); catalogConfirmed = false; notice = e.message || '학교급식 업체 목록을 확인하지 못했습니다.'; error = true; render(); });
  const statusController = new AbortController(); requestOrderAi(session, 'status', { signal: statusController.signal }).then(data => { if (!disposed) { configured = data.configured === true; connectionReady = true; render(); } }).catch(e => { if (!disposed && e.name !== 'AbortError') { connectionReady = true; notice = e.message; error = true; render(); } });
  const connectionChanged = () => { if (navigator.onLine === false) clearReviews(); else reviewEpoch++; render(); }; window.addEventListener('offline', connectionChanged); window.addEventListener('online', connectionChanged); render();
  return { setMail(value) { generation++; controller?.abort(); mail = value; analysis = null; clearReviews(); busy = false; loading = false; notice = ''; error = false; input.value = ''; render(); if (mail) void loadAnalysis(); }, previewAttachment: value => previewAttachment?.({ mail, attachment: value }), canLeave() { if (busy) { notice = '분석·저장 작업을 마친 뒤 다른 메일을 선택해 주세요.'; render(); return false; } if (input.value.trim() && !window.confirm('보내지 않은 답변이 있습니다. 다른 메일로 이동할까요?')) return false; input.value = ''; return true; }, destroy() { disposed = true; generation++; controller?.abort(); statusController.abort(); stopCustomers?.(); window.removeEventListener('offline', connectionChanged); window.removeEventListener('online', connectionChanged); } };
}
