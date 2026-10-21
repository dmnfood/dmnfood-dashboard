import { normalizeErpCustomer, planCustomerImport, validateErpCustomer } from './erp-customer-model.js';
import { readErpCustomerFile } from './erp-customer-import.js';
import { saveErpCustomer, saveErpCustomerImport, subscribeErpCustomers } from './erp-customer-store.js';

const CSS_URL = new URL('../css/erp-customer-settings.css', import.meta.url);
function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function button(text, handler, primary = false) { const node = element('button', text, `order-button${primary ? ' order-primary' : ''}`); node.type = 'button'; node.addEventListener('click', handler); return node; }
function field(label, input) { const node = element('label', undefined, 'erp-customer-field'); node.append(element('span', label), input); return node; }
function input(placeholder) { const node = element('input', undefined, 'erp-customer-input'); node.placeholder = placeholder; node.type = 'text'; return node; }
function table(headers, values) {
    const wrap = element('div', undefined, 'erp-customer-table-wrap'), result = element('table', undefined, 'erp-customer-table');
    const head = element('thead'), tr = element('tr'); for (const label of headers) { const th = element('th', label); th.scope = 'col'; tr.append(th); } head.append(tr);
    const body = element('tbody'); for (const row of values) { const item = element('tr'); for (const value of row) { const td = element('td'); if (value instanceof Node) td.append(value); else td.textContent = value; item.append(td); } body.append(item); }
    result.append(head, body); wrap.append(result); return wrap;
}
const readableError = error => error?.code === 'permission-denied' ? '거래처 설정 권한을 확인하지 못했습니다. 다시 로그인해 주세요.'
    : error?.code === 'unavailable' ? '인터넷 연결 후 다시 시도해 주세요.' : String(error?.message || '저장하지 못했습니다. 다시 시도해 주세요.').slice(0, 500);

