export const ERR_RE = /\berror\b|\bfatal\b|FAILED/i;
export const WARN_RE = /\bwarning\b/i;

/* ---- ANSI (SGR) rendering: real terminal colors in the log panes ---- */

export const SGR_SPLIT_RE = /(\x1b\[[0-9;]*m)/;
export const CSI_OTHER_RE = /\x1b\[[0-9;?]*[A-LN-Za-ln-z]/g;  // CSI codes other than SGR
export const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;

export function newSgr() { return { bold: false, fg: null, bg: null }; }

export function applySgr(st, codes) {
  const nums = codes === '' ? [0] : codes.split(';').map(x => parseInt(x || '0', 10));
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i];
    if (n === 0) { st.bold = false; st.fg = null; st.bg = null; }
    else if (n === 1) st.bold = true;
    else if (n === 22) st.bold = false;
    else if (n >= 30 && n <= 37) st.fg = { i: n - 30 };
    else if (n >= 90 && n <= 97) st.fg = { i: n - 90 + 8 };
    else if (n === 39) st.fg = null;
    else if (n >= 40 && n <= 47) st.bg = { i: n - 40 };
    else if (n >= 100 && n <= 107) st.bg = { i: n - 100 + 8 };
    else if (n === 49) st.bg = null;
    else if (n === 38 || n === 48) {
      let col = null;
      if (nums[i + 1] === 5 && nums.length > i + 2) {
        col = { x: nums[i + 2] }; i += 2;
      } else if (nums[i + 1] === 2 && nums.length > i + 4) {
        col = { rgb: [nums[i + 2], nums[i + 3], nums[i + 4]] }; i += 4;
      }
      if (n === 38) st.fg = col; else st.bg = col;
    }
  }
}

export function xterm256(n) {  // 16..255 -> rgb triple
  if (n >= 232) { const v = 8 + (n - 232) * 10; return [v, v, v]; }
  const m = n - 16;
  return [Math.floor(m / 36), Math.floor(m / 6) % 6, m % 6]
    .map(v => (v ? 55 + v * 40 : 0));
}

export function sgrSpan(st) {
  const s = document.createElement('span');
  if (st.bold) s.style.fontWeight = '600';
  const apply = (col, prop, cls) => {
    if (!col) return;
    if (col.i != null) s.classList.add(cls + col.i);
    else if (col.x != null) {
      if (col.x < 16) s.classList.add(cls + col.x);
      else {
        const c = xterm256(col.x);
        s.style[prop] = `rgb(${c[0]},${c[1]},${c[2]})`;
      }
    } else if (col.rgb) s.style[prop] = `rgb(${col.rgb.join(',')})`;
  };
  apply(st.fg, 'color', 'af');
  apply(st.bg, 'backgroundColor', 'ab');
  return s;
}

export const TS_RE = /^\[\s*\d+(?:\.\d+)?s?\] /;

export function renderLogLine(p, line, frag) {
  const tm = TS_RE.exec(line);
  let tsSpan = null;
  if (tm) {
    tsSpan = document.createElement('span');
    tsSpan.className = 'ts';
    tsSpan.textContent = tm[0];
    line = line.slice(tm[0].length);
  }
  const emit = node => {
    if (tsSpan) frag.appendChild(tsSpan);
    frag.appendChild(node);
  };
  const base = ERR_RE.test(line) ? 'l-err' : WARN_RE.test(line) ? 'l-warn' : null;
  if (!line.includes('\x1b') &&
      !(p.sgr.bold || p.sgr.fg || p.sgr.bg)) {  // fast path: no color state
    if (base) {
      const s = document.createElement('span');
      s.className = base;
      s.textContent = line + '\n';
      emit(s);
    } else {
      emit(document.createTextNode(line + '\n'));
    }
    return;
  }
  const holder = document.createElement('span');
  if (base) holder.className = base;
  for (const part of line.split(SGR_SPLIT_RE)) {
    const m = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (m) { applySgr(p.sgr, m[1]); continue; }
    const text = part.replace(CSI_OTHER_RE, '').replace(OSC_RE, '');
    if (!text) continue;
    if (p.sgr.bold || p.sgr.fg || p.sgr.bg) {
      const s = sgrSpan(p.sgr);
      s.textContent = text;
      holder.appendChild(s);
    } else {
      holder.appendChild(document.createTextNode(text));
    }
  }
  holder.appendChild(document.createTextNode('\n'));
  emit(holder);
}
