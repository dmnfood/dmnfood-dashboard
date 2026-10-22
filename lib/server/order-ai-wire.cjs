'use strict';
// A compact provider protocol only. Persisted proposals still use the canonical
// source/cell/coverage shape and pass the existing independent normalizer.
const nullable = value => ({ anyOf: [value, { type: 'null' }] });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const array = items => ({ type: 'array', items });
const string = { type: 'string' }, integer = { type: 'integer' };
const int = (value, max) => Number.isSafeInteger(value) && value >= 0 && value < max;
const text = (value, max = 2000) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const hasValue = cell => cell?.formula || (cell?.value != null && String(cell.value).trim() !== '') || (cell?.text != null && String(cell.text).trim() !== '');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = () => { throw new Error('분석 응답의 원본 행 또는 셀 연결을 확인할 수 없습니다.'); };
const clone = value => structuredClone(value);
function cellAddress(row, column) {
    let letters = '';
    for (let n = column + 1; n; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + (n - 1) % 26) + letters;
    return letters + (row + 1);
}
function schema(products) {
    const product = nullable({ type: 'integer', enum: products.map((_, index) => index) });
    const box = nullable(object({ x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }));
    const workbookItem = object({ p: product, c: array(integer), q: nullable(integer), u: nullable(integer), x: array(string) });
    const imageItem = object({ p: product, n: nullable(string), t: nullable(string), b: box, x: array(string) });
    const tokenRange = object({ s: integer, e: integer });
    const textItem = object({ p: product, c: array(tokenRange), q: nullable(tokenRange), u: nullable(tokenRange), x: array(string) });
    return object({ assistantMessage: string,
        questions: array(object({ id: string, text: string, rowId: nullable(integer), itemIndex: nullable(integer) })), customerId: nullable(string),
        rows: array(object({ r: integer, d: { type: 'string', enum: ['included', 'excluded', 'unresolved'] }, x: string,
            l: array({ anyOf: [workbookItem, imageItem, textItem] }) })), excludedRows: array(object({ r: array(integer), x: string })) });
}
const instructions = `응답은 지정한 간결한 JSON 형식을 사용하고 설명은 한국어로 작성하세요.
sources의 Excel 행, 텍스트 행과 이미지 파일에는 서버가 rowId를 붙였습니다. rowId:null인 빈 행을 제외한 모든 rowId를 rows와 excludedRows를 합쳐 정확히 한 번씩 기록하세요. 누락하거나 중복하지 말고 원본 파일·시트·행·셀을 바꾸지 마세요.
rows의 r은 rowId, d는 included(발주), excluded(제목·소계 등), unresolved(확인 필요), x는 해당 이유, l은 그 행의 상품 목록입니다. excluded는 l이 비어 있어야 하며 x에 제외 이유가 필요합니다. included의 x는 빈 문자열이어도 됩니다.
번호만 있는 양식 행 등 같은 이유로 제외하는 행들은 excludedRows의 {r:[rowId목록],x:공통제외이유}로 묶으세요. r에는 실제로 확인한 모든 제외 행의 rowId를 하나씩 명시하며 빈 배열·추론한 범위·생략은 허용하지 않습니다. 발주 included나 확인 필요 unresolved는 묶지 말고 rows에 개별 기록하세요. 제외 행이 없으면 excludedRows:[]입니다.
상품의 p는 products 배열의 0부터 시작하는 순번이며 불명확하면 null입니다. 상품의 x는 확인할 사항의 배열입니다.
Excel 상품은 {p,c,q,u,x}입니다. c는 상품·원산지·규격의 근거 셀에 해당하는 원본 columnIndex의 배열, q는 수량 셀, u는 단위 셀의 원본 columnIndex입니다. cells 배열 안의 순번이 아닙니다. 해당 rowId와 같은 행에 실제로 존재하는 셀만 지정하고 불명확한 q/u는 null로 두세요. 수량·단위의 값을 만들거나 반환하지 마세요. 서버가 지정 셀에서 직접 읽습니다.
이미지 상품은 {p,n,t,b,x}입니다. n은 보이는 원문 수량 문자열, t는 원문 단위, b는 이미지 안의 근거 영역 {x,y,width,height}을 각각 0~1 비율로 지정합니다. 불명확하면 null입니다. 이미지에 Excel용 항목을 사용하거나 그 반대로 사용하지 마세요.
텍스트 상품은 {p,c,q,u,x}이며 Excel과 달리 c는 토큰 범위 배열, q/u는 토큰 범위 또는 null입니다. 각 범위는 {s:첫토큰index,e:마지막토큰index}이고 양 끝을 모두 포함합니다. rows의 tokens에 서버가 제공한 index를 그대로 선택하세요. 문자 위치를 세거나 숫자를 새로 만들지 마세요. c에는 상품·원산지·규격의 토큰 범위를 모두 연결하고, q에는 원문의 수량 숫자 토큰, u에는 바로 붙거나 공백으로 이어진 단위 토큰만 연결하세요. 상품 규격의 1.8L를 주문 수량으로 사용하지 마세요. 여러 상품이 한 행에 있으면 각 상품과 그 수량·단위를 각각 연결하세요. 수량이나 단위가 적혀 있지 않으면 추정하지 말고 null과 질문을 남기세요.
questions는 {id,text,rowId,itemIndex}입니다. 특정 상품에 관한 질문은 rowId와 그 행 l의 0부터 시작하는 itemIndex를 지정하세요. 행 전체의 질문은 rowId와 itemIndex:null, 일반 질문은 둘 다 null입니다. customerId는 제공한 학교급식 업체 id만 사용하며 불명확하면 null입니다.`;

