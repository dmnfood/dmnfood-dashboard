export const SCHOOL_MEAL_COMPANY_PATH = 'settings/schoolMealCompanies';
export const SCHOOL_MEAL_COMPANY_STORAGE_KEY = 'dmf_school_meal_included_companies_v1';
export const SCHOOL_MEAL_COMPANY_LIMIT = 200;
export const DEFAULT_SCHOOL_MEAL_COMPANIES = Object.freeze(['주식회사 태화에프에스', '동진푸드', '참팜', '진장푸드', '푸드랜드', '(주)수영농산', '샵원푸드', '신대동유통', '우일푸드', '번성 주식회사', '샬롬푸드', '다누리푸드', '정푸드', '동방유통', '(주)정안', '파워푸드', '원진DF', '친환경급식센터', '주식회사 두연푸드']);
export function normalizeSchoolMealCompanyName(value) {
    if (typeof value !== 'string') throw new Error('업체명을 확인해 주세요.');
    const name = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('업체명은 200자 이내로 입력해 주세요.');
    return name;
}
export function normalizeSchoolMealCompanyNames(names) {
    if (!Array.isArray(names) || names.length > SCHOOL_MEAL_COMPANY_LIMIT) throw new Error('업체는 200개까지 등록할 수 있습니다.');
    const seen = new Set();
    return names.map(value => {
        const name = normalizeSchoolMealCompanyName(value), key = name.toLowerCase().replace(/\s+/g, '');
        if (seen.has(key)) throw new Error(`중복된 업체명을 확인해 주세요: ${name}`);
        seen.add(key); return name;
    });
}
export async function schoolMealCompanyId(name) {
    const bytes = new TextEncoder().encode(normalizeSchoolMealCompanyName(name));
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    return `school-${hash.slice(0, 24)}`;
}
export async function buildSchoolMealCompanies(names) {
    return Promise.all(normalizeSchoolMealCompanyNames(names).map(async name => ({ id: await schoolMealCompanyId(name), name })));
}
export function legacySchoolMealCompanyNames(storage = globalThis.localStorage) {
    let raw;
    try { raw = storage?.getItem(SCHOOL_MEAL_COMPANY_STORAGE_KEY); }
    catch { throw new Error('기존 업체 목록을 읽지 못했습니다. 브라우저 저장 설정을 확인해 주세요.'); }
    if (raw == null) return [...DEFAULT_SCHOOL_MEAL_COMPANIES];
    try { return normalizeSchoolMealCompanyNames(JSON.parse(raw)); }
    catch { throw new Error('이 브라우저에 저장된 업체 목록을 확인해 주세요. 기존 목록을 덮어쓰지 않았습니다.'); }
}
export async function validateSchoolMealCompanyCatalog(data) {
    if (!data || data.schemaVersion !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 1 || !Array.isArray(data.companies)) throw new Error('공유 업체 목록을 확인하지 못했습니다.');
    const expected = await buildSchoolMealCompanies(data.companies.map(item => item?.name));
    if (expected.some((item, index) => item.id !== data.companies[index]?.id || item.name !== data.companies[index]?.name
        || Object.keys(data.companies[index]).some(key => !['id', 'name'].includes(key)))) throw new Error('공유 업체 정보가 일치하지 않습니다. 관리자에게 확인해 주세요.');
    return expected;
}
