import { $ } from './util.js';

/* ---------------- toasts ---------------- */

const MAX_TOASTS = 4;  // older toasts go first, so the stack never covers the page

export function toast(html, cls = '', onclick = null, ttl = 9000) {
  const t = document.createElement('div');
  t.className = 'toast ' + cls;
  t.innerHTML = `<div class="tbody">${html}</div>`
    + '<button class="tclose" title="close" aria-label="close">✕</button>';
  t.onclick = ev => {
    if (!ev.target.closest('.tclose') && onclick) onclick();
    t.remove();
  };
  const box = $('#toasts');
  box.appendChild(t);
  while (box.children.length > MAX_TOASTS) box.firstElementChild.remove();
  setTimeout(() => t.remove(), ttl);
  return t;
}
