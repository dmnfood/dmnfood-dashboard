import { CCP_GROUPS, HYGIENE_GROUPS } from '/dashboard/js/haccp-management-definitions.js';

const column = (key, label) => Object.freeze({ key, label });

const METADATA_COLUMNS = Object.freeze([
  column('createdByEmail', '작성 계정'),
  column('createdAt', '작성 시각'),
  column('updatedAt', '수정 시각'),
  column('documentId', 'Firestore 문서 ID'),
]);

const safeText = value => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '값 형식 확인 필요';
};

const numberOrBlank = value => {
  if (value === '' || value === null || value === undefined) return '';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : '';
};

const markFromBoolean = value => value === true ? 'O' : value === false ? 'X' : safeText(value);
const packagingLabel = value => ({ good: '양호', poor: '불량' }[value] || safeText(value));
const expirationLabel = value => ({ x: 'X', o: 'O' }[value] || safeText(value));
const meshDamageLabel = value => value === true ? '파손 있음' : value === false ? '파손 없음' : safeText(value);
const meshCriterionLabel = value => value === true ? '파손 없어야 함' : value === false ? '파손 허용' : safeText(value);

export const localDateValue = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const localMonthStartValue = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;

function dateFromTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value.toDate === 'function') {
    const date = value.toDate();
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
  }
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

