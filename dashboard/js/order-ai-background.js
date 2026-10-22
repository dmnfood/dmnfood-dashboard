import { requestOrderAi } from './order-ai-client.js';

const validId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const STATES = new Set(['pending', 'running', 'ready', 'failed', 'confirmed']);
const savedState = state => state === 'ready' || state === 'confirmed';

/** Work only while this signed-in page exists. The server owns the once-only AI claim. */
export function initOrderBackground(session, {
  onStates, onReady, onMailSynced, onStatus, getPreferredIntakeId = () => '',
  request = requestOrderAi, events = window, isOnline = () => navigator.onLine !== false,
  schedule = setTimeout, unschedule = clearTimeout, intervalMs = 120000,
} = {}) {
  let disposed = false, scanning = false, draining = false, scanAgain = false, timer, scanController, workerController;
  let continuation = null, firstSync = true, collectedCount = 0, activeId = '';
  const states = new Map(), queue = [], queued = new Set(), attempted = new Set();

  function notify(callback, value) { if (!disposed) callback?.(value); }
  function publish(items) {
    if (disposed) return;
    const changed = [], ready = [];
    for (const raw of items) {
      if (!validId(raw?.intakeId) || !STATES.has(raw.state) || raw.state === 'confirmed' && (!Number.isSafeInteger(raw.revision) || raw.revision < 1)) throw new Error('발주 분석 상태를 확인하지 못했습니다.');
      const previous = states.get(raw.intakeId);
      // A scan begun before a worker finished cannot regress its committed result.
      if (previous?.state === 'confirmed' && raw.state !== 'confirmed' || previous?.state === 'ready' && !savedState(raw.state)
        || savedState(previous?.state) && savedState(raw.state) && Number.isSafeInteger(raw.revision) && raw.revision < previous.revision
        || attempted.has(raw.intakeId) && raw.state === 'pending') continue;
      const item = { intakeId: raw.intakeId, state: raw.state,
        ...(Number.isSafeInteger(raw.revision) && raw.revision > 0 ? { revision: raw.revision } : {}),
        ...(raw.state === 'confirmed' && typeof raw.confirmedAt === 'string' && Number.isFinite(Date.parse(raw.confirmedAt)) ? { confirmedAt: raw.confirmedAt } : {}),
        ...(typeof raw.message === 'string' && raw.message ? { message: raw.message.slice(0, 1000) } : {}) };
      if (JSON.stringify(item) === JSON.stringify(previous)) continue;
      states.set(item.intakeId, item); changed.push(item);
      if (savedState(item.state) && (previous?.state !== item.state || previous.revision !== item.revision)) ready.push(item);
    }
    if (changed.length) notify(onStates, changed);
    for (const item of ready) notify(onReady, item);
  }
  function arrangeNext() {
    if (disposed) return;
    if (timer !== undefined) unschedule(timer);
    timer = schedule(() => { timer = undefined; void scan(); }, intervalMs);
  }
  function enqueue(items) {
    for (const item of items) {
      if (item.state !== 'pending' || states.get(item.intakeId)?.state !== 'pending' || attempted.has(item.intakeId) || queued.has(item.intakeId)) continue;
      queued.add(item.intakeId); queue.push(item.intakeId);
    }
    void drain();
  }
  async function drain() {
    if (disposed || draining || !isOnline()) return;
    draining = true;
    try {
      while (!disposed && isOnline() && queue.length) {
        const preferred = queue.indexOf(getPreferredIntakeId());
        const id = queue.splice(preferred < 0 ? 0 : preferred, 1)[0]; queued.delete(id);
        if (states.get(id)?.state !== 'pending' || attempted.has(id)) continue;
        attempted.add(id);
        activeId = id; workerController = new AbortController();
        publish([{ intakeId: id, state: 'running' }]);
        try {
          const result = await request(session, 'background', { body: { action: 'analyze', intakeId: id }, signal: workerController.signal });
          if (disposed || workerController.signal.aborted) return;
          if (result.intakeId !== id || !STATES.has(result.state) || result.state === 'pending') throw new Error('사전 분석 결과를 확인하지 못했습니다.');
          publish([result]);
        } catch (error) {
          if (disposed) return;
          // Never repeat an uncertain/failed AI request. A later scan reads its persisted state.
          publish([{ intakeId: id, state: 'failed', message: error.message || '자동 분석 결과를 확인하지 못했습니다. 메일을 선택해 다시 확인해 주세요.' }]);
        } finally { activeId = ''; workerController = null; }
      }
    } finally { draining = false; }
  }
  async function collect(signal) {
    if (!continuation) collectedCount = 0;
    for (let page = 0; page < 5; page++) {
      const result = await request(session, 'background', { body: { action: 'sync', ...(continuation ? { continuation } : {}) }, signal });
      if (disposed || signal.aborted) return;
      const sync = result.sync;
      if (!sync || !['complete', 'partial'].includes(sync.status) || !Number.isSafeInteger(sync.collected) || sync.collected < 0
        || sync.continuation != null && (typeof sync.continuation !== 'string' || !sync.continuation || sync.continuation.length > 20000)
        || sync.status === 'partial' && !sync.continuation || sync.status === 'complete' && sync.continuation) throw new Error('학교급식 메일의 수집 상태를 확인하지 못했습니다.');
      if (firstSync || sync.collected > collectedCount) notify(onMailSynced, sync);
      firstSync = false; collectedCount = sync.collected; continuation = sync.continuation || null;
      if (!continuation) return;
    }
  }
  async function scan({ collectMail = true } = {}) {
    if (disposed) return;
    if (scanning) { scanAgain = true; return; }
    if (timer !== undefined) { unschedule(timer); timer = undefined; }
    if (!isOnline()) { notify(onStatus, { state: 'offline', message: '인터넷 연결 후 자동 확인을 이어갑니다.' }); arrangeNext(); return; }
    scanning = true; scanController = new AbortController(); const signal = scanController.signal;
    let scanError = '';
    notify(onStatus, { state: 'checking', message: '학교급식 메일을 자동 확인하고 있습니다.' });
    try {
      if (collectMail) {
        try { await collect(signal); }
        catch (error) { if (disposed || signal.aborted) return; if (error.code === 'mail_continuation_invalid') continuation = null; scanError = error.message || '메일 자동 수집 상태를 확인해 주세요.'; }
      }
      let cursor = null; const seen = new Set();
      for (let page = 0; page < 50; page++) {
        const result = await request(session, `background${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal });
        if (disposed || signal.aborted) return;
        if (!Array.isArray(result.items) || result.items.length > 20 || result.items.some(item => !validId(item?.intakeId) || !STATES.has(item.state))) throw new Error('메일의 사전 분석 목록을 확인하지 못했습니다.');
        publish(result.items); enqueue(result.items);
        const next = result.nextCursor;
        if (next == null) break;
        if (typeof next !== 'string' || !next || next.length > 20000 || next === cursor || seen.has(next)) throw new Error('사전 분석 목록의 다음 범위를 확인하지 못했습니다.');
        if (page === 49) throw new Error('확인할 메일이 많아 다음 자동 확인에서 이어갑니다.');
        seen.add(next); cursor = next;
      }
      notify(onStatus, scanError ? { state: 'failed', message: scanError } : { state: 'idle', message: '' });
    } catch (error) {
      if (!disposed && !signal.aborted) notify(onStatus, { state: 'failed', message: error.message || '자동 확인에 연결하지 못했습니다.' });
    } finally {
      scanning = false;
      if (!disposed) {
        if (scanAgain) { scanAgain = false; void scan({ collectMail: false }); }
        else arrangeNext();
      }
    }
  }
  const online = () => { void scan(); void drain(); };
  const mailUpdated = event => { if (event?.detail?.origin !== 'background') void scan({ collectMail: false }); };
  events.addEventListener('online', online); events.addEventListener('mail-intakes-updated', mailUpdated);
  void scan();
  return {
    refresh: scan,
    stateFor: id => states.get(id) || null,
    markConfirmed(value) {
      if (disposed || !validId(value?.intakeId) || !Number.isSafeInteger(value.revision) || value.revision < 1) return false;
      publish([{ intakeId: value.intakeId, state: 'confirmed', revision: value.revision, confirmedAt: value.confirmedAt }]);
      return true;
    },
    destroy() { disposed = true; scanAgain = false; if (timer !== undefined) unschedule(timer); scanController?.abort(); workerController?.abort(); queue.length = 0; queued.clear(); attempted.clear(); states.clear(); events.removeEventListener('online', online); events.removeEventListener('mail-intakes-updated', mailUpdated); },
  };
}
