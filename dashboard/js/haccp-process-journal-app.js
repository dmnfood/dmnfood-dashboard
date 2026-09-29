import { escapeHtml, formatDateValue } from '/dashboard/js/haccp-form-common.js';
import { createJournalModal } from '/dashboard/js/journal-modal.js';

// Each process supplies its own settings, date query and paper renderer.
export function mountProcessJournal({ title, code, loadSettings, subscribeByDate, render }) {
  const overlay = document.createElement('div');
  overlay.id = 'processJournalModal';
  overlay.className = 'journal-modal-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = `<section class="journal-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="processJournalTitle">
    <header class="journal-modal-header"><div><h2 class="journal-modal-title" id="processJournalTitle">${escapeHtml(title)} 일지 조회 / 인쇄</h2><p class="journal-modal-subtitle">날짜별 ${escapeHtml(code)} 모니터링 기록을 조회하고 인쇄합니다.</p></div><button type="button" class="journal-modal-close" data-journal-close aria-label="일지 조회 창 닫기">×</button></header>
    <div class="journal-modal-body"><aside class="journal-dashboard"><h3 class="journal-dashboard-heading">조회 조건</h3><div class="journal-modal-toolbar"><label>조회일자<input id="processJournalDate" type="date"></label><button class="btn-secondary" id="processJournalLoad" type="button">조회</button><button class="btn-secondary" id="processJournalToday" type="button">오늘</button><button class="btn-primary journal-print-button" id="processJournalPrint" type="button" disabled>인쇄 / PDF 저장</button></div><h3 class="journal-summary-heading">기록 요약</h3><div class="journal-modal-summary" id="processJournalSummary"></div><p class="journal-modal-status" id="processJournalStatus" role="status"></p></aside><div class="journal-preview-viewport"><div class="journal-preview-scale-stage"><div id="ccpJournalPrintRoot" class="journal-sheet-list"></div></div></div></div></section>`;
  document.body.append(overlay);
  const find = id => overlay.querySelector(`#${id}`);
  const date = find('processJournalDate');
  const output = find('ccpJournalPrintRoot');
  const stage = output.parentElement;
  const print = find('processJournalPrint');
  const status = find('processJournalStatus');
  const summary = find('processJournalSummary');
  let unsubscribe;
  let version = 0;
  let detached = false;
  let originalTitle;

  const stop = () => { version += 1; unsubscribe?.(); unsubscribe = null; };
  const setStatus = (text, error = false) => { status.textContent = text; status.classList.toggle('error', error); };
  const load = async () => {
    stop();
    const request = version;
    const recordDate = date.value;
    output.replaceChildren(); summary.replaceChildren(); print.disabled = true;
    if (!recordDate) { setStatus('조회일자를 선택해 주세요.', true); return; }
    setStatus('기록을 불러오는 중...');
    const fail = error => {
      if (request !== version) return;
      print.disabled = true; output.replaceChildren(); summary.replaceChildren();
      console.error(`${code} journal query failed`, error);
      setStatus(error?.code === 'permission-denied' ? '기록 조회 권한이 없습니다.' : '기록을 불러오지 못했습니다. 다시 조회해 주세요.', true);
    };
    try {
      const settings = await loadSettings();
      if (request !== version) return;
      unsubscribe = subscribeByDate(recordDate, records => {
        if (request !== version) return;
        try {
          const pages = render({ container: output, date: recordDate, records, settings });
          summary.innerHTML = [['총 기록', `${records.length}건`], ['출력 페이지', `${pages}장`], ['PASS', `${records.filter(r => r.judgment === 'PASS').length}건`], ['FAIL', `${records.filter(r => r.judgment === 'FAIL').length}건`]].map(([label, count]) => `<div class="journal-summary-card"><b>${label}</b><span>${count}</span></div>`).join('');
          setStatus(records.length ? `${recordDate} 기록 ${records.length}건을 불러왔습니다.` : `${recordDate}에 저장된 기록이 없습니다. 빈 양식으로 인쇄할 수 있습니다.`);
          print.disabled = false;
          requestAnimationFrame(modal.fitPreview);
        } catch (error) { fail(error); }
      }, fail);
    } catch (error) { fail(error); }
  };
  const modal = createJournalModal({ modalId: overlay.id, printRootId: output.id,
    onOpen: () => { date.value ||= formatDateValue(new Date()); return load(); }, onClose: stop });
  document.getElementById('openJournalBtn').addEventListener('click', modal.open);
  find('processJournalLoad').addEventListener('click', load);
  find('processJournalToday').addEventListener('click', () => { date.value = formatDateValue(new Date()); load(); });
  date.addEventListener('change', load);

  window.addEventListener('beforeprint', () => {
    if (detached || print.disabled || !overlay.classList.contains('open')) return;
    detached = true;
    document.body.append(output);
  });
  window.addEventListener('afterprint', () => {
    if (detached) { detached = false; stage.append(output); requestAnimationFrame(modal.fitPreview); }
    if (originalTitle !== undefined) { document.title = originalTitle; originalTitle = undefined; }
  });
  print.addEventListener('click', () => {
    if (print.disabled) return;
    originalTitle = document.title;
    document.title = `${code}_${title}_모니터링일지_${date.value}`;
    window.print();
  });
  window.addEventListener('beforeunload', stop);
  return modal;
}
