// Shared modal shell. Each form supplies its own direct-DOM renderer and lifecycle callbacks.
export function createJournalModal({ modalId, title, subtitle, query, render, summarize, printRootId, onOpen, onClose }) {
  const overlay = document.getElementById(modalId);
  const closeButton = overlay.querySelector('[data-journal-close]');
  let opener = null;

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
  };

  closeButton.addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && overlay.classList.contains('open')) close(); });
  return { open, close };
}
