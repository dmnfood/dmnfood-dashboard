import { requestOrderAi } from './order-ai-client.js';

const validId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
const units = new Set(['병', '봉', '개', 'EA']);
const sourceLabel = kind => kind === 'mail' ? '메일' : kind === 'image' ? '카톡·문자 사진' : '카톡·문자';
const matches = (value, search) => value.normalize('NFKC').toLocaleLowerCase('ko-KR').includes(search);
const timeLabel = value => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
function el(tag, value, cls) { const node = document.createElement(tag); if (value != null) node.textContent = value; if (cls) node.className = cls; return node; }
function button(label, action, cls = '') { const node = el('button', label, `order-button ${cls}`); node.type = 'button'; node.addEventListener('click', action); return node; }
function validRecord(value) {
  return value && validId(value.intakeId) && validId(value.sourceHash) && ['mail', 'text', 'image'].includes(value.sourceKind)
    && Number.isSafeInteger(value.revision) && value.revision > 0 && value.revision < 10000
    && typeof value.confirmedAt === 'string' && Number.isFinite(Date.parse(value.confirmedAt))
    && text(value.customer?.name, 200) && Number.isSafeInteger(value.lineCount) && value.lineCount > 0 && value.lineCount <= 1000
    && Array.isArray(value.groups) && value.groups.length > 0 && value.groups.length <= value.lineCount
    && value.groups.every(group => text(group?.id, 200) && text(group.productId, 100) && text(group.label, 200)
      && typeof group.quantity === 'string' && /^\d{1,12}(?:\.\d{1,6})?$/.test(group.quantity) && Number(group.quantity) > 0 && units.has(group.unit))
    && new Set(value.groups.map(group => group.id)).size === value.groups.length;
}

/** Read final saved analyses. Constructing the controller never loads or changes a record. */
export function initConfirmedOrderList(session, mount, { onOpenSource, onRecords, request = requestOrderAi } = {}) {
  let disposed = false, loading = false, loaded = false, generation = 0, controller, nextCursor = null, notice = '', failed = false;
  const records = new Map(), seenCursors = new Set(), opening = new Set();
  const toolbar = el('div', null, 'order-confirmed-toolbar'), searchLabel = el('label', null, 'order-confirmed-search');
  const search = el('input'); search.type = 'search'; search.placeholder = '거래처명 검색'; search.maxLength = 200; search.setAttribute('aria-label', '확정 발주 거래처 검색'); searchLabel.append(search);
  const refresh = button('목록 새로고침', () => void load());
  toolbar.append(searchLabel, refresh);
  const feedback = el('p', '', 'order-confirmed-feedback'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  const list = el('div', null, 'order-confirmed-list'); list.setAttribute('aria-label', '확정한 발주 목록');
  const more = button('더 보기', () => void load({ append: true }), 'order-confirmed-more');
  mount.replaceChildren(toolbar, feedback, list, more);

  async function openSource(record) {
    if (disposed || opening.has(record.intakeId) || records.get(record.intakeId)?.revision !== record.revision || !onOpenSource) return;
    opening.add(record.intakeId); render();
    try { await onOpenSource({ intakeId: record.intakeId, sourceKind: record.sourceKind }); }
    catch (error) { if (!disposed) { notice = error.message || '원본 대조 화면을 열지 못했습니다.'; failed = true; } }
    finally { if (!disposed) { opening.delete(record.intakeId); render(); } }
  }
  function render() {
    if (disposed) return;
    const query = search.value.trim().normalize('NFKC').toLocaleLowerCase('ko-KR');
    const visible = [...records.values()].filter(record => !query || matches(record.customer.name, query))
      .sort((a, b) => Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt) || b.intakeId.localeCompare(a.intakeId));
    refresh.disabled = loading;
    feedback.textContent = notice; feedback.hidden = !notice; feedback.dataset.error = String(failed);
    list.setAttribute('aria-busy', String(loading)); list.replaceChildren();
    if (!visible.length) list.append(el('p', loading ? '확정한 발주를 불러오고 있습니다.' : query ? nextCursor ? '일치하는 거래처가 없습니다. 더 보기를 눌러 확인해 주세요.' : '일치하는 거래처가 없습니다.' : loaded ? '아직 확정한 발주가 없습니다.' : '확정한 발주를 확인할 수 있습니다.', 'order-confirmed-empty'));
    for (const record of visible) {
      const card = el('article', null, 'order-confirmed-item'); card.dataset.intakeId = record.intakeId;
      const heading = el('div', null, 'order-confirmed-heading'), title = el('div');
      const name = el('h3', record.customer.name), metadata = el('div', null, 'order-confirmed-meta'), time = el('time', timeLabel(record.confirmedAt)); time.dateTime = record.confirmedAt;
      metadata.append(el('span', '발주 확정', 'order-confirmed-badge'), el('span', sourceLabel(record.sourceKind)), time); title.append(name, metadata);
      const open = button(opening.has(record.intakeId) ? '여는 중…' : '원본 대조 화면', () => void openSource(record), 'order-confirmed-open'); open.disabled = opening.has(record.intakeId) || !onOpenSource; open.setAttribute('aria-label', `${record.customer.name} 원본 대조 화면`); heading.append(title, open);
      const details = el('details', null, 'order-confirmed-products'), summary = el('summary', `${record.groups.length}개 상품`), products = el('ul');
      for (const group of record.groups) { const row = el('li'); row.append(el('span', group.label), el('strong', `${group.quantity} ${group.unit}`)); products.append(row); }
      details.append(summary, products); card.append(heading, details); list.append(card);
    }
    more.hidden = !loaded || nextCursor === null; more.disabled = loading;
  }
  async function load({ append = false } = {}) {
    if (disposed || append && (loading || !nextCursor)) return false;
    const cursor = append ? nextCursor : null, version = ++generation;
    controller?.abort(); const active = new AbortController(); controller = active; loading = true; notice = ''; failed = false; render();
    try {
      const data = await request(session, `analysis?list=confirmed${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal: active.signal });
      if (disposed || version !== generation || active.signal.aborted) return false;
      if (!Array.isArray(data.records) || data.records.length > 25 || data.records.some(record => !validRecord(record))
        || data.nextCursor != null && (typeof data.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(data.nextCursor)
          || data.nextCursor === cursor || append && seenCursors.has(data.nextCursor))) throw new Error('확정한 발주 목록을 확인하지 못했습니다. 다시 불러와 주세요.');
      if (!append) { records.clear(); seenCursors.clear(); }
      for (const record of data.records) {
        const previous = records.get(record.intakeId);
        if (!previous || record.revision > previous.revision) records.set(record.intakeId, { ...record, customer: { ...record.customer }, groups: record.groups.map(group => ({ ...group })) });
      }
      if (cursor) seenCursors.add(cursor); nextCursor = data.nextCursor || null; loaded = true;
      try { Promise.resolve(onRecords?.(data.records)).catch(() => {}); } catch { /* A display callback cannot turn a saved list into a fetch error. */ }
      return true;
    } catch (error) { if (!disposed && version === generation && error.name !== 'AbortError') { notice = error.message || '확정한 발주 목록을 불러오지 못했습니다.'; failed = true; } return false; }
    finally { if (!disposed && version === generation) { loading = false; render(); } }
  }
  const searchChanged = () => render(); search.addEventListener('input', searchChanged); render();
  return { refresh: load, destroy() { if (disposed) return; disposed = true; generation++; controller?.abort(); search.removeEventListener('input', searchChanged); records.clear(); seenCursors.clear(); opening.clear(); } };
}
