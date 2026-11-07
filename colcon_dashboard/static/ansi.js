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
const PKG_RE = /^\[([\w.+-]+)\] /;
const FOLD_MIN = 4;  // a shorter run of install lines stays open

const FOLD_LABEL = { install: 'install lines' };

/* One log line becomes one <span class="ln">: the timestamp, then the
   text in <span class="lc">. ctx is the pane (or a pane-like object):
   sgr (the ANSI state), lint (lint.js state), fixed (the build log),
   ai (prose: no lint), raw (the exact text: no lint, no folds), pre,
   and grps (the open fold groups). Returns the line element. */
export function renderLogLine(ctx, line, frag) {
  const ln = document.createElement('span');
  ln.className = 'ln';
  const tm = TS_RE.exec(line);
  if (tm) {
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = tm[0];
    ln.appendChild(ts);
    line = line.slice(tm[0].length);
    // wrapped lines indent past the timestamp (style.css)
    if (ctx.pre && !ctx.tsw) {
      ctx.tsw = true;
      ctx.pre.style.setProperty('--tsw', `${tm[0].length}ch`);
    }
  }
  const lc = document.createElement('span');
  lc.className = 'lc';
  ln.appendChild(lc);
  let fold = null;
  let pkg = '';
  if (line.includes('\x1b') || ctx.sgr.bold || ctx.sgr.fg || ctx.sgr.bg) {
    // real terminal colors win over the lint
    if (/\berror\b|\bfatal\b|FAILED/i.test(line)) ln.classList.add('l-err');
    else if (/\bwarning\b/i.test(line)) ln.classList.add('l-warn');
    for (const part of line.split(SGR_SPLIT_RE)) {
      const m = /^\x1b\[([0-9;]*)m$/.exec(part);
      if (m) { applySgr(ctx.sgr, m[1]); continue; }
      const text = part.replace(CSI_OTHER_RE, '').replace(OSC_RE, '');
      if (!text) continue;
      if (ctx.sgr.bold || ctx.sgr.fg || ctx.sgr.bg) {
        const s = sgrSpan(ctx.sgr);
        s.textContent = text;
        lc.appendChild(s);
      } else {
        lc.appendChild(document.createTextNode(text));
      }
    }
  } else if (ctx.ai) {
    lc.textContent = line;
  } else {
    let lst = ctx.lint || (ctx.lint = newLintState());
    let text = line;
    if (ctx.fixed) {
      const pm = PKG_RE.exec(line);
      if (pm) {
        pkg = pm[1];
        text = line.slice(pm[0].length);
        // parallel jobs interleave their lines: each package keeps its
        // own lint state (a CMake warning block, the last diagnostic)
        const by = ctx.lintBy || (ctx.lintBy = new Map());
        if (!by.has(pkg)) by.set(pkg, newLintState());
        lst = by.get(pkg);
      }
    }
    const r = lintLine(text, lst);
    if (ctx.raw) {
      // the exact text, but the marks beside the scrollbar still find
      // the errors and warnings: m-err and m-warn carry no style
      lc.textContent = line;
      if (r.cls.includes('l-err')) ln.classList.add('m-err');
      else if (r.cls.includes('l-warn')) ln.classList.add('m-warn');
    } else {
      if (pkg) lc.append(pkgTag(pkg), ' ');
      if (r.cls.length) ln.classList.add(...r.cls);
      lc.append(...r.nodes);
      fold = r.fold;
    }
  }
  lc.appendChild(document.createTextNode('\n'));

  // install lines fold into one group line. In the build log, each
  // package keeps one open group: its later install lines join it, also
  // when other packages print in between, until it prints something else.
  // In a package pane, a group is one unbroken run.
  const grps = ctx.grps || (ctx.grps = new Map());
  let g = grps.get(pkg);
  if (g && (!fold || g.kind !== fold || !(g.el.isConnected || frag.contains(g.el)))) {
    grps.delete(pkg);
    g = null;
  }
  if (!fold) {
    frag.appendChild(ln);
    return ln;
  }
  if (!g) {
    const el = document.createElement('span');
    el.className = 'lgrp';
    const head = document.createElement('span');
    head.className = 'lgrp-head';
    head.title = 'click to show or hide these lines';
    if (pkg) head.append(pkgTag(pkg), ' ');
    head.appendChild(Object.assign(document.createElement('span'), { className: 'gcount' }));
    const body = document.createElement('span');
    body.className = 'lgrp-body';
    el.append(head, body);
    frag.appendChild(el);
    g = { el, body, kind: fold, n: 0 };
    grps.set(pkg, g);
  }
  g.body.appendChild(ln);
  g.n++;
  updateGroup(g.el, g.n, FOLD_LABEL[fold]);
  return ln;
}

// the head of a fold group: the count, and open or closed
export function updateGroup(el, n, label) {
  if (label) el.dataset.label = label;
  el.dataset.n = n;
  el.querySelector('.gcount').textContent = `${n} ${el.dataset.label}`;
  // a group closes once it is long enough, unless the user opened it
  if (n >= FOLD_MIN && !el.dataset.user) el.classList.add('folded');
  el.classList.toggle('short', n < FOLD_MIN);
}
