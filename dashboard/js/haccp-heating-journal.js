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

function sheet(groups, index, date, inspectors, settings) {
  const rows = ['1', '2', '3', '4'].map(number => {
    const items = groups[number].slice(index * 4, index * 4 + 4);
    return Array.from({ length: 4 }, (_, rowIndex) => {
      const record = items[rowIndex];
      return `<tr>${rowIndex === 0 ? `<td rowspan="4">${number}</td>` : ''}<td class="product">${value(record, item => item.productName)}</td><td>${value(record, item => item.measurements?.setTemperature)}</td><td>${value(record, timeOf)}</td><td>${value(record, item => item.measurements ? `${item.measurements.heatingMinutes || ''}분 ${item.measurements.heatingSeconds || ''}초` : '')}</td><td>${value(record, item => item.measurements?.productTemperature)}</td><td>${value(record, item => item.judgement)}</td><td class="signature"></td></tr>`;
    }).join('');
  }).join('');
  const failed = sortRecords(Object.values(groups).flat()).filter(record => record.judgement === 'FAIL');
  const aggregate = key => failed.map((record, itemIndex) => `${itemIndex + 1}. [${record.measurements?.roasterNo || '-'}호 / ${timeOf(record) || '-'}] ${record[key] || ''}`).join('\n');
  return `<section class="journal-sheet sheet-page"><h1 class="journal-title">중요관리점(CCP-1) 모니터링일지<small>[가열 공정]</small></h1><div class="approval"><div>결재</div><div>작성</div><div>확인</div></div><div class="journal-meta"><div>작성일자: ${escapeHtml(date)}</div><div>작업자: ${escapeHtml(inspectors)}</div><div>페이지 ${index + 1}</div></div><div class="criteria"><div><b>제품 표면온도</b>${settings.productSurfaceTempMin}~${settings.productSurfaceTempMax}℃</div><div><b>가열시간</b>${settings.heatingMinutesTarget} ± ${settings.heatingMinutesTolerance}분</div></div><div class="method"><b>점검 주기</b> 작업 시작 후 2시간마다<br><b>점검 방법</b> 온도계로 제품 표면온도를 확인하고 타이머로 가열시간을 확인합니다. 온도계는 월 1회 검·교정이 필요합니다.</div><table class="journal-table"><thead><tr><th>볶음기 No.</th><th>품명</th><th>세팅온도</th><th>측정시각</th><th>가열시간</th><th>제품표면온도</th><th>판정</th><th>서명</th></tr></thead><tbody>${rows}</tbody></table><div class="method"><b>개선조치 방법</b><br>가열온도 및 가열시간 초과 시 제품 검사 후 이상이 없을 때 출고합니다. 기계 고장 시 생산을 중단하고 수리 후 생산을 재개합니다.</div><div class="corrective-title">한계기준 이탈 및 개선조치 기록</div><table class="corrective"><thead><tr><th>한계기준 이탈내용</th><th>개선조치 및 결과</th><th>조치자</th><th>확인</th></tr></thead><tbody><tr><td>${escapeHtml(aggregate('deviationDetail'))}</td><td>${escapeHtml(aggregate('correctiveAction'))}</td><td>${escapeHtml(aggregate('actionBy'))}</td><td>${escapeHtml(aggregate('verifiedBy'))}</td></tr></tbody></table></section>`;
}

export function renderHeatingJournal({ container, date, records, settings }) {
  const sorted = sortRecords(records);
  const groups = Object.fromEntries(['1', '2', '3', '4'].map(number => [number, sorted.filter(record => String(record.measurements?.roasterNo) === number)]));
  const sheetCount = Math.max(1, ...Object.values(groups).map(group => Math.ceil(group.length / 4)));
  const inspectors = [...new Set(sorted.map(record => record.workerName).filter(Boolean))].join(', ');
  container.innerHTML = Array.from({ length: sheetCount }, (_, index) => sheet(groups, index, date, inspectors, settings)).join('');
  return sheetCount;
}
