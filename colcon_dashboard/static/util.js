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
