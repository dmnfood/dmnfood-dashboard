export function formatDateValue(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function formatTimeValue(date) {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

export function getCurrentUserIdentity(user) {
    const email = user?.email || '';
    const displayName = user?.displayName || '';
    const localPart = email ? email.split('@')[0] : '';
    return {
        workerId: user?.uid || '',
        workerName: displayName?.trim() || localPart || '미지정',
    };
}

export function normalizeHeatingValues(values) {
    const minutes = Math.max(0, parseInt(values.heatingMinutes || '0', 10) || 0);
    const seconds = Math.max(0, parseInt(values.heatingSeconds || '0', 10) || 0);
    const totalSeconds = minutes * 60 + seconds;
    const normalizedMinutes = Math.floor(totalSeconds / 60);
    const normalizedSeconds = totalSeconds % 60;
    return {
        ...values,
        heatingMinutes: String(normalizedMinutes),
        heatingSeconds: String(normalizedSeconds),
        heatingTotalSeconds: String(totalSeconds),
    };
}

export function badgeClassForJudgement(judgement) {
    return judgement === 'FAIL' ? 'badge badge-danger' : 'badge badge-success';
}

export function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
