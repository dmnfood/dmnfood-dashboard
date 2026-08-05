// Shared modal shell. Each form supplies its own direct-DOM renderer and lifecycle callbacks.
export function createJournalModal({ modalId, title, subtitle, query, render, summarize, printRootId, onOpen, onClose }) {
  const overlay = document.getElementById(modalId);
  const closeButton = overlay.querySelector('[data-journal-close]');
  const previewViewport = overlay.querySelector('.journal-preview-viewport');
  const previewStage = overlay.querySelector('.journal-preview-scale-stage');
  const printRoot = document.getElementById(printRootId);
  let opener = null;

  const fitPreview = () => {
    const sheets = printRoot?.querySelectorAll('.journal-sheet');
    if (!previewViewport || !previewStage || !printRoot || !sheets?.length) return;
    printRoot.classList.remove('is-preview-scaled');
    const sheet = sheets[0]; const width = sheet.offsetWidth; const height = sheet.offsetHeight;
    const viewportWidth = Math.max(1, previewViewport.clientWidth - 32); const viewportHeight = Math.max(1, previewViewport.clientHeight - 32);
    const scale = Math.min(viewportWidth / width, sheets.length === 1 ? viewportHeight / height : viewportWidth / width, 1);
    const unscaledHeight = printRoot.scrollHeight;
    printRoot.style.setProperty('--journal-preview-scale', String(scale));
    printRoot.classList.add('is-preview-scaled');
    previewStage.style.width = `${Math.ceil(width * scale)}px`;
    previewStage.style.height = `${Math.ceil(unscaledHeight * scale)}px`;
  };
  const resizeObserver = typeof ResizeObserver === 'undefined' || !previewViewport ? null : new ResizeObserver(() => requestAnimationFrame(fitPreview));
  resizeObserver?.observe(previewViewport);

  const close = () => {
    if (!overlay.classList.contains('open')) return;
    onClose?.();
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('journal-modal-open');
    opener?.focus();
  };

  const open = async () => {
    opener = document.activeElement;
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('journal-modal-open');
    closeButton.focus();
    await onOpen?.({ title, subtitle, query, render, summarize, printRootId });
    requestAnimationFrame(fitPreview);
  };

  closeButton.addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && overlay.classList.contains('open')) close(); });
  window.addEventListener('resize', fitPreview);
  return { open, close, fitPreview };
}
