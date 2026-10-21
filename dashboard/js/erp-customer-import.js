import { parseCustomerCsv } from './erp-customer-model.js';
const WORKER_URL = new URL('./mail-workbook-worker.js', import.meta.url);
const MAX_BYTES = 3 * 1024 * 1024;

/** Reuses the bounded, same-origin read-only workbook parser in a short-lived worker. */
export async function readErpCustomerFile(file, { signal, WorkerClass = globalThis.Worker } = {}) {
    if (!file || !Number.isSafeInteger(file.size) || !file.size || file.size > MAX_BYTES) throw new Error('파일을 읽을 수 없습니다. 거래처 파일을 작게 나누어 다시 선택해 주세요.');
    const extension = /\.([a-z]+)$/i.exec(file.name)?.[1]?.toLowerCase();
    if (!['csv', 'tsv', 'xlsx', 'xls'].includes(extension)) throw new Error('Excel 또는 CSV 파일을 선택해 주세요.');
    if (signal?.aborted) throw new DOMException('취소되었습니다.', 'AbortError');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength !== file.size) throw new Error('파일 크기를 확인할 수 없습니다. 다시 선택해 주세요.');
    if (['csv', 'tsv'].includes(extension)) {
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { try { text = new TextDecoder('euc-kr', { fatal: true }).decode(bytes); } catch { throw new Error('파일의 문자 형식을 읽을 수 없습니다. UTF-8 CSV로 저장해 주세요.'); } }
        return { rows: parseCustomerCsv(text, { delimiter: extension === 'tsv' ? '\t' : ',' }), sheetName: '', sheetCount: 1 };
    }
    let worker, nextId = 0; const pending = new Map();
    const stop = (error = new DOMException('취소되었습니다.', 'AbortError')) => {
        worker?.terminate();
        for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error instanceof Error || error?.name ? error : new DOMException('취소되었습니다.', 'AbortError')); }
        pending.clear();
    };
    signal?.addEventListener('abort', stop, { once: true });
    try {
        worker = new WorkerClass(WORKER_URL);
        worker.onmessage = event => {
            const task = pending.get(event.data?.id); if (!task) return;
            pending.delete(event.data.id); clearTimeout(task.timer);
            if (event.data.error) task.reject(new Error(event.data.error)); else task.resolve(event.data.result);
        };
        worker.onerror = () => { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Excel을 읽지 못했습니다. 파일을 다시 선택해 주세요.')); } pending.clear(); };
        const request = (type, fields, transfer = []) => new Promise((resolve, reject) => {
            if (signal?.aborted) { reject(new DOMException('취소되었습니다.', 'AbortError')); return; }
            const id = ++nextId, timer = setTimeout(() => { stop(new Error('파일 읽기 시간이 초과되었습니다. 파일을 나누어 다시 선택해 주세요.')); }, 15000);
            pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, type, ...fields }, transfer);
        });
        const metadata = await request('open', { bytes, fileName: file.name }, [bytes.buffer]);
        const info = metadata?.sheets?.[0];
        if (!info?.range) throw new Error('첫 번째 시트에 거래처 표가 없습니다.');
        if (info.hidden || info.hiddenRows || info.hiddenColumns) throw new Error('숨겨진 시트·행·열을 모두 표시한 거래처 파일을 선택해 주세요.');
        if (info.columns > 20 || info.range.e.r >= 1000) throw new Error('거래처코드·거래처명 표만 별도 파일로 저장해 주세요.');
        const rows = Array.from({ length: info.range.s.r }, () => []), pages = Math.ceil(info.rows / 100);
        for (let page = 0; page < pages; page++) {
            const result = await request('page', { sheetIndex: 0, page, columnPage: 0 });
            if (result.merges?.length) throw new Error('병합된 셀을 풀고 거래처코드와 거래처명을 각 행에 넣어 주세요.');
            for (const row of result.rows) {
                if (row.cells.some(cell => cell.formula)) throw new Error('수식이 있는 거래처 표입니다. 값으로 붙여넣은 파일을 선택해 주세요.');
                rows.push(row.cells.map(cell => cell.text));
            }
        }
        return { rows, sheetName: info.name, sheetCount: metadata.sheets.length };
    } finally { signal?.removeEventListener('abort', stop); stop(); }
}
