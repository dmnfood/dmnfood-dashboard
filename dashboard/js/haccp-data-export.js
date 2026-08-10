import { collection, getDocs, orderBy, query, where } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db, requireApprovedActiveUser } from '/dashboard/js/firebase-client.js';
import { getHaccpHomeUrl, initializeHaccpHomeLinks } from '/dashboard/js/haccp-navigation.js';
import {
  EXPORT_DEFINITIONS,
  EXPORT_ORDER,
  formatKoreanDateTime,
  localDateValue,
  localMonthStartValue,
  normalizeDocuments,
} from '/dashboard/js/haccp-data-export-adapters.js';

initializeHaccpHomeLinks();

const $ = id => document.getElementById(id);
const elements = {
  startDate: $('startDate'), endDate: $('endDate'), allPeriod: $('allPeriod'), selectAll: $('selectAllDatasets'),
  query: $('queryBtn'), download: $('downloadBtn'), status: $('queryStatus'), summary: $('summaryGrid'),
};

let lastQuery = null;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

const selectedKeys = () => EXPORT_ORDER.filter(key => document.querySelector(`[data-export-dataset][value="${key}"]`)?.checked);

function setStatus(message, type = '') {
  elements.status.textContent = message;
  elements.status.className = `export-status${type ? ` ${type}` : ''}`;
}

function updateDateDisabledState() {
  elements.startDate.disabled = elements.allPeriod.checked;
  elements.endDate.disabled = elements.allPeriod.checked;
}

function setQueryControlsDisabled(disabled) {
  elements.query.disabled = disabled;
  elements.allPeriod.disabled = disabled;
  elements.selectAll.disabled = disabled;
  document.querySelectorAll('[data-export-dataset]').forEach(input => { input.disabled = disabled; });
  elements.startDate.disabled = disabled || elements.allPeriod.checked;
  elements.endDate.disabled = disabled || elements.allPeriod.checked;
}

function clearResults(message = '') {
  lastQuery = null;
  elements.download.disabled = true;
  elements.summary.innerHTML = '<div class="empty-state export-empty">조회 후 기록 건수가 표시됩니다.</div>';
  if (message) setStatus(message, 'notice');
}

function validateQuery(keys) {
  if (!keys.length) return '내보낼 일지를 하나 이상 선택해 주세요.';
  if (elements.allPeriod.checked) return '';
  if (!elements.startDate.value || !elements.endDate.value) return '조회 시작일과 종료일을 선택해 주세요.';
  if (elements.startDate.value > elements.endDate.value) return '시작일은 종료일보다 늦을 수 없습니다.';
  return '';
}

async function loadDataset(key, range) {
  const definition = EXPORT_DEFINITIONS[key];
  const reference = collection(db, definition.collection);
  const snapshot = range.allPeriod
    ? await getDocs(reference)
    : await getDocs(query(
      reference,
      where(definition.dateField, '>=', range.startDate),
      where(definition.dateField, '<=', range.endDate),
      orderBy(definition.dateField, 'asc'),
    ));
  const documents = snapshot.docs.map(document => ({ id: document.id, data: document.data() }));
  documents.sort((left, right) => {
    const dateCompare = String(left.data[definition.dateField] || '').localeCompare(String(right.data[definition.dateField] || ''));
    return dateCompare || left.id.localeCompare(right.id);
  });
  const normalized = normalizeDocuments(definition, documents);
  return { key, definition, documents, documentCount: documents.length, ...normalized };
}

function countLabel(result) {
  return result.key === 'production'
    ? `${result.documentCount}일 / ${result.rows.length}항목`
    : `${result.documentCount}건`;
}

function renderSummary(keys, results, failures) {
  elements.summary.innerHTML = keys.map(key => {
    const definition = EXPORT_DEFINITIONS[key];
    const failure = failures.find(item => item.key === key);
    if (failure) return `<article class="summary-card error"><span>${escapeHtml(definition.label)}</span><strong>조회 실패</strong></article>`;
    const result = results.get(key);
    const anomaly = result.anomalies.length ? `<small>${result.anomalies.length}개 기록 확인 필요</small>` : '';
    return `<article class="summary-card"><span>${escapeHtml(definition.label)}</span><strong>${escapeHtml(countLabel(result))}</strong>${anomaly}</article>`;
  }).join('');
}

async function runQuery() {
  const keys = selectedKeys();
  const error = validateQuery(keys);
  if (error) { setStatus(error, 'error'); return; }
  const range = {
    allPeriod: elements.allPeriod.checked,
    startDate: elements.startDate.value,
    endDate: elements.endDate.value,
  };
  lastQuery = null;
  setQueryControlsDisabled(true);
  elements.download.disabled = true;
  elements.summary.innerHTML = '<div class="empty-state export-empty">Firestore 기록을 조회하는 중입니다.</div>';
  setStatus(`${keys.length}개 일지를 조회하는 중입니다.`, 'loading');

  const settled = await Promise.allSettled(keys.map(key => loadDataset(key, range)));
  const results = new Map();
  const failures = [];
  settled.forEach((outcome, index) => {
    const key = keys[index];
    if (outcome.status === 'fulfilled') results.set(key, outcome.value);
    else failures.push({ key, error: outcome.reason });
  });

  lastQuery = { keys, range, results, complete: failures.length === 0, queriedAt: new Date() };
  renderSummary(keys, results, failures);
  setQueryControlsDisabled(false);

  if (failures.length) {
    const details = failures.map(item => {
      const error_ = item.error;
      const code = error_?.code || error_?.message || 'unknown';
      return `${EXPORT_DEFINITIONS[item.key].label} (${code})`;
    }).join(', ');
    elements.download.disabled = true;
    setStatus(`일부 조회에 실패하여 Excel 다운로드를 막았습니다: ${details}`, 'error');
    return;
  }

  const anomalyCount = [...results.values()].reduce((sum, result) => sum + result.anomalies.length, 0);
  elements.download.disabled = false;
  setStatus(anomalyCount
    ? `조회가 완료되었습니다. ${anomalyCount}개 기록은 저장 형식을 확인해 주세요.`
    : '조회가 완료되었습니다. Excel을 다운로드할 수 있습니다.', anomalyCount ? 'notice' : 'success');
}

