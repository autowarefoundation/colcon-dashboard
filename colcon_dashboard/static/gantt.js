import { emit, on } from './bus.js';
import { hideTooltip, label, showNodeTooltip } from './graph.js';
import { GS } from './gsearch.js';
import { App } from './state.js';
import { $, fmtDur, PINNED_BUILD, svgEl, WS } from './util.js';

/* ---------------- gantt ---------------- */

// The live chart redraws every other poll. Its row elements are kept by
// package name, and a redraw only moves and resizes them: rebuilding
// three elements per package each time cost real work on big builds.
// the place in the timeline, kept for a reload of this tab (restorePos)
const POS_KEY = `cmc-gpos:${WS || ''}|${PINNED_BUILD || ''}`;
const G = { rows: new Map(), gT: null, aT: null, now: null, charW: 0,
            order: [], gut: 0, gutAuto: 0, W: 0, restore: loadPos(),
            ptrY: null };  // the pointer height over the rows, for the hover band
// the width of the name column that the user dragged; 0 fits it to the names
try { G.userGut = parseInt(localStorage.getItem('cmc-gname-w') || '0', 10) || 0; }
catch (e) { G.userGut = 0; }
const ROW = 16, AXIS = 22, TOP = 4;

function clearGantt(svg, axis) {
  svg.innerHTML = '';
  axis.innerHTML = '';
  G.rows.clear();
  G.gT = G.aT = G.now = G.zb = G.hov = null;
}

