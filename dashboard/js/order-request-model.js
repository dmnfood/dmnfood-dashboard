export const ORDER_CUSTOMER_GROUPS = Object.freeze({ wedding: '예식장', school: '학교급식', distributor: '유통사', hotel: '호텔', other: '기타' });
export const ORDER_SOURCE_CHANNELS = Object.freeze({ kakao: '카카오톡', sms: '문자', email: '메일', hotel_erp: '호텔 ERP', manual: '직접 접수' });
export const ORDER_STATUSES = Object.freeze({ pending_review: '확인 대기', needs_information: '추가 확인', approved: '확인 완료', rejected: '처리 제외' });
export const ORDER_DELIVERY_METHODS = Object.freeze({ courier: '택배', direct: '직접 배송', pickup: '방문 수령', undetermined: '미확정' });
export const ORDER_LIMITS = Object.freeze({ lines: 5, sourceText: 20000, sourceReference: 500, customerName: 120, name: 120, phone: 50, address: 500, product: 200, specification: 200, unit: 30, notes: 2000, quantity: 1000000 });

const text = value => typeof value === 'string' ? value.trim() : '';
const hasChoice = (choices, value) => Object.hasOwn(choices, value);
const validText = (value, max, required = false) => typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0);

export function isOrderDate(value) {
    if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Empty details remain unconfirmed. No quantity, unit, address or date is inferred.
export function normalizeOrderDraft(input = {}) {
    return {
        deliveryDate: text(input.deliveryDate),
        deliveryMethod: text(input.deliveryMethod) || 'undetermined',
        recipientName: text(input.recipientName),
        recipientPhone: text(input.recipientPhone),
        deliveryAddress: text(input.deliveryAddress),
        lines: Array.isArray(input.lines) ? input.lines.map(line => ({
            productName: text(line?.productName),
            specification: text(line?.specification),
            quantity: line?.quantity === '' || line?.quantity == null ? 0 : Number(line.quantity),
            unit: text(line?.unit),
        })) : [],
    };
}

export function validateOrderDraft(draft) {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return ['발주 상세를 확인해 주세요.'];
    const errors = [];
    if (!validText(draft.deliveryDate, 10) || (draft.deliveryDate && !isOrderDate(draft.deliveryDate))) errors.push('납품일을 올바른 날짜로 입력해 주세요.');
    if (!hasChoice(ORDER_DELIVERY_METHODS, draft.deliveryMethod)) errors.push('배송 방법을 확인해 주세요.');
    if (!validText(draft.recipientName, ORDER_LIMITS.name)) errors.push('수령인 이름은 120자 이내로 입력해 주세요.');
    if (!validText(draft.recipientPhone, ORDER_LIMITS.phone)) errors.push('수령인 연락처는 50자 이내로 입력해 주세요.');
    if (!validText(draft.deliveryAddress, ORDER_LIMITS.address)) errors.push('배송지는 500자 이내로 입력해 주세요.');
    if (!Array.isArray(draft.lines) || draft.lines.length > ORDER_LIMITS.lines) errors.push('이번 단계에서는 품목을 최대 5개까지 등록할 수 있습니다. 6개 이상인 발주는 원문을 유지하고 상세 정리를 보류해 주세요.');
    else draft.lines.forEach((line, index) => {
        if (!line || !validText(line.productName, ORDER_LIMITS.product) || !validText(line.specification, ORDER_LIMITS.specification)
            || !validText(line.unit, ORDER_LIMITS.unit) || typeof line.quantity !== 'number' || !Number.isFinite(line.quantity)
            || line.quantity < 0 || line.quantity > ORDER_LIMITS.quantity) errors.push(`${index + 1}번 품목의 이름·규격·수량·단위를 확인해 주세요. (수량 0~1,000,000)`);
    });
    return errors;
}

export function validateOrderInput(input) {
    if (!input || typeof input !== 'object') return ['접수 내용을 확인해 주세요.'];
    const errors = [];
    if (!validText(input.customerName, ORDER_LIMITS.customerName, true)) errors.push('거래처 이름을 입력해 주세요. (최대 120자)');
    if (!hasChoice(ORDER_CUSTOMER_GROUPS, input.customerGroup)) errors.push('거래처 유형을 선택해 주세요.');
    if (!hasChoice(ORDER_SOURCE_CHANNELS, input.sourceChannel)) errors.push('수신 경로를 선택해 주세요.');
    if (!validText(input.sourceText, ORDER_LIMITS.sourceText, true)) errors.push('발주 원문을 입력해 주세요. (최대 20,000자)');
    if (!validText(input.sourceReference ?? '', ORDER_LIMITS.sourceReference)) errors.push('원문 위치 설명은 500자 이내로 입력해 주세요.');
    if (input.isTest != null && typeof input.isTest !== 'boolean') errors.push('테스트 발주 여부를 확인해 주세요.');
    return errors.concat(validateOrderDraft(input.draft || normalizeOrderDraft()));
}

export function getApprovalIssues(order) {
    const draft = order?.draft || {};
    const errors = validateOrderDraft(draft);
    if (!validText(order?.customerName, ORDER_LIMITS.customerName, true)) errors.push('거래처를 확인해 주세요.');
    if (!validText(order?.sourceText, ORDER_LIMITS.sourceText, true)) errors.push('발주 원문을 확인해 주세요.');
    if (!draft.deliveryDate) errors.push('납품일을 확정해 주세요.');
    if (!draft.deliveryMethod || draft.deliveryMethod === 'undetermined') errors.push('배송 방법을 확정해 주세요.');
    if (!text(draft.recipientName)) errors.push('수령인을 확인해 주세요.');
    if (!text(draft.recipientPhone)) errors.push('수령인 연락처를 확인해 주세요.');
    if (draft.deliveryMethod !== 'pickup' && !text(draft.deliveryAddress)) errors.push('배송지를 확인해 주세요.');
    if (!Array.isArray(draft.lines) || !draft.lines.length) errors.push('발주 품목을 추가해 주세요.');
    else draft.lines.forEach((line, index) => {
        if (!text(line?.productName)) errors.push(`${index + 1}번 품목명을 확인해 주세요.`);
        if (!(typeof line?.quantity === 'number' && Number.isFinite(line.quantity) && line.quantity > 0)) errors.push(`${index + 1}번 품목 수량을 확정해 주세요.`);
        if (!text(line?.unit)) errors.push(`${index + 1}번 품목 단위를 확인해 주세요.`);
    });
    return [...new Set(errors)];
}

export function emptyReviewChecks() { return { identity: false, items: false, delivery: false }; }

export function assertOrderRevision(order, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || order?.revision !== expectedRevision) {
        throw new Error('다른 담당자가 발주를 변경했습니다. 최신 내용을 다시 확인해 주세요.');
    }
}

