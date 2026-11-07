import { $, initPanel } from './util.js';

/* ---------------- keyboard help dropdown ----------------
   Every shortcut already exists; this dropdown makes them findable.
   It also owns the two global keys: ? opens it, / finds a package. */

const ROWS = [
  ['?', 'open or close this help'],
  ['/', 'jump to the find-package box'],
  ['Enter / Shift+Enter', 'next / previous match, in every search box'],
  ['Ctrl+Enter', 'in the find-package box: open the log of the current match'],
  ['Esc', 'clear the search, or close a dropdown or the settings'],
  ['Tab / ← / →', 'move between the log tabs; Enter opens one, Delete closes it'],
  ['click a package', 'open its log pane, and select it: its chain stays in focus'],
  ['Ctrl+click / Shift+click', 'add a package to the selection, or take it out'],
  ['click empty space / Esc', 'clear the selection'],
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
  initPanel(overlay, $('#helpBtn'), { align: 'right' });
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