export function drawGantt() {
  const svg = $('#gantt');
  const axis = $('#gaxis');  // the time labels stay on top while rows scroll
  const wrap = $('#ganttwrap');
  const nowS0 = Date.now() / 1000;
  const endOf = p => p.t1 || (App.active ? nowS0 : p.t0);
  const rank = { failed: 0, aborted: 1, building: 2, done: 3, skipped: 4 };
  const cmp = {
    start: (a, b) => a[1].t0 - b[1].t0,
    duration: (a, b) => (endOf(b[1]) - b[1].t0) - (endOf(a[1]) - a[1].t0),
    end: (a, b) => endOf(a[1]) - endOf(b[1]),
    status: (a, b) => (rank[a[1].s] ?? 9) - (rank[b[1].s] ?? 9)
                      || a[1].t0 - b[1].t0,
  }[App.ganttSort] || ((a, b) => a[1].t0 - b[1].t0);
  const rows = Object.entries(App.pkgs)
    .filter(([, p]) => p.t0)
    .sort(cmp);
  if (!rows.length || !App.buildStarted) {
    clearGantt(svg, axis);
    G.order = [];
    return;
  }
  if (G.gT && !G.gT.isConnected) clearGantt(svg, axis);  // someone emptied the svg

  const nowS = Date.now() / 1000;
  const t0 = App.buildStarted;
  let tMax = App.active ? nowS : t0 + 1;
  for (const [, p] of rows) tMax = Math.max(tMax, p.t1 || (App.active ? nowS : p.t0));
  const span = Math.max(30, tMax - t0);

  const W = Math.max(640, wrap.clientWidth - 16);
  // the name gutter fits the longest name, up to a third of the width, or
  // takes the width that the user dragged it to; a longer name ends in "…"
  // (the tooltip still shows all of it)
  if (!G.charW) {  // measure once: it forces a layout
    const probe = svgEl('text', { class: 'gname' }, svg);
    probe.textContent = 'M'.repeat(20);
    G.charW = probe.getComputedTextLength() / 20;  // 0 while hidden
    probe.remove();
  }
  const cw = G.charW || 6.3;
  const longest = Math.max(...rows.map(([name]) => label(name).length));
  G.gutAuto = Math.round(Math.min(Math.max(160, W / 3),
                                  Math.max(90, longest * cw + 16)));
  const GUT = G.userGut ? Math.round(Math.min(Math.max(60, G.userGut), W - 160))
                        : G.gutAuto;
  G.gut = GUT;
  G.W = W;
  const fit = Math.floor((GUT - 16) / cw);
  const H = TOP + rows.length * ROW + 10;
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  axis.setAttribute('width', W);
  axis.setAttribute('height', AXIS);
  const k = (W - GUT - 20) / span;

  // the grid lines and the axis are few: draw them fresh
  if (!G.gT) {
    // failed bars are striped, not only red: a red-green color blind user
    // must tell them from the green done bars
    const defs = svgEl('defs', {}, svg);
    defs.innerHTML = '<pattern id="gHatch" patternUnits="userSpaceOnUse" width="6" height="6"'
      + ' patternTransform="rotate(45)"><rect class="gh-bg" width="6" height="6"/>'
      + '<line class="gh-line" x1="0" y1="0" x2="0" y2="6"/></pattern>'
      // every other row is a little darker, so that each bar sits on a row
      // with its name; one rect for all rows, not one per row
      + `<pattern id="gZebra" patternUnits="userSpaceOnUse" width="8" height="${2 * ROW}"`
      + ` y="${TOP}"><rect class="gzebra" y="${ROW}" width="8" height="${ROW}"/></pattern>`;
    G.zb = svgEl('rect', { fill: 'url(#gZebra)', x: 0, y: 0 }, svg);
    G.hov = svgEl('rect', { class: 'ghover', x: 0, height: ROW }, svg);
    G.gT = svgEl('g', { class: 'gtick' }, svg);
    G.aT = svgEl('g', { class: 'gtick' }, axis);
    // the edge of the name column: drag it to resize the column
    G.hs = svgEl('rect', { class: 'gsplit', width: 7 }, svg);
    G.ha = svgEl('rect', { class: 'gsplit', width: 7 }, axis);
    for (const h of [G.hs, G.ha]) {
      svgEl('title', {}, h).textContent =
        'drag to resize the name column, double-click to fit it to the names';
    }
  }
  svg.prepend(G.gT);  // behind the bars
  svg.prepend(G.hov);  // behind the grid lines
  svg.prepend(G.zb);
  G.zb.setAttribute('width', W);
  G.zb.setAttribute('height', H);
  G.hov.setAttribute('width', W);
  G.gT.innerHTML = '';
  G.aT.innerHTML = '';
  const steps = [10, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200];
  const step = steps.find(s => span / s <= 10) || 14400;
  for (let t = 0; t <= span; t += step) {
    const x = GUT + t * k;
    svgEl('line', { x1: x, y1: 0, x2: x, y2: H }, G.gT);
    svgEl('line', { x1: x, y1: AXIS - 6, x2: x, y2: AXIS }, G.aT);
    const lbl = svgEl('text', { x: x + 3, y: AXIS - 8 }, G.aT);
    lbl.textContent = fmtDur(t);
  }

  const seen = new Set();
  rows.forEach(([name, p], i) => {
    seen.add(name);
    let r = G.rows.get(name);
    if (!r) {
      const tn = svgEl('text', { class: 'gname', 'text-anchor': 'end' }, svg);
      const bar = svgEl('rect', { class: 'gbar', rx: 3 }, svg);
      tn.dataset.name = bar.dataset.name = name;
      r = { tn, bar, s: null, text: null };
      G.rows.set(name, r);
    }
    const y = TOP + i * ROW;
    // a mark that does not rely on color: ✗ failed, ◌ aborted
    const mark = p.s === 'failed' ? '✗ ' : p.s === 'aborted' ? '◌ ' : '';
    const text = mark + label(name);
    const shown = text.length > fit ? text.slice(0, fit - 1) + '…' : text;
    if (shown !== r.text) { r.tn.textContent = shown; r.text = shown; }
    r.tn.setAttribute('x', GUT - 8);
    r.tn.setAttribute('y', y + 11);
    r.tn.classList.toggle('failed', p.s === 'failed');
    if (p.s !== r.s) {  // classList, so that a running .flash survives
      if (r.s) r.bar.classList.remove(r.s);
      r.bar.classList.add(p.s);
      r.s = p.s;
    }
    const end = p.t1 || (App.active ? nowS : p.t0 + 1);
    r.bar.setAttribute('x', GUT + (p.t0 - t0) * k);
    r.bar.setAttribute('y', y + 2);
    r.bar.setAttribute('width', Math.max(2, (end - p.t0) * k));
    r.bar.setAttribute('height', ROW - 5);
    r.bar.classList.toggle('smatch', !!GS.set?.has(name));
  });
  for (const [name, r] of G.rows) {
    if (!seen.has(name)) { r.tn.remove(); r.bar.remove(); G.rows.delete(name); }
  }
  G.order = rows.map(([name]) => name);
  for (const [h, hh] of [[G.hs, H], [G.ha, AXIS]]) {
    h.setAttribute('x', GUT - 5);
    h.setAttribute('height', hh);
    h.parentNode.appendChild(h);  // above the bars
  }

  if (App.active) {
    const x = GUT + (nowS - t0) * k;
    if (!G.now) G.now = svgEl('line', { class: 'gnow' }, svg);
    svg.appendChild(G.now);  // on top
    for (const [a, v] of [['x1', x], ['y1', 0], ['x2', x], ['y2', H]]) G.now.setAttribute(a, v);
  } else if (G.now) {
    G.now.remove();
    G.now = null;
  }
  if (G.restore !== null) restorePos(wrap);
  else if (App.ganttFollow) wrap.scrollTop = wrap.scrollHeight;
  placeHover();  // the rows can change order under a still pointer

  // clicks are handled in initGanttPan, resolved at press time: the live
  // chart redraws every poll, and a mid-click redraw would eat the click
  svg.onpointermove = ev => {
    G.ptrY = ev.clientY;
    placeHover();
    const b = ev.target.closest('.gbar, .gname');
    if (b) showNodeTooltip(b.dataset.name, ev); else hideTooltip();
  };
  svg.onpointerleave = () => {
    G.ptrY = null;
    placeHover();
    hideTooltip();
  };
}

