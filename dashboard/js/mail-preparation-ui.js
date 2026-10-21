import { subscribeErpCustomers } from './erp-customer-store.js';
import { subscribeMailPreparation, saveMailPreparation } from './mail-preparation-store.js';

const selectionKeys = ['sheetIndex', 'sheetName', 'range', 'startRow', 'endRow', 'startColumn', 'endColumn'];
const sameCustomer = (a, b) => !!a && !!b && ['id', 'code', 'name', 'revision'].every(key => a[key] === b[key]);
const selectionValue = value => value ? Object.fromEntries(selectionKeys.map(key => [key, value[key]])) : null;
const sameSelection = (a, b) => JSON.stringify(selectionValue(a)) === JSON.stringify(selectionValue(b));
function el(tag, text, cls) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; }

/** The saved preparation is tied to one immutable mail attachment, never a legacy order. */
export function initMailPreparation(session, mount) {
  let customers = [], catalogConfirmed = false, mail = null, attachment = null, workbook = null;
  let customer = null, selection = null, record = null, readConfirmed = false, stopRecord;
  let generation = 0, dirty = false, busy = false, conflict = false, disposed = false, restored = false, notice = '', pendingSave = null;
  const steps = el('ol', null, 'mail-preparation-steps'); steps.setAttribute('aria-label', '발주 처리 순서');
  const stepNodes = ['거래처·원본', '범위 지정', '상품·수량 연결', '대조·확정'].map((text, i) => { const node = el('li'); node.append(el('span', String(i + 1)), el('strong', text)); steps.append(node); return node; });
  const controls = el('div', null, 'mail-preparation-controls');
  const searchLabel = el('label', 'ERP 거래처 검색'), search = el('input'); search.type = 'search'; search.placeholder = '거래처명 또는 코드'; search.setAttribute('aria-label', 'ERP 거래처 검색'); searchLabel.append(search);
  const selectLabel = el('label', '거래처 선택'), picker = el('select'); picker.setAttribute('aria-label', 'ERP 거래처 선택'); selectLabel.append(picker);
  const summary = el('p', '', 'mail-preparation-summary'), save = el('button', '범위 저장', 'order-button order-primary'); save.type = 'button';
  const status = el('p', '', 'mail-preparation-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const reload = el('button', '저장된 범위 다시 불러오기', 'order-button'); reload.type = 'button'; reload.hidden = true;
  controls.append(searchLabel, selectLabel, save); mount.append(steps, controls, summary, status, reload);

  function renderPicker() {
    const query = search.value.trim().toLocaleLowerCase('ko'); picker.replaceChildren();
    const empty = el('option', !catalogConfirmed ? '거래처 목록 확인 중' : customers.length ? '거래처를 선택하세요' : '거래처 설정에서 먼저 등록하세요'); empty.value = ''; picker.append(empty);
    for (const item of customers.filter(item => item.id === customer?.id || !query || `${item.code} ${item.name}`.toLocaleLowerCase('ko').includes(query))) { const option = el('option', `${item.name} · ${item.code}`); option.value = item.id; picker.append(option); }
    picker.value = customer?.id || ''; picker.disabled = !mail || !catalogConfirmed || busy || !!pendingSave; search.disabled = !mail || busy || !!pendingSave;
  }
  function readyCustomer() { return catalogConfirmed && customer?.syncState === 'confirmed' && sameCustomer(customer, customers.find(item => item.id === customer.id)); }
  function render() {
    const validCustomer = readyCustomer(), saved = validCustomer && !!record && readConfirmed && !dirty && record.sourceHash === mail?.rawStorage?.sha256 && record.attachmentSha256 === attachment?.sha256 && sameCustomer(record.customer, customer) && sameSelection(record.selection, selection);
    const currentStep = validCustomer && workbook ? 1 : 0;
    stepNodes.forEach((node, i) => { node.dataset.state = i < currentStep || (i === 1 && saved) ? 'done' : i === currentStep ? 'current' : 'pending'; if (i === currentStep) node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current'); });
    summary.textContent = !mail ? '메일을 선택해 시작하세요.' : !customer ? 'ERP에 등록된 거래처를 선택하고 첨부 원본을 여세요.' : !validCustomer ? '거래처 정보가 변경되었습니다. 목록에서 다시 선택해 주세요.' : !workbook ? '첨부 원본을 열어 발주 범위를 지정하세요.' : selection ? `${customer.name} · ${selection.sheetName} · ${selection.range} · ${selection.endRow - selection.startRow + 1}개 행` : '원본에서 발주 내용이 있는 셀을 드래그하세요.';
    status.textContent = notice || (saved ? '범위 저장 완료 · 다음은 상품·수량 연결입니다.' : selection ? '선택한 범위를 확인하고 저장하세요.' : '');
    status.dataset.error = String(conflict || (!!customer && !validCustomer));
    save.disabled = busy || !!pendingSave || conflict || !readConfirmed || !validCustomer || !selection || !workbook || navigator.onLine === false || !dirty;
    save.textContent = busy ? '저장 중…' : saved ? '범위 저장 완료' : '범위 저장';
    reload.hidden = !conflict; reload.disabled = busy;
    workbook?.setSelectionEnabled?.(validCustomer && !busy && !pendingSave && !conflict);
    renderPicker();
  }
  async function restore() {
    if (!record || !workbook || restored || dirty || !readConfirmed || !catalogConfirmed) return;
    restored = true; const token = generation, expected = record, activeWorkbook = workbook;
    if (record.sourceHash !== mail?.rawStorage?.sha256 || record.attachmentSha256 !== attachment?.sha256) { conflict = true; notice = '저장된 작업과 원본이 다릅니다. 원본을 다시 열어 주세요.'; render(); return; }
    const latest = customers.find(item => sameCustomer(item, record.customer));
    if (!latest) { customer = { ...record.customer, syncState: 'cached' }; notice = '저장 후 거래처 정보가 변경되었습니다. 거래처를 다시 선택해 주세요.'; render(); return; }
    try {
      const restoredSelection = await activeWorkbook.setSelection(record.selection);
      if (disposed || generation !== token || record?.revision !== expected.revision || record?.updatedAtIso !== expected.updatedAtIso || workbook !== activeWorkbook || dirty) return;
      if (!sameSelection(restoredSelection, expected.selection)) throw new Error('저장된 범위를 원본에서 다시 확인해 주세요.');
      customer = latest; selection = restoredSelection; notice = ''; render();
    } catch (error) { if (generation === token) { conflict = true; notice = error.message; render(); } }
  }
  function closeWorkbook() { generation++; stopRecord?.(); stopRecord = null; attachment = null; workbook = null; selection = null; record = null; readConfirmed = false; restored = false; dirty = false; conflict = false; busy = false; pendingSave = null; notice = ''; render(); }
  function setMail(value) { closeWorkbook(); mail = value; customer = null; search.value = ''; render(); }
  function openWorkbook(value) {
    closeWorkbook(); mail = value.mail; attachment = value.attachment; workbook = value.workbook;
    const token = generation; render();
    try { stopRecord = subscribeMailPreparation(mail.id, String(attachment.id), (next, metadata = {}) => {
      if (disposed || token !== generation) return;
      const confirmed = !metadata.fromCache && !metadata.hasPendingWrites && (!next || next.syncState === 'confirmed');
      readConfirmed = confirmed;
      const changed = record?.revision !== next?.revision || record?.updatedAtIso !== next?.updatedAtIso;
      const ownSave = confirmed && pendingSave && next?.revision === pendingSave.revision && sameCustomer(next.customer, pendingSave.customer) && sameSelection(next.selection, pendingSave.selection);
      if (ownSave) { dirty = false; pendingSave = null; notice = ''; }
      else if (confirmed && pendingSave && next?.revision >= pendingSave.revision) { pendingSave = null; conflict = true; notice = '다른 담당자가 범위를 변경했습니다. 저장된 범위를 다시 불러와 주세요.'; }
      else if (dirty && changed && !busy) { conflict = true; notice = '다른 담당자가 범위를 변경했습니다. 저장된 범위를 다시 불러와 주세요.'; }
      record = next;
      if (!dirty) { if (changed) restored = false; void restore(); }
      render();
    }, error => { if (token === generation) { readConfirmed = false; notice = error?.message || '저장된 범위를 확인하지 못했습니다.'; render(); } }); }
    catch (error) { notice = error.message; render(); }
  }
  search.addEventListener('input', renderPicker);
  picker.addEventListener('change', () => {
    customer = customers.find(item => item.id === picker.value) || null; selection = null; dirty = true; notice = ''; restored = true;
    void workbook?.setSelection?.(null); render();
  });
  function selectionChanged(value) { selection = value; dirty = true; notice = ''; render(); }
  save.addEventListener('click', async () => {
    if (save.disabled) return;
    const token = generation, beforeCustomer = { ...customer }, beforeSelection = selectionValue(selection);
    busy = true; pendingSave = { revision: (record?.revision || 0) + 1, customer: beforeCustomer, selection: beforeSelection }; notice = ''; render();
    try {
      const result = await saveMailPreparation({ intakeId: mail.id, attachmentId: String(attachment.id), account: mail.account,
        sourceHash: mail.rawStorage?.sha256, attachmentSha256: attachment.sha256, customer: beforeCustomer,
        selection: beforeSelection, expectedRevision: record?.revision || 0, expectedUpdatedAtIso: record?.updatedAtIso }, session);
      if (token !== generation) return;
      if (conflict) return;
      // The confirmed snapshot is still required before this draft is shown as saved.
      dirty = !(record?.syncState === 'confirmed' && record.revision === result.revision && sameCustomer(record.customer, beforeCustomer) && sameSelection(record.selection, beforeSelection));
      if (dirty) notice = '저장 결과를 확인하고 있습니다.';
      else notice = '';
    } catch (error) { if (token === generation) { pendingSave = null; conflict = true; notice = error?.message || '범위를 저장하지 못했습니다.'; } }
    finally { if (token === generation) { busy = false; render(); } }
  });
  reload.addEventListener('click', () => { if (!dirty || window.confirm('현재 선택을 버리고 저장된 범위를 불러올까요?')) { dirty = false; restored = false; conflict = false; notice = ''; selection = null; void workbook?.setSelection?.(null); void restore(); render(); } });
  const stopCustomers = subscribeErpCustomers((items, metadata = {}) => { customers = items; catalogConfirmed = !metadata.fromCache && !metadata.hasPendingWrites; void restore(); render(); }, () => { catalogConfirmed = false; notice = '거래처 목록을 확인하지 못했습니다.'; render(); });
  const connectionChanged = () => render(); window.addEventListener('offline', connectionChanged); window.addEventListener('online', connectionChanged);
  const beforeUnload = event => { if (dirty && selection) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', beforeUnload);
  render();
  return { setMail, openWorkbook, closeWorkbook, selectionChanged,
    canLeave: () => !busy && !pendingSave && (!dirty || !selection || window.confirm('저장하지 않은 범위 선택이 있습니다. 이동할까요?')),
    destroy() { disposed = true; generation++; stopRecord?.(); stopCustomers?.(); window.removeEventListener('offline', connectionChanged); window.removeEventListener('online', connectionChanged); window.removeEventListener('beforeunload', beforeUnload); } };
}