export function buildOrderReview(order, expectedRevision, decision, reviewer) {
    assertOrderRevision(order, expectedRevision);
    if (decision?.expectedStatus != null && decision.expectedStatus !== order.status) throw new Error('다른 담당자가 발주 상태를 변경했습니다. 최신 내용을 다시 확인해 주세요.');
    if (!['pending_review', 'needs_information'].includes(order.status)) throw new Error('이미 처리가 끝난 발주입니다. 내용을 수정하려면 새 버전으로 저장해 주세요.');
    if (!['approved', 'needs_information', 'rejected'].includes(decision?.status)) throw new Error('처리 상태를 확인해 주세요.');
    const reviewNotes = text(decision.reviewNotes);
    if (!validText(reviewNotes, ORDER_LIMITS.notes)) throw new Error('검토 메모는 2,000자 이내로 입력해 주세요.');
    if (decision.status !== 'approved' && !reviewNotes) throw new Error('추가 확인 또는 처리 제외 사유를 입력해 주세요.');
    if (!reviewer?.uid || !reviewer?.name) throw new Error('검토자 계정을 확인해 주세요.');
    const reviewChecks = { identity: decision.reviewChecks?.identity === true, items: decision.reviewChecks?.items === true, delivery: decision.reviewChecks?.delivery === true };
    if (decision.status === 'approved') {
        const issues = getApprovalIssues(order);
        if (issues.length) throw new Error(issues.join('\n'));
        if (!Object.values(reviewChecks).every(Boolean)) throw new Error('원문·거래처, 품목·수량, 배송 정보를 모두 확인해 주세요.');
    }
    return { status: decision.status, reviewNotes, reviewChecks: decision.status === 'approved' ? reviewChecks : emptyReviewChecks(),
        reviewedByUid: reviewer.uid, reviewedByName: reviewer.name, approvedRevision: decision.status === 'approved' ? expectedRevision : 0 };
}
