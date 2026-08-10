import { requireApprovedActiveUser } from '/dashboard/js/firebase-client.js';
import { initializeHaccpHomeLinks } from '/dashboard/js/haccp-navigation.js';

const DEFAULT_CHOICES = Object.freeze({
  offOdorDetected: false,
  packagingCondition: 'good',
  expirationCheck: 'x',
  testReportReceived: false,
});

const localDateValue = () => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

export function initializeIncomingInspectionPage({
  pageName,
  itemLabel,
  journalLabel,
  firestore,
}) {
  initializeHaccpHomeLinks();

  const $ = id => document.getElementById(id);
  const elements = {
    recordDate: $('recordDate'),
    itemName: $('itemName'),
    supplierName: $('supplierName'),
    purchaseQuantity: $('purchaseQuantity'),
    temperature: $('temperature'),
    vehicleTemperature: $('vehicleTemperature'),
    grade: $('grade'),
    writerConfirmName: $('writerConfirmName'),
    notes: $('notes'),
    save: $('saveBtn'),
    toast: $('toast'),
    body: $('recordsBody'),
    filter: $('dateFilter'),
  };

  let currentUser;
  let currentRole = '';
  let records = [];
  let editingRecord = null;
  let unsubscribe;
  let choices = { ...DEFAULT_CHOICES };

  const canManage = record => record.createdByUid === currentUser?.uid || ['manager', 'admin'].includes(currentRole);

  function notify(message, error = false) {
    elements.toast.textContent = message;
    elements.toast.className = `toast show${error ? ' error' : ''}`;
  }

  function clearNotify() {
    elements.toast.className = 'toast';
    elements.toast.textContent = '';
  }

  function setChoice(name, value) {
    choices[name] = ['offOdorDetected', 'testReportReceived'].includes(name) ? value === true || value === 'true' : value;
    document.querySelectorAll(`[data-choice="${name}"]`).forEach(button => {
      const active = button.dataset.value === String(choices[name]);
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function resetForm() {
    editingRecord = null;
    elements.recordDate.value = localDateValue();
    elements.itemName.value = '';
    elements.supplierName.value = '';
    elements.purchaseQuantity.value = '';
    elements.temperature.value = '실온';
    elements.vehicleTemperature.value = '실온';
    elements.grade.value = '일반';
    elements.writerConfirmName.value = '이승표';
    elements.notes.value = '';
    Object.entries(DEFAULT_CHOICES).forEach(([name, value]) => setChoice(name, value));
    elements.save.textContent = '기록 저장';
    clearNotify();
  }

  function formValues() {
    const quantityText = elements.purchaseQuantity.value.trim();
    return {
      recordDate: elements.recordDate.value,
      itemName: elements.itemName.value,
      supplierName: elements.supplierName.value,
      purchaseQuantity: quantityText === '' ? null : Number(quantityText),
      temperature: elements.temperature.value,
      vehicleTemperature: elements.vehicleTemperature.value,
      grade: elements.grade.value,
      writerConfirmName: elements.writerConfirmName.value,
      notes: elements.notes.value,
      ...choices,
    };
  }

  function validate(values) {
    if (!values.recordDate) return '작성일을 선택해 주세요.';
    if (!values.itemName.trim()) return `${itemLabel}명을 입력해 주세요.`;
    if (!values.supplierName.trim()) return '매입처를 입력해 주세요.';
    if (!Number.isFinite(values.purchaseQuantity) || values.purchaseQuantity < 0) return '매입량은 0 이상의 숫자로 입력해 주세요.';
    if (!values.temperature.trim()) return '온도를 입력해 주세요.';
    if (!values.vehicleTemperature.trim()) return '운송차량온도를 입력해 주세요.';
    if (!values.grade.trim()) return '등급을 입력해 주세요.';
    if (!values.writerConfirmName.trim()) return '작성자/확인을 입력해 주세요.';
    return '';
  }

  function loadRecord(record) {
    if (!canManage(record)) {
      notify('다른 사용자가 작성한 기록은 수정할 수 없습니다.', true);
      return;
    }
    editingRecord = record;
    elements.recordDate.value = record.recordDate;
    elements.itemName.value = record.itemName;
    elements.supplierName.value = record.supplierName;
    elements.purchaseQuantity.value = record.purchaseQuantity;
    elements.temperature.value = record.temperature;
    elements.vehicleTemperature.value = record.vehicleTemperature;
    elements.grade.value = record.grade;
    elements.writerConfirmName.value = record.writerConfirmName;
    elements.notes.value = record.notes;
    Object.keys(DEFAULT_CHOICES).forEach(name => setChoice(name, record[name]));
    elements.save.textContent = '수정 저장';
    clearNotify();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderRecords() {
    const filtered = records.filter(record => !elements.filter.value || record.recordDate === elements.filter.value);
    if (!filtered.length) {
      elements.body.innerHTML = '<tr><td colspan="7" class="empty-state">조건에 맞는 기록이 없습니다.</td></tr>';
      return;
    }
    elements.body.innerHTML = filtered.map(record => {
      const actions = canManage(record)
        ? `<button class="record-link" data-edit="${escapeHtml(record.id)}">수정</button> · <button class="record-link" data-delete="${escapeHtml(record.id)}">삭제</button>`
        : '<span class="muted">조회만 가능</span>';
      const packaging = record.packagingCondition === 'good' ? '양호' : '불량';
      return `<tr><td>${escapeHtml(record.recordDate)}</td><td>${escapeHtml(record.itemName)}</td><td>${escapeHtml(record.supplierName)}</td><td>${escapeHtml(record.purchaseQuantity)}</td><td>${packaging}</td><td>${escapeHtml(record.writerConfirmName)}</td><td>${actions}</td></tr>`;
    }).join('');
  }

  async function save() {
    const values = formValues();
    const error = validate(values);
    if (error) { notify(error, true); return; }
    if (editingRecord && !canManage(editingRecord)) { notify('이 기록을 저장할 권한이 없습니다.', true); return; }
    elements.save.disabled = true;
    try {
      const wasEditing = Boolean(editingRecord);
      await firestore.saveInspectionRecord(values, currentUser, editingRecord);
      resetForm();
      notify(wasEditing ? `${journalLabel}를 수정했습니다.` : `${journalLabel}를 저장했습니다.`);
    } catch (error_) {
      console.error(`${pageName} save failed`, error_);
      notify(error_?.code === 'permission-denied' ? '이 기록을 저장할 권한이 없습니다.' : '저장하지 못했습니다. 다시 시도해 주세요.', true);
    } finally {
      elements.save.disabled = false;
    }
  }

  document.querySelectorAll('[data-choice]').forEach(button => {
    button.addEventListener('click', () => setChoice(button.dataset.choice, button.dataset.value));
  });
  elements.save.addEventListener('click', save);
  $('resetBtn').addEventListener('click', resetForm);
  elements.filter.addEventListener('change', renderRecords);
  $('clearFilterBtn').addEventListener('click', () => { elements.filter.value = ''; renderRecords(); });
  elements.body.addEventListener('click', async event => {
    const editId = event.target.dataset.edit;
    const deleteId = event.target.dataset.delete;
    if (editId) {
      const record = records.find(item => item.id === editId);
      if (record) loadRecord(record);
      return;
    }
    if (!deleteId) return;
    const record = records.find(item => item.id === deleteId);
    if (!record || !canManage(record) || !confirm(`${record.recordDate} ${record.itemName} 기록을 삭제할까요?`)) return;
    try {
      await firestore.deleteInspectionRecord(deleteId);
      if (editingRecord?.id === deleteId) resetForm();
    } catch (error) {
      console.error(`${pageName} delete failed`, error);
      notify('삭제하지 못했습니다.', true);
    }
  });

  requireApprovedActiveUser({ page: pageName }).then(session => {
    if (!session) return;
    currentUser = session.user;
    currentRole = session.role;
    resetForm();
    unsubscribe = firestore.subscribeToInspectionRecords(rows => {
      records = rows;
      renderRecords();
    }, error => {
      console.error(`${pageName} subscription failed`, error);
      elements.body.innerHTML = '<tr><td colspan="7" class="empty-state">기록을 불러오지 못했습니다.</td></tr>';
    });
    $('loadingScreen').classList.add('hidden');
    $('mainContent').classList.remove('auth-hidden');
  });

  window.addEventListener('beforeunload', () => unsubscribe?.());
}
