import { localDateValue, isoWeekKey, firstMondayDateValue } from '/dashboard/js/haccp-management-utils.js';

export function hygienePeriod(date, group) {
  if (group === 'weekly') return isoWeekKey(date);
  if (group === 'monthly') return date.slice(0, 7);
  if (group === 'annual') return date.slice(0, 4);
  return date;
}
export function hygieneRecordFor(records, date, group) {
  if (group === 'incoming') return null;
  return records.find(record => record.inspectionGroup === group && hygienePeriod(record.recordDate, group) === hygienePeriod(date, group)) || null;
}
export function hygieneSchedule(date, group, records) {
  const record = hygieneRecordFor(records, date, group);
  if (record) return { state: 'completed', label: '✓ 작성 완료', detail: `${record.recordDate.slice(5).replace('-', '/')} 기록`, record };
  if (group === 'incoming') {
    const count = records.filter(r => r.inspectionGroup === group && r.recordDate === date).length;
    return { state: 'event', label: count ? `${count}건 작성 · 추가 가능` : '입고 시 작성', detail: '입고 시' };
  }
  if (group === 'annual') return { state: 'due', label: '올해 미작성', detail: '연 1회' };
  if (!['weekly', 'monthly'].includes(group)) return { state: 'due', label: '작성 필요', detail: '매일' };
  const day = new Date(`${date}T12:00:00`);
  let due;
  if (group === 'monthly') due = firstMondayDateValue(day.getFullYear(), day.getMonth());
  else { day.setDate(day.getDate() + 5 - (day.getDay() || 7)); due = localDateValue(day); }
  return { state: date < due ? 'upcoming' : date === due ? 'due' : 'overdue', label: date < due ? '예정' : date === due ? '작성 필요' : '기한 경과 · 미작성', detail: `${due.slice(5).replace('-', '/')} ${group === 'weekly' ? '금요일' : '첫째 월요일'}` };
}

export function hygieneQueryRange(date) {
  const year = Number(date.slice(0, 4));
  return { start: localDateValue(new Date(year, 0, -6, 12)), end: localDateValue(new Date(year + 1, 0, 7, 12)) };
}
