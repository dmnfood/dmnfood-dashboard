import { doc, getDoc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db } from '/dashboard/js/firebase-client.js';

export const DEFAULT_INSPECTION_SETTINGS = Object.freeze({
  temperature: '실온', vehicleTemperature: '실온', grade: '일반', writerConfirmName: '이승표',
  offOdorDetected: false, packagingCondition: 'good', expirationCheck: 'x', testReportReceived: false,
});

export function normalizeInspectionSettings(values = {}) {
  const settings = { ...DEFAULT_INSPECTION_SETTINGS };
  for (const key of ['temperature', 'vehicleTemperature', 'grade', 'writerConfirmName']) {
    if (typeof values[key] === 'string' && values[key].trim()) settings[key] = values[key].trim();
  }
  for (const key of ['offOdorDetected', 'testReportReceived']) {
    if (typeof values[key] === 'boolean') settings[key] = values[key];
  }
  if (['good', 'poor'].includes(values.packagingCondition)) settings.packagingCondition = values.packagingCondition;
  if (['x', 'o'].includes(values.expirationCheck)) settings.expirationCheck = values.expirationCheck;
  return settings;
}

export function createInspectionSettingsStore(kind) {
  if (!['rawMaterialInspection', 'auxMaterialInspection'].includes(kind)) throw new Error('Unknown inspection settings');
  const reference = () => doc(db, 'haccpSettings', kind);
  return {
    async loadInspectionSettings() {
      const snapshot = await getDoc(reference());
      return normalizeInspectionSettings(snapshot.exists() ? snapshot.data() : {});
    },
    async saveInspectionSettings(values, user) {
      await setDoc(reference(), { ...normalizeInspectionSettings(values), schemaVersion: 1, updatedByUid: user.uid, updatedAt: serverTimestamp() }, { merge: true });
    },
  };
}

export function mountInspectionSettings({ title, canEdit, getSettings, saveSettings, onSaved }) {
  const overlay = document.createElement('div');
  overlay.className = 'inspection-settings-modal'; overlay.hidden = true;
  const textFields = [['temperature','온도'],['vehicleTemperature','운송차량온도'],['grade','등급'],['writerConfirmName','작성자/확인']];
  const choiceFields = [['offOdorDetected','이미·이취',[['false','X'],['true','O']]],['packagingCondition','포장 상태',[['good','양호'],['poor','불량']]],['expirationCheck','유통 기한',[['x','X'],['o','O']]],['testReportReceived','시험성적서 수령',[['false','X'],['true','O']]]];
  overlay.innerHTML = `<section class="inspection-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="inspectionSettingsTitle"><header><h2 id="inspectionSettingsTitle"></h2><button type="button" data-close aria-label="기본 설정 닫기">×</button></header><form><div class="field-grid">${textFields.map(([key,label])=>`<label class="field">${label}<input name="${key}" required></label>`).join('')}${choiceFields.map(([key,label,options])=>`<label class="field">${label}<select name="${key}">${options.map(([value,text])=>`<option value="${value}">${text}</option>`).join('')}</select></label>`).join('')}</div><div class="action-row"><button type="submit" class="btn-primary">설정 저장</button><button type="button" class="btn-secondary" data-close>닫기</button></div><p role="status"></p></form></section>`;
  overlay.querySelector('h2').textContent = `${title} 기본 설정`;
  document.body.append(overlay);
  const form = overlay.querySelector('form'), status = overlay.querySelector('[role=status]'), save = form.querySelector('[type=submit]');
  let busy = false;
  const opener = document.getElementById('settingsBtn');
  const close = () => { if (busy) return; overlay.hidden = true; document.body.classList.remove('inspection-settings-open'); opener.focus(); };
  opener.addEventListener('click', () => {
    for (const [key,value] of Object.entries(getSettings())) form.elements.namedItem(key).value = String(value);
    form.querySelectorAll('input,select,button[type=submit]').forEach(element => { element.disabled = !canEdit(); });
    status.textContent = canEdit() ? '저장한 기본값은 새 기록 작성과 초기화 시 적용됩니다.' : '설정은 관리자 또는 매니저만 변경할 수 있습니다.';
    overlay.hidden = false; document.body.classList.add('inspection-settings-open'); overlay.querySelector('[data-close]').focus();
  });
  overlay.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click',close));
  overlay.addEventListener('click',event=>{if(event.target===overlay)close();});
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const controls = [...overlay.querySelectorAll('button,input,select')].filter(element => !element.disabled);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !canEdit()) return;
    const values = Object.fromEntries(new FormData(form));
    if (textFields.some(([key]) => !values[key].trim())) { status.textContent = '기본값을 모두 입력해 주세요.'; return; }
    values.offOdorDetected = values.offOdorDetected === 'true'; values.testReportReceived = values.testReportReceived === 'true';
    busy = true; save.disabled = true; status.textContent = '설정을 저장하는 중...';
    try { const next = normalizeInspectionSettings(values); await saveSettings(next); onSaved(next); status.textContent = '설정을 저장했습니다. 새 기록 작성과 초기화 시 적용됩니다.'; }
    catch (error) { console.error('Inspection settings save failed',error); status.textContent = '설정을 저장하지 못했습니다. 다시 시도해 주세요.'; }
    finally { busy = false; save.disabled = !canEdit(); }
  });
}