export function formatKoreanDateTime(value) {
  const date = dateFromTimestamp(value);
  if (!date) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

const metadata = (data, documentId) => ({
  createdByEmail: safeText(data.createdByEmail),
  createdAt: formatKoreanDateTime(data.createdAt),
  updatedAt: formatKoreanDateTime(data.updatedAt),
  documentId,
});

const volumeLabel = value => Number(value) === 1000 ? '1L' : Number(value) === 1800 ? '1.8L' : value === '' || value == null ? '' : `${value}ml`;
const containerLabel = (material, volumeMl) => {
  const materialLabel = material === 'pet' ? 'PET' : material === 'glass' ? '유리병' : safeText(material);
  return [materialLabel, volumeLabel(volumeMl)].filter(Boolean).join(' ');
};

const failureReasonLabel = reasons => {
  if (!Array.isArray(reasons)) return reasons == null ? '' : '값 형식 확인 필요';
  const labels = {
    pressure_below_limit: '압력 기준 미달',
    duration_below_limit: '세병시간 기준 미달',
  };
  return reasons.map(reason => labels[reason] || safeText(reason)).join(', ');
};

const PRODUCT_LABELS = Object.freeze({ sesame_oil: '참기름', roasted_sesame: '볶음통깨' });
const SOURCE_LABELS = Object.freeze({ china: '중국산', imported: '수입산', korea: '국산', imported_sesame_powder: '수입깨분' });
const sizeLabel = (value, unit) => {
  const numeric = Number(value);
  if (numeric === 1000) return unit === 'ml' ? '1L' : unit === 'g' ? '1kg' : `${value}${safeText(unit)}`;
  if (numeric === 1800 && unit === 'ml') return '1.8L';
  return value === '' || value == null ? '' : `${value}${safeText(unit)}`;
};

const incomingColumns = Object.freeze([
  column('recordDate', '작성일'), column('itemName', '품명'), column('supplierName', '매입처'),
  column('purchaseQuantity', '매입량'), column('offOdorDetected', '이미·이취'),
  column('packagingCondition', '포장 상태'), column('temperature', '온도'),
  column('expirationCheck', '유통 기한'), column('vehicleTemperature', '운송차량온도'),
  column('testReportReceived', '시험성적서 수령'), column('grade', '등급'),
  column('writerConfirmName', '작성자/확인'), column('notes', '특이사항'), ...METADATA_COLUMNS,
]);

const incomingRow = (data, documentId) => ({
  recordDate: safeText(data.recordDate),
  itemName: safeText(data.itemName),
  supplierName: safeText(data.supplierName),
  purchaseQuantity: numberOrBlank(data.purchaseQuantity),
  offOdorDetected: markFromBoolean(data.offOdorDetected),
  packagingCondition: packagingLabel(data.packagingCondition),
  temperature: safeText(data.temperature),
  expirationCheck: expirationLabel(data.expirationCheck),
  vehicleTemperature: safeText(data.vehicleTemperature),
  testReportReceived: markFromBoolean(data.testReportReceived),
  grade: safeText(data.grade),
  writerConfirmName: safeText(data.writerConfirmName),
  notes: safeText(data.notes),
  ...metadata(data, documentId),
});

export const EXPORT_DEFINITIONS = Object.freeze({
  heating: Object.freeze({
    label: 'CCP-1 가열', sheetName: 'CCP-1 가열', collection: 'haccpHeatingRecords', dateField: 'recordDate',
    columns: Object.freeze([
      column('recordDate', '작성일'), column('measuredTime', '측정시각'), column('inspectorName', '점검자'),
      column('productName', '품명'), column('roasterNo', '볶음기'), column('setTemperature', '세팅온도(℃)'),
      column('heatingMinutes', '가열시간(분)'), column('heatingSeconds', '가열시간(초)'),
      column('heatingTotalSeconds', '가열총시간(초)'), column('productSurfaceTemperature', '제품표면온도(℃)'),
      column('judgment', '판정'), column('deviationDetail', '이탈내용'),
      column('correctiveActionResult', '개선조치 및 결과'), column('actionBy', '조치자'),
      column('verifiedBy', '확인'), column('notes', '비고'), ...METADATA_COLUMNS,
    ]),
    flattenRecord: (data, documentId) => [{
      recordDate: safeText(data.recordDate), measuredTime: safeText(data.measuredTime), inspectorName: safeText(data.inspectorName),
      productName: safeText(data.productName), roasterNo: numberOrBlank(data.roasterNo), setTemperature: numberOrBlank(data.setTemperature),
      heatingMinutes: numberOrBlank(data.heatingMinutes), heatingSeconds: numberOrBlank(data.heatingSeconds),
      heatingTotalSeconds: numberOrBlank(data.heatingTotalSeconds), productSurfaceTemperature: numberOrBlank(data.productSurfaceTemperature),
      judgment: safeText(data.judgment), deviationDetail: safeText(data.deviationDetail), correctiveActionResult: safeText(data.correctiveActionResult),
      actionBy: safeText(data.actionBy), verifiedBy: safeText(data.verifiedBy), notes: safeText(data.notes), ...metadata(data, documentId),
    }],
  }),
  filtering: Object.freeze({
    label: 'CCP-2 여과', sheetName: 'CCP-2 여과', collection: 'haccpFilteringRecords', dateField: 'recordDate',
    columns: Object.freeze([
      column('recordDate', '작성일'), column('checkedTime', '확인시각'), column('inspectorName', '점검자'),
      column('productName', '품명'), column('filterMeshDamaged', '여과망 파손 유무'), column('pressurePsi', '압력(psi)'),
      column('foreignMaterialDescription', '걸러진 이물 종류 및 크기'), column('judgment', '판정'),
      column('deviationDetail', '이탈내용'), column('correctiveActionResult', '개선조치 및 결과'),
      column('actionBy', '조치자'), column('verifiedBy', '확인'), column('notes', '비고'),
      column('pressureLimitMpa', '저장 당시 압력기준(MPa)'), column('pressureLimitPsi', '저장 당시 압력기준(psi)'),
      column('meshMustBeIntact', '저장 당시 여과망 기준'), ...METADATA_COLUMNS,
    ]),
    flattenRecord: (data, documentId) => [{
      recordDate: safeText(data.recordDate), checkedTime: safeText(data.checkedTime), inspectorName: safeText(data.inspectorName),
      productName: safeText(data.productName), filterMeshDamaged: meshDamageLabel(data.filterMeshDamaged), pressurePsi: numberOrBlank(data.pressurePsi),
      foreignMaterialDescription: safeText(data.foreignMaterialDescription), judgment: safeText(data.judgment), deviationDetail: safeText(data.deviationDetail),
      correctiveActionResult: safeText(data.correctiveActionResult), actionBy: safeText(data.actionBy), verifiedBy: safeText(data.verifiedBy),
      notes: safeText(data.notes), pressureLimitMpa: numberOrBlank(data.judgmentCriteria?.pressureLimitMpa),
      pressureLimitPsi: numberOrBlank(data.judgmentCriteria?.pressureLimitPsi), meshMustBeIntact: meshCriterionLabel(data.judgmentCriteria?.meshMustBeIntact),
      ...metadata(data, documentId),
    }],
  }),
  bottleWashing: Object.freeze({
    label: 'CCP-3 세병', sheetName: 'CCP-3 세병', collection: 'haccpBottleWashingRecords', dateField: 'recordDate',
    columns: Object.freeze([
      column('recordDate', '작성일'), column('measuredTime', '측정시각'), column('inspectorName', '점검자'),
      column('container', '세병용기'), column('pressureMpa', '압력(MPa)'), column('washDurationSec', '세병시간(초)'),
      column('washedQuantity', '세병완료수'), column('judgment', '판정'), column('failureReasons', '이탈 사유'),
      column('deviationDetail', '이탈내용'), column('correctiveActionResult', '개선조치 및 결과'),
      column('actionBy', '조치자'), column('verifiedBy', '확인'), column('notes', '비고'),
      column('minPressureMpa', '저장 당시 최소압력(MPa)'), column('minDurationSec', '저장 당시 최소시간(초)'), ...METADATA_COLUMNS,
    ]),
    flattenRecord: (data, documentId) => [{
      recordDate: safeText(data.recordDate), measuredTime: safeText(data.measuredTime), inspectorName: safeText(data.inspectorName),
      container: containerLabel(data.containerMaterial, data.containerVolumeMl), pressureMpa: numberOrBlank(data.pressureMpa),
      washDurationSec: numberOrBlank(data.washDurationSec), washedQuantity: numberOrBlank(data.washedQuantity), judgment: safeText(data.judgment),
      failureReasons: failureReasonLabel(data.failureReasons), deviationDetail: safeText(data.deviationDetail),
      correctiveActionResult: safeText(data.correctiveActionResult), actionBy: safeText(data.actionBy), verifiedBy: safeText(data.verifiedBy),
      notes: safeText(data.notes), minPressureMpa: numberOrBlank(data.judgmentCriteria?.minPressureMpa),
      minDurationSec: numberOrBlank(data.judgmentCriteria?.minDurationSec), ...metadata(data, documentId),
    }],
  }),
  rawMaterialUsage: Object.freeze({
    label: '원료 사용', sheetName: '원료 사용', collection: 'haccpRawMaterialUsageRecords', dateField: 'recordDate',
    columns: Object.freeze([
      column('recordDate', '일자'), column('chinaSesame', '중국산 참깨'), column('importedSesame', '수입산 참깨'),
      column('koreanSesame', '국산 참깨'), column('importedSesamePowderOil', '수입깨분참기름'), ...METADATA_COLUMNS,
    ]),
    anomalies: data => data.materials && typeof data.materials === 'object' && !Array.isArray(data.materials) ? [] : ['materials 맵 형식 확인 필요'],
    flattenRecord: (data, documentId) => {
      const materials = data.materials && typeof data.materials === 'object' && !Array.isArray(data.materials) ? data.materials : {};
      return [{
        recordDate: safeText(data.recordDate), chinaSesame: numberOrBlank(materials.chinaSesame), importedSesame: numberOrBlank(materials.importedSesame),
        koreanSesame: numberOrBlank(materials.koreanSesame), importedSesamePowderOil: numberOrBlank(materials.importedSesamePowderOil),
        ...metadata(data, documentId),
      }];
    },
  }),
  production: Object.freeze({
    label: '제품 생산', sheetName: '제품 생산', collection: 'haccpProductionRecords', dateField: 'recordDate',
    columns: Object.freeze([
      column('recordDate', '생산일자'), column('productType', '품목'), column('sourceCategory', '구분'),
      column('size', '규격'), column('quantity', '생산량'), ...METADATA_COLUMNS,
    ]),
    anomalies: data => Array.isArray(data.items) ? [] : ['items 배열 형식 확인 필요'],
    flattenRecord: (data, documentId) => (Array.isArray(data.items) ? data.items : []).map(item => ({
      recordDate: safeText(data.recordDate), productType: PRODUCT_LABELS[item.productType] || safeText(item.productType),
      sourceCategory: SOURCE_LABELS[item.sourceCategory] || safeText(item.sourceCategory), size: sizeLabel(item.sizeValue, item.sizeUnit),
      quantity: numberOrBlank(item.quantity), ...metadata(data, documentId),
    })),
  }),
  rawMaterialInspection: Object.freeze({
    label: '원재료 입고', sheetName: '원재료 입고', collection: 'haccpRawMaterialInspectionRecords', dateField: 'recordDate',
    columns: incomingColumns,
    flattenRecord: (data, documentId) => [incomingRow(data, documentId)],
  }),
  auxMaterialInspection: Object.freeze({
    label: '부재료 입고', sheetName: '부재료 입고', collection: 'haccpAuxMaterialInspectionRecords', dateField: 'recordDate',
    columns: incomingColumns,
    flattenRecord: (data, documentId) => [incomingRow(data, documentId)],
  }),
  ccpVerification: Object.freeze({
    label:'CCP 검증', sheetName:'CCP 검증', collection:'haccpCcpVerificationRecords', dateField:'recordDate',
    columns:Object.freeze([column('periodKey','점검월'),column('recordDate','점검일'),column('inspectorName','점검자'),column('process','공정'),column('question','검증내용'),column('answer','응답'),column('deviationDetail','이탈내용'),column('correctiveActionResult','개선조치 및 결과'),column('actionBy','조치자'),column('confirmedBy','확인'),...METADATA_COLUMNS]),
    flattenRecord:(data,documentId)=>CCP_GROUPS.flatMap(group=>group.questions.map(question=>{const answer=data.answers?.[question.key];return{periodKey:safeText(data.periodKey),recordDate:safeText(data.recordDate),inspectorName:safeText(data.inspectorName),process:group.label,question:question.text,answer:answer===true?'예':answer===false?'아니오':'',deviationDetail:safeText(data.deviationDetail),correctiveActionResult:safeText(data.correctiveActionResult),actionBy:safeText(data.actionBy),confirmedBy:safeText(data.confirmedBy),...metadata(data,documentId)}})),
  }),
  generalHygiene: Object.freeze({
    label:'일반위생/공정점검', sheetName:'일반위생 공정점검', collection:'haccpGeneralHygieneProcessRecords', dateField:'recordDate',
    columns:Object.freeze([column('recordDate','점검일'),column('inspectionGroup','점검구분'),column('cadence','주기'),column('managementGroup','관리구분'),column('question','점검내용'),column('answer','응답/값'),column('notes','특이사항'),column('correctiveActionResult','개선조치 및 결과'),column('actionBy','조치자'),column('confirmedBy','확인자'),column('inspectorName','점검자'),...METADATA_COLUMNS]),
    flattenRecord:(data,documentId)=>{const group=HYGIENE_GROUPS.find(item=>item.key===data.inspectionGroup);const base={recordDate:safeText(data.recordDate),inspectionGroup:group?.label||safeText(data.inspectionGroup),cadence:safeText(data.cadence),notes:safeText(data.notes),correctiveActionResult:safeText(data.correctiveActionResult),actionBy:safeText(data.actionBy),confirmedBy:safeText(data.confirmedBy),inspectorName:safeText(data.inspectorName),...metadata(data,documentId)};if(group?.dates)return[['검·교정','온도계 등 검·교정일',data.annualDates?.thermometer],['검·교정','CCP 모니터링 장비 검·교정일',data.annualDates?.ccpEquipment]].map(([managementGroup,question,answer])=>({...base,managementGroup,question,answer:safeText(answer)}));const rows=(group?.questions||[]).map(([managementGroup,question],index)=>({...base,managementGroup,question,answer:data.answers?.[index]===true?'예':data.answers?.[index]===false?'아니오':''}));if(group?.numeric)rows.unshift({...base,managementGroup:'방충방서',question:'포획 개체수',answer:numberOrBlank(data.capturedPestCount)});return rows;},
  }),
  compressedAir: Object.freeze({
    label:'압축공기 필터', sheetName:'압축공기 필터', collection:'haccpCompressedAirFilterRecords', dateField:'recordDate',
    columns:Object.freeze([column('managementMonth','관리월'),column('recordDate','점검일'),column('responsibleName','담당자'),column('number','번호'),column('installationLocation','설치위치'),column('purpose','용도'),column('productName','제품명'),column('specification','규격'),column('installationDate','설치일'),column('replacementCycle','교체주기'),column('replacementDate','이번달 교체일'),column('notes','비고'),...METADATA_COLUMNS]),
    flattenRecord:(data,documentId)=>(Array.isArray(data.filters)?data.filters:[]).map(filter=>({managementMonth:safeText(data.managementMonth||data.periodKey),recordDate:safeText(data.recordDate),responsibleName:safeText(data.responsibleName),number:numberOrBlank(filter.number),installationLocation:safeText(filter.installationLocation),purpose:safeText(filter.purpose),productName:safeText(filter.productName),specification:safeText(filter.specification),installationDate:safeText(filter.installationDate),replacementCycle:safeText(filter.replacementCycle),replacementDate:safeText(filter.replacementDate),notes:safeText(data.notes),...metadata(data,documentId)})),
  }),
  pestControl: Object.freeze({
    label:'방충·방서', sheetName:'방충 방서', collection:'haccpPestControlRecords', dateField:'recordDate',
    columns:Object.freeze([column('periodKey','점검주'),column('recordDate','점검일'),column('inspectorName','점검자'),column('deviceType','구분'),column('deviceNumber','번호'),column('location','설치위치'),column('fly','파리'),column('moth','나방'),column('mosquito','모기'),column('mayfly','하루살이'),column('cockroach','바퀴'),column('spider','거미'),column('ant','개미'),column('mouse','쥐'),column('other','기타'),column('total','합계'),column('deviationCause','기준이탈/원인'),column('correctiveAction','개선조치'),...METADATA_COLUMNS]),
    flattenRecord:(data,documentId)=>(Array.isArray(data.devices)?data.devices:[]).map(device=>({periodKey:safeText(data.periodKey),recordDate:safeText(data.recordDate),inspectorName:safeText(data.inspectorName),deviceType:({insect_light:'포충등',cockroach_trap:'바퀴 트랩',mouse_trap:'쥐 트랩'}[device.deviceType]||safeText(device.deviceType)),deviceNumber:numberOrBlank(device.deviceNumber),location:safeText(device.location),fly:numberOrBlank(device.counts?.['파리']),moth:numberOrBlank(device.counts?.['나방']),mosquito:numberOrBlank(device.counts?.['모기']),mayfly:numberOrBlank(device.counts?.['하루살이']),cockroach:numberOrBlank(device.counts?.['바퀴']),spider:numberOrBlank(device.counts?.['거미']),ant:numberOrBlank(device.counts?.['개미']),mouse:numberOrBlank(device.counts?.['쥐']),other:numberOrBlank(device.counts?.['기타']),total:numberOrBlank(device.total),deviationCause:safeText(data.deviationCause),correctiveAction:safeText(data.correctiveAction),...metadata(data,documentId)})),
  }),
});

export const EXPORT_ORDER = Object.freeze([
  'heating', 'filtering', 'bottleWashing', 'rawMaterialUsage', 'production', 'rawMaterialInspection', 'auxMaterialInspection',
  'ccpVerification', 'generalHygiene', 'compressedAir', 'pestControl',
]);

export function normalizeDocuments(definition, documents) {
  const rows = [];
  const anomalies = [];
  documents.forEach(document => {
    try {
      (definition.anomalies?.(document.data) || []).forEach(message => anomalies.push(`${document.id}: ${message}`));
      const recordRows = definition.flattenRecord(document.data, document.id);
      if (!Array.isArray(recordRows)) throw new Error('정규화 결과가 배열이 아닙니다.');
      recordRows.forEach(row => rows.push(Object.fromEntries(definition.columns.map(({ key }) => {
        const value = row[key];
        return [key, value && typeof value === 'object' ? '값 형식 확인 필요' : value ?? ''];
      }))));
    } catch (error) {
      anomalies.push(`${document.id}: ${error.message || '변환 실패'}`);
    }
  });
  return { rows, anomalies };
}
