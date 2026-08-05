import { escapeHtml } from '/dashboard/js/haccp-form-common.js';
import { loadHeatingSettings, subscribeHeatingRecordsByDate } from '/dashboard/js/haccp-heating-firestore.js';

const timeOf = record => record.measurements?.measuredTime || '';
const sortRecords = records => [...records].sort((a, b) => Number(a.measurements?.roasterNo) - Number(b.measurements?.roasterNo) || timeOf(a).localeCompare(timeOf(b)));
const value = (record, selector) => record ? escapeHtml(selector(record) || '') : '&nbsp;';

export async function loadHeatingJournalData(date, { onRecords, onError }) {
  const settings = await loadHeatingSettings();
  const unsubscribe = subscribeHeatingRecordsByDate(date, onRecords, onError);
  return { settings, unsubscribe };
}

export function buildHeatingJournalSummary(records, sheetCount) {
  const sorted = sortRecords(records);
  const count = roaster => sorted.filter(record => String(record.measurements?.roasterNo) === roaster).length;
  return [
    ['총 기록', `${sorted.length}건`], ['1호기', `${count('1')}건`], ['2호기', `${count('2')}건`], ['3호기', `${count('3')}건`], ['4호기', `${count('4')}건`],
    ['PASS', `${sorted.filter(record => record.judgement === 'PASS').length}건`], ['FAIL', `${sorted.filter(record => record.judgement === 'FAIL').length}건`], ['출력 페이지', `${sheetCount}장`],
  ];
}

const temperatureCriteria = settings => {
  const minimum = Number(settings.productSurfaceTempMin); const maximum = Number(settings.productSurfaceTempMax); const midpoint = (minimum + maximum) / 2; const tolerance = (maximum - minimum) / 2;
  return Number.isInteger(midpoint) && Number.isInteger(tolerance) ? `${midpoint} ± ${tolerance}℃` : `${minimum}~${maximum}℃`;
};

function sheet(groups, index, date, inspectors, settings) {
  const rows = ['1', '2', '3', '4'].map(number => {
    const items = groups[number].slice(index * 4, index * 4 + 4);
    return Array.from({ length: 4 }, (_, rowIndex) => {
      const record = items[rowIndex];
      const setTemperature = record ? value(record, item => item.measurements?.setTemperature) : escapeHtml(String(settings.roasterSetTemperatures?.[number] ?? ''));
      const judgment = record ? (record.judgement === 'PASS' ? '<b>○</b> / ×' : record.judgement === 'FAIL' ? '○ / <b>×</b>' : '') : '○ / ×';
      return `<tr><td class="product">${value(record, item => item.productName)}</td>${rowIndex === 0 ? `<td rowspan="4">${number}</td>` : ''}<td>${setTemperature}</td><td>${record ? value(record, timeOf) : ':'}</td><td>${value(record, item => item.measurements ? `${item.measurements.heatingMinutes || ''}분 ${item.measurements.heatingSeconds || ''}초` : '')}</td><td>${value(record, item => item.measurements?.productTemperature)}</td><td class="judgment ${record?.judgement === 'PASS' ? 'pass' : record?.judgement === 'FAIL' ? 'fail' : ''}">${judgment}</td><td class="signature"></td></tr>`;
    }).join('');
  }).join('');
  const failed = sortRecords(Object.values(groups).flat()).filter(record => record.judgement === 'FAIL');
  const aggregate = key => failed.map((record, itemIndex) => `${itemIndex + 1}. [${record.measurements?.roasterNo || '-'}호 / ${timeOf(record) || '-'}] ${record[key] || ''}`).join('\n');
  return `<section class="journal-sheet sheet-page"><table class="journal-form-header"><colgroup><col><col style="width:9mm"><col style="width:18mm"><col style="width:18mm"></colgroup><tbody><tr><td class="journal-form-title" rowspan="2">중요관리점(CCP-1) 모니터링일지<small>[가열 공정]</small></td><td class="journal-approval-label" rowspan="2">결재</td><td class="journal-approval-person">작성</td><td class="journal-approval-person">확인</td></tr><tr><td></td><td></td></tr></tbody></table><table class="journal-info"><tbody><tr><td class="label">작성일자</td><td style="width:38mm">${escapeHtml(date)}</td><td class="label">작업자</td><td>${escapeHtml(inspectors)}</td></tr></tbody></table><table class="journal-criteria"><tbody><tr><td class="journal-section-label" rowspan="2">한계기준</td><th>제품 표면온도</th><th>가열 시간</th></tr><tr><td>${temperatureCriteria(settings)}</td><td>${settings.heatingMinutesTarget} ± ${settings.heatingMinutesTolerance}분</td></tr></tbody></table><table class="journal-frequency"><tbody><tr><td class="journal-section-label">주기</td><td>작업 시작 후 2시간마다</td></tr></tbody></table><table class="journal-method"><tbody><tr><td class="journal-section-label">방법</td><td>① 가열온도 : 온도계 또는 적외선 온도계를 이용하여 제품 표면 온도 확인<br>② 가열시간 : 타이머를 이용하여 제품 가열시간 확인 (투입 후 가열시간 측정)<br>③ 온도계는 월 1회 검·교정 실시 필요</td></tr></tbody></table><table class="journal-records"><colgroup><col style="width:16%"><col style="width:8%"><col style="width:12%"><col style="width:13%"><col style="width:13%"><col style="width:17%"><col style="width:9%"><col style="width:12%"></colgroup><thead><tr><th>품명</th><th>볶음기<br>No.</th><th>세팅온도</th><th>측정시각</th><th>가열시간</th><th>제품표면온도</th><th>판정</th><th>서명</th></tr></thead><tbody>${rows}</tbody></table><table class="journal-guidance"><tbody><tr><td class="journal-section-label">개선조치 방법</td><td>① 가열온도 및 가열시간 초과 시 제품 검사 후 이상이 없을 때 출고<br>② 기계 고장 시 생산을 중단하고, 수리 후 제품 생산 재개<br>③ 즉각적인 수리가 불가능한 경우, 공정라인 교체 또는 별도 보관 후 수리 후 제품 생산 재개</td></tr></tbody></table><table class="journal-corrective"><colgroup><col style="width:35%"><col style="width:35%"><col style="width:15%"><col style="width:15%"></colgroup><thead><tr><th>한계기준 이탈내용</th><th>개선조치 및 결과</th><th>조치자</th><th>확인</th></tr></thead><tbody><tr><td>${escapeHtml(aggregate('deviationDetail'))}</td><td>${escapeHtml(aggregate('correctiveAction'))}</td><td>${escapeHtml(aggregate('actionBy'))}</td><td>${escapeHtml(aggregate('verifiedBy'))}</td></tr></tbody></table></section>`;
}

export function renderHeatingJournal({ container, date, records, settings }) {
  const sorted = sortRecords(records);
  const groups = Object.fromEntries(['1', '2', '3', '4'].map(number => [number, sorted.filter(record => String(record.measurements?.roasterNo) === number)]));
  const sheetCount = Math.max(1, ...Object.values(groups).map(group => Math.ceil(group.length / 4)));
  const inspectors = [...new Set(sorted.map(record => record.workerName).filter(Boolean))].join(', ');
  container.innerHTML = Array.from({ length: sheetCount }, (_, index) => sheet(groups, index, date, inspectors, settings)).join('');
  return sheetCount;
}
