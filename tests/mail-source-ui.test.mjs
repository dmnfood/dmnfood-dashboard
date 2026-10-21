import assert from 'node:assert/strict';
import test from 'node:test';
import { getMailAttachmentPolicy } from '../dashboard/js/mail-source-viewer.js';

const ordinary = { attachmentId: '101', filename: '학교급식 발주서.xls', contentType: 'application/vnd.ms-excel', size: 1200 };

test('ordinary Excel and CSV within the archive limit remain available', () => {
    for (const input of [ordinary,
        { ...ordinary, filename: '학교급식 발주서.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        { ...ordinary, filename: '학교급식 발주서.csv', contentType: 'text/plain; charset=utf-8' },
        { ...ordinary, size: 3 * 1024 * 1024, contentType: 'application/octet-stream' },
    ]) assert.equal(getMailAttachmentPolicy(input).restriction, '');
    assert.equal(getMailAttachmentPolicy(ordinary).fileName, ordinary.filename);
});

test('inline and expiring large-file sources cannot start archive downloads', () => {
    for (const input of [
        { ...ordinary, attachmentId: '-1' }, { ...ordinary, attachmentId: '0' },
        { ...ordinary, contentDisposition: 'inline' },
        { ...ordinary, bigFileFid: 'expiration-bound-id' },
        { ...ordinary, bigFileExpireTime: '2026-10-22T00:00:00Z' },
    ]) assert.match(getMailAttachmentPolicy(input).restriction, /본문 이미지·대용량/);
});

test('unsupported types, MIME mismatches, and unverified sizes have visible reasons', () => {
    assert.match(getMailAttachmentPolicy({ ...ordinary, filename: '발주서.pdf', contentType: 'application/pdf' }).restriction, /Excel/);
    assert.match(getMailAttachmentPolicy({ ...ordinary, contentType: 'image/png' }).restriction, /형식이 달라/);
    for (const size of [0, -1, NaN, 1.5, undefined]) assert.match(getMailAttachmentPolicy({ ...ordinary, size }).restriction, /크기/);
    assert.match(getMailAttachmentPolicy({ ...ordinary, size: 3 * 1024 * 1024 + 1 }).restriction, /3 MB/);
    assert.match(getMailAttachmentPolicy({ ...ordinary, filename: '발주\u0000서.xls' }).restriction, /이름/);
});
