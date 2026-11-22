import { on } from './bus.js';
import { hideTooltip, label, selectionChain, showNodeTooltip } from './graph.js';
import { GS } from './gsearch.js';
import { cutRanges, fitNames } from './namefit.js';
import { clearSelection, pickPkg, selectPkg } from './selection.js';
import { App } from './state.js';
import { $, esc, fmtDur, fmtWhen, PINNED_BUILD, svgEl, WS, wsParam } from './util.js';

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

/* ---- compare: the time of each package in another run ----
   The key is '' (off), 'last' (the nearest earlier run of the same kind),
   'usual' (the median of the last runs), or the id of an earlier run.
   App.cmp holds the times that it resolves to: an outline bar shows each
   one, and a label after the bars gives the change. */
const CMP_KEY = 'cmc-gcmp';
let cmpKey = '';
try { cmpKey = localStorage.getItem(CMP_KEY) || ''; } catch (e) { /* not kept */ }
const outcomes = new Map();  // run id -> /api/outcome answer
let runsFor = null;          // the build that the run list was made for
const runsRetry = { build: null, n: 0 };  // asks again for missing outcomes

function resolveCmp() {
  const prev = App.prev;
  let ref = null;
  if (cmpKey === 'last' && prev?.last) {
    ref = { label: `the last run (${fmtWhen(prev.at)})`, dur: prev.last,
            failed: prev.failed, unfinished: prev.unfinished, duration: prev.duration,
            complete: prev.complete };
  } else if (cmpKey === 'usual' && prev) {
    ref = { label: prev.runs > 1 ? `the usual time (the median of ${prev.runs} runs)`
                                 : `the last run (${fmtWhen(prev.at)})`,
            dur: prev.durations, failed: prev.failed, unfinished: prev.unfinished, duration: null };
  } else if (outcomes.has(cmpKey)) {
    const o = outcomes.get(cmpKey);
    ref = { label: `the run of ${fmtWhen(o.at)}`, dur: o.pkg_durations,
            failed: o.failed_names, unfinished: o.unfinished_names, duration: o.duration,
            complete: o.complete };
  }
  // untimed: in that run, but failed or never finished there, so not new
  App.cmp = ref && { ...ref, key: cmpKey, dur: ref.dur || {},
                     untimed: new Set([...(ref.failed || []), ...(ref.unfinished || [])]) };
}

// a package that finished in both runs: its seconds more (+) or less (-)
function pkgChange(name, p) {
  const ref = App.cmp?.dur[name];
  if (ref == null || p.s !== 'done' || !p.t1) return null;
  return p.t1 - p.t0 - ref;
}
// a change worth a label: 10 s, or 2 s and 10 %
const notable = (d, ref) => Math.abs(d) >= 10 || (Math.abs(d) >= 2 && Math.abs(d) >= 0.1 * ref);
// the order by change: slower first, then the packages with no notable
// change, then faster, then the packages with no time to compare
function changeKey(name, p) {
  const d = pkgChange(name, p);
  if (d == null) return -Infinity;
  return notable(d, App.cmp.dur[name]) ? d : 0;
}
const fmtChange = d => (d > 0 ? '+' : '−') + fmtDur(Math.abs(d));

// the counts beside the Compare choice
function cmpSummary() {
  const el = $('#gcmpSum');
  if (!App.cmp) { el.textContent = ''; el.title = ''; return; }
  let slower = 0, faster = 0, added = 0, unfinished = 0;
  for (const [name, p] of Object.entries(App.pkgs)) {
    if (p.s !== 'done' && p.s !== 'failed') unfinished++;
    if (!p.t0) continue;
    const ref = App.cmp.dur[name];
    const d = pkgChange(name, p);
    if (d != null && notable(d, ref)) { if (d > 0) slower++; else faster++; }
    else if (ref == null && !App.cmp.untimed.has(name)) added++;
  }
  const parts = [];
  // the whole time compares only when both runs ran every package to its end
  if (!App.active && !unfinished && App.cmp.complete !== false && App.cmp.duration != null
      && App.elapsedBase) {
    const d = App.elapsedBase - App.cmp.duration;
    if (Math.abs(d) >= 1) parts.push(`<b class="${d > 0 ? 'slow' : 'fast'}">${fmtChange(d)}</b> in all`);
  }
  if (slower) parts.push(`<b class="slow">${slower}</b> slower`);
  if (faster) parts.push(`<b class="fast">${faster}</b> faster`);
  if (added) parts.push(`<b>${added}</b> new`);
  el.innerHTML = parts.length ? parts.join(' · ') : 'no notable change';
  el.title = `against ${App.cmp.label}. A package counts as slower or faster when its time changed by 10 s, or by 2 s and 10 %. New: not in that run.`;
}

