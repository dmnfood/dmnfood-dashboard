import { requestOrderAi } from './order-ai-client.js';
import { subscribeErpCustomers } from './erp-customer-store.js';

function el(tag, text, cls) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; }
function button(text, action, cls = '') { const node = el('button', text, `order-button ${cls}`); node.type = 'button'; node.addEventListener('click', action); return node; }
const confirmed = value => ['confirmed', 'approved'].includes(value?.status);
const groupLabel = group => group.label || group.productLabel || group.product?.label || group.productId || '상품 확인 필요';

export function initOrderAiChat(session, mount, { openEvidence, previewAttachment } = {}) {
  let mail = null, analysis = null, generation = 0, busy = false, loading = false, disposed = false, configured = false, connectionReady = false;
  let controller, customers = [], catalogConfirmed = false, reviewed = new Set(), reviewEpoch = 0, notice = '', error = false, localMessages = [];
  const timeline = el('div', null, 'order-ai-timeline'); timeline.setAttribute('aria-label', '발주 분석 대화');
  const actions = el('div', null, 'order-ai-start-actions');
  const start = button('발주 분석 시작', () => void analyze(), 'order-primary');
  const refresh = button('저장된 분석 불러오기', () => void loadAnalysis()); refresh.hidden = true;
  actions.append(start, refresh);
  const feedback = el('p', '', 'order-ai-feedback'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  const result = el('section', null, 'order-ai-result'); result.setAttribute('aria-label', '분석 결과와 원본 대조');
  const form = el('form', null, 'order-ai-composer'), label = el('label', '확인할 내용이나 수정 사항');
  const input = el('textarea'); input.rows = 2; input.maxLength = 2000; input.placeholder = '예: 이 발주서는 중국산 참기름 1.8L입니다.'; input.setAttribute('aria-label', '발주 분석 답변'); label.append(input);
  const send = el('button', '답변 보내기', 'order-button order-primary'); send.type = 'submit';
  form.append(label, send); mount.replaceChildren(timeline, actions, feedback, result, form);
  function say(role, content) { const item = el('article', null, `order-ai-message order-ai-message-${role}`); item.append(el('strong', role === 'user' ? '담당자' : '발주 도우미'), el('p', content)); timeline.append(item); }
  function render() {
    timeline.replaceChildren(); result.replaceChildren();
    if (!mail) say('assistant', '왼쪽에서 발주 메일을 선택하세요.');
    else if (loading) say('assistant', '저장된 분석을 확인하고 있습니다.');
    else if (analysis) {
      const conversation = analysis.conversation || [];
      for (const item of conversation) if (['user', 'assistant'].includes(item.role) && typeof item.content === 'string') say(item.role, item.content);
      if (!conversation.length || conversation.at(-1)?.content !== analysis.assistantMessage) say('assistant', analysis.assistantMessage || '원본과 분석 결과를 대조해 주세요.');
    } else say('assistant', '발주 분석을 시작하면 거래처와 상품·수량을 정리하고, 필요한 내용을 질문합니다.');
    for (const item of localMessages) say(item.role, item.content);
    if (busy) say('assistant', '원본 파일과 거래처·상품 정보를 확인하고 있습니다…');
    const locked = busy || loading || !mail || !connectionReady || !configured || navigator.onLine === false;
    start.hidden = !!analysis; start.disabled = locked; refresh.hidden = !analysis && !error; refresh.disabled = busy || loading || !mail;
    feedback.textContent = notice || (!connectionReady ? 'AI 연결을 확인하고 있습니다.' : !configured ? 'AI 연결 설정을 확인해 주세요.' : ''); feedback.dataset.error = String(error); feedback.hidden = !feedback.textContent;
    form.hidden = !analysis || confirmed(analysis); input.disabled = locked; send.disabled = locked;
    if (!analysis) return;
    const groups = analysis.groups || [], questions = analysis.questions || [], blockers = analysis.blockers || [];
    if (questions.length) { const list = el('ul', null, 'order-ai-questions'); for (const q of questions) list.append(el('li', typeof q === 'string' ? q : q.text || q.question || q.message || '내용 확인 필요')); result.append(list); }
    const customer = el('div', null, 'order-ai-customer');
    customer.append(el('strong', '거래처'), el('span', analysis.customer ? `${analysis.customer.name} · ${analysis.customer.code}` : '거래처 확인 필요'));
    if (!confirmed(analysis)) {
      const select = el('select'); select.setAttribute('aria-label', '분석 거래처 선택');
      const placeholder = el('option', !catalogConfirmed ? '거래처 목록 확인 중' : customers.length ? '거래처를 지정하거나 변경하세요' : '상단 거래처 설정에서 등록하세요'); placeholder.value = ''; select.append(placeholder);
      for (const item of customers) { const option = el('option', `${item.name} · ${item.code}`); option.value = item.code; select.append(option); }
      select.disabled = locked || !catalogConfirmed;
      select.addEventListener('change', () => { const item = customers.find(item => item.code === select.value); if (item) void analyze({ message: `이번 발주의 거래처를 ${item.name} (${item.code})로 지정합니다.`, customerCode: item.code }); }); customer.append(select);
    }
    result.append(customer);
    if (groups.length) {
      result.append(el('h3', '상품별 원본 대조'));
      for (const group of groups) {
        const id = group.id || group.productId, done = confirmed(analysis) || reviewed.has(id), row = el('div', null, 'order-ai-product');
        const text = el('div'); text.append(el('strong', groupLabel(group)), el('span', `${group.quantity} ${group.unit || ''}`, 'order-ai-quantity'));
        const review = button(done ? '대조 완료 · 원본 보기' : '원본 대조', async () => {
          const token = generation, epoch = reviewEpoch, version = analysis.revision, active = analysis;
          const accepted = await openEvidence?.({ mail, analysis: active, group });
          const latest = customers.find(item => item.code === active.customer?.code);
          if (!disposed && token === generation && epoch === reviewEpoch && analysis?.revision === version && accepted && navigator.onLine !== false && catalogConfirmed
            && latest?.name === active.customer?.name && latest?.revision === active.customer?.revision && !confirmed(analysis)) { reviewed.add(id); render(); }
        }); review.disabled = busy || loading; row.dataset.reviewed = String(done); row.append(text, review); result.append(row);
      }
    }
    if (analysis.exclusions?.length) {
      const group = { id: '__excluded__', label: `제외한 원본 ${analysis.exclusions.length}개 행`, quantity: '해당 없음', unit: '', lineIds: [] };
      const exclusionReview = button(reviewed.has('__excluded__') || confirmed(analysis) ? '제외한 행 확인 완료 · 원본 보기' : '제외한 행 원본 확인', async () => {
        const token = generation, epoch = reviewEpoch, version = analysis.revision;
        const accepted = await openEvidence?.({ mail, analysis, group, exclusions: true });
        if (!disposed && token === generation && epoch === reviewEpoch && analysis?.revision === version && accepted && navigator.onLine !== false && catalogConfirmed && !confirmed(analysis)) { reviewed.add('__excluded__'); render(); }
      }); exclusionReview.disabled = busy || loading;
      result.append(exclusionReview);
    }
    if (blockers.length) { const pending = el('div', null, 'order-ai-blockers'); pending.append(el('strong', '확인할 내용')); const list = el('ul'); for (const item of blockers) list.append(el('li', typeof item === 'string' ? item : item.message || item.reason || item.code || '원본 확인 필요')); pending.append(list); result.append(pending); }
    const unresolved = (analysis.lines || []).filter(line => !line.productId || line.included === false || (line.blockers?.length));
    if (unresolved.length) result.append(el('p', `상품·수량을 추가 확인할 원본 항목 ${unresolved.length}개`, 'order-ai-note'));
    const finalize = button(confirmed(analysis) ? '발주 확인·확정 완료' : '원본 대조 완료 · 최종 확정', () => void confirmAnalysis(), 'order-primary');
    const currentCustomer = customers.find(item => item.code === analysis.customer?.code);
    const customerCurrent = catalogConfirmed && currentCustomer?.revision === analysis.customer?.revision && currentCustomer?.name === analysis.customer?.name;
    finalize.disabled = locked || confirmed(analysis) || !analysis.readyForReview || !customerCurrent || !groups.length || groups.some(group => !reviewed.has(group.id || group.productId)) || (!!analysis.exclusions?.length && !reviewed.has('__excluded__'));
    result.append(finalize, el('p', confirmed(analysis) ? '이 분석 버전의 원본 대조와 확정 기록을 저장했습니다.' : '모든 상품의 원본을 대조한 뒤 최종 확정합니다.', 'order-ai-note'));
  }
  async function loadAnalysis() {
    if (!mail || busy) return; controller?.abort(); controller = new AbortController(); const token = ++generation, id = mail.id;
    loading = true; notice = ''; error = false; render();
    try { const data = await requestOrderAi(session, `analysis?intakeId=${encodeURIComponent(id)}`, { signal: controller.signal }); if (disposed || generation !== token || mail?.id !== id) return; analysis = data.analysis || null; reviewed.clear(); localMessages = []; }
    catch (e) { if (!disposed && generation === token && e.name !== 'AbortError') { notice = e.message; error = true; } }
    finally { if (!disposed && generation === token) { loading = false; render(); } }
  }
  async function analyze({ message = '', customerCode } = {}) {
    if (!mail || busy || loading || !configured || !connectionReady || confirmed(analysis)) return;
    const token = generation, id = mail.id, revision = analysis?.revision || 0; controller?.abort(); controller = new AbortController();
    reviewEpoch++; reviewed.clear(); busy = true; notice = ''; error = false; if (message) localMessages = [{ role: 'user', content: message }]; render();
    try {
      const data = await requestOrderAi(session, 'analysis', { body: { intakeId: id, expectedRevision: revision, ...(message ? { message } : {}), ...(customerCode ? { customerCode } : {}) }, signal: controller.signal });
      if (disposed || token !== generation || mail?.id !== id) return;
      analysis = data.analysis; reviewed.clear(); localMessages = []; input.value = '';
    } catch (e) { if (!disposed && token === generation && e.name !== 'AbortError') { notice = e.message; error = true; } }
    finally { if (!disposed && token === generation) { busy = false; render(); } }
  }
  async function confirmAnalysis() {
    if (!analysis || busy || !analysis.readyForReview || confirmed(analysis) || navigator.onLine === false || !catalogConfirmed) return;
    const customer = customers.find(item => item.code === analysis.customer?.code);
    if (!customer || customer.name !== analysis.customer?.name || customer.revision !== analysis.customer?.revision) return;
    const groups = analysis.groups || []; if (!groups.length || groups.some(group => !reviewed.has(group.id || group.productId))) return;
    if (analysis.exclusions?.length && !reviewed.has('__excluded__')) return;
    const token = generation, id = mail.id; busy = true; notice = ''; error = false; render();
    try {
      const data = await requestOrderAi(session, 'confirm', { body: { intakeId: id, expectedRevision: analysis.revision, expectedUpdatedAt: analysis.updatedAt, reviewedGroupIds: groups.map(group => group.id || group.productId), reviewedExclusions: !analysis.exclusions?.length || reviewed.has('__excluded__') }, signal: controller.signal });
      if (disposed || generation !== token || mail?.id !== id) return;
      analysis = data.analysis; notice = '원본 대조와 최종 확정을 저장했습니다.';
    } catch (e) { if (!disposed && generation === token && e.name !== 'AbortError') { notice = e.message; error = true; reviewed.clear(); } }
    finally { if (!disposed && generation === token) { busy = false; render(); } }
  }
  form.addEventListener('submit', event => { event.preventDefault(); const message = input.value.trim(); if (message) void analyze({ message }); });
  const stopCustomers = subscribeErpCustomers((items, metadata = {}) => { reviewEpoch++; reviewed.clear(); customers = items; catalogConfirmed = !metadata.fromCache && !metadata.hasPendingWrites; render(); }, () => { reviewEpoch++; reviewed.clear(); catalogConfirmed = false; render(); });
  const statusController = new AbortController();
  requestOrderAi(session, 'status', { signal: statusController.signal }).then(data => { if (!disposed) { configured = data.configured === true; connectionReady = true; render(); } }).catch(e => { if (!disposed && e.name !== 'AbortError') { connectionReady = true; notice = e.message; error = true; render(); } });
  const connectionChanged = () => { reviewEpoch++; if (navigator.onLine === false) reviewed.clear(); render(); }; window.addEventListener('offline', connectionChanged); window.addEventListener('online', connectionChanged);
  render();
  return { setMail(value) { generation++; controller?.abort(); mail = value; analysis = null; reviewed.clear(); localMessages = []; busy = false; loading = false; notice = ''; error = false; render(); if (mail) void loadAnalysis(); },
    previewAttachment: value => previewAttachment?.({ mail, attachment: value }),
    canLeave() { if (busy) { notice = '분석·저장 작업을 마친 뒤 다른 메일을 선택해 주세요.'; render(); return false; } if (input.value.trim() && !window.confirm('보내지 않은 답변이 있습니다. 다른 메일로 이동할까요?')) return false; input.value = ''; return true; },
    destroy() { disposed = true; generation++; controller?.abort(); statusController.abort(); stopCustomers?.(); window.removeEventListener('offline', connectionChanged); window.removeEventListener('online', connectionChanged); } };
}
