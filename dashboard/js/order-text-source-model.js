/** Immutable pasted text uses UTF-16 offsets, matching browser selections and JS slice. */
export const ORDER_TEXT_SOURCE_LIMIT = 20000;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function getOrderAiTextRows(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > ORDER_TEXT_SOURCE_LIMIT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error('붙여넣은 원문을 확인해 주세요.');
    const rows = []; let rowIndex = 0;
    for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
        if (!match[0]) continue;
        const value = match[0].replace(/(?:\r\n|\r|\n)$/, ''), start = match.index, end = start + value.length;
        if (value.trim()) {
            const tokens = [...value.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?|[A-Za-z]+|병|봉|개|[가-힣]+|[^\s]/gu)].map((token, index) => ({ index, start: start + token.index, end: start + token.index + token[0].length, text: token[0] }));
            rows.push({ rowIndex, start, end, tokens });
        }
        rowIndex++;
    }
    if (!rows.length || rows.length > 2500) throw new Error('붙여넣은 원문이 처리 범위를 넘었습니다.');
    return rows;
}
export function createOrderAiTextSource({ text, sha256, channel }) {
    if (!hash(sha256) || !['kakao', 'sms'].includes(channel)) throw new Error('붙여넣은 원문의 보관 정보를 확인할 수 없습니다.');
    return { attachmentId: 'text', kind: 'text', sha256, complete: true, fileName: channel === 'kakao' ? '카카오톡 원문' : '문자 원문', text, rows: getOrderAiTextRows(text) };
}
export function validOrderAiTextRange(range, row) {
    return range && typeof range === 'object' && !Array.isArray(range) && Object.keys(range).length === 2
        && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= row.start && range.end <= row.end && range.start < range.end;
}
