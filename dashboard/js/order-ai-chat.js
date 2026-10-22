import { requestOrderAi } from './order-ai-client.js';
import { subscribeSchoolMealCompanies, ensureSchoolMealCompanies } from './school-meal-company-store.js';

function el(tag, text, cls) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; }
function button(text, action, cls = '') { const node = el('button', text, 'order-button ' + cls); node.type = 'button'; node.addEventListener('click', action); return node; }
const confirmed = value => ['confirmed', 'approved'].includes(value?.status);
const customerId = value => value?.id || value?.code;
const groupId = group => group.id || group.productId;
const groupLabel = group => group.label || group.productLabel || group.productId || '상품 확인 필요';
const STEPS = [{ id: 'analysis', label: '분석 확인' }, { id: 'review', label: '원본 대조' }, { id: 'final', label: '최종 확인' }];

export function initOrderAiChat(session, mount, { openEvidence, cancelEvidence, previewAttachment } = {}) {
  let mail = null, analysis = null, generation = 0, analysisEpoch = 0, busy = false, loading = false, disposed = false, configured = false, connectionReady = false;
  let controller, refreshController, customers = [], catalogConfirmed = false, catalogKey = '', reviewed = new Set(), reviewEpoch = 0, notice = '', error = false, initializingCatalog = false;
  let acknowledged = '', editorOpen = false, selectedGroup = '', evidenceKey = '', evidenceRun = 0, pendingAnalysis = null, automation = null;
  let evidenceMount = el('div', null, 'order-ai-inline-evidence');
  const progress = el('nav', null, 'order-ai-steps'); progress.setAttribute('aria-label', '발주 처리 순서');
  const feedback = el('p', '', 'order-ai-feedback'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  const panel = el('section', null, 'order-ai-stage'); panel.setAttribute('aria-label', '발주 처리');
  const form = el('form', null, 'order-ai-composer'), label = el('label', '수정할 내용');
  const input = el('textarea'); input.rows = 2; input.maxLength = 2000; input.placeholder = '예: 이 상품은 중국산 참기름 1.8L입니다.'; input.setAttribute('aria-label', '발주 분석 수정 내용'); label.append(input);
  const send = el('button', '수정 내용 반영', 'order-button order-primary'); send.type = 'submit'; form.append(label, send);
  mount.replaceChildren(progress, feedback, panel);

  function identity(value = analysis) { return value ? JSON.stringify([value.revision, value.updatedAt, customerId(value.customer), value.customer?.name, value.customer?.revision, catalogKey]) : ''; }
  function latestCustomer(value = analysis) { return customers.find(item => customerId(item) === customerId(value?.customer)); }
  function customerCurrent(value = analysis) { const latest = latestCustomer(value); return catalogConfirmed && latest && latest.name === value?.customer?.name && latest.revision === value?.customer?.revision; }
  function customerChecked() { return confirmed(analysis) || !!acknowledged && acknowledged === identity() && !!customerCurrent(); }
  function reviewReady() { return analysis?.customerCatalogSource !== 'erp' && !!analysis?.readyForReview && !!analysis.groups?.length && !!customerCurrent(); }
  function allReviewed() { return !!analysis?.groups?.length && analysis.groups.every(group => reviewed.has(groupId(group))) && (!analysis.exclusions?.length || reviewed.has('__excluded__')); }
  function phase() { return confirmed(analysis) || customerChecked() && reviewReady() && allReviewed() ? 'final' : customerChecked() && reviewReady() ? 'review' : 'analysis'; }
  function cancelReview() { evidenceRun++; evidenceKey = ''; cancelEvidence?.(); evidenceMount = el('div', null, 'order-ai-inline-evidence'); }
  function clearReviews() { reviewEpoch++; reviewed.clear(); acknowledged = ''; selectedGroup = ''; cancelReview(); }
  function localWork() { return !!acknowledged || reviewed.size > 0 || editorOpen || !!input.value.trim() || !!evidenceKey; }
  function applyAnalysis(value) { analysisEpoch++; clearReviews(); analysis = value; pendingAnalysis = null; editorOpen = false; input.value = ''; }
  function entries() {
    const items = (analysis?.groups || []).map(group => ({ key: groupId(group), group, exclusions: false }));
    if (analysis?.exclusions?.length) items.push({ key: '__excluded__', exclusions: true, group: { id: '__excluded__', label: '제외한 행', quantity: String(analysis.exclusions.length), unit: '행', lineIds: [] } });
    return items;
  }
  function selectGroup(key) { if (busy || loading || key === selectedGroup && evidenceKey) return; selectedGroup = key; cancelReview(); render(); }
  function ensureEvidence() {
    if (!openEvidence || busy || loading || !analysis || !mail || navigator.onLine === false || !connectionReady || !configured) return;
    if (!confirmed(analysis) && !reviewReady()) return;
    const items = entries(), selected = items.find(item => item.key === selectedGroup) || items[0]; if (!selected) return;
    selectedGroup = selected.key;
    const key = JSON.stringify([mail.id, identity(), reviewEpoch, selected.key]); if (evidenceKey === key) return;
    evidenceKey = key;
    const run = ++evidenceRun, token = generation, epoch = reviewEpoch, active = analysis, version = identity(), target = evidenceMount;
    Promise.resolve().then(() => {
      if (disposed || run !== evidenceRun || token !== generation || epoch !== reviewEpoch || target !== evidenceMount) return false;
      return openEvidence({ mail, analysis: active, group: selected.group, ...(selected.exclusions ? { exclusions: true } : {}), mount: target });
    }).then(accepted => {
      if (disposed || run !== evidenceRun || token !== generation || epoch !== reviewEpoch || version !== identity() || !accepted || navigator.onLine === false || !customerCurrent(active) || confirmed(analysis)) return;
      reviewed.add(selected.key);
      const next = items.find(item => !reviewed.has(item.key));
      if (next) { selectedGroup = next.key; cancelReview(); }
      render();
    }).catch(e => { if (!disposed && run === evidenceRun && token === generation && epoch === reviewEpoch) { notice = e.message || '원본 대조 화면을 열지 못했습니다.'; error = true; render(); } });
  }
  function renderProgress() {
    progress.replaceChildren(); const current = phase(), currentIndex = STEPS.findIndex(item => item.id === current);
    for (const [index, item] of STEPS.entries()) {
      const node = el('span', null, 'order-ai-step'); node.append(el('span', String(index + 1), 'order-ai-step-number'), el('span', item.label)); node.setAttribute('aria-current', item.id === current ? 'step' : 'false'); node.dataset.completed = String(index < currentIndex || confirmed(analysis)); progress.append(node);
    }
    panel.dataset.step = current;
  }
  function renderEditor(locked) {
    const editor = el('section', null, 'order-ai-editor'); editor.setAttribute('aria-label', '분석 수정');
    const field = el('label', '학교급식 업체', 'order-ai-editor-company'), select = el('select'); select.setAttribute('aria-label', '분석 거래처 선택');
    const placeholder = el('option', !catalogConfirmed ? '업체 목록 확인 중' : customers.length ? '업체를 선택하세요' : '학교급식 업체 목록을 확인해 주세요'); placeholder.value = ''; select.append(placeholder);
    for (const item of customers) { const option = el('option', item.name); option.value = customerId(item); select.append(option); }
    select.value = latestCustomer() ? customerId(analysis.customer) : ''; select.disabled = locked || !catalogConfirmed;
    select.addEventListener('change', () => { const item = customers.find(value => customerId(value) === select.value); if (item && customerId(item) !== customerId(analysis?.customer)) void analyze({ message: '이번 발주의 업체를 ' + item.name + '으로 지정합니다.', customerId: customerId(item) }); }); field.append(select); editor.append(field, form);
    const actions = el('div', null, 'order-ai-editor-actions'), reload = button('저장된 분석 불러오기', () => void loadAnalysis({ replace: true })); reload.disabled = locked;
    if (catalogConfirmed && latestCustomer() && !customerCurrent()) {
      const refresh = button('최신 업체 정보로 다시 분석', () => { const latest = latestCustomer(); if (catalogConfirmed && latest) void analyze({ message: '학교급식 업체 목록의 최신 정보로 ' + latest.name + ' 업체를 다시 분석해 주세요.', customerId: customerId(latest) }); }, 'order-primary'); refresh.disabled = locked; actions.append(refresh);
    }
    actions.append(reload); editor.append(actions); return editor;
  }
  function renderCustomer(locked) {
    const header = el('header', null, 'order-ai-review-header'), title = el('div'); title.append(el('span', confirmed(analysis) ? '확정된 업체' : 'AI가 확인한 학교급식 업체', 'order-ai-kicker'), el('h2', analysis.customer?.name || '업체를 확인해 주세요'));
    const actions = el('div', null, 'order-ai-customer-actions');
    if (confirmed(analysis)) actions.append(el('span', '확정 완료', 'order-ai-checked'));
    else {
      const accept = button(customerChecked() ? '업체 확인 완료' : '맞아요', () => { if (!locked && customerCurrent() && analysis.customerCatalogSource !== 'erp') { acknowledged = identity(); render(); } }, customerChecked() ? 'order-ai-checked' : 'order-primary');
      accept.disabled = locked || !customerCurrent() || analysis.customerCatalogSource === 'erp' || customerChecked();
      const edit = button(editorOpen ? '수정 닫기' : '수정', () => { if (!locked) { editorOpen = !editorOpen; render(); } }); edit.disabled = locked; edit.setAttribute('aria-expanded', String(editorOpen)); actions.append(accept, edit);
    }
    header.append(title, actions); return header;
  }
  function renderReview(locked) {
    const section = el('section', null, 'order-ai-review-section'); section.setAttribute('aria-label', '원본과 분석 결과');
    const items = entries(), checked = confirmed(analysis) ? items.length : items.filter(item => reviewed.has(item.key)).length;
    const heading = el('div', null, 'order-ai-review-heading'); heading.append(el('h3', '원본과 분석 결과'), el('span', checked + ' / ' + items.length + ' 대조 완료', 'order-ai-review-progress')); section.append(heading);
    if (items.length) {
      if (!items.some(item => item.key === selectedGroup)) selectedGroup = items[0].key;
      const products = el('div', null, 'order-ai-review-products'); products.setAttribute('aria-label', '대조할 상품');
      for (const item of items) {
        const done = confirmed(analysis) || reviewed.has(item.key), choice = button('', () => selectGroup(item.key), 'order-ai-review-product' + (item.exclusions ? ' order-ai-review-excluded' : ''));
        choice.append(el('strong', groupLabel(item.group)), el('span', item.group.quantity + ' ' + (item.group.unit || ''), 'order-ai-quantity'), el('span', done ? '대조 완료' : item.exclusions ? '제외 내역 확인' : '대조하기', 'order-ai-product-state'));
        choice.dataset.reviewed = String(done); choice.setAttribute('aria-pressed', String(item.key === selectedGroup)); choice.disabled = locked || !confirmed(analysis) && !reviewReady(); products.append(choice);
      }
      section.append(products);
    }
    if (!confirmed(analysis) && !reviewReady()) section.append(el('p', '위의 확인할 내용을 수정하면 원본과 상품·수량을 대조할 수 있습니다.', 'order-ai-review-placeholder'));
    else if (!items.length) section.append(el('p', '대조할 상품을 찾지 못했습니다. 분석 내용을 수정해 주세요.', 'order-ai-review-placeholder'));
    section.append(evidenceMount); return section;
  }
  function renderConfirmation(locked) {
    const done = confirmed(analysis), ready = customerChecked() && reviewReady() && allReviewed() && !editorOpen && !input.value.trim() && !pendingAnalysis, footer = el('footer', null, 'order-ai-confirm-bar'), summary = el('div');
    summary.append(el('strong', done ? '발주 확인을 마쳤습니다' : '최종 확인'), el('span', (analysis.groups?.length || 0) + '개 상품 · 발주 항목 ' + (analysis.lines?.length || 0) + '개'));
    if (!done) summary.append(el('span', pendingAnalysis ? '새로 저장된 분석을 불러온 뒤 확인해 주세요.' : input.value.trim() ? '작성 중인 수정 내용을 반영하거나 지워 주세요.' : editorOpen ? '수정할 내용이 없으면 수정 창을 닫아 주세요.' : !customerChecked() ? '업체가 맞는지 확인해 주세요.' : !reviewReady() ? '분석에서 확인할 내용을 수정해 주세요.' : !allReviewed() ? '모든 상품과 제외한 행의 원본을 대조해 주세요.' : '업체와 원본 대조를 마쳤습니다.', 'order-ai-confirm-status'));
    const finalize = button(done ? '발주 확인·확정 완료' : busy ? '저장 중' : '발주 확정', () => void confirmAnalysis(), 'order-primary'); finalize.disabled = locked || done || !ready; footer.append(summary, finalize);
    const wrapper = el('div', null, 'order-ai-confirmation'); wrapper.append(footer, el('p', done ? '원본 대조와 확정 기록을 저장했습니다.' : '확정한 발주를 저장합니다. ERP 판매 입력은 후속 연결 단계입니다.', 'order-ai-note')); return wrapper;
  }
  function render() {
    const restoreInput = document.activeElement === input, selectionStart = input.selectionStart, selectionEnd = input.selectionEnd;
    renderProgress(); panel.replaceChildren();
    const locked = busy || loading || !mail || !connectionReady || !configured || navigator.onLine === false;
    feedback.textContent = notice || (!connectionReady ? 'AI 연결을 확인하고 있습니다.' : !configured ? 'AI 연결 설정을 확인해 주세요.' : ''); feedback.dataset.error = String(error); feedback.hidden = !feedback.textContent; input.disabled = locked; send.disabled = locked;
    if (!mail || loading || !analysis) {
      const automatic = mail && !['text', 'image'].includes(mail.sourceKind) && automation?.intakeId === mail.id && ['pending', 'running', 'ready', 'failed'].includes(automation.state), failed = automatic && automation.state === 'failed';
      const state = el('div', null, 'order-ai-empty'); state.append(el('span', busy || loading || automatic && !failed ? '진행 중' : '시작하기', 'order-ai-kicker'), el('h2', !mail ? '발주 자료를 선택하세요' : loading ? '저장된 분석을 확인하고 있습니다' : busy ? '발주 내용을 분석하고 있습니다' : failed ? '자동 분석을 마치지 못했습니다' : automatic ? automation?.state === 'running' ? '발주 내용을 자동 분석하고 있습니다' : '자동 분석을 준비하고 있습니다' : '발주 분석을 시작할까요?'));
      state.append(el('p', !mail ? '왼쪽 목록에서 확인할 발주를 선택해 주세요.' : busy ? '업체와 상품·수량을 정리하고 있습니다.' : failed ? automation.message || '다시 분석한 뒤 원본과 대조해 주세요.' : automatic ? '분석이 완료되면 업체와 원본을 함께 확인할 수 있습니다.' : 'AI가 정리한 내용을 원본과 대조한 뒤 확정하세요.'));
      if (!busy && !loading && mail && (!automatic || failed)) { const start = button(failed ? '다시 분석' : '발주 분석 시작', () => void analyze(), 'order-primary'); start.disabled = locked; state.append(start); }
      if (error && !busy && !loading && mail) state.append(button('저장된 분석 불러오기', () => void loadAnalysis({ replace: true }))); panel.append(state); return;
    }
    const card = el('article', null, 'order-ai-review-card'); card.setAttribute('aria-label', '발주 검토'); card.append(renderCustomer(locked));
    if (busy) card.append(el('p', '변경한 내용을 반영하고 있습니다.', 'order-ai-working'));
    if (pendingAnalysis) { const update = el('div', null, 'order-ai-saved-update'); update.append(el('span', '새 분석이 저장되어 있습니다.'), button('불러오기', () => void loadAnalysis({ replace: true }))); card.append(update); }
    const legacy = analysis.customerCatalogSource === 'erp' && !confirmed(analysis);
    if (legacy) { const message = el('div', null, 'order-ai-pending'); message.append(el('p', '학교급식 업체 목록으로 다시 분석해 주세요.')); const migrate = button('업체 목록으로 다시 분석', () => void analyze(), 'order-primary'); migrate.disabled = locked || !catalogConfirmed; message.append(migrate); card.append(message); }
    if (!legacy && !confirmed(analysis) && catalogConfirmed && !customerCurrent()) { const warning = el('div', null, 'order-ai-pending'); warning.append(el('strong', '업체 정보 확인 필요'), el('p', latestCustomer() ? '업체 정보가 변경되었습니다. ‘수정’에서 최신 업체 정보로 다시 분석한 뒤 확인해 주세요.' : '이 발주의 업체가 현재 학교급식 업체 목록에 없습니다. ‘수정’에서 업체를 선택해 주세요.')); card.append(warning); }
    const messages = legacy || confirmed(analysis) ? [] : [...(analysis.questions || []).map(item => typeof item === 'string' ? item : item.text || item.message), ...(analysis.blockers || []).map(item => typeof item === 'string' ? item : item.message || item.reason)].filter(Boolean), pending = [...new Set(messages)];
    if (pending.length) { const box = el('div', null, 'order-ai-pending'); box.append(el('strong', '확인할 내용')); const list = el('ul'); for (const text of pending) list.append(el('li', text)); box.append(list); card.append(box); }
    if (editorOpen && !confirmed(analysis)) card.append(renderEditor(locked));
    card.append(renderReview(locked), renderConfirmation(locked)); panel.append(card); ensureEvidence();
    if (restoreInput && editorOpen && !input.disabled) { input.focus?.({ preventScroll: true }); if (typeof selectionStart === 'number' && typeof selectionEnd === 'number') input.setSelectionRange?.(selectionStart, selectionEnd); }
  }
  async function loadAnalysis({ background = false, replace = false } = {}) {
    if (!mail || busy || loading) return false;
    if (replace && localWork() && !window.confirm('현재 업체 확인과 원본 대조를 초기화하고 저장된 분석을 불러올까요?')) return false;
    const token = generation, id = mail.id, epoch = analysisEpoch;
    if (background) { refreshController?.abort(); const activeController = new AbortController(); refreshController = activeController;
      try { const data = await requestOrderAi(session, 'analysis?intakeId=' + encodeURIComponent(id), { signal: activeController.signal }); if (disposed || generation !== token || mail?.id !== id || analysisEpoch !== epoch || busy || activeController.signal.aborted) return false;
        const next = data.analysis || null; if (next?.revision === analysis?.revision && next?.updatedAt === analysis?.updatedAt && next?.status === analysis?.status) return true;
        if (analysis && localWork()) { pendingAnalysis = next; render(); return true; } applyAnalysis(next); render(); return true;
      } catch { return false; }
    }
    controller?.abort(); refreshController?.abort(); controller = new AbortController(); const version = ++generation; clearReviews(); loading = true; notice = ''; error = false; render();
    try { const data = await requestOrderAi(session, 'analysis?intakeId=' + encodeURIComponent(id), { signal: controller.signal }); if (disposed || generation !== version || mail?.id !== id) return false; applyAnalysis(data.analysis || null); return true; }
    catch (e) { if (!disposed && generation === version && e.name !== 'AbortError') { notice = e.message; error = true; } return false; }
    finally { if (!disposed && generation === version) { loading = false; render(); } }
  }
  async function analyze({ message = '', customerId: selectedCustomerId } = {}) {
    if (!mail || busy || loading || !configured || !connectionReady || confirmed(analysis) || navigator.onLine === false) return;
    const token = generation, id = mail.id, revision = analysis?.revision || 0; controller?.abort(); refreshController?.abort(); const requestController = new AbortController(); controller = requestController; clearReviews(); busy = true; notice = ''; error = false; render();
    try { await ensureSchoolMealCompanies(session); if (disposed || token !== generation || mail?.id !== id || requestController.signal.aborted) return; const data = await requestOrderAi(session, 'analysis', { body: { intakeId: id, expectedRevision: revision, ...(analysis?.updatedAt ? { expectedUpdatedAt: analysis.updatedAt } : {}), ...(['text', 'image'].includes(mail.sourceKind) ? { sourceKind: mail.sourceKind } : {}), ...(message ? { message } : {}), ...(selectedCustomerId ? { customerId: selectedCustomerId } : {}) }, signal: requestController.signal }); if (disposed || token !== generation || mail?.id !== id) return; applyAnalysis(data.analysis); }
    catch (e) { if (!disposed && token === generation && e.name !== 'AbortError') { notice = e.message; error = true; } }
    finally { if (!disposed && token === generation) { busy = false; render(); } }
  }
  async function confirmAnalysis() {
    if (!analysis || busy || loading || confirmed(analysis) || navigator.onLine === false || !customerChecked() || !reviewReady() || !allReviewed() || editorOpen || input.value.trim() || pendingAnalysis) return;
    const token = generation, id = mail.id; refreshController?.abort(); busy = true; notice = ''; error = false; render();
    try { const data = await requestOrderAi(session, 'confirm', { body: { intakeId: id, expectedRevision: analysis.revision, expectedUpdatedAt: analysis.updatedAt, ...(['text', 'image'].includes(mail.sourceKind) ? { sourceKind: mail.sourceKind } : {}), reviewedGroupIds: analysis.groups.map(groupId), reviewedExclusions: !analysis.exclusions?.length || reviewed.has('__excluded__') }, signal: controller?.signal }); if (disposed || generation !== token || mail?.id !== id) return; analysisEpoch++; analysis = data.analysis; pendingAnalysis = null; notice = '원본 대조와 최종 확정을 저장했습니다.'; }
    catch (e) { if (!disposed && generation === token && e.name !== 'AbortError') { notice = e.message; error = true; clearReviews(); } }
    finally { if (!disposed && generation === token) { busy = false; render(); } }
  }
  form.addEventListener('submit', event => { event.preventDefault(); const message = input.value.trim(); if (message) void analyze({ message }); });
  const stopCustomers = subscribeSchoolMealCompanies((items, metadata = {}) => { const nextConfirmed = !metadata.fromCache && !metadata.hasPendingWrites && metadata.exists !== false, key = JSON.stringify(items.map(item => [customerId(item), item.name, item.revision])); if (key !== catalogKey || nextConfirmed !== catalogConfirmed) clearReviews(); customers = items; catalogKey = key; catalogConfirmed = nextConfirmed;
    if (metadata.exists === false && !metadata.fromCache && !metadata.hasPendingWrites && !initializingCatalog) { initializingCatalog = true; ensureSchoolMealCompanies(session).catch(e => { if (!disposed) { notice = e.message; error = true; render(); } }); } render();
  }, e => { clearReviews(); catalogConfirmed = false; notice = e.message || '학교급식 업체 목록을 확인하지 못했습니다.'; error = true; render(); });
  const statusController = new AbortController(); const statusReady = requestOrderAi(session, 'status', { signal: statusController.signal }).then(data => { if (!disposed) { configured = data.configured === true; connectionReady = true; render(); } }).catch(e => { if (!disposed && e.name !== 'AbortError') { connectionReady = true; notice = e.message; error = true; render(); } });
  const connectionChanged = () => { if (navigator.onLine === false) clearReviews(); else { reviewEpoch++; cancelReview(); } render(); }; window.addEventListener('offline', connectionChanged); window.addEventListener('online', connectionChanged); render();
  async function setSource(value, { analyze: autoAnalyze = false } = {}) {
    const version = ++generation; controller?.abort(); refreshController?.abort(); mail = value; analysis = null; analysisEpoch++; pendingAnalysis = null; automation = null; clearReviews(); busy = false; loading = false; editorOpen = false; notice = ''; error = false; input.value = ''; render();
    if (!mail) return true;
    await statusReady;
    if (disposed || generation !== version || mail !== value) return false;
    const readGeneration = generation + 1;
    await loadAnalysis();
    if (disposed || generation !== readGeneration || mail !== value || error) return false;
    if (autoAnalyze && !analysis) {
      if (!configured || !connectionReady || navigator.onLine === false) { notice = '원문을 저장했습니다. AI 연결 상태를 확인한 뒤 분석을 시작해 주세요.'; render(); return false; }
      await analyze();
    }
    return !error;
  }
  return { setMail: setSource, setSource, refreshAnalysis({ revision } = {}) { if (analysis && Number.isInteger(revision) && revision <= analysis.revision) return Promise.resolve(true); return loadAnalysis({ background: true }); }, setAutomationState(value) { if (disposed || value && value.intakeId !== mail?.id || ['text', 'image'].includes(mail?.sourceKind)) return; const next = value || null; if (JSON.stringify(next) === JSON.stringify(automation)) return; automation = next; if (!analysis) render(); }, previewAttachment: value => previewAttachment?.({ mail, attachment: value }), canLeave() { if (busy) { notice = '분석·저장 작업을 마친 뒤 다른 발주를 선택해 주세요.'; render(); return false; } if (input.value.trim() && !window.confirm('보내지 않은 수정 내용이 있습니다. 다른 발주로 이동할까요?')) return false; input.value = ''; return true; }, destroy() { disposed = true; generation++; controller?.abort(); refreshController?.abort(); cancelReview(); statusController.abort(); stopCustomers?.(); window.removeEventListener('offline', connectionChanged); window.removeEventListener('online', connectionChanged); } };
}
