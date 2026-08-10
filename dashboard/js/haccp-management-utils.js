export const localDateValue = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
export const monthKey = date => String(date || '').slice(0,7);
export function firstMondayDateValue(year, monthIndex) {
  const firstDay = new Date(year, monthIndex, 1, 12, 0, 0);
  const offset = (8 - firstDay.getDay()) % 7;
  firstDay.setDate(firstDay.getDate() + offset);
  return localDateValue(firstDay);
}
export function monthlyScheduleStatus(year, monthIndex, hasRecord, todayValue = localDateValue()) {
  if (hasRecord) return 'completed';
  const dueValue = firstMondayDateValue(year, monthIndex);
  if (dueValue > todayValue) return 'upcoming';
  const today = new Date(`${todayValue}T12:00:00`);
  if (year === today.getFullYear() && monthIndex === today.getMonth()) return 'due';
  return 'overdue';
}
export function isoWeekKey(value) {
  const date = new Date(`${value}T12:00:00`);
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  utc.setUTCDate(utc.getUTCDate() + 4 - (utc.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  return `${utc.getUTCFullYear()}-W${String(Math.ceil((((utc-yearStart)/86400000)+1)/7)).padStart(2,'0')}`;
}
export const canManageRecord = (record, session) => record?.createdByUid === session?.user?.uid || ['manager','admin'].includes(session?.role);
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
