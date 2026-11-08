import { lintLine, newLintState, pkgTag } from './lint.js';

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
// the build log names the package of each line after the timestamp
export const PKG_RE = /^\[([\w.+-]+)\] /;

export const sgrActive = st => !!(st.bold || st.fg || st.bg);

// the ANSI state after line, from the state before it
export function advanceSgr(st, line) {
  for (const part of line.split(SGR_SPLIT_RE)) {
    const m = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (m) applySgr(st, m[1]);
  }
}

export function stripAnsi(line) {
  return line.replace(/\x1b\[[0-9;]*m/g, '').replace(CSI_OTHER_RE, '').replace(OSC_RE, '');
}

const ERR_WORD = /\berror\b|\bfatal\b|FAILED/i;
const WARN_WORD = /\bwarning\b/i;

/* One log line as one <span class="ln">: the timestamp, then the text in
   <span class="lc">. o: fixed (a build log line: a package tag), ai
   (prose: no lint), raw (the exact text: no lint, but cls still marks
   the errors and warnings for the marks), cls (the line's lint classes),
   st (the lint state before the line), sgr (the ANSI state before it).
   st and sgr advance past the line. */
export function buildLine(line, o) {
  const ln = document.createElement('span');
  ln.className = 'ln';
  const tm = TS_RE.exec(line);
  if (tm) {
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = tm[0];
    ln.appendChild(ts);
    line = line.slice(tm[0].length);
  }
  const lc = document.createElement('span');
  lc.className = 'lc';
  ln.appendChild(lc);
  if (line.includes('\x1b') || sgrActive(o.sgr)) {
    // real terminal colors win over the lint
    if (ERR_WORD.test(line)) ln.classList.add(o.raw ? 'm-err' : 'l-err');
    else if (WARN_WORD.test(line)) ln.classList.add(o.raw ? 'm-warn' : 'l-warn');
    for (const part of line.split(SGR_SPLIT_RE)) {
      const m = /^\x1b\[([0-9;]*)m$/.exec(part);
      if (m) { applySgr(o.sgr, m[1]); continue; }
      const text = part.replace(CSI_OTHER_RE, '').replace(OSC_RE, '');
      if (!text) continue;
      if (sgrActive(o.sgr)) {
        const s = sgrSpan(o.sgr);
        s.textContent = text;
        lc.appendChild(s);
      } else {
        lc.appendChild(document.createTextNode(text));
      }
    }
  } else if (o.ai) {
    lc.textContent = line;
  } else if (o.raw) {
    // the exact text; the marks beside the scrollbar still find the
    // errors and warnings: m-err and m-warn carry no style
    lc.textContent = line;
    const cls = o.cls ?? lintLine(o.fixed ? line.replace(PKG_RE, '') : line, o.st, false).cls.join(' ');
    if (/\bl-err\b/.test(cls)) ln.classList.add('m-err');
    else if (/\bl-warn\b/.test(cls)) ln.classList.add('m-warn');
  } else {
    let text = line;
    if (o.fixed) {
      const pm = PKG_RE.exec(text);
      if (pm) {
        lc.append(pkgTag(pm[1]), ' ');
        text = text.slice(pm[0].length);
      }
    }
    const r = lintLine(text, o.st);
    if (r.cls.length) ln.classList.add(...r.cls);
    lc.append(...r.nodes);
  }
  lc.appendChild(document.createTextNode('\n'));
  return ln;
}

// a few lines in order, with no fold groups (the failures pane): ctx keeps
// the ANSI state (sgr) and the lint state (lint) from line to line
export function renderLogLine(ctx, line, frag) {
  const ln = buildLine(line, {
    fixed: ctx.fixed, ai: ctx.ai, raw: ctx.raw,
    st: ctx.lint || (ctx.lint = newLintState()), sgr: ctx.sgr,
  });
  frag.appendChild(ln);
  return ln;
}
