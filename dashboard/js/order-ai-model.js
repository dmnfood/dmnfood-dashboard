import { getOrderAiTextRows, validOrderAiTextRange } from './order-text-source-model.js';
/* Pure analysis validation. Source files are data; no model output authorizes a sale. */
export const ORDER_AI_PRODUCTS = Object.freeze([
    ['oil-kr-500ml', '국산 참기름 500ml', 'oil', 'kr', '500ml'],
    ['oil-kr-1l', '국산 참기름 1L', 'oil', 'kr', '1L'],
    ['oil-kr-1_8l', '국산 참기름 1.8L', 'oil', 'kr', '1.8L'],
    ['oil-cn-1l', '중국산 참기름 1L', 'oil', 'cn', '1L'],
    ['oil-cn-1_8l', '중국산 참기름 1.8L', 'oil', 'cn', '1.8L'],
    ['sesame-kr-1kg', '국산 볶음통깨 1kg', 'sesame', 'kr', '1kg'],
    ['sesame-kr-peeled-1kg', '국산 볶음통깨_거피 1kg', 'sesame', 'kr', '1kg'],
    ['sesame-cn-1kg', '중국산 볶음통깨 1kg', 'sesame', 'cn', '1kg'],
    ['sesame-cn-peeled-1kg', '중국산 볶음통깨_거피 1kg', 'sesame', 'cn', '1kg'],
    ['sesame-kr-black-1kg', '국산 볶음통깨_흑임자 1kg', 'sesame', 'kr', '1kg'],
    ['sesame-cn-black-1kg', '중국산 볶음통깨_흑임자 1kg', 'sesame', 'cn', '1kg']
].map(([id, label, kind, origin, size]) => Object.freeze({ id, label, kind, origin, size,
    units: Object.freeze(kind === 'oil' ? ['병', '개', 'EA'] : ['봉', '개', 'EA']) })));

const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const string = { type: 'string' }, integer = { type: 'integer' };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const array = items => ({ type: 'array', items });
export const ORDER_AI_RESPONSE_SCHEMA = object({
    assistantMessage: string,
    questions: array(object({ id: string, text: string, lineId: nullable(string) })),
    customerId: nullable(string),
    lines: array(object({
        id: string, productId: nullable({ type: 'string', enum: ORDER_AI_PRODUCTS.map(product => product.id) }),
        unit: nullable(string), imageQuantity: nullable(string), issues: array(string),
        source: object({ attachmentId: string, sheetIndex: nullable(integer), rowIndex: nullable(integer),
            productCells: array(string), quantityCell: nullable(string), unitCell: nullable(string),
            bbox: nullable(object({ x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } })) })
    })),
    coverage: array(object({ attachmentId: string, sheetIndex: nullable(integer), rowIndex: nullable(integer),
        disposition: { type: 'string', enum: ['included', 'excluded', 'unresolved'] }, lineIds: array(string), reason: string }))
});

export const ORDER_AI_LIMITS = Object.freeze({ sources: 8, sheets: 32, rows: 2500, cells: 20000, lines: 1000,
    questions: 100, text: 2000, quantityDecimals: 6, quantityIntegerDigits: 12 });
const PRODUCTS = new Map(ORDER_AI_PRODUCTS.map(product => [product.id, product]));
const isObject = value => value != null && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const int = (value, max = 100000) => Number.isSafeInteger(value) && value >= 0 && value < max;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const boundedText = (value, max = ORDER_AI_LIMITS.text) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const fail = message => { throw new Error(message); };
const plainText = value => boundedText(value) ? value : '';
const rowKey = (attachmentId, sheetIndex, rowIndex) => JSON.stringify([attachmentId, sheetIndex, rowIndex]);
const cellKey = (attachmentId, sheetIndex, address) => JSON.stringify([attachmentId, sheetIndex, address]);
const maxQuantity = 999999999999999999n;

