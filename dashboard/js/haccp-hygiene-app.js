import { requireApprovedActiveUser } from '/dashboard/js/firebase-client.js';
import { initializeHaccpHomeLinks } from '/dashboard/js/haccp-navigation.js';
import { HYGIENE_GROUPS } from '/dashboard/js/haccp-management-definitions.js';
import { localDateValue, canManageRecord, escapeHtml } from '/dashboard/js/haccp-management-utils.js';
import { subscribeHygieneSchedule, saveGeneralHygiene, deleteGeneralHygiene } from '/dashboard/js/haccp-general-hygiene-process-firestore.js';
import { hygieneSchedule, hygieneRecordFor, hygieneQueryRange } from '/dashboard/js/haccp-hygiene-schedule.js';

initializeHaccpHomeLinks();
const form = document.getElementById('journalForm');
const recent = document.getElementById('recentRecords');
const drafts = new Map();
let session, records = [], date = localDateValue(), selected = 'pre_work', inspector = '김석기';
let editing = null, dirty = false, busy = false, ready = false, unsubscribe, queryYear, version = 0;
const key = () => `${date}:${selected}`;
const field = (id, label, value = '', type = 'text', extra = '') => `<label class="field"><span class="field-label">${label}</span><input id="${id}" type="${type}" value="${escapeHtml(value)}" ${extra}></label>`;