export function initErpCustomerSettings(session, mount, { onCustomersChange } = {}) {
    if (!mount || !['manager', 'admin'].includes(session?.profile?.role)) return () => {};
    if (!document.querySelector('link[data-erp-customer-styles]')) { const link = element('link'); link.rel = 'stylesheet'; link.href = CSS_URL.href; link.dataset.erpCustomerStyles = 'true'; document.head.append(link); }
    const controller = new AbortController(); let disposed = false, busy = false, customers = [], ready = false, editing = null, importPlan = null, fileGeneration = 0;
    const trigger = button('거래처 설정', () => { renderCatalog(); dialog.showModal(); close.focus(); });
    const dialog = element('dialog', undefined, 'erp-customer-dialog'); dialog.setAttribute('aria-label', 'ERP 거래처 설정');
    const shell = element('div', undefined, 'erp-customer-shell'), header = element('div', undefined, 'erp-customer-header');
    const closeDialog = () => { dialog.close(); if (!disposed) trigger.focus(); };
    const close = button('닫기', closeDialog); close.setAttribute('aria-label', '거래처 설정 닫기'); header.append(element('h2', 'ERP 거래처 설정'), close);
    const feedback = element('p', undefined, 'erp-customer-feedback'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
    function message(text, error = false) { feedback.textContent = text; feedback.dataset.error = String(error); }
    const loginSection = element('section', undefined, 'erp-customer-section');
    const loginActions = element('div', undefined, 'erp-customer-actions'), loginStatus = element('p', '연결 확인 전', 'erp-customer-note');
    const loginButton = button('Ecount 연결 확인', async () => {
        loginButton.disabled = true; loginStatus.textContent = '연결을 확인하는 중…';
        try {
            const token = await session.user.getIdToken();
            const response = await fetch('/api/ecount/login', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: controller.signal });
            const data = await response.json(); if (disposed) return;
            if (!response.ok || data.ok !== true || data.hasSession !== true) {
                const notes = { missing_ecount_env: 'Ecount 연결 설정을 먼저 확인해 주세요.', ecount_timeout: 'Ecount 응답이 늦어 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.' };
                const errorCode = Number.isSafeInteger(data.errorCode) ? ` (${data.errorCode})` : '';
                loginStatus.textContent = notes[data.code] || (response.status === 401 ? '다시 로그인한 뒤 확인해 주세요.' : `Ecount 연결 확인 실패${errorCode} · 연결 설정을 확인해 주세요.`);
            } else loginStatus.textContent = 'Ecount 연결 확인 완료';
        } catch (error) { if (!disposed && error.name !== 'AbortError') loginStatus.textContent = '연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'; }
        finally { if (!disposed) loginButton.disabled = false; }
    });
    loginActions.append(element('h3', 'Ecount 연결'), loginButton); loginSection.append(loginActions, loginStatus);
    const manualSection = element('section', undefined, 'erp-customer-section'), form = element('form', undefined, 'erp-customer-form');
    const code = input('예: 00123'), name = input('ERP에 등록된 거래처명'); code.maxLength = 100; name.maxLength = 200;
    const save = button('등록', () => form.requestSubmit(), true), reset = button('새 거래처', resetEdit);
    const manualActions = element('div', undefined, 'erp-customer-actions'); manualActions.append(save, reset);
    form.append(field('거래처코드', code), field('거래처명', name), manualActions);
    manualSection.append(element('h3', '직접 등록'), form);
    function resetEdit() { if (busy) return; editing = null; code.readOnly = false; code.value = ''; name.value = ''; save.textContent = '등록'; }
    form.addEventListener('submit', async event => {
        event.preventDefault(); if (busy || !ready) return;
        const value = normalizeErpCustomer({ code: code.value, name: name.value }), errors = validateErpCustomer(value);
        if (errors.length) { message(errors.join(' '), true); return; }
        if (!editing && customers.some(item => item.code === value.code)) { message('이미 등록된 코드입니다. 아래 목록에서 수정할 거래처를 선택해 주세요.', true); return; }
        setBusy(true); message('저장하는 중…');
        try {
            await saveErpCustomer({ ...value, expectedRevision: editing?.revision ?? null, expectedUpdatedAtIso: editing?.updatedAtIso || '' }, session);
            if (!disposed) { setBusy(false); resetEdit(); message('거래처를 저장했습니다.'); }
        } catch (error) { if (!disposed) message(readableError(error), true); }
        finally { if (!disposed) setBusy(false); }
    });
    const importSection = element('section', undefined, 'erp-customer-section'), file = element('input', undefined, 'erp-customer-input');
    file.type = 'file'; file.accept = '.csv,.tsv,.xlsx,.xls'; file.setAttribute('aria-label', 'ERP 거래처 파일 선택');
    const preview = element('div'), previewNote = element('p', undefined, 'erp-customer-note'), confirm = element('input'); confirm.type = 'checkbox';
    const confirmation = element('label', undefined, 'erp-customer-checkbox'); confirmation.append(confirm, element('span', '기존 거래처명 변경 내용을 확인했습니다.')); confirmation.hidden = true;
    const importSave = button('확인한 거래처 저장', async () => {
        if (busy || !ready || !importPlan) return;
        if (importPlan.updates && !confirm.checked) { message('기존 거래처명 변경 내용을 확인해 주세요.', true); return; }
        setBusy(true); message('거래처를 저장하는 중…');
        try {
            const result = await saveErpCustomerImport(importPlan, session, { confirmNameChanges: confirm.checked });
            if (!disposed) { clearImport(); message(`${result.saved}개 거래처를 저장했습니다.`); }
        } catch (error) { if (!disposed) message(readableError(error), true); }
        finally { if (!disposed) setBusy(false); }
    }, true); importSave.hidden = true;
    importSection.append(element('h3', '파일로 가져오기'), element('p', '첫 행: 거래처코드, 거래처명 · Excel은 첫 번째 시트를 확인합니다.', 'erp-customer-note'), file, previewNote, preview, confirmation, importSave);
    function clearImport() { importPlan = null; preview.replaceChildren(); previewNote.textContent = ''; confirm.checked = false; confirmation.hidden = true; importSave.hidden = true; file.value = ''; }
    file.addEventListener('change', async () => {
        const selected = file.files?.[0], generation = ++fileGeneration; clearImport(); if (!selected || busy || !ready) return;
        setBusy(true); message('파일을 확인하는 중…');
        try {
            const parsed = await readErpCustomerFile(selected, { signal: controller.signal });
            if (disposed || generation !== fileGeneration) return;
            importPlan = planCustomerImport(parsed.rows, customers);
            previewNote.textContent = `${selected.name}${parsed.sheetName ? ` · ${parsed.sheetName}${parsed.sheetCount > 1 ? ' (첫 번째 시트)' : ''}` : ''}\n신규 ${importPlan.creates} · 이름 변경 ${importPlan.updates} · 동일 ${importPlan.unchanged}`;
            preview.append(table(['코드', '거래처명', '저장 내용'], importPlan.entries.map(item => [item.code, item.name,
                item.action === 'update' ? `${item.previousName} → ${item.name}` : item.action === 'create' ? '신규 등록' : '변경 없음'])));
            confirmation.hidden = !importPlan.updates; importSave.hidden = !importPlan.creates && !importPlan.updates;
            message('저장할 거래처를 확인해 주세요.');
        } catch (error) { if (!disposed && error.name !== 'AbortError') { clearImport(); message(readableError(error), true); } }
        finally { if (!disposed) setBusy(false); }
    });
    const catalogSection = element('section', undefined, 'erp-customer-section'), search = input('거래처명 또는 코드 검색'), catalog = element('div'); search.classList.add('erp-customer-search'); search.setAttribute('aria-label', '등록 거래처 검색');
    catalogSection.append(element('h3', '등록된 거래처'), search, catalog); search.addEventListener('input', renderCatalog);
    function renderCatalog() {
        catalog.replaceChildren();
        if (!ready) { catalog.append(element('p', '거래처 목록을 확인하는 중…', 'erp-customer-note')); return; }
        const term = search.value.trim().toLocaleLowerCase('ko-KR'), matches = customers.filter(item => `${item.code} ${item.name}`.toLocaleLowerCase('ko-KR').includes(term));
        if (!matches.length) { catalog.append(element('p', customers.length ? '검색 결과가 없습니다.' : 'ERP 거래처를 등록해 주세요.', 'erp-customer-note')); return; }
        catalog.append(table(['코드', '거래처명', ''], matches.slice(0, 50).map(item => [item.code, item.name, button('수정', () => {
            if (busy) return; editing = item; code.value = item.code; code.readOnly = true; name.value = item.name; save.textContent = '변경 저장'; name.focus();
        })])));
        if (matches.length > 50) catalog.append(element('p', `검색 결과 ${matches.length}개 중 50개 표시 · 검색어를 입력해 주세요.`, 'erp-customer-note'));
    }
    function setBusy(value) { busy = value; form.setAttribute('aria-busy', String(value)); for (const node of [code, name, save, reset, file, importSave, confirm]) node.disabled = value || !ready; }
    shell.append(header, loginSection, feedback, manualSection, importSection, catalogSection); dialog.append(shell); mount.replaceChildren(trigger, dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); }); dialog.addEventListener('click', event => { if (event.target === dialog) closeDialog(); });
    setBusy(false);
    const unsubscribe = subscribeErpCustomers((values, metadata) => {
        if (disposed) return; customers = values; ready = !metadata.fromCache && !metadata.hasPendingWrites;
        setBusy(busy); if (dialog.open) renderCatalog(); onCustomersChange?.(values, metadata);
    }, error => { if (disposed) return; ready = false; setBusy(false); message(readableError(error), true); });
    return () => { if (disposed) return; disposed = true; controller.abort(); unsubscribe(); if (dialog.open) dialog.close(); mount.replaceChildren(); };
}
