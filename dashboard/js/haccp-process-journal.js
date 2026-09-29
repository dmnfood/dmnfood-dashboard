import { escapeHtml } from '/dashboard/js/haccp-form-common.js';

const text = value => escapeHtml(String(value ?? ''));
const timeOf = record => record.checkedTime || record.measuredTime || '';
const sortRecords = records => [...records].sort((a, b) => timeOf(a).localeCompare(timeOf(b)) || String(a.id || '').localeCompare(String(b.id || '')));
const judgment = record => `<span class="journal-judgment-option${record?.judgment === 'PASS' ? ' is-selected' : ''}">○</span> / <span class="journal-judgment-option${record?.judgment === 'FAIL' ? ' is-selected' : ''}">×</span>`;
const header = (code, title) => `<table class="process-header"><colgroup><col><col style="width:6mm"><col style="width:24mm"><col style="width:25mm"></colgroup><tbody><tr><td rowspan="2" class="process-title">중요관리점(${code}) 모니터링일지<small>[${title}]</small></td><td rowspan="2" class="process-approval">결<br>재</td><td>작성</td><td>승인</td></tr><tr><td></td><td></td></tr></tbody></table>`;
const info = (date, inspectors) => `<table class="process-info"><colgroup><col style="width:12%"><col style="width:36%"><col style="width:12%"><col></colgroup><tbody><tr><th>작성일자</th><td>${text(date)}</td><th>점검자</th><td>${inspectors}</td></tr></tbody></table>`;

// Keep the original paper geometry. Long entries are preserved on explicitly
// referenced continuation sheets instead of shrinking text or silently clipping it.
function field(value, label, additions, maxLength = 70) {
  const content = String(value ?? '');
  if (content.length <= maxLength && content.split('\n').length <= 4) return text(content);
  const number = additions.push({ label, content });
  return `별지 ${number} 참조`;
}
function corrective(records, additions, sourcePage, bottle = false) {
  const failed = records.filter(record => record.judgment === 'FAIL');
  const labels = [bottle ? '이탈내용' : '한계기준 이탈내용', '개선조치 및 결과', '조치자', '확인'];
  const keys = ['deviationDetail', 'correctiveActionResult', 'actionBy', 'verifiedBy'];
  const values = keys.map((key, i) => field(failed.map(record => `[${timeOf(record)}] ${record[key] || ''}`).join('\n'), `${sourcePage}쪽 ${labels[i]}`, additions, i < 2 ? 85 : 25));
  return `<table class="process-corrective"><colgroup>${(bottle ? [31,31,11,27] : [41,33,12,14]).map(width => `<col style="width:${width}%">`).join('')}</colgroup><thead><tr>${labels.map(label => `<th>${label}</th>`).join('')}</tr></thead><tbody><tr>${values.map(value => `<td>${value}</td>`).join('')}</tr></tbody></table>`;
}
function pageInfo(date, records, additions, page) {
  const inspectors = [...new Set(records.map(record => record.inspectorName).filter(Boolean))].join(', ');
  return info(date, field(inspectors, `${page}쪽 점검자`, additions, 32));
}
function notes(records, additions, page) {
  records.filter(record => record.notes).forEach(record => additions.push({ label: `${page}쪽 ${timeOf(record)} 비고`, content: record.notes }));
}