const displayWidth = value => [...String(value ?? '')].reduce((width, character) => width + (character.charCodeAt(0) > 127 ? 2 : 1), 0);
const safeSpreadsheetValue = value => typeof value === 'string' && /^[=+\-@]/.test(value) ? `'${value}` : value;

function worksheetFromResult(result) {
  const headers = result.definition.columns.map(item => item.label);
  const values = result.rows.map(row => result.definition.columns.map(item => safeSpreadsheetValue(row[item.key] ?? '')));
  const worksheet = window.XLSX.utils.aoa_to_sheet([headers, ...values]);
  worksheet['!cols'] = headers.map((header, index) => ({
    wch: Math.min(34, Math.max(10, ...values.slice(0, 200).map(row => displayWidth(row[index]) + 2), displayWidth(header) + 2)),
  }));
  worksheet['!autofilter'] = { ref: window.XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(values.length, 0), c: headers.length - 1 } }) };
  return worksheet;
}

function buildSummaryWorksheet(exportState) {
  const rangeLabel = exportState.range.allPeriod ? '전체 기간' : `${exportState.range.startDate} ~ ${exportState.range.endDate}`;
  const rows = [
    ['들메내식품 HACCP 데이터 내보내기'],
    ['내보낸 시각', formatKoreanDateTime(new Date())],
    ['조회 기간', rangeLabel],
    [],
    ['일지', 'Firestore 컬렉션', '문서 수', '내보낸 행 수', '비고'],
    ...exportState.keys.map(key => {
      const result = exportState.results.get(key);
      return [
        result.definition.label,
        result.definition.collection,
        result.documentCount,
        result.rows.length,
        result.anomalies.length ? `${result.anomalies.length}개 기록 형식 확인 필요` : '',
      ];
    }),
  ];
  const worksheet = window.XLSX.utils.aoa_to_sheet(rows);
  worksheet['!cols'] = [{ wch: 22 }, { wch: 40 }, { wch: 12 }, { wch: 16 }, { wch: 30 }];
  worksheet['!autofilter'] = { ref: `A5:E${Math.max(5, rows.length)}` };
  return worksheet;
}

function exportWorkbook() {
  if (!lastQuery?.complete) { setStatus('먼저 선택한 조건으로 조회를 완료해 주세요.', 'error'); return; }
  if (!window.XLSX) { setStatus('Excel 라이브러리를 불러오지 못했습니다. 네트워크 연결 후 다시 시도해 주세요.', 'error'); return; }
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, buildSummaryWorksheet(lastQuery), '요약');
  lastQuery.keys.forEach(key => {
    const result = lastQuery.results.get(key);
    window.XLSX.utils.book_append_sheet(workbook, worksheetFromResult(result), result.definition.sheetName);
  });
  const today = localDateValue();
  const rawName = lastQuery.range.allPeriod
    ? `들메내_HACCP_전체_${today}.xlsx`
    : `들메내_HACCP_${lastQuery.range.startDate}_${lastQuery.range.endDate}.xlsx`;
  const fileName = rawName.replace(/[\\/:*?"<>|]/g, '_');
  window.XLSX.writeFile(workbook, fileName, { compression: true });
  setStatus(`${fileName} 다운로드를 시작했습니다.`, 'success');
}

elements.query.addEventListener('click', runQuery);
elements.download.addEventListener('click', exportWorkbook);
elements.allPeriod.addEventListener('change', () => { updateDateDisabledState(); clearResults('조회 조건이 변경되었습니다. 다시 조회해 주세요.'); });
elements.startDate.addEventListener('change', () => clearResults('조회 조건이 변경되었습니다. 다시 조회해 주세요.'));
elements.endDate.addEventListener('change', () => clearResults('조회 조건이 변경되었습니다. 다시 조회해 주세요.'));
document.querySelectorAll('[data-export-dataset]').forEach(input => input.addEventListener('change', () => {
  const inputs = [...document.querySelectorAll('[data-export-dataset]')];
  elements.selectAll.checked = inputs.every(item => item.checked);
  elements.selectAll.indeterminate = !elements.selectAll.checked && inputs.some(item => item.checked);
  clearResults('조회 대상이 변경되었습니다. 다시 조회해 주세요.');
}));
elements.selectAll.addEventListener('change', () => {
  document.querySelectorAll('[data-export-dataset]').forEach(input => { input.checked = elements.selectAll.checked; });
  elements.selectAll.indeterminate = false;
  clearResults('조회 대상이 변경되었습니다. 다시 조회해 주세요.');
});

requireApprovedActiveUser({ page: 'haccp-data-export' }).then(session => {
  if (!session) return;
  if (!['manager', 'admin'].includes(session.role)) {
    console.info('[auth] redirect', { page: 'haccp-data-export', target: getHaccpHomeUrl(), reason: 'manager-role-required' });
    window.location.replace(getHaccpHomeUrl());
    return;
  }
  elements.startDate.value = localMonthStartValue();
  elements.endDate.value = localDateValue();
  updateDateDisabledState();
  clearResults();
  $('loadingScreen').classList.add('hidden');
  $('mainContent').classList.remove('auth-hidden');
});
