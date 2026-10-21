// LOOPBACK FICTIONAL FIXTURE ONLY. Uses real validation and local session storage.
import { assertMailPreparationAddress, assertMailPreparationRevision, assertMailPreparationSource, validateMailPreparationInput } from '/dashboard/js/mail-preparation-model.js';
import { getLocalErpCustomers } from '/dashboard/js/erp-customer-store.js';
export const MAIL_PREPARATION_COLLECTION = 'mailPreparations';
const KEY = 'dmnfood-fictional-mail-preparations-v1', EVENT = 'fictional-mail-preparation-changed';
function read() { if (!['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('Local fictional verification only.'); return JSON.parse(sessionStorage.getItem(KEY) || '{}'); }
const address = (intakeId, attachmentId) => { assertMailPreparationAddress(intakeId, attachmentId); return `${intakeId}/${attachmentId}`; };
export function subscribeMailPreparation(intakeId, attachmentId, next, error) {
    const key = address(intakeId, attachmentId); let disposed = false;
    const emit = () => { if (disposed) return; try { next(read()[key] || null, { fromCache: false, hasPendingWrites: false }); } catch (failure) { error?.(failure); } };
    window.addEventListener(EVENT, emit); queueMicrotask(emit); return () => { disposed = true; window.removeEventListener(EVENT, emit); };
}
export async function saveMailPreparation(input, session) {
    if (navigator.onLine === false) throw new Error('인터넷 연결 후 다시 시도해 주세요.');
    if (session?.user?.uid !== 'fictional-local-manager' || !['manager', 'admin'].includes(session?.profile?.role)) throw new Error('가상 검증 계정을 확인해 주세요.');
    const values = validateMailPreparationInput(input), key = address(values.intakeId, values.attachmentId);
    const headers = { Authorization: 'Bearer fictional-local-token-not-a-firebase-credential' };
    const sourceResponse = await fetch(`/api/naverworks/source?intakeId=${encodeURIComponent(values.intakeId)}`, { headers });
    const source = await sourceResponse.json(); if (!sourceResponse.ok || !source.mail) throw new Error('가상 원본을 확인할 수 없습니다.');
    const attachmentResponse = await fetch('/api/naverworks/attachment', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ intakeId: values.intakeId, attachmentId: values.attachmentId }) });
    const archive = await attachmentResponse.json(); if (!attachmentResponse.ok || !archive.attachment) throw new Error('가상 첨부 원본을 확인할 수 없습니다.');
    assertMailPreparationSource(values, source.mail, { ...archive.attachment, schemaVersion: 1, intakeId: values.intakeId, attachmentId: values.attachmentId });
    const catalog = getLocalErpCustomers(), customer = catalog.find(item => item.id === values.customer.id);
    if (!customer || ['id', 'code', 'name', 'revision'].some(field => customer[field] !== values.customer[field])) throw new Error('ERP 거래처 정보가 변경되었습니다. 최신 거래처를 다시 확인해 주세요.');
    const records = read(), previous = records[key] || null; assertMailPreparationRevision(previous, input, value => value || '');
    const now = new Date(Math.max(Date.now(), Date.parse(previous?.updatedAtIso || '') + 1 || 0)).toISOString();
    const record = { ...values, id: values.intakeId, revision: input.expectedRevision + 1,
        createdAtIso: previous?.createdAtIso || now, createdByUid: previous?.createdByUid || session.user.uid,
        updatedAtIso: now, updatedAt: now, updatedByUid: session.user.uid, syncState: 'confirmed' };
    if (previous) records[`${key}/versions/${previous.revision}`] = { record: previous, archivedAtIso: now, archivedByUid: session.user.uid };
    records[key] = record; sessionStorage.setItem(KEY, JSON.stringify(records)); window.dispatchEvent(new Event(EVENT));
    return { id: values.intakeId, attachmentId: values.attachmentId, revision: record.revision, status: 'range_selected' };
}