function filteringSheet(records, date, settings, additions, page) {
  const rows = Array.from({ length: 6 }, (_, i) => {
    const record = records[i];
    const context = `${page}쪽 ${timeOf(record || {})}`;
    return `<tr><td>${field(record?.productName, `${context} 품명`, additions, 24)}</td><td>${text(record?.checkedTime || ':')}</td><td>${record?.filterMeshDamaged === true ? '파손 있음' : record?.filterMeshDamaged === false ? '파손 없음' : ''}</td><td>${text(record?.pressurePsi)}${record ? ' ' : ''}psi</td><td>${field(record?.foreignMaterialDescription, `${context} 걸러진 이물 종류 및 크기`, additions, 45)}</td><td class="judgment">${judgment(record)}</td><td></td></tr>`;
  }).join('');
  notes(records, additions, page);
  return `<section class="journal-sheet sheet-page"><div class="process-paper process-filtering">
    ${header('CCP-2', '여과 공정')}${pageInfo(date, records, additions, page)}
    <table class="process-criteria"><colgroup><col style="width:12%"><col><col><col></colgroup><tbody><tr><th rowspan="2">한계기준</th><th>여과망</th><th>Cartridge Filter</th><th>여과 압력</th></tr><tr><td>${text(settings.meshSpecification)}</td><td>${text(settings.cartridgeFilterSpecification)}</td><td>${text(settings.pressureLimitMpa)}MPa</td></tr></tbody></table>
    <table><colgroup><col style="width:12%"><col><col></colgroup><tbody><tr><th rowspan="2">주　기</th><td>여과망, Cartridge Filter 크기 확인</td><td>여과망 파손 유무 확인, 압력 ${text(settings.pressureLimitMpa)}MPa 이상 시</td></tr><tr><td>여과망, Cartridge Filter 설치 시</td><td>작업시작 전 / 작업 종료 후</td></tr></tbody></table>
    <table class="process-instruction"><colgroup><col style="width:12%"><col></colgroup><tbody><tr><th>방　법</th><td>○ 여과망의 파손이 발견된 경우 파손이 없는 정상 여과망으로 교체한다.</td></tr></tbody></table>
    <table class="process-records"><colgroup>${[12,17.5,12.5,14,14,12.5,17.5].map(width => `<col style="width:${width}%">`).join('')}</colgroup><thead><tr><th>품　명</th><th>확인시간</th><th>여과망<br>파손유무</th><th>압력</th><th>걸러진 이물<br>종류 및 크기</th><th>판　정<br>(적합/부적합)</th><th>서 명</th></tr></thead><tbody>${rows}</tbody></table>
    <table class="process-instruction"><colgroup><col style="width:12%"><col></colgroup><tbody><tr><th>개선조치<br>방법</th><td>○ 작업 공정 중이나 작업 종료 후에 여과망 파손이 발견된 경우 이미 걸러진 참기름을 회수하여 새로 설치한 정상 여과망을 이용하여 재 여과를 실시한다.</td></tr></tbody></table>
    ${corrective(records, additions, page)}
  </div></section>`;
}

const originalContainers = [180,250,300,350].map(volume => ({ material:'glass', volume })).concat([{ material:'pet', volume:1000 }, { material:'pet', volume:1800 }]);
const containerKey = (material, volume) => `${material}:${Number(volume)}`;
const volumeLabel = volume => Number(volume) >= 1000 ? `${Number(volume)/1000}L` : `${volume}<br>ml`;
function bottleSheet(slots, date, settings, additions, page) {
  const records = slots.map(slot => slot.record).filter(Boolean);
  const rows = slots.map((slot, i) => {
    const record = slot.record;
    const material = slot.material === 'glass' ? '유리병' : slot.material === 'pet' ? 'PET' : slot.material;
    const first = i === 0 || slots[i-1].material !== slot.material;
    const span = slots.slice(i).findIndex(next => next.material !== slot.material);
    return `<tr>${first ? `<td rowspan="${span < 0 ? slots.length-i : span}" class="process-material">${text(material)}</td>` : ''}<td>${volumeLabel(slot.volume)}</td><td>${text(record?.measuredTime || ':')}</td><td>${text(record?.pressureMpa)}${record ? ' ' : ''}MPa</td><td>${record ? `${text(record.washDurationSec)}초` : ''}</td><td>${record ? `${text(record.washedQuantity)}개` : ''}</td><td class="judgment">${judgment(record)}</td><td></td></tr>`;
  }).join('');
  notes(records, additions, page);
  return `<section class="journal-sheet sheet-page"><div class="process-paper process-bottle" style="--process-record-count:${slots.length}">
    ${header('CCP-3', '세병 공정')}${pageInfo(date, records, additions, page)}
    <table class="process-criteria"><colgroup><col style="width:10.5%"><col style="width:14%"><col style="width:31%"><col></colgroup><tbody><tr><th rowspan="2">한계기준</th><th class="process-diagonal"><svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path d="M0 0 L100 30" fill="none" stroke="black" stroke-width="0.7"/></svg></th><th>압력</th><th>시간</th></tr><tr><td>유리병,<br>PET 등</td><td>${text(settings.minPressureMpa)}MPa 이상</td><td>${text(settings.minDurationSec)}초 이상</td></tr></tbody></table>
    <table><colgroup><col style="width:10.5%"><col></colgroup><tbody><tr><th>주　기</th><td>작업 시작 전/후, 2시간마다</td></tr></tbody></table>
    <table class="process-instruction"><colgroup><col style="width:10.5%"><col></colgroup><tbody><tr><th>방　법</th><td>○ 압력 : 압축기의 압력계 확인<br>○ 시간 : 타이머로 확인</td></tr></tbody></table>
    <table class="process-records"><colgroup>${[5.25,5.25,13.5,16.25,16.25,16.25,12,15.25].map(width => `<col style="width:${width}%">`).join('')}</colgroup><thead><tr><th colspan="2">품명</th><th>측정시각</th><th>압력수치</th><th>시간</th><th>세병완료수</th><th>판정</th><th>서명</th></tr></thead><tbody>${rows}</tbody></table>
    <table class="process-instruction"><colgroup><col style="width:10.5%"><col></colgroup><tbody><tr><th>개선조치<br>방법</th><td>○ 기준 이탈 시 재세병 실시<br>○ 압력이 기준 이탈인 경우 일정시간 압력이 정상범위로 올라간 후 재세병 실시<br>○ 세병시간이 짧은 경우 기준 이상으로 세병할 수 있도록 개선</td></tr></tbody></table>
    ${corrective(records, additions, page, true)}
  </div></section>`;
}

