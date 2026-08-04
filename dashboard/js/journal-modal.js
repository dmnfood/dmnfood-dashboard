// Shared journal modal shell. Form-specific journal documents remain responsible for their own data and print layout.
export function createJournalModal({ modalId, title, subtitle, frameUrl }) {
  const overlay = document.getElementById(modalId); const frame = overlay.querySelector('iframe'); const close = overlay.querySelector('[data-journal-close]'); let opener = null;
  const closeModal = () => { overlay.classList.remove('open'); overlay.setAttribute('aria-hidden','true'); document.body.classList.remove('journal-modal-open'); opener?.focus(); };
  const open = () => { opener=document.activeElement; overlay.classList.add('open'); overlay.setAttribute('aria-hidden','false'); if (!frame.getAttribute('src')) frame.src=frameUrl; close.focus(); };
  close.addEventListener('click', closeModal); overlay.addEventListener('click', e=>{if(e.target===overlay)closeModal()}); document.addEventListener('keydown',e=>{if(e.key==='Escape'&&overlay.classList.contains('open'))closeModal()});
  return { open, close: closeModal, title, subtitle };
}
