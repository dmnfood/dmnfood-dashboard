export const MAIL_PREPARATION_ACCOUNT = 'official@dmnfood.co.kr';
export const MAIL_PREPARATION_LIMITS = Object.freeze({ rows: 100000, columns: 1024, sheets: 32 });

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const customerCode = value => typeof value === 'string' && value.length >= 1 && value.length <= 100
    && !/[\s/\u0000-\u001f\u007f]/u.test(value) && !['.', '..'].includes(value) && !/^__.*__$/.test(value);

export function assertMailPreparationAddress(intakeId, attachmentId) {
    if (!hash(intakeId) || typeof attachmentId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(attachmentId)) {
        throw new Error('메일과 첨부 파일을 다시 선택해 주세요.');
    }
}

export function mailPreparationColumnLabel(index) {
    if (!integer(index, 0, MAIL_PREPARATION_LIMITS.columns - 1)) throw new Error('선택한 열을 확인해 주세요.');
    let number = index + 1, label = '';
    while (number > 0) { number--; label = String.fromCharCode(65 + number % 26) + label; number = Math.floor(number / 26); }
    return label;
}

export function validateMailPreparationSelection(selection) {
    const keys = ['sheetIndex', 'sheetName', 'range', 'startRow', 'endRow', 'startColumn', 'endColumn'];
    if (!exactKeys(selection, keys) || !integer(selection.sheetIndex, 0, MAIL_PREPARATION_LIMITS.sheets - 1)
        || typeof selection.sheetName !== 'string' || !selection.sheetName.trim() || selection.sheetName.length > 255
        || /[\u0000-\u001f\u007f]/.test(selection.sheetName)
        || !integer(selection.startRow, 0, MAIL_PREPARATION_LIMITS.rows - 1)
        || !integer(selection.endRow, selection.startRow, MAIL_PREPARATION_LIMITS.rows - 1)
        || !integer(selection.startColumn, 0, MAIL_PREPARATION_LIMITS.columns - 1)
        || !integer(selection.endColumn, selection.startColumn, MAIL_PREPARATION_LIMITS.columns - 1)) {
        throw new Error('원본에서 발주 범위를 다시 선택해 주세요.');
    }
    const expected = `${mailPreparationColumnLabel(selection.startColumn)}${selection.startRow + 1}:${mailPreparationColumnLabel(selection.endColumn)}${selection.endRow + 1}`;
    if (selection.range !== expected) throw new Error('선택한 셀 주소와 발주 범위가 다릅니다. 원본에서 다시 선택해 주세요.');
    return { ...selection };
}

export function validateMailPreparationCustomer(customer, { requireConfirmed = false } = {}) {
    if (!customer || !customerCode(customer.id) || customer.id !== customer.code
        || typeof customer.name !== 'string' || customer.name !== customer.name.trim() || !customer.name || customer.name.length > 200
        || /[\u0000-\u001f\u007f]/.test(customer.name) || !integer(customer.revision, 1)) {
        throw new Error('ERP 거래처 목록에서 거래처를 다시 선택해 주세요.');
    }
    if (requireConfirmed && customer.syncState !== 'confirmed') throw new Error('서버에서 확인된 ERP 거래처를 선택해 주세요.');
    return { id: customer.id, code: customer.code, name: customer.name, revision: customer.revision };
}

export function validateMailPreparationInput(input) {
    assertMailPreparationAddress(input?.intakeId, input?.attachmentId);
    if (input.account !== MAIL_PREPARATION_ACCOUNT || !hash(input.sourceHash) || !hash(input.attachmentSha256)) {
        throw new Error('원본 파일 확인 정보를 다시 불러와 주세요.');
    }
    if (!integer(input.expectedRevision, 0) || (input.expectedUpdatedAtIso != null && typeof input.expectedUpdatedAtIso !== 'string')) {
        throw new Error('저장된 작업의 최신 내용을 다시 불러와 주세요.');
    }
    return { schemaVersion: 1, intakeId: input.intakeId, attachmentId: input.attachmentId, account: input.account,
        sourceHash: input.sourceHash, attachmentSha256: input.attachmentSha256,
        customer: validateMailPreparationCustomer(input.customer, { requireConfirmed: true }),
        selection: validateMailPreparationSelection(input.selection), status: 'range_selected' };
}

export function assertMailPreparationSource(values, parent, attachment) {
    if (!parent || parent.schemaVersion !== 1 || parent.account !== values.account || parent.rawStorage?.sha256 !== values.sourceHash
        || !attachment || attachment.schemaVersion !== 1 || attachment.intakeId !== values.intakeId
        || attachment.attachmentId !== values.attachmentId || attachment.sha256 !== values.attachmentSha256) {
        throw new Error('보관된 원본과 현재 파일 정보가 다릅니다. 원본을 다시 불러와 주세요.');
    }
}

export function assertMailPreparationRevision(previous, input, toIso = () => '') {
    const revision = previous?.revision || 0;
    if (!integer(revision, 0) || revision !== input.expectedRevision) throw new Error('다른 담당자가 작업을 변경했습니다. 최신 내용을 다시 확인해 주세요.');
    if (previous && input.expectedUpdatedAtIso != null && toIso(previous.updatedAt) !== input.expectedUpdatedAtIso) {
        throw new Error('다른 담당자가 작업을 변경했습니다. 최신 내용을 다시 확인해 주세요.');
    }
    if (previous && ['intakeId', 'attachmentId', 'account', 'sourceHash', 'attachmentSha256'].some(key => previous[key] !== input[key])) {
        throw new Error('저장된 작업이 다른 원본에 연결되어 있습니다. 원본을 다시 확인해 주세요.');
    }
}