form.innerHTML = `<section class="panel"><div class="hygiene-basic">${field('recordDate','점검일자',date,'date','required')}${field('inspectorName','점검자',inspector,'text','required')}</div><div id="hygieneCards" class="hygiene-cards" role="group" aria-label="점검구분 선택"></div><p class="hygiene-help">선택한 날짜 기준입니다. 예정일이 아니어도 점검할 수 있습니다.</p><p id="scheduleStatus" class="hygiene-help" role="status"></p></section><div id="hygieneContent"></div>`;
const cards = document.getElementById('hygieneCards'), content = document.getElementById('hygieneContent');
const dateInput = document.getElementById('recordDate'), inspectorInput = document.getElementById('inspectorName');
function status(message, error = false) {
  const target = document.getElementById('formStatus');
  target.textContent = message; target.className = `toast show${error ? ' error' : ''}`;
}
function drawCards() {
  cards.innerHTML = HYGIENE_GROUPS.map(group => {
    const state = ready ? hygieneSchedule(date, group.key, records) : { state:'loading',label:'확인 중',detail:group.cadence };
    const draft = drafts.has(`${date}:${group.key}`) || group.key === selected && dirty;
    return `<button type="button" class="hygiene-card status-${state.state}" data-group="${group.key}" aria-pressed="${selected === group.key}" ${busy ? 'disabled' : ''}><strong>${group.label}</strong><span>${state.detail}</span><small>${state.label}</small>${draft ? '<small class="draft-marker">입력 중</small>' : ''}</button>`;
  }).join('');
}
function snapshot() {
  const answers = {};
  content.querySelectorAll('input[type=radio]:checked').forEach(input => { answers[input.name.slice(2)] = input.value === 'true'; });
  const value = id => document.getElementById(id)?.value || '';
  return { recordDate: editing?.recordDate || date, inspectionGroup:selected, inspectorName:inspectorInput.value, answers,
    capturedPestCount:value('capturedPestCount'), annualDates:{thermometer:value('annualThermometerDate'),ccpEquipment:value('annualCcpEquipmentDate')},
    notes:value('notes'), correctiveActionResult:value('correctiveActionResult'), actionBy:value('actionBy'), confirmedBy:value('confirmedBy') };
}
function remember() {
  inspector = inspectorInput.value;
  if (dirty) drafts.set(key(), { values:snapshot(), editing, open:content.querySelector('details')?.open });
}
function drawContent(explicitRecord) {
  const draft = drafts.get(key());
  editing = explicitRecord || draft?.editing || (ready ? hygieneRecordFor(records,date,selected) : null);
  const values = explicitRecord || draft?.values || editing || {};
  dirty = !explicitRecord && Boolean(draft);
  if (values.inspectorName) inspector = values.inspectorName;
  inspectorInput.value = inspector;
  const group = HYGIENE_GROUPS.find(group => group.key === selected);
  const readonly = editing && !canManageRecord(editing,session);
  const questions = group.dates
    ? `<div class="field-grid">${field('annualThermometerDate','온도계 등 검·교정일',values.annualDates?.thermometer,'date','required')}${field('annualCcpEquipmentDate','CCP 모니터링 장비 검·교정일',values.annualDates?.ccpEquipment,'date','required')}</div>`
    : `<div class="question-list">${group.questions.map(([category,text],i) => `<div class="question-row"><div class="question-copy"><small>${escapeHtml(category)}</small>${escapeHtml(text)}</div><div class="radio-pair">${[[true,'예'],[false,'아니오']].map(([answer,label]) => `<input id="q_${i}_${answer}" type="radio" name="q_${i}" value="${answer}" ${values.answers?.[i] === answer ? 'checked' : ''} required><label for="q_${i}_${answer}">${label}</label>`).join('')}</div></div>`).join('')}</div>`;
  content.innerHTML = `<section class="panel"><h2 class="panel-title">${group.label} · ${group.cadence}</h2>${editing ? `<p class="hygiene-record-status">${escapeHtml(editing.recordDate)} 저장 기록${readonly ? ' · 조회만 가능' : ' · 수정 가능'}</p>` : ''}${questions}${group.numeric ? `<div class="subsection">${field('capturedPestCount','쥐덫·해충 포획 장치의 포획 개체수',values.capturedPestCount ?? '', 'number', 'min="0" step="1" required')}</div>` : ''}</section><details class="guide-details" ${draft?.open || values.notes || values.correctiveActionResult ? 'open' : ''}><summary>특이사항 및 개선조치</summary><div class="guide-body field-grid">${field('notes','특이사항',values.notes)}${field('correctiveActionResult','개선조치 및 결과',values.correctiveActionResult)}${field('actionBy','조치자',values.actionBy)}${field('confirmedBy','확인자',values.confirmedBy)}</div></details><div class="action-row hygiene-actions"><button type="submit" class="btn-primary" ${!ready || busy || readonly ? 'disabled' : ''}>${editing ? '수정 저장' : '저장'}</button><button type="button" id="resetHygiene" class="btn-secondary">${editing ? '저장 내용 복원' : '초기화'}</button></div><p id="formStatus" class="toast" role="status"></p>`;
  content.querySelectorAll('input').forEach(input => { input.disabled = Boolean(readonly || busy); });
  inspectorInput.disabled = Boolean(readonly || busy);
  document.getElementById('resetHygiene').onclick = () => { drafts.delete(key()); dirty = false; drawContent(); drawCards(); };
  drawCards();
}
cards.addEventListener('click', event => {
  const button = event.target.closest('[data-group]');
  if (!button || busy || button.dataset.group === selected) return;
  remember(); selected = button.dataset.group; drawContent(); cards.querySelector(`[data-group="${selected}"]`).focus();
});
form.addEventListener('input', event => {
  if (event.target === dateInput) return;
  dirty = true;
  if (event.target.type === 'radio' && event.target.value === 'false') content.querySelector('details').open = true;
  drawCards();
});
dateInput.addEventListener('change', () => {
  if (!dateInput.value || !dateInput.validity.valid || busy) return;
  remember(); date = dateInput.value;
  if (queryYear !== date.slice(0,4)) subscribe();
  drawContent();
});
function subscribe() {
  unsubscribe?.(); const request = ++version;
  queryYear = date.slice(0,4); ready = false; records = [];
  document.getElementById('scheduleStatus').textContent = '작성 상태를 확인하고 있습니다.';
  const range = hygieneQueryRange(date);
  unsubscribe = subscribeHygieneSchedule(range.start,range.end,items => {
    if (request !== version) return;
    records = items; ready = true;
    document.getElementById('scheduleStatus').textContent = '';
    // Snapshot updates must not discard unsaved answers.
    if (!dirty && !busy) drawContent();
    else {
      drawCards();
      if (!busy) content.querySelector('[type=submit]').disabled = false;
    }
    drawRecent();
  }, error => {
    if (request !== version) return;
    ready = false; drawCards();
    content.querySelector('[type=submit]').disabled = true;
    document.getElementById('scheduleStatus').textContent = '작성 상태를 불러오지 못했습니다. 페이지를 새로고침해 주세요.';
    console.error('Hygiene schedule query failed',error);
  });
}
form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !ready) return;
  const values = snapshot();
  const existing = editing || hygieneRecordFor(records,date,selected);
  if (existing && !canManageRecord(existing,session)) { status('같은 기간 기록을 수정할 권한이 없습니다.',true); return; }
  const group = HYGIENE_GROUPS.find(group => group.key === selected);
  if (!group.dates && Object.keys(values.answers).length !== group.questions.length) { status('모든 점검항목에 응답해 주세요.',true); return; }
  if (!values.inspectorName.trim()) { status('점검자를 입력해 주세요.',true); return; }
  values.inspectorName = values.inspectorName.trim();
  values.cadence = {pre_work:'daily',during_work:'daily',post_work:'daily',incoming:'event',weekly:'weekly',monthly:'monthly',annual:'annual'}[selected];
  values.capturedPestCount = group.numeric ? Number(values.capturedPestCount) : null;
  if (!group.dates) values.annualDates = {};
  busy = true; dateInput.disabled = true; inspectorInput.disabled = true;
  content.querySelectorAll('input,button').forEach(element => { element.disabled = true; }); drawCards();
  try {
    const id = await saveGeneralHygiene(values,session.user,existing);
    const saved = {...existing,...values,id,createdByUid:existing?.createdByUid || session.user.uid};
    records = [saved,...records.filter(record => record.id !== id)];
    drafts.delete(key()); dirty = false; busy = false;
    drawContent(selected === 'incoming' ? undefined : saved); drawRecent(); status('저장했습니다.');
  } catch (error) {
    busy = false; remember(); drawContent(); status('저장하지 못했습니다. 입력 내용은 유지됩니다.',true); console.error(error);
  } finally { busy = false; dateInput.disabled = false; drawCards(); }
});
function drawRecent() {
  const rows = [...records].sort((a,b) => b.recordDate.localeCompare(a.recordDate)).slice(0,100);
  recent.innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>점검일</th><th>점검구분</th><th>점검자</th><th>관리</th></tr></thead><tbody>${rows.map(record => `<tr><td>${escapeHtml(record.recordDate)}</td><td>${escapeHtml(HYGIENE_GROUPS.find(group => group.key === record.inspectionGroup)?.label || '')}</td><td>${escapeHtml(record.inspectorName)}</td><td><button type="button" class="record-link" data-open="${escapeHtml(record.id)}">${canManageRecord(record,session) ? '수정' : '조회'}</button>${canManageRecord(record,session) ? ` · <button type="button" class="record-link" data-delete="${escapeHtml(record.id)}">삭제</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">선택한 연도에 저장된 기록이 없습니다.</div>';
}
recent.addEventListener('click', async event => {
  if (busy) return;
  const id = event.target.dataset.open || event.target.dataset.delete;
  const record = records.find(record => record.id === id); if (!record) return;
  if (event.target.dataset.open) {
    remember(); date = record.recordDate; selected = record.inspectionGroup; dateInput.value = date;
    // Open a saved record explicitly; drafts for other date/group pairs remain intact.
    drafts.delete(key()); drawContent(record); window.scrollTo({top:0,behavior:'smooth'});
  } else if (canManageRecord(record,session) && confirm('이 기록을 삭제하시겠습니까?')) {
    try { await deleteGeneralHygiene(id); records = records.filter(record => record.id !== id); if (editing?.id === id) { drafts.delete(key()); dirty = false; drawContent(); } drawCards(); drawRecent(); }
    catch (error) { status('삭제하지 못했습니다.',true); }
  }
});
window.addEventListener('beforeunload', event => {
  if (dirty || drafts.size) { event.preventDefault(); event.returnValue = ''; }
});
requireApprovedActiveUser({page:'haccp-hygiene'}).then(current => {
  if (!current) return; session = current; drawContent(); subscribe();
  document.getElementById('loadingScreen').classList.add('hidden'); document.getElementById('mainContent').classList.remove('auth-hidden');
});
