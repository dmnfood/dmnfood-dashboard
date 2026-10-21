/* Same-origin, read-only worker. Never loads workbook links or executes formulas/macros. */
'use strict';
importScripts('../vendor/sheetjs/xlsx.full.min.js', './mail-workbook-model.js');
let workbook = null, metadata = null, format = null;
self.onmessage = async event => {
  const { id, type } = event.data || {};
  try {
    if (type === 'open') {
      if (workbook) throw new Error('이미 열려 있는 Excel 미리보기입니다.');
      const bytes = MailWorkbookModel.inputBytes(event.data.bytes);
      format = MailWorkbookModel.sniffFormat(bytes, event.data.fileName);
      if (format.kind === 'xlsx') await MailWorkbookModel.verifyInflatedSize(bytes, MailWorkbookModel.inspectZip(bytes));
      let data = bytes, inputType = 'array';
      if (['html', 'xml', 'csv'].includes(format.kind)) {
        const head = new TextDecoder().decode(bytes.subarray(0, 4096));
        const declared = /(?:charset\s*=\s*["']?\s*|encoding\s*=\s*["'])([a-z\d_-]+)/i.exec(head)?.[1];
        const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be'
          : /^(euc-kr|ks_c_5601-1987|ksc5601|cp949|windows-949)$/i.test(declared || '') ? 'euc-kr' : 'utf-8';
        data = new TextDecoder(encoding, { fatal: true }).decode(bytes); inputType = 'string';
        // Do not let HTML source silently consume only the first of several tables.
        if (format.kind === 'html' && (data.match(/<table\b/gi) || []).length !== 1) throw new Error('HTML 형식의 발주서에 표가 여러 개 있거나 없습니다. 누락 없이 확인하려면 원본을 내려받아 주세요.');
      }
      workbook = XLSX.read(data, { type: inputType, cellFormula: true, cellHTML: false, cellNF: true,
        cellStyles: true, cellText: true, cellDates: false, bookVBA: true, raw: true, dense: false,
        WTF: true, codepage: 949 });
      metadata = MailWorkbookModel.describeWorkbook(workbook, XLSX);
      self.postMessage({ id, result: { ...metadata, format } });
    } else if (type === 'page') {
      if (!workbook || !metadata) throw new Error('Excel을 먼저 열어 주세요.');
      self.postMessage({ id, result: MailWorkbookModel.sheetPage(workbook, metadata, event.data, XLSX) });
    } else if (type === 'selectionInfo') {
      if (!workbook || !metadata) throw new Error('Excel을 먼저 열어 주세요.');
      self.postMessage({ id, result: MailWorkbookModel.selectionInfo(workbook, metadata, event.data, XLSX) });
    } else throw new Error('지원하지 않는 미리보기 요청입니다.');
  } catch (error) {
    self.postMessage({ id, error: String(error?.message || 'Excel 파일을 읽을 수 없습니다.').slice(0, 500) });
  }
};