async function setCompare(key) {
  cmpKey = key || '';
  try {
    if (['', 'last', 'usual'].includes(cmpKey)) localStorage.setItem(CMP_KEY, cmpKey);
  } catch (e) { /* not kept */ }
  const sel = $('#gcmpSelect');
  if (cmpKey && !['last', 'usual'].includes(cmpKey) && !outcomes.has(cmpKey)) {
    try {
      const r = await fetch(`/api/outcome?id=${encodeURIComponent(cmpKey)}${wsParam('&')}`);
      if (r.ok) outcomes.set(cmpKey, await r.json());
    } catch (e) { /* offline */ }
    if (!outcomes.has(cmpKey)) cmpKey = '';
  }
  sel.value = cmpKey;
  resolveCmp();
  drawGantt();
}

// the choices: the last run and the usual times, then each earlier run
// of the same kind
async function fillCompareRuns() {
  const sel = $('#gcmpSelect');
  const prev = App.prev;
  const last = sel.querySelector('option[value="last"]');
  const usual = sel.querySelector('option[value="usual"]');
  usual.disabled = !prev;
  last.disabled = !prev?.last;  // a 0.11.1 server sends only the medians
  last.textContent = prev?.at ? `Last run (${fmtWhen(prev.at)})` : 'Last run';
  usual.textContent = prev?.runs > 1 ? `Usual times (median of ${prev.runs} runs)` : 'Usual times';
  if (runsFor !== App.buildId) {
    runsFor = App.buildId;
    let builds = [];
    try { builds = (await (await fetch(`/api/builds${wsParam()}`)).json()).builds || []; }
    catch (e) { /* offline */ }
    const id = App.buildId || '';
    const kind = id.split('_')[0] + '_';
    const earlier = builds.filter(b => b.id.startsWith(kind) && b.id < id);
    const runs = earlier.filter(b => b.outcome && b.outcome !== 'empty');
    // The server can still compute some outcomes: after an upgrade, and
    // for the run that just ended. Ask again in a moment, a few times.
    if (runsRetry.build !== id) Object.assign(runsRetry, { build: id, n: 0 });
    if (earlier.some(b => !b.outcome) && runsRetry.n < 10) {
      runsRetry.n++;
      runsFor = null;
      setTimeout(() => { if (runsFor === null && App.buildId === id) fillCompareRuns(); }, 2000);
    }
    const og = $('#gcmpRuns');
    og.innerHTML = runs.map(b => `<option value="${esc(b.id)}">`
      + `${esc(fmtWhen(b.time))} · ${esc(b.outcome)} · ${fmtDur(b.duration)}</option>`).join('');
    og.disabled = !runs.length;
  }
  sel.value = cmpKey;
  if (sel.value !== cmpKey) sel.value = '';  // a run that is gone
}

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
    // slower first, faster last (changeKey)
    change: (a, b) => (changeKey(...b) - changeKey(...a)) || a[1].t0 - b[1].t0,
  }[App.ganttSort] || ((a, b) => a[1].t0 - b[1].t0);
  const rows = Object.entries(App.pkgs)
    .filter(([, p]) => p.t0)
    .sort(cmp);
  cmpSummary();
  if (!rows.length || !App.buildStarted) {
    clearGantt(svg, axis);
    G.order = [];
    return;
  }
  if (G.gT && !G.gT.isConnected) clearGantt(svg, axis);  // someone emptied the svg

  const nowS = Date.now() / 1000;
  const t0 = App.buildStarted;
  let tMax = App.active ? nowS : t0 + 1;
  for (const [name, p] of rows) {
    tMax = Math.max(tMax, p.t1 || (App.active ? nowS : p.t0));
    if (App.cmp) tMax = Math.max(tMax, p.t0 + (App.cmp.dur[name] ?? 0));  // the outline too
  }
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
  // room on the right for the change labels
  const k = (W - GUT - (App.cmp ? 64 : 20)) / span;

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

  const fitted = fitNames(rows.map(([name]) => label(name)), fit);
  const seen = new Set();
  const chain = selectionChain();
  markFocus(svg, chain);
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
    const f = fitted[i];
    const ranges = mark ? cutRanges(f.text, fit - mark.length, f.u) : f.ranges;
    const key = mark + f.text + f.mask + ranges.join();
    if (key !== r.text) { nameParts(r.tn, mark, f, ranges); r.text = key; }
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
    markRow(name, r, chain);
    // compare: the time in the other run as an outline behind the bar, and
    // the change after the longer of the two
    const ref = App.cmp?.dur[name];
    if (ref != null) {
      if (!r.ref) {
        r.ref = svgEl('rect', { class: 'gref', rx: 3 });
        r.ref.dataset.name = name;
        svg.insertBefore(r.ref, r.bar);
      }
      r.ref.setAttribute('x', GUT + (p.t0 - t0) * k);
      r.ref.setAttribute('y', y + 1.5);
      r.ref.setAttribute('width', Math.max(2, ref * k));
      r.ref.setAttribute('height', ROW - 4);
    } else if (r.ref) { r.ref.remove(); r.ref = null; }
    const d = pkgChange(name, p);
    const txt = d != null && notable(d, ref) ? fmtChange(d)
      : App.cmp && ref == null && !App.cmp.untimed.has(name) ? 'new' : null;
    if (txt) {
      if (!r.dt) {
        r.dt = svgEl('text', {}, svg);
        r.dt.dataset.name = name;
      }
      r.dt.textContent = txt;
      r.dt.setAttribute('class', 'gdelta ' + (txt === 'new' ? 'new' : d > 0 ? 'slow' : 'fast'));
      r.dt.setAttribute('x', GUT + (p.t0 - t0 + Math.max(end - p.t0, ref ?? 0)) * k + 5);
      r.dt.setAttribute('y', y + 11);
    } else if (r.dt) { r.dt.remove(); r.dt = null; }
  });
  for (const [name, r] of G.rows) {
    if (!seen.has(name)) {
      r.tn.remove(); r.bar.remove(); r.ref?.remove(); r.dt?.remove();
      G.rows.delete(name);
    }
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
    const b = ev.target.closest('.gbar, .gname, .gref, .gdelta');
    if (b) showNodeTooltip(b.dataset.name, ev); else hideTooltip();
  };
  svg.onpointerleave = () => {
    G.ptrY = null;
    placeHover();
    hideTooltip();
  };
}

