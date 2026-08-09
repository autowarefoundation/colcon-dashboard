import { G3, tokens3d } from './g3d.js';
import { $ } from './util.js';

/* ---------------- theme ---------------- */

export function initTheme() {
  const saved = localStorage.getItem('cmc-theme') || 'auto';
  applyTheme(saved);
  $('#themeBtn').onclick = () => {
    const cur = localStorage.getItem('cmc-theme') || 'auto';
    const next = cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto';
    localStorage.setItem('cmc-theme', next);
    applyTheme(next);
  };
}
// Material Symbols, Apache-2.0, inlined so the page stays self-contained
export const THEME_ICONS = {
  auto: '<svg viewBox="0 0 24 24"><path d="M10.85 12.65h2.3L12 9l-1.15 3.65z' +
        'M20 8.69V4h-4.69L12 .69 8.69 4H4v4.69L.69 12 4 15.31V20h4.69L12 ' +
        '23.31 15.31 20H20v-4.69L23.31 12 20 8.69zM14.3 16l-.7-2h-3.2l-.7 ' +
        '2H7.8L11 7h2l3.2 9h-1.9z"/></svg>',
  light: '<svg viewBox="0 0 24 24"><path d="M6.76 4.84l-1.8-1.79-1.41 1.41 ' +
         '1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 ' +
         '3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 ' +
         '1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 ' +
         '0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2' +
         'v2.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z"/></svg>',
  dark: '<svg viewBox="0 0 24 24"><path d="M9.37 5.51c-.18.64-.27 1.31-.27 ' +
        '1.99 0 4.08 3.32 7.4 7.4 7.4.68 0 1.35-.09 1.99-.27C17.45 17.19 ' +
        '14.93 19 12 19c-3.86 0-7-3.14-7-7 0-2.93 1.81-5.45 4.37-6.49zM12 ' +
        '3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36' +
        '-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-' +
        '3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"/></svg>',
};

export function applyTheme(mode) {
  if (mode === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
  $('#themeBtn').innerHTML = THEME_ICONS[mode] || THEME_ICONS.auto;
  if (G3.colors) tokens3d();  // refresh the 3D canvas palette
}
