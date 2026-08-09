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
export const SVGNS = 'http://www.w3.org/2000/svg';

export function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

export function fmtDur(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
           : `${m}:${String(s).padStart(2, '0')}`;
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
