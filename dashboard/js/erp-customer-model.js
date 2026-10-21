export const CUSTOMER_IMPORT_LIMIT = 200;

export function normalizeErpCustomer(input) {
    return { code: typeof input?.code === 'string' ? input.code.trim() : '', name: typeof input?.name === 'string' ? input.name.trim() : '' };
}
export function validateErpCustomer(input) {
    const errors = [];
    if (typeof input?.code !== 'string' || !input.code || input.code.length > 100 || input.code !== input.code.trim()
        || /[\s/\x00-\x1f\x7f]/u.test(input.code) || ['.', '..'].includes(input.code) || /^__.*__$/.test(input.code)) errors.push('거래처코드를 공백 없이 정확하게 입력해 주세요.');
    if (typeof input?.name !== 'string' || !input.name || input.name.length > 200 || input.name !== input.name.trim() || /[\x00-\x1f\x7f]/.test(input.name)) errors.push('거래처명을 정확하게 입력해 주세요.');
    return errors;
}

/** CSV is read as text throughout: numeric-looking customer codes retain zeroes. */
export function parseCustomerCsv(text, { delimiter = ',' } = {}) {
    if (typeof text !== 'string' || text.length > 3 * 1024 * 1024) throw new Error('거래처 파일을 읽을 수 없습니다.');
    if (![',', '\t'].includes(delimiter)) throw new Error('거래처 파일 구분자를 확인해 주세요.');
    const rows = []; let row = [], value = '', quoted = false, closed = false;
    text = text.replace(/^\uFEFF/, '');
    const endCell = () => { row.push(value); value = ''; closed = false; };
    const endRow = () => { endCell(); rows.push(row); row = []; if (rows.length > 1000) throw new Error('거래처 파일은 한 번에 200개씩 나누어 주세요.'); };
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) { if (c === '"') { if (text[i + 1] === '"') { value += '"'; i++; } else { quoted = false; closed = true; } } else value += c; continue; }
        if (c === delimiter) { endCell(); continue; }
        if (c === '\r' || c === '\n') { if (c === '\r' && text[i + 1] === '\n') i++; endRow(); continue; }
        if (c === '"' && !value && !closed) { quoted = true; continue; }
        if (closed || c === '"') throw new Error('CSV의 따옴표 구성을 확인해 주세요.');
        value += c;
    }
    if (quoted) throw new Error('CSV의 따옴표가 닫히지 않았습니다.');
    if (value || row.length || closed) endRow();
    return rows;
}

const HEADERS = { code: new Set(['거래처코드', '거래처 코드', 'CUST_CODE', 'CODE']), name: new Set(['거래처명', '거래처 명', 'CUST_NAME', 'NAME']) };
/** The first nonempty row is an explicit header. Never infer by position or similarity. */
export function planCustomerImport(rows, existing = []) {
    if (!Array.isArray(rows)) throw new Error('거래처 표를 읽을 수 없습니다.');
    const meaningful = rows.map((row, i) => ({ row: Array.isArray(row) ? row.map(value => typeof value === 'string' ? value.trim() : value) : [], line: i + 1 }))
        .filter(({ row }) => row.some(value => value !== '' && value != null));
    if (meaningful.length < 2) throw new Error('거래처코드·거래처명 제목과 거래처 내용을 넣어 주세요.');
    const header = meaningful[0].row;
    const codeColumns = header.map((value, i) => HEADERS.code.has(String(value).toUpperCase()) ? i : -1).filter(i => i >= 0);
    const nameColumns = header.map((value, i) => HEADERS.name.has(String(value).toUpperCase()) ? i : -1).filter(i => i >= 0);
    if (codeColumns.length !== 1 || nameColumns.length !== 1) throw new Error('첫 행에 ‘거래처코드’, ‘거래처명’ 제목을 각각 하나씩 넣어 주세요.');
    const source = meaningful.slice(1);
    if (source.length > CUSTOMER_IMPORT_LIMIT) throw new Error('거래처는 한 번에 200개까지 가져올 수 있습니다. 파일을 나누어 주세요.');
    const known = new Map(existing.map(item => [item.code, item])), seen = new Set();
    const entries = source.map(({ row, line }) => {
        const code = row[codeColumns[0]] ?? '', name = row[nameColumns[0]] ?? '';
        if (typeof code !== 'string' || typeof name !== 'string') throw new Error(`${line}행의 거래처코드와 이름은 문자로 저장해 주세요.`);
        const errors = validateErpCustomer({ code, name }); if (errors.length) throw new Error(`${line}행: ${errors.join(' ')}`);
        if (seen.has(code)) throw new Error(`${line}행: 거래처코드 ${code}가 파일 안에서 중복됩니다.`); seen.add(code);
        const previous = known.get(code);
        return { code, name, line, action: !previous ? 'create' : previous.name === name ? 'unchanged' : 'update',
            previousName: previous?.name || '', expectedRevision: previous?.revision ?? null, expectedUpdatedAtIso: previous?.updatedAtIso || '' };
    });
    return { entries, creates: entries.filter(item => item.action === 'create').length, updates: entries.filter(item => item.action === 'update').length,
        unchanged: entries.filter(item => item.action === 'unchanged').length };
}
