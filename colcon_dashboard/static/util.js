export const $ = s => document.querySelector(s);

// the workspace and, optionally, a pinned historical build this page shows
export const PAGE_PARAMS = new URLSearchParams(location.search);
export const WS = PAGE_PARAMS.get('ws');
export const PINNED_BUILD = PAGE_PARAMS.get('build');
export function wsParam(joiner = '?') {
  let s = '';
  if (WS) {
    s = `${joiner}ws=${encodeURIComponent(WS)}`;
    if (PINNED_BUILD) s += `&build=${encodeURIComponent(PINNED_BUILD)}`;
  }
  return s;
}
// for strings that reach innerHTML: log content and URLs are not HTML
export const esc = s => String(s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// "#1e7fd9", "#fff", or "rgb(30, 127, 217)" as [r, g, b]
export function hexRgb(h) {
  if (h.startsWith('rgb')) return h.match(/[\d.]+/g).slice(0, 3).map(Number);
  h = h.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
          parseInt(h.slice(4, 6), 16)];
}

// the canvas version of the CSS color-mix(in srgb, b t, a)
export function mixColor(a, b, t) {
  const A = hexRgb(a), B = hexRgb(b);
  return `rgb(${A.map((x, i) => Math.round(x + (B[i] - x) * t)).join(',')})`;
}

export const SVGNS = 'http://www.w3.org/2000/svg';

export function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

// 44s, 12m 5s, 1h 0m 5s: units always, so "0:44" never leaves the
// reader guessing minutes or seconds. Trailing zero units drop: 12m, 1h.
export function fmtDur(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const parts = h ? [[h, 'h'], [m, 'm'], [s, 's']] : m ? [[m, 'm'], [s, 's']] : [[s, 's']];
  while (parts.length > 1 && parts[parts.length - 1][0] === 0) parts.pop();
  return parts.map(([v, unit]) => v + unit).join(' ');
}

// why a package failed: its exit code, or "tests failed" for a colcon
// test run, which keeps the exit code at 0 (p.tf)
export function failNote(p) {
  const why = p?.tf ? 'tests failed' : `rc ${p?.rc ?? '?'}`;
  return p?.ph && !p?.tf ? `${why} in ${p.ph}` : why;  // the step that failed
}

// the exact time in words, for tooltips: "44 minutes 12.4 seconds"
export function fmtDurLong(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  const s = Math.round((sec - h * 3600 - m * 60) * 10) / 10;
  const word = (v, w) => `${v} ${w}${v === 1 ? '' : 's'}`;
  const out = [];
  if (h) out.push(word(h, 'hour'));
  if (h || m) out.push(word(m, 'minute'));
  out.push(word(s, 'second'));
  return out.join(' ');
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {  // http:// pages get no clipboard API: fall back
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { /* denied */ }
    ta.remove();
    return ok;
  }
}

export function fmtGB(kb) {
  const gb = kb / 1048576;
  return gb >= 100 ? Math.round(gb) : gb.toFixed(1).replace(/\.0$/, '');
}

/* ---- workspace picker: one server, any workspace ---- */

export function fmtAgo(ts) {
  if (!ts) return '';
  const s = Date.now() / 1000 - ts;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function fmtBytes(n) {
  if (!n) return '0';
  const units = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  while (n >= 1024 && i < 4) { n /= 1024; i++; }
  return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + units[i];
}

// Toggle buttons show their state with the .on class. Mirror it into
// aria-pressed, so screen readers hear it too, for every toggle at once.
export function mirrorPressed(root = document.body) {
  const sync = b => {
    if (b.classList.contains('on')) b.setAttribute('aria-pressed', 'true');
    else if (b.hasAttribute('aria-pressed')) b.setAttribute('aria-pressed', 'false');
  };
  root.querySelectorAll('button.on').forEach(sync);
  new MutationObserver(list => {
    for (const m of list) {
      if (m.type === 'attributes') {
        if (m.target.tagName === 'BUTTON') sync(m.target);
        continue;
      }
      for (const n of m.addedNodes) {  // new panes come with buttons already on
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'BUTTON') sync(n);
        n.querySelectorAll('button.on').forEach(sync);
      }
    }
  }).observe(root, { subtree: true, childList: true, attributes: true,
                     attributeFilter: ['class'] });
}