/** Exact positive decimal quantities only. No rounding, implicit units, or row counts. */
export function normalizeOrderAiQuantity(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) return null;
    let text = String(value).trim();
    if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text)) text = text.replaceAll(',', '');
    if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
    let [whole, fraction = ''] = text.split('.');
    whole = whole.replace(/^0+(?=\d)/, ''); fraction = fraction.replace(/0+$/, '');
    if (whole.length > ORDER_AI_LIMITS.quantityIntegerDigits || fraction.length > ORDER_AI_LIMITS.quantityDecimals) return null;
    const scaled = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0') || '0');
    if (scaled <= 0n || scaled > maxQuantity) return null;
    return whole + (fraction ? `.${fraction}` : '');
}

export function addOrderAiQuantities(values) {
    let total = 0n;
    for (const value of values) {
        const normalized = normalizeOrderAiQuantity(value);
        if (!normalized) fail('수량을 원본과 다시 확인해 주세요.');
        const [whole, fraction = ''] = normalized.split('.');
        total += BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
        if (total > maxQuantity) fail('합산 수량이 처리 범위를 넘습니다.');
    }
    if (!values.length) fail('합산할 수량이 없습니다.');
    const whole = total / 1000000n, fraction = String(total % 1000000n).padStart(6, '0').replace(/0+$/, '');
    return String(whole) + (fraction ? `.${fraction}` : '');
}

function addressPosition(address) {
    if (typeof address !== 'string' || !/^[A-Z]{1,3}[1-9]\d{0,5}$/.test(address)) return null;
    const [, letters, digits] = /^([A-Z]+)(\d+)$/.exec(address);
    let columnIndex = 0;
    for (const letter of letters) columnIndex = columnIndex * 26 + letter.charCodeAt(0) - 64;
    const rowIndex = Number(digits) - 1; columnIndex--;
    return int(rowIndex) && int(columnIndex, 1024) ? { rowIndex, columnIndex } : null;
}
function hasCellValue(cell) { return cell.formula || (cell.value != null && String(cell.value).trim() !== '') || (cell.text != null && String(cell.text).trim() !== ''); }
function originalText(cell) { return String(cell?.text ?? cell?.value ?? ''); }
function unitText(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return /^(?:ea)$/i.test(text) ? 'EA' : text;
}
function validBox(value) {
    return sameKeys(value, ['x', 'y', 'width', 'height']) && ['x', 'y', 'width', 'height'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]))
        && value.x >= 0 && value.y >= 0 && value.width > 0 && value.height > 0
        && value.x + value.width <= 1 && value.y + value.height <= 1;
}

