import { escapeHtml } from '/dashboard/js/haccp-form-common.js';
import { createJournalModal } from '/dashboard/js/journal-modal.js';
import { createJournalDateSelector, groupJournalDates, journalSelectionError } from '/dashboard/js/journal-date-selection.js';

// Each process supplies its own settings, date query and paper renderer.
export function mountProcessJournal({ title, code, loadSettings, subscribeByRange, render, summarize, createSelector = createJournalDateSelector, groupRecords = groupJournalDates, subtitle = `날짜별 ${code} 모니터링 기록을 조회하고 인쇄합니다.` }) {
  const overlay = document.createElement('div');
  overlay.id = 'processJournalModal';
  overlay.className = 'journal-modal-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = `<section class="journal-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="processJournalTitle">
    <header class="journal-modal-header"><div><h2 class="journal-modal-title" id="processJournalTitle">${escapeHtml(title)} 일지 조회 / 인쇄</h2><p class="journal-modal-subtitle">${escapeHtml(subtitle)}</p></div><button type="button" class="journal-modal-close" data-journal-close aria-label="일지 조회 창 닫기">×</button></header>
    <div class="journal-modal-body"><aside class="journal-dashboard"><h3 class="journal-dashboard-heading">조회 조건</h3><div class="journal-modal-toolbar"><div class="journal-date-selector"></div><button class="btn-primary journal-print-button" id="processJournalPrint" type="button" disabled>인쇄 / PDF 저장</button></div><h3 class="journal-summary-heading">기록 요약</h3><div class="journal-modal-summary" id="processJournalSummary"></div><p class="journal-modal-status" id="processJournalStatus" role="status"></p></aside><div class="journal-preview-viewport"><div class="journal-preview-scale-stage"><div id="ccpJournalPrintRoot" class="journal-sheet-list"></div></div></div></div></section>`;
  document.body.append(overlay);
  const find = id => overlay.querySelector(`#${id}`);
  const output = find('ccpJournalPrintRoot');
  const stage = output.parentElement;
  const print = find('processJournalPrint');
  const status = find('processJournalStatus');
  const summary = find('processJournalSummary');
  let unsubscribe;
  let version = 0;
  let detached = false;
  let originalTitle;
  let loadedSelection;

  const stop = () => { version += 1; unsubscribe?.(); unsubscribe = null; };
  const setStatus = (text, error = false) => { status.textContent = text; status.classList.toggle('error', error); };
  const load = async (selection = selector.getSelection()) => {
    stop();
    const request = version;
    output.replaceChildren(); summary.replaceChildren(); print.disabled = true;
    output.classList.remove('is-preview-scaled'); stage.style.width = ''; stage.style.height = '';
    const invalid = journalSelectionError(selection);
    if (invalid) { setStatus(invalid, true); return; }
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
      unsubscribe = subscribeByRange(selection.start, selection.end, records => {
        if (request !== version) return;
        try {
          output.replaceChildren();
          const groups = groupRecords(records, selection);
          const selectedRecords = groups.flatMap(([, items]) => items);
          let pages = 0;
          for (const [date, items] of groups) {
            // Render in the live DOM so continuation pages can measure text,
            // then flatten sheets so page breaks work across date boundaries.
            const host = document.createElement('div'); output.append(host);
            pages += render({ container: host, date, records: items, settings });
            for (const sheet of host.children) sheet.dataset.journalDate = date;
            output.append(...host.children); host.remove();
          }
          const totals = summarize ? summarize(selectedRecords, pages) : [['총 기록', `${selectedRecords.length}건`], ['출력 페이지', `${pages}장`], ['PASS', `${selectedRecords.filter(r => (r.judgment || r.judgement) === 'PASS').length}건`], ['FAIL', `${selectedRecords.filter(r => (r.judgment || r.judgement) === 'FAIL').length}건`]];
          if (selection.mode === 'range') totals.push(['기록 날짜', `${groups.length}일`]);
          summary.innerHTML = totals.map(([label, count]) => `<div class="journal-summary-card"><b>${escapeHtml(label)}</b><span>${escapeHtml(count)}</span></div>`).join('');
          const period = selection.start === selection.end ? selection.start : `${selection.start} ~ ${selection.end}`;
          setStatus(selectedRecords.length ? `${period} · ${selectedRecords.length}건 · ${pages}장` : pages ? `${period}에 저장된 기록이 없습니다. 빈 양식으로 인쇄할 수 있습니다.` : `${period}에 저장된 기록이 없습니다.`);
          loadedSelection = selection;
          print.disabled = pages === 0;
          requestAnimationFrame(modal.fitPreview);
        } catch (error) { fail(error); }
      }, fail);
    } catch (error) { fail(error); }
  };
  const selector = createSelector(overlay.querySelector('.journal-date-selector'), load);
  const modal = createJournalModal({ modalId: overlay.id, printRootId: output.id, onOpen: () => load(), onClose: stop });
  document.getElementById('openJournalBtn').addEventListener('click', modal.open);

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
    const period = loadedSelection.start === loadedSelection.end ? loadedSelection.start : `${loadedSelection.start}_${loadedSelection.end}`;
    document.title = `${code}_${title}_${period}`;
    window.print();
  });
  window.addEventListener('beforeunload', stop);
  return modal;
}
