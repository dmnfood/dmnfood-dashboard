export function journalMonthRange(year, month) {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  return { mode: 'month', start: `${prefix}-01`, end: `${prefix}-${new Date(year, month, 0).getDate()}` };
}

export function createJournalMonthSelector(container, onChange) {
  const today = new Date();
  let year = today.getFullYear(), month = today.getMonth() + 1;
  const getSelection = () => journalMonthRange(year, month);
  container.innerHTML = `<div class="journal-calendar-heading"><button type="button" data-year="-1" aria-label="이전 연도">‹</button><span aria-live="polite"></span><button type="button" data-year="1" aria-label="다음 연도">›</button></div><div class="journal-month-grid" role="group" aria-label="조회 월 선택">${Array.from({length:12}, (_, i) => `<button type="button" data-month="${i+1}">${i+1}월</button>`).join('')}</div>`;
  const draw = () => {
    container.querySelector('span').textContent = `${year}년`;
    container.querySelectorAll('[data-month]').forEach(button => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.month) === month));
      button.setAttribute('aria-label', `${year}년 ${button.dataset.month}월`);
    });
  };
  container.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.year) year = Math.min(9999, Math.max(1000, year + Number(button.dataset.year)));
    else month = Number(button.dataset.month);
    draw(); onChange(getSelection());
  });
  draw();
  return { getSelection };
}
