'use strict';
const { createHash } = require('node:crypto');
const { imageDimensions } = require('./order-ai-extraction.cjs');
const MAX_TEXT_CHARS = 20000;
const MAX_IMAGE_BYTES = 600 * 1024;
const CHANNELS = new Set(['kakao', 'sms']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ID = /^[a-f0-9]{64}$/;
const fields = ['schemaVersion', 'channel', 'scope', 'text', 'sha256', 'title', 'createdByUid', 'createdAt'];
const imageFields = ['schemaVersion', 'kind', 'channel', 'scope', 'sha256', 'title', 'fileName', 'mimeType', 'byteLength', 'contentBase64', 'createdByUid', 'createdAt'];
const SUMMARY_FIELDS = ['schemaVersion', 'kind', 'channel', 'scope', 'sha256', 'title', 'fileName', 'mimeType', 'byteLength', 'createdByUid', 'createdAt'];
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validText = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_CHARS && value.trim().length > 0
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value;
const textHash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const imageTitle = channel => channel === 'kakao' ? '카카오톡 이미지 발주' : '문자 이미지 발주';
function validImageMetadata(value) {
    return typeof value.fileName === 'string' && value.fileName.length > 0 && value.fileName.length <= 250
        && !/[\u0000-\u001f\u007f/\\]/.test(value.fileName) && Buffer.from(value.fileName, 'utf8').toString('utf8') === value.fileName
        && (value.mimeType === 'image/png' && /\.png$/i.test(value.fileName) || value.mimeType === 'image/jpeg' && /\.jpe?g$/i.test(value.fileName));
}
function readImage(value) {
    if (!validImageMetadata(value) || typeof value.contentBase64 !== 'string' || !value.contentBase64.length
        || value.contentBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || value.contentBase64.length % 4 !== 0
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.contentBase64)) throw fail(400, 'message_image_invalid', 'PNG 또는 JPEG 원본 이미지를 확인해 주세요.');
    const bytes = Buffer.from(value.contentBase64, 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== value.contentBase64) throw fail(400, 'message_image_invalid', '이미지의 원본 크기나 형식을 확인해 주세요.');
    let dimensions;
    try { dimensions = imageDimensions(bytes, value.mimeType); } catch { throw fail(400, 'message_image_invalid', '이미지의 원본 형식과 크기를 확인해 주세요.'); }
    return { bytes, ...dimensions };
}
function sourceTitle(text) {
    const line = text.split(/\r\n|\n|\r/).find(value => value.trim())?.trim() || ''; let title = '';
    for (const character of line) { if (title.length + character.length > 80) break; title += character; }
    return title;
}
function buildTextSourceId(uid, requestId) {
    if (typeof uid !== 'string' || !uid || uid.length > 128 || !UUID.test(requestId || '')) throw fail(400, 'text_source_input_invalid', '발주 접수 정보를 다시 확인해 주세요.');
    return textHash(`order-text-source:v1\u0000${uid}\u0000${requestId.toLowerCase()}`);
}
function buildTextSource(input, uid) {
    if (exact(input, ['requestId', 'channel', 'image']) && CHANNELS.has(input.channel) && exact(input.image, ['fileName', 'mimeType', 'contentBase64'])) {
        const id = buildTextSourceId(uid, input.requestId), { bytes } = readImage(input.image);
        return { id, data: { schemaVersion: 1, kind: 'image', channel: input.channel, scope: 'school_meal', sha256: textHash(bytes), title: imageTitle(input.channel),
            ...input.image, byteLength: bytes.length, createdByUid: uid } };
    }
    if (!exact(input, ['requestId', 'channel', 'text']) || !CHANNELS.has(input.channel) || !validText(input.text)) throw fail(400, 'text_source_input_invalid', '받은 경로와 발주 원문을 확인해 주세요. 원문은 20,000자까지 저장할 수 있습니다.');
    const id = buildTextSourceId(uid, input.requestId);
    return { id, data: { schemaVersion: 1, channel: input.channel, scope: 'school_meal', text: input.text, sha256: textHash(input.text), title: sourceTitle(input.text), createdByUid: uid } };
}
function validateTextSourceRecord(data) {
    const image = data?.kind === 'image';
    let validOriginal = false;
    if (image) { try { const { bytes } = readImage(data); validOriginal = data.byteLength === bytes.length && textHash(bytes) === data.sha256 && data.title === imageTitle(data.channel); } catch { /* Invalid bytes never reach AI or the original viewer. */ } }
    else validOriginal = validText(data?.text) && textHash(data.text) === data.sha256 && data.title === sourceTitle(data.text);
    if (!exact(data, image ? imageFields : fields) || data.schemaVersion !== 1 || !CHANNELS.has(data.channel) || data.scope !== 'school_meal' || !validOriginal
        || !ID.test(data.sha256 || '')
        || typeof data.createdByUid !== 'string' || !data.createdByUid || data.createdByUid.length > 128
        || typeof data.createdAt !== 'string' || !Number.isFinite(Date.parse(data.createdAt))) throw fail(503, 'text_source_invalid', '보관된 발주 원문의 무결성을 확인하지 못했습니다.');
    return data;
}
function publicTextSource(id, data, { summary = false } = {}) {
    if (!ID.test(id || '')) throw fail(503, 'text_source_invalid', '보관된 발주 원문을 확인하지 못했습니다.');
    validateTextSourceRecord(data);
    const value = { id, ...data };
    if (summary) { delete value.text; delete value.contentBase64; }
    return value;
}
function publicTextSourceSummary(id, data) {
    const image = data?.kind === 'image', keys = image ? imageFields.filter(field => field !== 'contentBase64') : fields.filter(field => field !== 'text');
    if (!ID.test(id || '') || !exact(data, keys) || data.schemaVersion !== 1 || !CHANNELS.has(data.channel) || data.scope !== 'school_meal'
        || !ID.test(data.sha256 || '') || typeof data.title !== 'string' || !data.title.trim() || data.title.length > 80
        || typeof data.createdByUid !== 'string' || !data.createdByUid || data.createdByUid.length > 128
        || typeof data.createdAt !== 'string' || !Number.isFinite(Date.parse(data.createdAt))
        || image && (!validImageMetadata(data) || !Number.isSafeInteger(data.byteLength) || data.byteLength < 1 || data.byteLength > MAX_IMAGE_BYTES || data.title !== imageTitle(data.channel))) throw fail(503, 'text_source_invalid', '보관된 발주 목록을 확인하지 못했습니다.');
    return { id, ...data };
}
function textSourceMail(source) {
    const { id, ...data } = source;
    return { id, sourceKind: data.kind === 'image' ? 'image' : 'text', sourceChannel: data.channel, subject: data.title, receivedAt: data.createdAt,
        rawStorage: { sha256: data.sha256 }, textSource: publicTextSource(id, data) };
}
module.exports = { MAX_TEXT_CHARS, MAX_IMAGE_BYTES, SUMMARY_FIELDS, textHash, sourceTitle, buildTextSourceId, buildTextSource, validateTextSourceRecord, publicTextSource, publicTextSourceSummary, textSourceMail, readImage };
