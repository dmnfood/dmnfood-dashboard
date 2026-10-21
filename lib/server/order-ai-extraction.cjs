'use strict';
const crypto = require('node:crypto');
const XLSX = require('../../dashboard/vendor/sheetjs/xlsx.full.min.js');
const Workbook = require('../../dashboard/js/mail-workbook-model.js');
const LIMITS = Object.freeze({ attachments: 8, bytes: 9 * 1024 * 1024, cells: 20000, rows: 2500, contextBytes: 320000, imagePixels: 16000000, images: 4 });
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
function imageDimensions(bytes, mimeType) {
    let width, height;
    if (mimeType === 'image/png') {
        if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw fail(422, 'ai_image_invalid', '캡처 이미지 형식을 확인하지 못했습니다.');
        width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    } else if (mimeType === 'image/jpeg') {
        if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) throw fail(422, 'ai_image_invalid', '캡처 이미지 형식을 확인하지 못했습니다.');
        let at = 2;
        while (at + 4 <= bytes.length) {
            if (bytes[at++] !== 255) break;
            while (bytes[at] === 255) at++;
            const marker = bytes[at++];
            if (marker === 217 || marker === 218) break;
            if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
            if (at + 2 > bytes.length) break;
            const length = bytes.readUInt16BE(at);
            if (length < 2 || at + length > bytes.length) break;
            if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
                if (length < 8) break;
                height = bytes.readUInt16BE(at + 3); width = bytes.readUInt16BE(at + 5); break;
            }
            at += length;
        }
    }
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > LIMITS.imagePixels) throw fail(422, 'ai_image_dimensions', '이미지 크기를 확인하지 못했거나 분석 범위를 넘습니다.');
    return { width, height };
}
async function extractWorkbook(bytes, fileName) {
    const input = Workbook.inputBytes(bytes), format = Workbook.sniffFormat(input, fileName);
    if (format.kind === 'xlsx') await Workbook.verifyInflatedSize(input, Workbook.inspectZip(input));
    let data = input, type = 'array';
    if (['html', 'xml', 'csv'].includes(format.kind)) {
        const head = new TextDecoder().decode(input.subarray(0, 4096));
        const declared = /(?:charset\s*=\s*["']?\s*|encoding\s*=\s*["'])([a-z\d_-]+)/i.exec(head)?.[1];
        const encoding = input[0] === 255 && input[1] === 254 ? 'utf-16le' : input[0] === 254 && input[1] === 255 ? 'utf-16be' : /^(euc-kr|ks_c_5601-1987|ksc5601|cp949|windows-949)$/i.test(declared || '') ? 'euc-kr' : 'utf-8';
        data = new TextDecoder(encoding, { fatal: true }).decode(input); type = 'string';
        if (format.kind === 'html' && (data.match(/<table\b/gi) || []).length !== 1) throw fail(422, 'ai_workbook_tables', '표가 여러 개인 파일은 누락 없이 읽을 수 있는 Excel 파일로 다시 첨부해 주세요.');
    }
    const workbook = XLSX.read(data, { type, cellFormula: true, cellHTML: false, cellNF: true, cellText: true, cellDates: false, bookVBA: true, raw: true, dense: false, WTF: true, codepage: 949 });
    const meta = Workbook.describeWorkbook(workbook, XLSX);
    if (meta.hasMacros) throw fail(422, 'ai_workbook_macros', '매크로가 포함된 파일은 분석하지 않습니다. 일반 Excel 파일로 저장해 주세요.');
    let cellCount = 0, rowCount = 0;
    const sheets = meta.sheets.map(info => {
        const sheet = workbook.Sheets[info.name], rows = new Map();
        for (const address of Object.keys(sheet)) {
            if (address.startsWith('!')) continue;
            const cell = sheet[address];
            if (!cell || (cell.v == null && !cell.f) || (cell.v === '' && !cell.f)) continue;
            const { r, c } = XLSX.utils.decode_cell(address);
            if (++cellCount > LIMITS.cells) throw fail(413, 'ai_context_too_large', '발주서 전체를 빠짐없이 분석할 수 있는 범위를 넘었습니다. 파일을 나누어 주세요.');
            if (!rows.has(r)) { if (++rowCount > LIMITS.rows) throw fail(413, 'ai_context_too_large', '발주서 전체 행이 분석 범위를 넘었습니다. 파일을 나누어 주세요.'); rows.set(r, []); }
            rows.get(r).push({ columnIndex: c, value: cell.v ?? null, text: String(cell.w ?? cell.v ?? ''), ...(cell.f ? { formula: String(cell.f), hasCachedValue: cell.v != null } : {}) });
        }
        return { sheetIndex: info.index, sheetName: info.name, hidden: Boolean(info.hidden), range: info.range, rows: [...rows].sort((a, b) => a[0] - b[0]).map(([rowIndex, cells]) => ({ rowIndex, cells: cells.sort((a, b) => a.columnIndex - b.columnIndex) })) };
    });
    return { sheets, cellCount, rowCount };
}
async function extractMailSources(mail, mailService) {
    const metadata = mail.raw?.attachments;
    if (!Array.isArray(metadata) || !metadata.length) throw fail(422, 'ai_attachment_required', '분석할 Excel 또는 캡처 첨부 파일이 없습니다.');
    if (metadata.length > LIMITS.attachments) throw fail(413, 'ai_attachment_limit', '첨부 파일이 많습니다. 발주 파일을 나누어 주세요.');
    const sources = [], images = []; let bytesTotal = 0, cellTotal = 0, rowTotal = 0;
    for (const item of metadata) {
        const result = await mailService.attachment({ intakeId: mail.id, attachmentId: String(item?.attachmentId) });
        const file = result.attachment, bytes = Buffer.from(file.contentBase64, 'base64');
        if (!file.sha256 || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256 || bytes.length !== file.byteLength) throw fail(503, 'ai_source_changed', '원본 첨부 파일의 무결성을 확인하지 못했습니다.');
        bytesTotal += bytes.length;
        if (bytesTotal > LIMITS.bytes) throw fail(413, 'ai_attachment_limit', '첨부 파일 전체 크기가 분석 범위를 넘었습니다. 파일을 나누어 주세요.');
        const common = { attachmentId: String(file.id), sha256: file.sha256, fileName: file.fileName, complete: true };
        if (['image/png', 'image/jpeg'].includes(file.mimeType)) {
            if (images.length >= LIMITS.images) throw fail(413, 'ai_image_limit', '캡처 이미지는 한 번에 네 장까지 분석할 수 있습니다.');
            sources.push({ ...common, kind: 'image', ...imageDimensions(bytes, file.mimeType) });
            rowTotal++;
            images.push({ type: 'input_image', image_url: `data:${file.mimeType};base64,${file.contentBase64}`, detail: 'high' });
        } else {
            const parsed = await extractWorkbook(bytes, file.fileName);
            cellTotal += parsed.cellCount; rowTotal += parsed.rowCount;
            sources.push({ ...common, kind: 'workbook', sheets: parsed.sheets });
        }
        if (cellTotal > LIMITS.cells || rowTotal > LIMITS.rows) throw fail(413, 'ai_context_too_large', '첨부 전체의 발주 행이 한 번에 분석할 범위를 넘었습니다. 파일을 나누어 주세요.');
        if (Buffer.byteLength(JSON.stringify(sources)) > LIMITS.contextBytes) throw fail(413, 'ai_context_too_large', '발주서 전체 내용을 빠짐없이 분석할 수 있는 범위를 넘었습니다. 파일을 나누어 주세요.');
    }
    return { sources, images };
}
module.exports = { LIMITS, imageDimensions, extractWorkbook, extractMailSources };