/* ---------------- anchored panels ----------------
   The workspace picker, the build picker, and the help open as dropdowns
   under the button that opens them. The settings open as a side panel
   below the top bar. No backdrop: the dashboard stays visible and live.
   A click outside a dropdown closes it and still reaches the page. The
   side panel stays open until its button, ✕, or Esc closes it. Modules
   keep opening and closing a panel through its hidden attribute. */

const PANELS = new Map();  // panel -> { trigger, align, side, inPlace }

// inPlace: true while the panel is page content, not a dropdown (the
// workspace picker on the start page)
export function initPanel(panel, trigger,
                          { align = 'left', side = false, inPlace = () => false } = {}) {
  PANELS.set(panel, { trigger, align, side, inPlace });
  new MutationObserver(() => syncPanel(panel))
    .observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  syncPanel(panel);
}

function syncPanel(panel) {
  PANELS.get(panel).trigger.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
  placePanel(panel);
}

// a wrapper panel holds its box in .wsbox; a small panel is its own box
const boxOf = panel => panel.querySelector('.wsbox') || panel;

function placePanel(panel) {
  const cfg = PANELS.get(panel);
  if (panel.hidden || cfg.inPlace()) return;
  const box = boxOf(panel);
  if (cfg.side) {
    box.style.top = `${$('#topbar').getBoundingClientRect().bottom}px`;
    return;
  }
  const r = cfg.trigger.getBoundingClientRect();
  const width = box.offsetWidth;
  const top = r.bottom + 6;
  let left = cfg.align === 'right' ? r.right - width : r.left;
  left = Math.max(8, Math.min(left, document.documentElement.clientWidth - width - 8));
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.maxHeight = `${innerHeight - top - 12}px`;
  // the panel grows out of its button
  box.style.transformOrigin = `${Math.round(r.left + r.width / 2 - left)}px 0`;
}

addEventListener('pointerdown', ev => {
  if (ev.target.closest?.('#confirm')) return;
  for (const [panel, cfg] of PANELS) {
    if (panel.hidden || cfg.side || cfg.inPlace()) continue;
    if (boxOf(panel).contains(ev.target) || cfg.trigger.contains(ev.target)) continue;
    panel.hidden = true;
  }
}, true);
addEventListener('resize', () => { for (const panel of PANELS.keys()) placePanel(panel); });

/* ---------------- icons ----------------
   One icon set for every button: Material Symbols (Apache-2.0), inline
   so that the page stays self-contained. icon('copy') returns the SVG. */
const ICON_PATHS = {
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
  spark: 'M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z',
  locate: 'M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z',
  follow: 'M16 13h-3V3h-2v10H8l4 4 4-4zM4 19v2h16v-2H4z',
  top: 'M8 11h3v10h2V11h3l-4-4-4 4zM4 3v2h16V3H4z',
  up: 'M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z',
  down: 'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z',
  clock: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
  wrap: 'M4 19h6v-2H4v2zM20 5H4v2h16V5zm-3 6H4v2h13.25c1.1 0 2 .9 2 2s-.9 2-2 2H15v-2l-3 3 3 3v-2h2c2.21 0 4-1.79 4-4s-1.79-4-4-4z',
  fit: 'M15 3l2.3 2.3-2.89 2.87 1.42 1.42L18.7 6.7 21 9V3zM3 9l2.3-2.3 2.87 2.89 1.42-1.42L6.7 5.3 9 3H3zm6 12l-2.3-2.3 2.89-2.87-1.42-1.42L5.3 17.3 3 15v6zm12-6l-2.3 2.3-2.87-2.89-1.42 1.42 2.89 2.87L15 21h6z',
  log: 'M14 17H4v2h10v-2zm6-8H4v2h16V9zM4 15h16v-2H4v2zM4 5v2h16V5H4z',
  delete: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  raw: 'M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z',
  star: 'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
};

export function icon(name) {
  return `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON_PATHS[name]}"/></svg>`;
}

// index.html marks its icons as <span class="ic" data-icon="name">
export function fillIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) el.outerHTML = icon(el.dataset.icon);
}
