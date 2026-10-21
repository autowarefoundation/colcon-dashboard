import { emit, on } from './bus.js';
import { hideTooltip, label, showNodeTooltip } from './graph.js';
import { GS } from './gsearch.js';
import { App } from './state.js';
import { $, fmtDur, svgEl } from './util.js';

/* ---------------- gantt ---------------- */

// The live chart redraws every other poll. Its row elements are kept by
// package name, and a redraw only moves and resizes them: rebuilding
// three elements per package each time cost real work on big builds.
const G = { rows: new Map(), gT: null, aT: null, now: null, charW: 0 };

function clearGantt(svg, axis) {
  svg.innerHTML = '';
  axis.innerHTML = '';
  G.rows.clear();
  G.gT = G.aT = G.now = null;
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
    return;
  }
  if (G.gT && !G.gT.isConnected) clearGantt(svg, axis);  // someone emptied the svg

  const nowS = Date.now() / 1000;
  const t0 = App.buildStarted;
  let tMax = App.active ? nowS : t0 + 1;
  for (const [, p] of rows) tMax = Math.max(tMax, p.t1 || (App.active ? nowS : p.t0));
  const span = Math.max(30, tMax - t0);

  const ROW = 16, AXIS = 22, TOP = 4;
  const W = Math.max(640, wrap.clientWidth - 16);
  // the name gutter fits the longest name, up to a third of the width;
  // a longer name ends in "…" (the tooltip still shows all of it)
  if (!G.charW) {  // measure once: it forces a layout
    const probe = svgEl('text', { class: 'gname' }, svg);
    probe.textContent = 'M'.repeat(20);
    G.charW = probe.getComputedTextLength() / 20;  // 0 while hidden
    probe.remove();
  }
  const cw = G.charW || 6.3;
  const longest = Math.max(...rows.map(([name]) => label(name).length));
  const GUT = Math.round(Math.min(Math.max(160, W / 3),
                                  Math.max(90, longest * cw + 16)));
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
      + '<line class="gh-line" x1="0" y1="0" x2="0" y2="6"/></pattern>';
    G.gT = svgEl('g', { class: 'gtick' }, svg);
    G.aT = svgEl('g', { class: 'gtick' }, axis);
  }
  svg.prepend(G.gT);  // behind the bars
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

  if (App.active) {
    const x = GUT + (nowS - t0) * k;
    if (!G.now) G.now = svgEl('line', { class: 'gnow' }, svg);
    svg.appendChild(G.now);  // on top
    for (const [a, v] of [['x1', x], ['y1', 0], ['x2', x], ['y2', H]]) G.now.setAttribute(a, v);
  } else if (G.now) {
    G.now.remove();
    G.now = null;
  }
  if (App.ganttFollow) wrap.scrollTop = wrap.scrollHeight;

  // clicks are handled in initGanttPan, resolved at press time: the live
  // chart redraws every poll, and a mid-click redraw would eat the click
  svg.onpointermove = ev => {
    const b = ev.target.closest('.gbar, .gname');
    if (b) showNodeTooltip(b.dataset.name, ev); else hideTooltip();
  };
  svg.onpointerleave = hideTooltip;
}

export function initGanttPan() {
  // drag anywhere in the timeline to pan it, like the graph
  const wrap = $('#ganttwrap');
  let drag = null;
  wrap.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
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
      wrap.classList.add('panning');
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
}

on('state', () => {
  if (App.view !== 'graph' && (App.pollTick++ % 2 === 0)) drawGantt();
});

on('labels-changed', () => { if (App.view !== 'graph') drawGantt(); });