function createOrderAiWire(inputSources, products) {
    if (!Array.isArray(inputSources) || !inputSources.length || inputSources.length > 8 || !Array.isArray(products) || !products.length || products.some(product => !text(product?.id, 100))) fail();
    const sources = clone(inputSources), inventory = [], files = new Set();
    let cellCount = 0;
    for (const source of sources) {
        if (!text(source?.attachmentId, 100) || !source.attachmentId || files.has(source.attachmentId) || !['workbook', 'image', 'text'].includes(source.kind)) fail();
        files.add(source.attachmentId);
        if (source.kind === 'image') {
            source.rowId = inventory.length;
            inventory.push({ kind: 'image', attachmentId: source.attachmentId, sheetIndex: null, rowIndex: null });
            continue;
        }
        if (source.kind === 'text') {
            if (!text(source.text, 20000) || !source.text.trim() || !Array.isArray(source.rows) || !source.rows.length) fail();
            const seenRows = new Set();
            for (const row of source.rows) {
                if (!int(row.rowIndex, 100000) || seenRows.has(row.rowIndex) || !int(row.start, source.text.length) || !int(row.end, source.text.length + 1)
                    || row.start >= row.end || /[\r\n]/.test(source.text.slice(row.start, row.end)) || !Array.isArray(row.tokens) || !row.tokens.length) fail();
                seenRows.add(row.rowIndex); let previousEnd = row.start;
                for (let index = 0; index < row.tokens.length; index++) {
                    const token = row.tokens[index];
                    if (!exact(token, ['index', 'start', 'end', 'text']) || token.index !== index || !Number.isSafeInteger(token.start) || !Number.isSafeInteger(token.end)
                        || token.start < previousEnd || token.end > row.end || token.start >= token.end || !text(token.text, 20000) || source.text.slice(token.start, token.end) !== token.text) fail();
                    previousEnd = token.end;
                }
                row.rowId = inventory.length;
                inventory.push({ kind: 'text', attachmentId: source.attachmentId, sheetIndex: null, rowIndex: row.rowIndex, text: source.text, tokens: clone(row.tokens) });
                row.text = source.text.slice(row.start, row.end);
                row.tokens = row.tokens.map(({ index, text }) => ({ index, text }));
            }
            continue;
        }
        if (!Array.isArray(source.sheets) || !source.sheets.length || source.sheets.length > 32) fail();
        const sheets = new Set();
        for (const sheet of source.sheets) {
            if (!int(sheet.sheetIndex, 32) || sheets.has(sheet.sheetIndex) || !Array.isArray(sheet.rows)) fail();
            sheets.add(sheet.sheetIndex); const rows = new Set();
            for (const row of sheet.rows) {
                if (!int(row.rowIndex, 100000) || rows.has(row.rowIndex) || !Array.isArray(row.cells)) fail();
                rows.add(row.rowIndex); const cells = new Map();
                for (const cell of row.cells) {
                    if (!int(cell?.columnIndex, 1024) || cells.has(cell.columnIndex) || ++cellCount > 20000 || typeof cell.value === 'number' && !Number.isFinite(cell.value)) fail();
                    cells.set(cell.columnIndex, clone(cell));
                }
                if (row.cells.some(hasValue)) {
                    row.rowId = inventory.length;
                    inventory.push({ kind: 'workbook', attachmentId: source.attachmentId, sheetIndex: sheet.sheetIndex, rowIndex: row.rowIndex, cells });
                } else row.rowId = null;
            }
        }
    }
    if (!inventory.length || inventory.length > 2500) fail();
    const productIds = products.map(product => product.id);
    function expand(output) {
        const topKeys = ['assistantMessage', 'questions', 'customerId', 'rows'];
        const grouped = output && Object.hasOwn(output, 'excludedRows');
        if (!exact(output, grouped ? [...topKeys, 'excludedRows'] : topKeys) || !text(output.assistantMessage)
            || output.customerId !== null && (!text(output.customerId, 100) || !output.customerId)
            || !Array.isArray(output.questions) || output.questions.length > 100 || !Array.isArray(output.rows) || output.rows.length > inventory.length
            || grouped && (!Array.isArray(output.excludedRows) || output.excludedRows.length > inventory.length)) fail();
        const decisions = [...output.rows];
        for (const group of grouped ? output.excludedRows : []) {
            if (!exact(group, ['r', 'x']) || !Array.isArray(group.r) || !group.r.length || group.r.length > inventory.length || !text(group.x, 500) || !group.x.trim()) fail();
            for (const rowId of group.r) {
                if (!int(rowId, inventory.length) || decisions.length >= inventory.length) fail();
                decisions.push({ r: rowId, d: 'excluded', x: group.x, l: [] });
            }
        }
        if (decisions.length !== inventory.length) fail();
        const seen = new Set(), lines = [], coverage = [], rowsById = new Map();
        for (const decision of decisions) {
            if (!exact(decision, ['r', 'd', 'x', 'l']) || !int(decision.r, inventory.length) || seen.has(decision.r)
                || !['included', 'excluded', 'unresolved'].includes(decision.d) || !text(decision.x, 500) || !Array.isArray(decision.l)
                || decision.l.length > 1000 || decision.d === 'excluded' && (decision.l.length || !decision.x.trim())) fail();
            seen.add(decision.r); rowsById.set(decision.r, decision);
            const original = inventory[decision.r], lineIds = [];
            const address = column => {
                if (column === null) return null;
                if (!int(column, 1024) || !original.cells.has(column)) fail();
                return cellAddress(original.rowIndex, column);
            };
            for (let index = 0; index < decision.l.length; index++) {
                const item = decision.l[index];
                if (!exact(item, original.kind === 'image' ? ['p', 'n', 't', 'b', 'x'] : ['p', 'c', 'q', 'u', 'x'])
                    || item.p !== null && !int(item.p, productIds.length) || !Array.isArray(item.x) || item.x.length > 20 || item.x.some(issue => !text(issue, 500))) fail();
                const id = `r${decision.r}-i${index}`; lineIds.push(id);
                let source, unit, imageQuantity;
                if (original.kind === 'workbook') {
                    if (!Array.isArray(item.c) || item.c.length > 20 || new Set(item.c).size !== item.c.length) fail();
                    const productCells = item.c.map(column => { if (column === null) fail(); return address(column); });
                    const quantityCell = address(item.q), unitCell = address(item.u), unitSource = item.u === null ? null : original.cells.get(item.u);
                    unit = unitSource ? String(unitSource.text ?? unitSource.value ?? '') : null; imageQuantity = null;
                    source = { attachmentId: original.attachmentId, sheetIndex: original.sheetIndex, rowIndex: original.rowIndex, productCells, quantityCell, unitCell, bbox: null };
                } else if (original.kind === 'text') {
                    const range = value => {
                        if (value === null) return null;
                        if (!exact(value, ['s', 'e']) || !int(value.s, original.tokens.length) || !int(value.e, original.tokens.length) || value.s > value.e) fail();
                        return { start: original.tokens[value.s].start, end: original.tokens[value.e].end };
                    };
                    if (!Array.isArray(item.c) || item.c.length > 20 || item.c.some(value => value === null)) fail();
                    const productRanges = item.c.map(range), quantityRange = range(item.q), unitRange = range(item.u);
                    if (new Set(productRanges.map(value => `${value.start}:${value.end}`)).size !== productRanges.length) fail();
                    if (productRanges.reduce((count, value) => count + value.end - value.start, 0) > 2000 || productRanges.some((value, index) => productRanges.slice(index + 1).some(other => value.start < other.end && other.start < value.end))) fail();
                    unit = unitRange ? original.text.slice(unitRange.start, unitRange.end) : null; imageQuantity = null;
                    source = { attachmentId: original.attachmentId, sheetIndex: null, rowIndex: original.rowIndex, productCells: [], quantityCell: null, unitCell: null, bbox: null,
                        textRanges: { product: productRanges, quantity: quantityRange, unit: unitRange } };
                } else {
                    if (item.n !== null && !text(item.n, 100) || item.t !== null && !text(item.t, 30)
                        || item.b !== null && (!exact(item.b, ['x', 'y', 'width', 'height']) || Object.values(item.b).some(value => typeof value !== 'number' || !Number.isFinite(value)))) fail();
                    unit = item.t; imageQuantity = item.n;
                    source = { attachmentId: original.attachmentId, sheetIndex: null, rowIndex: null, productCells: [], quantityCell: null, unitCell: null, bbox: item.b === null ? null : clone(item.b) };
                }
                lines.push({ id, productId: item.p === null ? null : productIds[item.p], unit, imageQuantity, issues: [...item.x], source });
                if (lines.length > 1000) fail();
            }
            coverage.push({ attachmentId: original.attachmentId, sheetIndex: original.sheetIndex, rowIndex: original.rowIndex, disposition: decision.d, lineIds, reason: decision.x });
        }
        if (seen.size !== inventory.length) fail();
        // Provider row order does not affect canonical provenance, IDs, or totals.
        lines.sort((a, b) => Number(a.id.split('-')[0].slice(1)) - Number(b.id.split('-')[0].slice(1)) || Number(a.id.split('i')[1]) - Number(b.id.split('i')[1]));
        const rowKey = row => JSON.stringify([row.attachmentId, row.sheetIndex, row.rowIndex]);
        const order = new Map(inventory.map((row, index) => [rowKey(row), index]));
        coverage.sort((a, b) => order.get(rowKey(a)) - order.get(rowKey(b)));
        const questionIds = new Set();
        const questions = output.questions.map(question => {
            if (!exact(question, ['id', 'text', 'rowId', 'itemIndex']) || !/^[A-Za-z0-9_-]{1,100}$/.test(question.id || '') || questionIds.has(question.id) || !text(question.text)
                || question.rowId !== null && !int(question.rowId, inventory.length) || question.rowId === null && question.itemIndex !== null) fail();
            questionIds.add(question.id);
            const items = question.rowId === null ? null : rowsById.get(question.rowId)?.l;
            if (question.itemIndex !== null && (!items || !int(question.itemIndex, items.length))) fail();
            return { id: question.id, text: question.text, lineId: question.itemIndex === null ? null : `r${question.rowId}-i${question.itemIndex}` };
        });
        return { assistantMessage: output.assistantMessage, questions, customerId: output.customerId, lines, coverage };
    }
    return { sources, schema: schema(products), instructions, expand };
}
module.exports = { createOrderAiWire };