function indexSources(sources) {
    if (!Array.isArray(sources) || !sources.length || sources.length > ORDER_AI_LIMITS.sources) fail('분석할 원본 파일을 다시 확인해 주세요.');
    const files = new Map(), rows = new Map(), cells = new Map(), manifest = [];
    let rowCount = 0, cellCount = 0;
    for (const source of sources) {
        if (!isObject(source) || typeof source.attachmentId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(source.attachmentId)
            || files.has(source.attachmentId) || !hash(source.sha256) || !['workbook', 'image', 'text'].includes(source.kind)) fail('원본 파일 식별 정보가 올바르지 않습니다.');
        files.set(source.attachmentId, source);
        const entry = { attachmentId: source.attachmentId, sha256: source.sha256, kind: source.kind, complete: source.complete === true };
        if (boundedText(source.fileName, 255) && source.fileName.trim()) entry.fileName = source.fileName;
        if (source.kind === 'image') {
            if (!Number.isSafeInteger(source.width) || source.width <= 0 || !Number.isSafeInteger(source.height) || source.height <= 0) fail('이미지 크기를 확인할 수 없습니다.');
            entry.width = source.width; entry.height = source.height;
            rows.set(rowKey(source.attachmentId, null, null), { image: true, source });
        } else if (source.kind === 'text') {
            const textRows = getOrderAiTextRows(source.text);
            const rowValues = values => Array.isArray(values) ? values.map(row => [row.rowIndex, row.start, row.end, Array.isArray(row.tokens) ? row.tokens.map(token => [token.index, token.start, token.end, token.text]) : null]) : null;
            if (JSON.stringify(rowValues(source.rows)) !== JSON.stringify(rowValues(textRows))) fail('텍스트 원본의 행 위치가 다릅니다.');
            entry.rows = textRows.map(({ rowIndex, start, end }) => ({ rowIndex, start, end })); entry.rowCount = textRows.length;
            for (const row of textRows) {
                if (++rowCount > ORDER_AI_LIMITS.rows) fail('원본 행이 처리 범위를 넘습니다.');
                rows.set(rowKey(source.attachmentId, null, row.rowIndex), { text: true, source, row });
            }
        } else {
            if (!Array.isArray(source.sheets) || !source.sheets.length || source.sheets.length > ORDER_AI_LIMITS.sheets) fail('원본 시트를 확인할 수 없습니다.');
            const seenSheets = new Set(); entry.sheets = [];
            for (const sheet of source.sheets) {
                if (!int(sheet.sheetIndex, 32) || seenSheets.has(sheet.sheetIndex) || !boundedText(sheet.sheetName, 255) || !sheet.sheetName.trim() || !Array.isArray(sheet.rows)) fail('원본 시트 정보가 올바르지 않습니다.');
                seenSheets.add(sheet.sheetIndex);
                const range = sheet.range;
                if (range != null && (!sameKeys(range, ['s', 'e']) || !sameKeys(range.s, ['r', 'c']) || !sameKeys(range.e, ['r', 'c'])
                    || !int(range.s.r) || !int(range.e.r) || !int(range.s.c, 1024) || !int(range.e.c, 1024)
                    || range.s.r > range.e.r || range.s.c > range.e.c)) fail('원본 시트 범위를 확인할 수 없습니다.');
                let nonemptyRows = 0;
                const seenRows = new Set();
                for (const row of sheet.rows) {
                    if (!int(row.rowIndex) || seenRows.has(row.rowIndex) || !Array.isArray(row.cells)) fail('원본 행 정보가 올바르지 않습니다.');
                    seenRows.add(row.rowIndex);
                    const seenColumns = new Set();
                    for (const cell of row.cells) {
                        if (!isObject(cell) || !int(cell.columnIndex, 1024) || seenColumns.has(cell.columnIndex)) fail('원본 셀 정보가 올바르지 않습니다.');
                        seenColumns.add(cell.columnIndex);
                        if (range && (row.rowIndex < range.s.r || row.rowIndex > range.e.r || cell.columnIndex < range.s.c || cell.columnIndex > range.e.c)) fail('원본 셀과 시트 범위가 다릅니다.');
                        if (++cellCount > ORDER_AI_LIMITS.cells || (cell.text != null && !boundedText(cell.text, 32767))
                            || (cell.value != null && !['string', 'number', 'boolean'].includes(typeof cell.value))) fail('원본 셀 데이터가 처리 범위를 넘습니다.');
                        const address = columnLabel(cell.columnIndex) + (row.rowIndex + 1);
                        cells.set(cellKey(source.attachmentId, sheet.sheetIndex, address), cell);
                    }
                    if (row.cells.some(hasCellValue)) {
                        if (++rowCount > ORDER_AI_LIMITS.rows) fail('원본 행이 처리 범위를 넘습니다.');
                        rows.set(rowKey(source.attachmentId, sheet.sheetIndex, row.rowIndex), { source, sheet, row }); nonemptyRows++;
                    }
                }
                entry.sheets.push({ sheetIndex: sheet.sheetIndex, sheetName: sheet.sheetName, rowCount: nonemptyRows,
                    ...(range ? { range: { s: { ...range.s }, e: { ...range.e } } } : {}) });
            }
        }
        manifest.push(entry);
    }
    return { files, rows, cells, manifest };
}
function columnLabel(index) { let text = ''; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) text = String.fromCharCode(65 + (n - 1) % 26) + text; return text; }
function sameKeys(value, expected) {
    return isObject(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function assertOutputShape(output) {
    const customerField = isObject(output) && Object.hasOwn(output, 'customerId') ? 'customerId' : 'customerCode';
    if (!sameKeys(output, ['assistantMessage', 'questions', customerField, 'lines', 'coverage']) || !boundedText(output.assistantMessage)
        || (output[customerField] !== null && !boundedText(output[customerField], 100))
        || !Array.isArray(output.questions) || output.questions.length > ORDER_AI_LIMITS.questions
        || !Array.isArray(output.lines) || output.lines.length > ORDER_AI_LIMITS.lines
        || !Array.isArray(output.coverage) || output.coverage.length > ORDER_AI_LIMITS.rows + ORDER_AI_LIMITS.sources) fail('분석 응답 형식을 확인할 수 없습니다. 다시 분석해 주세요.');
    const ids = new Set();
    for (const question of output.questions) {
        if (!sameKeys(question, ['id', 'text', 'lineId']) || !id(question.id) || ids.has(question.id) || !boundedText(question.text)
            || (question.lineId !== null && !id(question.lineId))) fail('분석 질문 형식이 올바르지 않습니다.');
        ids.add(question.id);
    }
    ids.clear();
    for (const line of output.lines) {
        if (!sameKeys(line, ['id', 'productId', 'unit', 'imageQuantity', 'issues', 'source']) || !id(line.id) || ids.has(line.id)
            || (line.productId !== null && !boundedText(line.productId, 100)) || (line.unit !== null && !boundedText(line.unit, 30))
            || (line.imageQuantity !== null && !boundedText(line.imageQuantity, 100))
            || !Array.isArray(line.issues) || line.issues.length > 20 || line.issues.some(issue => !boundedText(issue, 500))
            || !sameKeys(line.source, ['attachmentId', 'sheetIndex', 'rowIndex', 'productCells', 'quantityCell', 'unitCell', 'bbox', ...(Object.hasOwn(line.source || {}, 'textRanges') ? ['textRanges'] : [])])
            || !boundedText(line.source.attachmentId, 100)
            || (line.source.sheetIndex !== null && !int(line.source.sheetIndex, 32))
            || (line.source.rowIndex !== null && !int(line.source.rowIndex))
            || !Array.isArray(line.source.productCells) || line.source.productCells.length > 20
            || line.source.productCells.some(value => !boundedText(value, 16))
            || (line.source.quantityCell !== null && !boundedText(line.source.quantityCell, 16))
            || (line.source.unitCell !== null && !boundedText(line.source.unitCell, 16))
            || (line.source.bbox !== null && (!sameKeys(line.source.bbox, ['x', 'y', 'width', 'height'])
                || Object.values(line.source.bbox).some(value => typeof value !== 'number' || !Number.isFinite(value))))
            || Object.hasOwn(line.source, 'textRanges') && (!sameKeys(line.source.textRanges, ['product', 'quantity', 'unit'])
                || !Array.isArray(line.source.textRanges.product) || line.source.textRanges.product.length > 20
                || [...line.source.textRanges.product, line.source.textRanges.quantity, line.source.textRanges.unit].some(range => range !== null && (!sameKeys(range, ['start', 'end']) || !int(range.start) || !int(range.end) || range.start >= range.end)))) fail('분석 행 형식이 올바르지 않습니다.');
        ids.add(line.id);
    }
    for (const question of output.questions) if (question.lineId !== null && !ids.has(question.lineId)) fail('질문의 원본 행을 찾을 수 없습니다.');
}
function sourceContradictions(text, product) {
    const issues = [];
    const china = /중국산|외국산/.test(text), korea = /국산|국내산/.test(text.replace(/중국산|외국산/g, ''));
    if (china && korea) issues.push('원본에 원산지가 함께 적혀 있습니다.');
    else if ((china && product.origin !== 'cn') || (korea && product.origin !== 'kr')) issues.push('선택한 상품과 원본의 원산지가 다릅니다.');
    const oil = /참기름/.test(text), sesame = /통깨|볶음깨|흑임자|거피/.test(text);
    if (oil && sesame) issues.push('상품 종류를 원본에서 확인해 주세요.');
    else if ((oil && product.kind !== 'oil') || (sesame && product.kind !== 'sesame')) issues.push('선택한 상품과 원본의 상품 종류가 다릅니다.');
    if (product.kind === 'sesame') {
        if (/거피/.test(text) && !product.id.includes('peeled')) issues.push('원본의 거피 구분을 확인해 주세요.');
        if (/흑임자/.test(text) && !product.id.includes('black')) issues.push('원본의 흑임자 구분을 확인해 주세요.');
    }
    return issues;
}

/** Validate an untrusted model proposal against immutable, verified source data. */
export function normalizeOrderAiAnalysis({ id: analysisId, intakeId, revision, sourceHash, sources, customers, output }) {
    if (!id(analysisId) || !hash(intakeId) || !hash(sourceHash) || !Number.isSafeInteger(revision) || revision < 1) fail('분석 버전 정보를 확인할 수 없습니다.');
    assertOutputShape(output);
    const indexed = indexSources(sources), blockers = [], questions = output.questions.map(question => ({ ...question }));
    const block = (code, message, lineId = null) => blockers.push({ code, message, lineId });
    for (const source of sources) if (source.complete !== true) block('source_incomplete', '일부 원본을 읽지 못했습니다. 전체 원본을 확인해 주세요.');
    let customer = null;
    if (!Array.isArray(customers)) fail('학교급식 업체 목록을 확인할 수 없습니다.');
    const schoolSelection = Object.hasOwn(output, 'customerId');
    const matches = schoolSelection
        ? customers.filter(value => value?.source === 'school_meal' && value.id === output.customerId && value.erpCode === null)
        : customers.filter(value => value?.source !== 'school_meal' && value?.code === output.customerCode);
    if ((schoolSelection ? output.customerId : output.customerCode) !== null && matches.length === 1
        && boundedText(matches[0].name, 200) && matches[0].name.trim() && Number.isSafeInteger(matches[0].revision) && matches[0].revision > 0
        && (!schoolSelection || /^school-[a-f0-9]{24}$/.test(matches[0].id))) {
        customer = schoolSelection ? { id: matches[0].id, name: matches[0].name, revision: matches[0].revision, source: 'school_meal', erpCode: null }
            : { code: matches[0].code, name: matches[0].name, revision: matches[0].revision };
    } else block('customer_required', '학교급식 주간현황표에 등록된 업체를 선택해 주세요.');
    const usedQuantities = new Map(), usedImageEvidence = new Map(), usedTextQuantities = [];
    const lines = output.lines.map(candidate => {
        const issues = [...candidate.issues], source = candidate.source, product = PRODUCTS.get(candidate.productId);
        let quantity = null, sourceText = '', validSource = true;
        const file = indexed.files.get(source.attachmentId);
        const originalRowKey = rowKey(source.attachmentId, source.sheetIndex, source.rowIndex);
        if (!file || !indexed.rows.has(originalRowKey)) { issues.push('원본 행을 찾을 수 없습니다.'); validSource = false; }
        if (file?.kind !== 'text' && Object.hasOwn(source, 'textRanges')) { issues.push('원본 형식과 근거 위치가 다릅니다.'); validSource = false; }
        if (file?.kind === 'workbook') {
            if (!int(source.sheetIndex, 32) || !int(source.rowIndex) || source.bbox !== null || candidate.imageQuantity !== null
                || !source.productCells.length || new Set(source.productCells).size !== source.productCells.length) { issues.push('Excel 원본 위치를 확인해 주세요.'); validSource = false; }
            const readCell = (address, type) => {
                const position = addressPosition(address);
                const cell = position && position.rowIndex === source.rowIndex ? indexed.cells.get(cellKey(source.attachmentId, source.sheetIndex, address)) : null;
                if (!cell || !hasCellValue(cell)) { issues.push(`${type} 셀을 원본에서 찾을 수 없습니다.`); validSource = false; }
                return cell;
            };
            sourceText = source.productCells.map(address => originalText(readCell(address, '상품'))).join(' ');
            const quantityCell = readCell(source.quantityCell, '수량'), unitCell = readCell(source.unitCell, '단위');
            if (quantityCell?.formula && quantityCell.hasCachedValue !== true) issues.push('수식 수량의 저장된 계산값을 확인할 수 없습니다.');
            else quantity = normalizeOrderAiQuantity(quantityCell?.value);
            if (unitText(originalText(unitCell)) !== unitText(candidate.unit)) issues.push('분석 단위와 원본 단위가 다릅니다.');
            if (quantityCell && addressPosition(source.quantityCell)) {
                const key = cellKey(source.attachmentId, source.sheetIndex, source.quantityCell);
                if (usedQuantities.has(key)) { issues.push('같은 수량 셀이 중복 사용되었습니다.'); usedQuantities.get(key).push(candidate.id); }
                else usedQuantities.set(key, [candidate.id]);
            }
        } else if (file?.kind === 'text') {
            const row = indexed.rows.get(originalRowKey)?.row, ranges = source.textRanges;
            const validRange = range => row && validOrderAiTextRange(range, row);
            const productRangesValid = ranges && ranges.product.length > 0 && ranges.product.every(validRange)
                && ranges.product.reduce((count, range) => count + range.end - range.start, 0) <= ORDER_AI_LIMITS.text
                && !ranges.product.some((range, index) => ranges.product.slice(index + 1).some(other => range.start < other.end && other.start < range.end));
            if (source.sheetIndex !== null || !int(source.rowIndex) || source.bbox !== null || source.productCells.length
                || source.quantityCell !== null || source.unitCell !== null || candidate.imageQuantity !== null || !productRangesValid || !validRange(ranges.quantity) || !validRange(ranges.unit)) {
                issues.push('텍스트 원본의 상품·수량·단위 위치를 확인해 주세요.'); validSource = false;
            }
            sourceText = productRangesValid ? ranges.product.map(range => file.text.slice(range.start, range.end)).join(' ') : '';
            if (validRange(ranges?.quantity)) {
                const range = ranges.quantity, before = file.text[range.start - 1] || '', after = file.text[range.end] || '';
                if (/[0-9.,+\-\u2212\u2010-\u2015~～]/.test(before) || /[0-9.,+\-\u2212\u2010-\u2015~～]/.test(after)
                    || /[+\-\u2212\u2010-\u2015~～]\s*$/.test(file.text.slice(row.start, range.start))) issues.push('수량 숫자의 일부만 선택되었거나 증감·범위 표기가 있습니다.');
                else quantity = normalizeOrderAiQuantity(file.text.slice(range.start, range.end));
                for (const old of usedTextQuantities) if (old.attachmentId === source.attachmentId && range.start < old.end && old.start < range.end) {
                    issues.push('같은 원문 수량이 중복 사용되었습니다.'); old.lineIds.push(candidate.id);
                }
                usedTextQuantities.push({ attachmentId: source.attachmentId, ...range, lineIds: [candidate.id] });
            }
            if (validRange(ranges?.unit)) {
                const rawUnit = file.text.slice(ranges.unit.start, ranges.unit.end);
                if (unitText(rawUnit) !== unitText(candidate.unit)) issues.push('분석 단위와 원문 단위가 다릅니다.');
                if (validRange(ranges.quantity)) {
                    const q = ranges.quantity, u = ranges.unit;
                    const between = q.end <= u.start ? file.text.slice(q.end, u.start) : u.end <= q.start ? file.text.slice(u.end, q.start) : null;
                    if (between === null || !/^\s*$/.test(between)) issues.push('수량과 단위가 같은 원문 항목에 연결되었는지 확인해 주세요.');
                }
            }
        } else if (file?.kind === 'image') {
            if (source.sheetIndex !== null || source.rowIndex !== null || source.productCells.length || source.quantityCell !== null
                || source.unitCell !== null || !validBox(source.bbox)) { issues.push('이미지의 원본 위치를 확인해 주세요.'); validSource = false; }
            quantity = normalizeOrderAiQuantity(candidate.imageQuantity);
            if (validBox(source.bbox)) {
                const key = JSON.stringify([source.attachmentId, source.bbox.x, source.bbox.y, source.bbox.width, source.bbox.height]);
                if (usedImageEvidence.has(key)) usedImageEvidence.get(key).push(candidate.id);
                else usedImageEvidence.set(key, [candidate.id]);
            }
        }
        if (!product) issues.push('회사 상품을 선택해 주세요.');
        if (!quantity) issues.push('원본의 양수 수량을 확인해 주세요.');
        const unit = unitText(candidate.unit);
        if (!product || !product.units.includes(unit)) issues.push('상품의 낱개 단위를 확인해 주세요.');
        if (product) issues.push(...sourceContradictions(sourceText, product));
        for (const question of questions) if (question.lineId === candidate.id) issues.push(question.text);
        return { id: candidate.id, source: { ...source, productCells: [...source.productCells], bbox: source.bbox ? { ...source.bbox } : null,
                ...(source.textRanges ? { textRanges: { product: source.textRanges.product.map(range => ({ ...range })), quantity: source.textRanges.quantity ? { ...source.textRanges.quantity } : null, unit: source.textRanges.unit ? { ...source.textRanges.unit } : null } } : {}) },
            productId: product?.id || null, productLabel: product?.label || '상품 확인 필요', quantity, unit,
            sourceText, issues: [...new Set(issues)], blockers: [], validSource, image: file?.kind === 'image', rowKey: originalRowKey };
    });
    for (const lineIds of usedQuantities.values()) if (lineIds.length > 1) for (const lineId of lineIds) {
        const line = lines.find(value => value.id === lineId); if (!line.issues.includes('같은 수량 셀이 중복 사용되었습니다.')) line.issues.push('같은 수량 셀이 중복 사용되었습니다.');
    }
    for (const item of usedTextQuantities) if (item.lineIds.length > 1) for (const lineId of item.lineIds) {
        const line = lines.find(value => value.id === lineId); if (!line.issues.includes('같은 원문 수량이 중복 사용되었습니다.')) line.issues.push('같은 원문 수량이 중복 사용되었습니다.');
    }
    for (const lineIds of usedImageEvidence.values()) if (lineIds.length > 1) for (const lineId of lineIds) {
        lines.find(value => value.id === lineId).issues.push('이미지의 같은 원본 영역이 중복 사용되었습니다.');
    }
    const lineById = new Map(lines.map(line => [line.id, line])), coverage = [], seenRows = new Set(), exclusions = [];
    for (const record of output.coverage) {
        if (!sameKeys(record, ['attachmentId', 'sheetIndex', 'rowIndex', 'disposition', 'lineIds', 'reason'])
            || typeof record.attachmentId !== 'string' || !['included', 'excluded', 'unresolved'].includes(record.disposition)
            || !Array.isArray(record.lineIds) || record.lineIds.length > ORDER_AI_LIMITS.lines || record.lineIds.some(value => !id(value))
            || new Set(record.lineIds).size !== record.lineIds.length || !boundedText(record.reason, 500)) fail('원본 행 확인 결과가 올바르지 않습니다.');
        const key = rowKey(record.attachmentId, record.sheetIndex, record.rowIndex);
        if (!indexed.rows.has(key)) { block('coverage_source_missing', '원본에 없는 행이 분석에 포함되었습니다.'); continue; }
        if (seenRows.has(key)) { block('coverage_duplicate', '원본 행 확인 결과가 중복되었습니다.'); continue; }
        seenRows.add(key);
        const references = record.lineIds.map(lineId => lineById.get(lineId));
        const linked = lines.filter(line => line.rowKey === key);
        if (references.some(line => !line || line.rowKey !== key) || references.length !== linked.length
            || linked.some(line => !record.lineIds.includes(line.id))) block('coverage_line_mismatch', '원본 행과 분석 행의 연결을 확인해 주세요.');
        if (record.disposition === 'included' && !references.length) block('included_without_line', '포함한 원본 행에 상품 분석이 없습니다.');
        if (record.disposition === 'excluded' && (references.length || !record.reason.trim())) block('invalid_exclusion', '제외한 행의 근거를 확인해 주세요.');
        if (record.disposition === 'unresolved') block('row_unresolved', record.reason || '원본 행의 처리 여부를 확인해 주세요.');
        const copy = { ...record, lineIds: [...record.lineIds] }; coverage.push(copy);
        if (record.disposition === 'excluded') exclusions.push(copy);
    }
    for (const [key, value] of indexed.rows) if (!seenRows.has(key)) block('row_uncovered', value.image ? '이미지 전체의 발주 내용을 확인해 주세요.' : `${value.text ? '텍스트 원본' : value.sheet.sheetName} ${value.row.rowIndex + 1}행의 처리 여부가 누락되었습니다.`);
    for (const question of questions) if (question.lineId === null) block('question_unanswered', question.text);
    for (const line of lines) {
        for (const message of line.issues) { line.blockers.push(message); block('line_unresolved', message, line.id); }
        delete line.validSource; delete line.rowKey;
    }
    const grouped = new Map();
    for (const line of lines) if (!line.blockers.length) {
        const key = `${line.productId}:${line.unit}`;
        if (!grouped.has(key)) grouped.set(key, { id: `group-${line.productId}-${encodeURIComponent(line.unit)}`, productId: line.productId,
            label: line.productLabel, quantity: '0', unit: line.unit, lineIds: [], sourceRefs: [] });
        const group = grouped.get(key); group.lineIds.push(line.id); group.sourceRefs.push(line.source);
    }
    const groups = [...grouped.values()];
    for (const group of groups) {
        try { group.quantity = addOrderAiQuantities(group.lineIds.map(lineId => lineById.get(lineId).quantity)); }
        catch { block('quantity_overflow', '합산 수량이 처리 범위를 넘습니다.'); }
    }
    if (!groups.length) block('no_order_lines', '확인할 발주 상품이 없습니다.');
    return { schemaVersion: 1, id: analysisId, intakeId, revision, status: 'needs_review', assistantMessage: plainText(output.assistantMessage),
        questions, customer, lines, groups, exclusions, coverage, blockers, sources: indexed.manifest, sourceHash,
        readyForReview: blockers.length === 0 && groups.length > 0, canConfirm: false };
}

function identities(sources) {
    if (!Array.isArray(sources) || !sources.length) fail('현재 원본 파일을 다시 확인해 주세요.');
    const seen = new Set();
    return sources.map(source => {
        if (!source || typeof source.attachmentId !== 'string' || seen.has(source.attachmentId) || !hash(source.sha256)
            || !['image', 'workbook', 'text'].includes(source.kind) || source.complete !== true) fail('현재 원본 파일을 다시 확인해 주세요.');
        seen.add(source.attachmentId); return JSON.stringify([source.attachmentId, source.sha256, source.kind]);
    }).sort();
}

/** Call only on server-revalidated analysis, after an explicit human confirmation. */
export function assertOrderAiConfirmation(analysis, { revision, sourceHash, sources, customers, reviewedGroupIds, reviewedExclusions }) {
    if (!analysis || analysis.schemaVersion !== 1 || analysis.status !== 'needs_review' || !analysis.readyForReview
        || !Array.isArray(analysis.blockers) || analysis.blockers.length || !analysis.customer) fail('미확인 내용을 먼저 확인해 주세요.');
    if (analysis.revision !== revision || analysis.sourceHash !== sourceHash || !hash(sourceHash)
        || JSON.stringify(identities(analysis.sources)) !== JSON.stringify(identities(sources))) fail('원본 또는 분석이 변경되었습니다. 최신 내용을 다시 확인해 주세요.');
    const schoolSelection = analysis.customer.source === 'school_meal';
    const customer = customers?.find(value => schoolSelection ? value.source === 'school_meal' && value.id === analysis.customer.id && value.erpCode === null : value.source !== 'school_meal' && value.code === analysis.customer.code);
    if (!customer || customer.name !== analysis.customer.name || customer.revision !== analysis.customer.revision
        || (schoolSelection && analysis.customer.erpCode !== null)) fail('업체 정보가 변경되었습니다. 다시 선택해 주세요.');
    if (!Array.isArray(reviewedGroupIds) || new Set(reviewedGroupIds).size !== reviewedGroupIds.length
        || !Array.isArray(analysis.groups) || !analysis.groups.length || reviewedGroupIds.length !== analysis.groups.length
        || analysis.groups.some(group => !reviewedGroupIds.includes(group.id))) fail('모든 상품을 원본과 대조해 주세요.');
    if (analysis.exclusions?.length && reviewedExclusions !== true) fail('제외한 원본 행도 함께 확인해 주세요.');
    return true;
}