/* ---- the selection (selection.js) in the timeline: the selected rows
   get an outline and a strong name, the bars of their dependency chains
   stay clear, and the other bars fade (style.css), as in the graph ---- */

// focused: the selection has chains, and the bars outside them fade.
// stepsel: a step of the find-package box made the selection. Then no
// bar fades for the selection while that search is on (style.css).
function markFocus(svg, chain) {
  svg.classList.toggle('focused', !!chain);
  svg.classList.toggle('stepsel', App.selStep);
}

function markRow(name, r, chain) {
  const sel = App.selected.has(name);
  r.bar.classList.toggle('sel', sel);
  r.tn.classList.toggle('sel', sel);
  // a selected row counts as a part of the chains, also when the graph
  // does not know its package
  r.bar.classList.toggle('chain', sel || !!chain?.has(name));
}

// the rows keep their places: only the marks change
function markSelection() {
  const chain = selectionChain();
  markFocus($('#gantt'), chain);
  for (const [name, r] of G.rows) markRow(name, r, chain);
}

/* The timeline half of a 'focus-pkg' request (views.js): bring the row of
   one package to the middle of the view, and flash its bar. A package that
   never started has no row, and then nothing moves. */
export function revealInTimeline(name) {
  const r = G.rows.get(name);
  if (!r) return;
  const wrap = $('#ganttwrap');
  const end = wrap.scrollHeight - wrap.clientHeight;
  const top = Math.max(0, Math.min(end, r.bar.y.baseVal.value - wrap.clientHeight / 2));
  // Follow means that the timeline sits at its end: the scroll listener
  // (views.js) keeps the two the same, with this 30 px rule. A row before
  // the end turns Follow off here too, because a redraw before the scroll
  // event would go back to the end. A row at the end: when the timeline
  // moves to its end, the listener turns Follow on, as after a scroll to
  // the end by hand.
  if (App.ganttFollow && top < end - 30) {
    App.ganttFollow = false;
    $('#gfollowBtn').classList.remove('on');
  }
  wrap.scrollTop = top;
  // sideways, move only for a bar that starts out of view, and only as far
  // as it needs: in a narrow pane, each step pushes the names out
  const x = r.bar.x.baseVal.value;
  if (x < wrap.scrollLeft) wrap.scrollLeft = Math.max(0, x - 24);
  else if (x > wrap.scrollLeft + wrap.clientWidth - 48)
    wrap.scrollLeft = x - wrap.clientWidth + 48;
  r.bar.classList.add('flash');
  setTimeout(() => r.bar.classList.remove('flash'), 2000);
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

// the name of one row: the shown parts, with the words that many names
// share in muted tspans, so that the part that differs stands out
function nameParts(tn, mark, f, ranges) {
  tn.textContent = mark;
  let run = '', muted = false;
  const flush = () => {
    if (!run) return;
    if (muted) svgEl('tspan', { class: 'gc' }, tn).textContent = run;
    else tn.append(run);
    run = '';
  };
  const put = (ch, m) => {
    if (m !== muted) { flush(); muted = m; }
    run += ch;
  };
  ranges.forEach(([a, b], i) => {
    if (i) put('…', false);
    for (let k = a; k < b; k++) put(f.text[k], f.mask[k] === '1');
  });
  if (ranges[ranges.length - 1][1] < f.text.length) put('…', false);
  flush();
}

export function initGanttPan() {
  // drag anywhere in the timeline to pan it, like the graph
  const wrap = $('#ganttwrap');
  let drag = null;
  wrap.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    // a press starts fresh: a drag that lost its release must not act now
    if (drag) {
      drag = null;
      wrap.classList.remove('panning');
    }
    if (ev.target.classList?.contains('gsplit')) {
      startResize(ev, wrap);
      return;
    }
    // a press on a scrollbar of the timeline is not a press on its rows
    const box = wrap.getBoundingClientRect();
    if (ev.clientX >= box.left + wrap.clientLeft + wrap.clientWidth
        || ev.clientY >= box.top + wrap.clientTop + wrap.clientHeight) return;
    drag = { x: ev.clientX, y: ev.clientY,
             sl: wrap.scrollLeft, st: wrap.scrollTop, moved: 0,
             name: ev.target.closest?.('.gbar, .gname, .gref, .gdelta')?.dataset?.name
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
    if (drag.moved <= 4 && ev.type === 'pointerup') {
      // the same rules as the graph: a click selects the package and opens
      // its log, and the graph flies to it in the side-by-side view (the
      // timeline stays where the user put it). Ctrl/Cmd/Shift+click adds
      // the package to the selection or takes it out. A click on empty
      // space clears the selection. With the key down it was a miss, and
      // the selection that the user builds stays.
      const add = ev.ctrlKey || ev.metaKey || ev.shiftKey;
      if (!drag.name) { if (!add) clearSelection(); }
      else if (add) selectPkg(drag.name, true);
      else pickPkg(drag.name, { source: 'timeline' });
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
  $('#gcmpSelect').value = cmpKey;
  $('#gcmpSelect').onchange = ev => setCompare(ev.target.value);
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
// the previous run arrives with the graph, and a new build brings new runs
on('graph', () => {
  resolveCmp();
  fillCompareRuns();
  markSelection();  // the graph brought new dependency chains
});
on('selection-changed', markSelection);
on('compare', key => setCompare(key));
