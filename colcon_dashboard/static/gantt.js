import { emit, on } from './bus.js';
import { hideTooltip, label, showNodeTooltip } from './graph.js';
import { GS } from './gsearch.js';
import { App } from './state.js';
import { $, fmtDur, svgEl } from './util.js';

/* ---------------- gantt ---------------- */

export function drawGantt() {
  const svg = $('#gantt');
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
  svg.innerHTML = '';
  if (!rows.length || !App.buildStarted) return;

  const nowS = Date.now() / 1000;
  const t0 = App.buildStarted;
  let tMax = App.active ? nowS : t0 + 1;
  for (const [, p] of rows) tMax = Math.max(tMax, p.t1 || (App.active ? nowS : p.t0));
  const span = Math.max(30, tMax - t0);

  const GUT = 250, ROW = 16, TOP = 26;
  const W = Math.max(640, wrap.clientWidth - 16);
  const H = TOP + rows.length * ROW + 10;
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  const k = (W - GUT - 20) / span;

  const steps = [10, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200];
  const step = steps.find(s => span / s <= 10) || 14400;
  const gT = svgEl('g', { class: 'gtick' }, svg);
  for (let t = 0; t <= span; t += step) {
    const x = GUT + t * k;
    svgEl('line', { x1: x, y1: TOP - 6, x2: x, y2: H }, gT);
    const lbl = svgEl('text', { x: x + 3, y: TOP - 10 }, gT);
    lbl.textContent = fmtDur(t);
  }

  rows.forEach(([name, p], i) => {
    const y = TOP + i * ROW;
    const tn = svgEl('text', {
      class: 'gname' + (p.s === 'failed' ? ' failed' : ''),
      x: GUT - 8, y: y + 11, 'text-anchor': 'end',
    }, svg);
    tn.textContent = label(name);
    tn.dataset.name = name;
    const end = p.t1 || (App.active ? nowS : p.t0 + 1);
    const bar = svgEl('rect', {
      class: 'gbar ' + p.s,
      x: GUT + (p.t0 - t0) * k, y: y + 2,
      width: Math.max(2, (end - p.t0) * k), height: ROW - 5, rx: 3,
    }, svg);
    bar.dataset.name = name;
    if (GS.set?.has(name)) bar.classList.add('smatch');
  });

  if (App.active) {
    const x = GUT + (nowS - t0) * k;
    svgEl('line', { class: 'gnow', x1: x, y1: TOP - 4, x2: x, y2: H }, svg);
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
      emit('focus-pkg', drag.name);
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