function appendContinuations(container, additions, code, title, date) {
  let body;
  const newPage = () => {
    const sheet = document.createElement('section');
    sheet.className = 'journal-sheet sheet-page';
    sheet.innerHTML = `<div class="journal-addendum"><h2>${code} ${text(title)} 상세 기록 (별지)</h2><p>작성일자: ${text(date)}</p><div class="journal-addendum-body"></div></div>`;
    container.append(sheet);
    body = sheet.querySelector('.journal-addendum-body');
  };
  additions.forEach(({label, content}, index) => {
    let remaining = String(content);
    let continued = false;
    while (remaining.length) {
      if (!body) newPage();
      const block = document.createElement('section');
      const heading = document.createElement('h3');
      heading.textContent = `별지 ${index+1} · ${label}${continued ? ' (계속)' : ''}`;
      const paragraph = document.createElement('p');
      paragraph.textContent = remaining;
      block.append(heading, paragraph); body.append(block);
      if (body.scrollHeight <= body.clientHeight + 1) break;
      if (body.children.length > 1) { block.remove(); newPage(); continue; }
      let low = 0, high = remaining.length;
      while (low < high) {
        const middle = Math.ceil((low + high)/2);
        paragraph.textContent = remaining.slice(0, middle);
        if (body.scrollHeight <= body.clientHeight + 1) low = middle;
        else high = middle - 1;
      }
      if (!low) throw new Error('Journal continuation page has no available space');
      paragraph.textContent = remaining.slice(0, low);
      remaining = remaining.slice(low); continued = true; newPage();
    }
  });
}

export function renderFilteringJournal({ container, date, records, settings }) {
  const sorted = sortRecords(records), additions = [];
  container.innerHTML = Array.from({length:Math.max(1, Math.ceil(sorted.length/6))}, (_, index) => filteringSheet(sorted.slice(index*6,index*6+6), date, settings, additions, index+1)).join('');
  appendContinuations(container, additions, 'CCP-2', '여과 공정', date);
  return container.querySelectorAll('.journal-sheet').length;
}

export function renderBottleWashingJournal({ container, date, records, settings }) {
  const sorted = sortRecords(records), additions = [], groups = new Map();
  const containers = [...originalContainers];
  sorted.forEach(record => {
    const key = containerKey(record.containerMaterial, record.containerVolumeMl);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
    if (!containers.some(item => containerKey(item.material,item.volume) === key)) containers.push({material:record.containerMaterial,volume:Number(record.containerVolumeMl)});
  });
  containers.sort((a,b) => a.material.localeCompare(b.material) || a.volume-b.volume);
  const count = Math.max(1,...[...groups.values()].map(group => group.length));
  container.innerHTML = Array.from({length:count}, (_, index) => bottleSheet(containers.map(item => ({...item,record:groups.get(containerKey(item.material,item.volume))?.[index]})), date, settings, additions, index+1)).join('');
  appendContinuations(container, additions, 'CCP-3', '세병 공정', date);
  return container.querySelectorAll('.journal-sheet').length;
}
