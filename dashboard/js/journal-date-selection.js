import { formatDateValue } from '/dashboard/js/haccp-form-common.js';

export function isJournalDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = new Date(`${value}T12:00:00`);
  return !Number.isNaN(parsed.getTime()) && formatDateValue(parsed) === value;
}

export function journalSelectionError({ start, end }) {
  if (!isJournalDate(start) || !isJournalDate(end)) return '시작일과 종료일을 모두 선택해 주세요.';
  if (start > end) return '종료일은 시작일과 같거나 이후 날짜로 선택해 주세요.';
  return '';
}

// A single empty date can still produce a blank form. Bulk printing includes
// only recorded dates, and never mixes two dates into one paper form.
export function groupJournalDates(records, selection) {
  if (journalSelectionError(selection)) return [];
  const groups = new Map();
  if (selection.mode === 'date') groups.set(selection.start, []);
  for (const record of records) {
    const date = record.recordDate;
    if (!isJournalDate(date) || date < selection.start || date > selection.end) continue;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(record);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}

export function createJournalDateSelector(container, onChange) {
  const today = formatDateValue(new Date());
  let selected = today;
  let month = new Date(`${selected}T12:00:00`);
  month.setDate(1);
  let mode = 'date';
  let rangeInitialized = false;
  container.innerHTML = `<div class="journal-date-mode" role="group" aria-label="조회 방식">
    <button type="button" data-mode="date" aria-pressed="true">날짜</button><button type="button" data-mode="range" aria-pressed="false">기간</button>
  </div><div class="journal-calendar"><div class="journal-calendar-heading"><button type="button" data-month="-1" aria-label="이전 달">‹</button><span aria-live="polite"></span><button type="button" data-month="1" aria-label="다음 달">›</button></div>
    <div class="journal-calendar-weekdays" aria-hidden="true">${['일','월','화','수','목','금','토'].map(day => `<span>${day}</span>`).join('')}</div><div class="journal-calendar-days" role="group" aria-label="조회 날짜 선택"></div></div>
  <div class="journal-date-range" hidden><label>시작일<input type="date" data-range="start" aria-label="시작일"></label><label>종료일<input type="date" data-range="end" aria-label="종료일"></label><p>기록이 있는 날짜의 일지를 날짜순으로 함께 출력합니다.</p></div>`;
  const calendar = container.querySelector('.journal-calendar');
  const grid = container.querySelector('.journal-calendar-days');
  const range = container.querySelector('.journal-date-range');
  const start = range.querySelector('[data-range="start"]');
  const end = range.querySelector('[data-range="end"]');
  start.value = today; end.value = today;
  const getSelection = () => ({ mode, start:mode === 'date' ? selected : start.value, end:mode === 'date' ? selected : end.value });
  const change = () => onChange(getSelection());
  const draw = () => {
    container.querySelector('.journal-calendar-heading span').textContent = `${month.getFullYear()}년 ${month.getMonth()+1}월`;
    const first = new Date(month); first.setDate(1-first.getDay());
    const visibleSelected = selected.slice(0,7) === formatDateValue(month).slice(0,7);
    grid.innerHTML = Array.from({length:42}, (_, index) => {
      const day = new Date(first); day.setDate(first.getDate()+index);
      const date = formatDateValue(day), active = date === selected, currentMonth = day.getMonth() === month.getMonth();
      const tabStop = visibleSelected ? active : currentMonth && day.getDate() === 1;
      return `<button type="button" data-date="${date}" class="${currentMonth ? '' : 'outside-month'} ${date === today ? 'is-today' : ''}" tabindex="${tabStop ? '0' : '-1'}" aria-label="${date}${date === today ? ' 오늘' : ''}" aria-pressed="${active}"${date === today ? ' aria-current="date"' : ''}>${day.getDate()}</button>`;
    }).join('');
  };
  const select = date => {
    selected = date; month = new Date(`${date}T12:00:00`); month.setDate(1);
    draw(); grid.querySelector(`[data-date="${selected}"]`)?.focus(); change();
  };
  container.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
    const next = button.dataset.mode;
    if (next === mode) return;
    mode = next;
    if (mode === 'range' && !rangeInitialized) { start.value = selected; end.value = selected; rangeInitialized = true; }
    container.querySelectorAll('[data-mode]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.mode === mode)));
    calendar.hidden = mode !== 'date'; range.hidden = mode !== 'range'; change();
  }));
  container.querySelectorAll('[data-month]').forEach(button => button.addEventListener('click', () => { month.setMonth(month.getMonth()+Number(button.dataset.month)); draw(); }));
  grid.addEventListener('click', event => { const button = event.target.closest('[data-date]'); if (button) select(button.dataset.date); });
  grid.addEventListener('keydown', event => {
    const button = event.target.closest('[data-date]');
    if (!button) return;
    const offsets = { ArrowLeft:-1, ArrowRight:1, ArrowUp:-7, ArrowDown:7 };
    if (!(event.key in offsets)) return;
    event.preventDefault(); const date = new Date(`${button.dataset.date}T12:00:00`); date.setDate(date.getDate()+offsets[event.key]); select(formatDateValue(date));
  });
  start.addEventListener('change', change); end.addEventListener('change', change);
  draw();
  return { getSelection };
}