// the band behind the row under the pointer, from its name to its bar
function placeHover() {
  if (!G.hov) return;
  const wrap = $('#ganttwrap');
  let i = -1;
  if (G.ptrY !== null && !wrap.classList.contains('panning')
      && !wrap.classList.contains('resizing')) {
    const y = G.ptrY - $('#gantt').getBoundingClientRect().top;
    i = Math.floor((y - TOP) / ROW);
  }
  const shown = i >= 0 && i < G.order.length;
  G.hov.style.display = shown ? '' : 'none';
  if (shown) G.hov.setAttribute('y', TOP + i * ROW);
}

export function initGanttPan() {
  // drag anywhere in the timeline to pan it, like the graph
  const wrap = $('#ganttwrap');
  let drag = null;
  wrap.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    if (ev.target.classList?.contains('gsplit')) {
      startResize(ev, wrap);
      return;
    }
    drag = { x: ev.clientX, y: ev.clientY,
             sl: wrap.scrollLeft, st: wrap.scrollTop, moved: 0,
             name: ev.target.closest?.('.gbar, .gname')?.dataset?.name
                   || null };
  });
  wrap.addEventListener('pointermove', ev => {
    if (!drag) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
    if (drag.moved > 4) {
      wrap.scrollLeft = drag.sl - dx;
      wrap.scrollTop = drag.st - dy;
      if (!wrap.classList.contains('panning')) {
        wrap.classList.add('panning');
        placeHover();
      }
      wrap.setPointerCapture(ev.pointerId);
    }
  });
  const end = ev => {
    if (!drag) return;
    if (drag.moved <= 4 && drag.name && ev.type === 'pointerup') {
      emit('open-pkg', drag.name);
      // in the side-by-side view, the graph flies to the package too; the
      // Timeline-only view stays where the user put it
      if (App.view !== 'gantt') emit('focus-pkg', drag.name);
    }
    drag = null;
    wrap.classList.remove('panning');
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
  wrap.addEventListener('dblclick', ev => {
    if (!ev.target.classList?.contains('gsplit')) return;
    setUserGut(0);
    drawGantt();
  });
  let saveTimer = 0;
  wrap.addEventListener('scroll', () => {
    placeHover();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => savePos(wrap), 250);
  });
  addEventListener('pagehide', () => savePos(wrap));
}

function setUserGut(w) {
  G.userGut = w;
  try {
    if (w) localStorage.setItem('cmc-gname-w', String(w));
    else localStorage.removeItem('cmc-gname-w');
  } catch (e) { /* not kept */ }
}

// drag the edge of the name column; one redraw per frame
function startResize(ev, wrap) {
  ev.preventDefault();
  const x0 = ev.clientX, g0 = G.gut;
  let raf = 0;
  wrap.classList.add('resizing');
  wrap.setPointerCapture(ev.pointerId);
  hideTooltip();
  const move = e => {
    const w = Math.round(Math.min(Math.max(60, g0 + e.clientX - x0), G.W - 160));
    if (w === G.userGut) return;
    G.userGut = w;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; drawGantt(); });
  };
  const up = () => {
    wrap.removeEventListener('pointermove', move);
    wrap.removeEventListener('pointerup', up);
    wrap.removeEventListener('pointercancel', up);
    wrap.classList.remove('resizing');
    // a drag back to the fitted width fits the names again
    setUserGut(Math.abs(G.userGut - G.gutAuto) <= 3 ? 0 : G.userGut);
    drawGantt();
  };
  wrap.addEventListener('pointermove', move);
  wrap.addEventListener('pointerup', up);
  wrap.addEventListener('pointercancel', up);
}

/* ---- the place in the timeline, kept for a reload of this tab: the
   package at the top of the view, or the end while it follows ---- */

function loadPos() {
  try { return JSON.parse(sessionStorage.getItem(POS_KEY) || 'null'); }
  catch (e) { return null; }
}

function savePos(wrap) {
  // not before the restore, and not while the timeline is hidden or empty
  if (G.restore !== null || !G.order.length || !wrap.clientHeight) return;
  const i = Math.max(0, Math.min(G.order.length - 1,
                                 Math.floor((wrap.scrollTop - TOP) / ROW)));
  try {
    sessionStorage.setItem(POS_KEY, JSON.stringify({
      build: App.buildId, follow: App.ganttFollow, name: G.order[i],
      dy: wrap.scrollTop - (TOP + i * ROW), left: wrap.scrollLeft,
    }));
  } catch (e) { /* not kept */ }
}

function restorePos(wrap) {
  const s = G.restore;
  G.restore = null;
  const i = s ? G.order.indexOf(s.name) : -1;
  // a new build, a following timeline, or a package gone: the end
  if (!s || s.follow || i < 0 || (s.build && s.build !== App.buildId)) {
    if (App.ganttFollow) wrap.scrollTop = wrap.scrollHeight;
    return;
  }
  App.ganttFollow = false;
  $('#gfollowBtn').classList.remove('on');
  wrap.scrollTop = TOP + i * ROW + s.dy;
  wrap.scrollLeft = s.left || 0;
}

on('state', () => {
  if (App.view !== 'graph' && (App.pollTick++ % 2 === 0)) drawGantt();
});

on('labels-changed', () => { if (App.view !== 'graph') drawGantt(); });
