import { $ } from './util.js';

/* ---------------- toasts ---------------- */

export function toast(html, cls = '', onclick = null, ttl = 9000) {
  const t = document.createElement('div');
  t.className = 'toast ' + cls;
  t.innerHTML = html;
  t.onclick = () => { if (onclick) onclick(); t.remove(); };
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ttl);
}
