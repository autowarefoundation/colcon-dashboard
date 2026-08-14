import { $ } from './util.js';

/* ---------------- keyboard help overlay ----------------
   Every shortcut already exists; this overlay makes them findable.
   It also owns the two global keys: ? opens it, / finds a package. */

const ROWS = [
  ['?', 'open or close this help'],
  ['/', 'jump to the find-package box'],
  ['Enter / Shift+Enter', 'next / previous match, in every search box'],
  ['Esc', 'clear the search, or close an overlay'],
  ['click a package', 'open its log pane'],
  ['double-click a log tab', 'center the view on that package'],
  ['drag', 'pan the graph or the timeline'],
  ['scroll', 'zoom the graph'],
  ['3D: drag / shift-drag / wheel', 'orbit / pan / zoom'],
];

export function initHelp() {
  const overlay = $('#help');
  const tbody = overlay.querySelector('tbody');
  for (const [keys, what] of ROWS) {
    const tr = document.createElement('tr');
    const kbds = keys.split(' / ')
      .map(k => `<kbd>${k}</kbd>`).join(' <span class="hsep">/</span> ');
    tr.innerHTML = `<td>${kbds}</td><td>${what}</td>`;
    tbody.appendChild(tr);
  }
  const toggle = () => { overlay.hidden = !overlay.hidden; };
  $('#helpBtn').onclick = toggle;
  overlay.addEventListener('click', ev => {
    if (ev.target === overlay) overlay.hidden = true;
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && !overlay.hidden) {
      overlay.hidden = true;
      return;
    }
    const t = ev.target;
    if (t.closest?.('input, textarea, select') || t.isContentEditable) return;
    if (ev.key === '?') {
      ev.preventDefault();
      toggle();
    } else if (ev.key === '/') {
      ev.preventDefault();
      overlay.hidden = true;
      $('#gsearch').focus();
    }
  });
}
