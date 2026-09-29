import { escapeHtml } from '/dashboard/js/haccp-form-common.js';
import { mountProcessJournal } from '/dashboard/js/haccp-process-journal-app.js';
import { createJournalMonthSelector } from '/dashboard/js/journal-month-selection.js';

export function groupInspectionMonth(records, selection) {
  return [[selection.start.slice(0, 7), records.filter(record => record.recordDate >= selection.start && record.recordDate <= selection.end)
    .sort((a, b) => a.recordDate.localeCompare(b.recordDate) || String(a.createdAtIso || '').localeCompare(String(b.createdAtIso || '')) || String(a.id || '').localeCompare(String(b.id || '')))]];
}

const booleanMark = value => value === true ? 'O' : value === false ? 'X' : '';
const itemText = record => `${record.itemName || ''}${record.supplierName ? ` (${record.supplierName})` : ''}`;
function row(record) {
  const material = record ? `<span class="inspection-item">${escapeHtml(record.itemName)}</span>${record.supplierName ? ` <span class="inspection-supplier">(${escapeHtml(record.supplierName)})</span>` : ''}` : '';
  const values = record ? [booleanMark(record.offOdorDetected), record.packagingCondition === 'good' ? '양호' : record.packagingCondition === 'poor' ? '불량' : '', record.temperature, record.expirationCheck?.toUpperCase(), record.vehicleTemperature, booleanMark(record.testReportReceived), record.grade, record.recordDate, record.writerConfirmName] : Array(9).fill('');
  return `<tr><td class="inspection-material">${material}</td>${values.map(value => `<td>${escapeHtml(value ?? '')}</td>`).join('')}</tr>`;
}

function sheetMarkup(date, records, itemLabel, continuation = false) {
  return `<section class="journal-sheet sheet-page inspection-sheet"><div class="inspection-paper">
    <table class="inspection-heading"><colgroup><col style="width:72.3%"><col style="width:4%"><col style="width:11.85%"><col style="width:11.85%"></colgroup><tbody><tr><td rowspan="2" class="inspection-title">${escapeHtml(itemLabel)} 입고검사서<small>${escapeHtml(date.replace('-', '년 '))}월${continuation ? ' · 특이사항 계속' : ''}</small></td><td rowspan="2">결<br>재</td><td>작성자</td><td>승인자</td></tr><tr><td></td><td></td></tr></tbody></table>
    <table class="inspection-records"><colgroup>${[11.5,8.9,8.9,8.9,8.9,9.7,9.7,10,10.7,12.8].map(width => `<col style="width:${width}%">`).join('')}</colgroup><thead><tr><th rowspan="2">${escapeHtml(itemLabel)}<br>(매입처)</th><th colspan="4">검사 항목</th><th rowspan="2">운송<br>차량<br>온도</th><th rowspan="2">시험성적서<br>수령</th><th rowspan="2">등급</th><th rowspan="2">작성일</th><th rowspan="2">작성자/확인</th></tr><tr><th>이미,<br>이취</th><th>포장<br>상태</th><th>온도</th><th>유통<br>기한</th></tr></thead><tbody>${Array.from({length:9}, (_, i) => row(records[i])).join('')}</tbody></table>
    <div class="inspection-notes"><div>* 특이사항</div><div class="inspection-note-content"></div></div>
    </div></section>`;
}

// Split notes by their actual rendered height so long entries are never clipped.
function fillNotes(element, text) {
  element.textContent = text;
  if (element.scrollHeight <= element.clientHeight + 1) return '';
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    element.textContent = text.slice(0, middle);
    if (element.scrollHeight <= element.clientHeight + 1) low = middle;
    else high = middle - 1;
  }
  element.textContent = text.slice(0, low);
  return text.slice(low);
}

export function renderIncomingJournal({ container, date, records, itemLabel }) {
  container.replaceChildren();
  let pages = 0;
  let offset = 0;
  const appendSheet = (entries, continuation = false) => {
    container.insertAdjacentHTML('beforeend', sheetMarkup(date, entries, itemLabel, continuation));
    const sheet = container.lastElementChild;
    sheet.querySelectorAll('.inspection-material').forEach(cell => {
      // Keep each part together when it fits; wrap the supplier onto its own line first.
      if (cell.scrollWidth > cell.clientWidth) cell.classList.add('is-wrapped');
    });
    return sheet;
  };
  do {
    const entries = records.slice(offset, offset + 9);
    let sheet = appendSheet(entries);
    const fits = () => sheet.querySelector('.inspection-notes').offsetTop + sheet.querySelector('.inspection-notes').offsetHeight <= sheet.querySelector('.inspection-paper').offsetTop + sheet.querySelector('.inspection-paper').offsetHeight + 1;
    if (!fits()) {
      sheet.querySelector('.inspection-records').classList.add('is-expanded');
      while (!fits() && entries.length > 1) {
        entries.pop(); sheet.remove(); sheet = appendSheet(entries);
        sheet.querySelector('.inspection-records').classList.add('is-expanded');
      }
      if (!fits()) throw new Error('입고검사 기록의 텍스트가 한 페이지에 들어가지 않습니다.');
    }
    offset += entries.length;
    let notes = entries.filter(record => record.notes?.trim()).map(record => `${record.recordDate} ${itemText(record)}: ${record.notes.trim()}`).join('\n');
    do {
      const remaining = fillNotes(sheet.querySelector('.inspection-note-content'), notes);
      if (remaining === notes && notes) throw new Error('입고검사서 특이사항을 배치할 공간이 없습니다.');
      notes = remaining; pages += 1;
      if (notes) sheet = appendSheet([], true);
    } while (notes);
  } while (offset < records.length);
  return pages;
}

export function mountIncomingJournal({ itemLabel, journalLabel, firestore }) {
  return mountProcessJournal({
    title: journalLabel, code: itemLabel, subtitle: '월을 선택하면 해당 월의 입고검사 기록을 모아 표시합니다.',
    loadSettings: async () => ({}), subscribeByRange: firestore.subscribeInspectionRecordsByRange,
    createSelector: createJournalMonthSelector, groupRecords: groupInspectionMonth,
    render: options => renderIncomingJournal({ ...options, itemLabel }),
    summarize: (records, pages) => [['총 기록', `${records.length}건`], ['출력 페이지', `${pages}장`]],
  });
}
