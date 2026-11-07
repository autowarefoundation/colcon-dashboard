import { emit, on } from './bus.js';
import { fitGraph, setViewBox } from './camera.js';
import { requestDraw } from './draw.js';
import { GS, runGraphSearch } from './gsearch.js';
import { mode } from './modes.js';
import { App } from './state.js';
import { $, esc, failNote, fmtDur, WS } from './util.js';

/* ---------------- graph ---------------- */

/* Label prefixes: a prefix that most packages share, such as autoware_,
   hides in the labels. The choice is per workspace and per browser:
   {mode: 'auto'} (the most common first word, when more than half of
   the packages share it), {mode: 'off'}, or {mode: 'custom', list}. */
const PREFIX_KEY = 'cmc-prefix:' + (WS || '');

function loadPrefixPref() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFIX_KEY));
    if (p && (p.mode === 'off' || (p.mode === 'custom' && Array.isArray(p.list))))
      return p;
  } catch (e) { /* a bad value falls back to auto */ }
  return { mode: 'auto' };
}

// returns true when the hidden prefixes changed
export function computePrefix() {
  const before = (App.prefixes || []).join(',');
  const names = Object.keys(App.graph).filter(n => App.graph[n].in_build);
  const freq = {};
  for (const n of names) {
    const i = n.indexOf('_');
    if (i > 0) { const t = n.slice(0, i + 1); freq[t] = (freq[t] || 0) + 1; }
  }
  // the suggestions in the prefix menu: first words that 3+ packages share
  App.prefixCands = Object.entries(freq).filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1]).slice(0, 6);
  App.prefixTotal = names.length;
  const best = App.prefixCands[0];
  App.prefixAuto = best && best[1] > names.length * 0.5 ? best[0] : '';
  const pref = loadPrefixPref();
  App.prefixMode = pref.mode;
  App.prefixes = (pref.mode === 'custom' ? pref.list
    : pref.mode === 'off' ? [] : App.prefixAuto ? [App.prefixAuto] : [])
    .slice().sort((a, b) => b.length - a.length);  // the longest match wins
  // a re-render while the user types in it would take the focus away
  if (!$('#setPrefix').contains(document.activeElement)) renderPrefixSettings();
  return App.prefixes.join(',') !== before;
}

function setPrefixPref(pref) {
  try { localStorage.setItem(PREFIX_KEY, JSON.stringify(pref)); } catch (e) { /* private mode */ }
  computePrefix();
  emit('labels-changed');
}

function parsePrefixList(text) {
  return [...new Set(text.split(/[\s,]+/).filter(Boolean))];
}

// the "Package names" section of the settings panel
function renderPrefixSettings() {
  const pop = $('#setPrefix');
  const auto = App.prefixAuto
    ? `<span class="ppmuted">now “${esc(App.prefixAuto)}”, ${App.prefixCands[0][1]} of ${App.prefixTotal}</span>`
    : '<span class="ppmuted">no common prefix found</span>';
  const custom = App.prefixMode === 'custom' ? App.prefixes : [];
  pop.innerHTML = `
    <label><input type="radio" name="pfx" value="auto"> Detect it ${auto}</label>
    <label><input type="radio" name="pfx" value="off"> Show the full names</label>
    <label><input type="radio" name="pfx" value="custom"> Hide these prefixes:</label>
    <input id="prefixInput" type="text" spellcheck="false" autocomplete="off"
           placeholder="autoware_, tier4_" value="${esc(custom.join(', '))}">
    ${App.prefixCands.length ? `<div class="ppsug">${App.prefixCands.map(([p, c]) =>
      `<button data-p="${esc(p)}" class="${custom.includes(p) ? 'on' : ''}">${esc(p)} <small>${c}</small></button>`
    ).join('')}</div>` : ''}
    <div class="ppnote">The graph, the timeline, the log tabs, and the failures use the short names. The pane headers and the tooltips show the full names.</div>`;
  pop.querySelector(`input[value="${App.prefixMode}"]`).checked = true;
  const input = pop.querySelector('#prefixInput');
  const applyCustom = () => setPrefixPref({ mode: 'custom', list: parsePrefixList(input.value) });
  pop.querySelectorAll('input[name="pfx"]').forEach(r => r.onchange = () => {
    if (r.value === 'custom') {
      // start the list from what the labels hide now
      if (!input.value.trim()) input.value = App.prefixes.join(', ');
      applyCustom();
    } else setPrefixPref({ mode: r.value });
    renderPrefixSettings();
    if (r.value === 'custom') $('#prefixInput').focus();
  });
  input.oninput = () => {
    pop.querySelector('input[value="custom"]').checked = true;
    applyCustom();
    pop.querySelectorAll('.ppsug button').forEach(b =>
      b.classList.toggle('on', App.prefixes.includes(b.dataset.p)));
  };
  pop.querySelectorAll('.ppsug button').forEach(b => b.onclick = () => {
    const list = parsePrefixList(input.value);
    const i = list.indexOf(b.dataset.p);
    if (i >= 0) list.splice(i, 1); else list.push(b.dataset.p);
    input.value = list.join(', ');
    input.oninput();
  });
}

export function initPrefixMenu() {
  renderPrefixSettings();
}

export const measureCtx = document.createElement('canvas').getContext('2d');
measureCtx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export function label(name) {
  for (const p of App.prefixes)
    if (name.length > p.length && name.startsWith(p)) return name.slice(p.length);
  return name;
}

export function buildGraphView() {
  if (!App.graph) return;
  const pkgs = App.graph;
  const names = Object.keys(pkgs)
    .filter(n => App.scope === 'all' || pkgs[n].in_build);
  const nameSet = new Set(names);

  const adjIn = new Map(names.map(n => [n, []]));
  const adjOut = new Map(names.map(n => [n, []]));
  const edges = [];
  for (const n of names) {
    for (const d of pkgs[n].deps || []) {
      if (!nameSet.has(d)) continue;
      edges.push([d, n]);
      adjOut.get(d).push(n);
      adjIn.get(n).push(d);
    }
  }
  App.adjIn = adjIn; App.adjOut = adjOut;

  // --- layering: longest path from the dependency roots (Kahn) ---
  const layer = new Map();
  const indeg = new Map(names.map(n => [n, adjIn.get(n).length]));
  const queue = names.filter(n => indeg.get(n) === 0);
  const order = [];
  while (queue.length) {
    const n = queue.shift();
    order.push(n);
    let l = 0;
    for (const d of adjIn.get(n)) l = Math.max(l, (layer.get(d) ?? -1) + 1);
    layer.set(n, l);
    for (const m of adjOut.get(n)) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
  }
  for (const n of names) {  // cycle leftovers (package.xml quirks)
    if (!layer.has(n)) {
      let l = 0;
      for (const d of adjIn.get(n)) if (layer.has(d)) l = Math.max(l, layer.get(d) + 1);
      layer.set(n, l);
    }
  }

  const nLayers = Math.max(0, ...[...layer.values()]) + 1;
  const layers = Array.from({ length: nLayers }, () => []);
  for (const n of names) layers[layer.get(n)].push(n);
  for (const arr of layers) arr.sort();

  // --- crossing reduction: barycenter sweeps on neighbor row fractions ---
  const pos = new Map();
  const setPos = () => layers.forEach(arr => arr.forEach((n, i) =>
    pos.set(n, arr.length > 1 ? i / (arr.length - 1) : 0.5)));
  setPos();
  const bary = (n, neigh) => {
    const ns = neigh.get(n);
    if (!ns.length) return pos.get(n);
    return ns.reduce((a, m) => a + pos.get(m), 0) / ns.length;
  };
  for (let it = 0; it < 4; it++) {
    const [neigh, from, to, step] = it % 2 === 0
      ? [adjIn, 1, layers.length, 1] : [adjOut, layers.length - 2, -1, -1];
    for (let l = from; l !== to; l += step) {
      layers[l].sort((a, b) => bary(a, neigh) - bary(b, neigh) || a.localeCompare(b));
      setPos();
    }
  }

  // --- geometry ---
  const H = 22, PITCH = 30, GAP = 90;
  const nodes = new Map();
  const colW = layers.map(arr => Math.max(40,
    ...arr.map(n => Math.ceil(measureCtx.measureText(label(n)).width) + 18)));
  let x = 0;
  layers.forEach((arr, l) => {
    const w = colW[l];
    arr.forEach((n, i) => {
      nodes.set(n, {
        name: n, x, ax: x, y: (i - (arr.length - 1) / 2) * PITCH,
        w: Math.ceil(measureCtx.measureText(label(n)).width) + 18, layer: l,
      });
    });
    x += w + GAP;
  });
  App.lay = { nodes, edges, H };
  renderGraph();
}

// The graph draws on a canvas (draw.js), from the layout and from the
// flags set here: per node st (its state), doomed, next, pct, and hl (in
// the focus chain); per edge kind and hl.
export function renderGraph() {
  App.edgeList = [];
  if (!App.lay || App.lay.nodes.size === 0) { requestDraw(); return; }
  App.edgeList = App.lay.edges.map(([a, b], i) =>
    ({ a, b, idx: i, kind: '', cls: 'edge', hl: false }));
  updateNodes();
  if (GS.q) runGraphSearch();  // recompute matches for the new node set
  // the new nodes carry no focus yet: show the selection on them again
  edgeFocus = nodeFocus = null;
  focusSelection();
  if (App.vb) setViewBox(App.vb);
  else fitGraph();
  mode().onLayout?.();
  requestDraw();
}

export function computeDoomed() {
  // everything downstream of a failed package can no longer build
  const failed = new Set(
    Object.keys(App.pkgs).filter(n => App.pkgs[n].s === 'failed'));
  const doomed = new Set();
  const stack = [...failed];
  while (stack.length) {
    const n = stack.pop();
    for (const m of App.adjOut.get(n) || []) {
      if (!doomed.has(m) && !failed.has(m)) { doomed.add(m); stack.push(m); }
    }
  }
  return { failed, doomed };
}

export function computeNext() {
  // waiting/ready packages whose remaining deps are all done or building now:
  // they start as soon as the current frontier finishes
  const next = new Set();
  for (const [name, p] of Object.entries(App.pkgs)) {
    if (p.s !== 'waiting' && p.s !== 'ready') continue;
    let ok = true;
    for (const d of App.adjIn.get(name) || []) {
      const ds = App.pkgs[d]?.s;
      if (ds && ds !== 'done' && ds !== 'building') { ok = false; break; }
    }
    if (ok) next.add(name);
  }
  return next;
}

export function updateNodes() {
  if (!App.lay) return;
  if (GS.states.size) runGraphSearch(true);  // states move: refresh chips
  const { failed, doomed } = computeDoomed();
  const next = computeNext();
  App.doomedSet = doomed;
  App.nextSet = next;
  for (const [name, n] of App.lay.nodes) {
    const p = App.pkgs[name];
    n.st = p ? p.s : App.graph?.[name]?.in_build ? 'waiting' : 'excluded';
    n.doomed = doomed.has(name);
    n.next = next.has(name);
    n.pct = p && p.s === 'building' && p.pct != null ? p.pct : 0;
    // desync the breathing, so the frontier shimmers instead of blinking
    if (n.st === 'building' && n.ph == null) n.ph = Math.random();
  }
  for (const e of App.edgeList) {
    const sa = App.pkgs[e.a]?.s, sb = App.pkgs[e.b]?.s;
    let kind = '';
    if (doomed.has(e.b) && (doomed.has(e.a) || failed.has(e.a))) kind = 'doomed';
    else if (next.has(e.b) && sa === 'building') kind = 'feed';
    else if (sb === 'building') kind = 'active';       // feeds a live build
    else if (sa === 'done' && sb === 'done') kind = 'edone';
    e.kind = kind;
    e.cls = kind ? 'edge ' + kind : 'edge';  // g3d.js reads the class words
  }
  requestDraw();
}

/* ---------------- force layout mode ----------------
   Live spring simulation over the same nodes: Barnes-Hut repulsion,
   degree-weighted link springs, an x-anchor to each node's dependency
   layer (keeps left-to-right causality), and label-aware collision. */

/* chain highlight */
export function chainOf(name) {
  const seen = new Set([name]);
  const walk = (start, adj) => {
    const st = [start];
    while (st.length) {
      const n = st.pop();
      for (const m of adj.get(n) || []) if (!seen.has(m)) { seen.add(m); st.push(m); }
    }
  };
  walk(name, App.adjIn);
  walk(name, App.adjOut);
  return seen;
}
export const FLOW_SPEED = 110;    // world units per second: constant velocity on every edge
export const FLOW_SPACING = 130;  // world units between droplets: constant density

/* Hover focus, split in two: the edge chain reacts instantly, like the
   tooltip, while the node dim engages only after the pointer rests and
   fades eased, so sweeping the mouse never strobes the whole graph. */

export let edgeFocus = null;
export let nodeFocus = null;
export let nodeFocusPending = null;
export let chainCache = { name: null, set: null };

export function chainSetFor(name) {
  if (chainCache.name !== name) chainCache = { name, set: chainOf(name) };
  return chainCache.set;
}

// The focus shows a dependency chain: its edges at once, its nodes after a
// rest, with the rest of the graph faded. A hover shows the chain of one
// package. A selection (click, Ctrl+click) keeps the chains of the selected
// packages in focus until it is cleared; a hover over another package
// previews that one meanwhile.
function chainOfAll(names) {
  if (names.length === 1) return chainSetFor(names[0]);
  const all = new Set();
  for (const n of names) for (const m of chainSetFor(n)) all.add(m);
  return all;
}

function focusEdges(key, chain) {
  if (edgeFocus === key) return;
  edgeFocus = key;
  for (const e of App.edgeList) e.hl = chain.has(e.a) && chain.has(e.b);
  requestDraw();
}

function focusNodes(key, chain) {
  nodeFocus = key;
  for (const [name, n] of App.lay.nodes) n.hl = chain.has(name);
  requestDraw();
}

export function hoverFocus(name) {
  const key = 'h:' + name;
  focusEdges(key, chainSetFor(name));  // edges: instant
  if (nodeFocus === key) {  // nodes: rest delay, then eased dim
    clearTimeout(nodeFocusPending);
    nodeFocusPending = null;
    return;
  }
  clearTimeout(nodeFocusPending);
  nodeFocusPending = setTimeout(() => {
    nodeFocusPending = null;
    focusNodes(key, chainSetFor(name));
  }, 280);
}

// the selection's focus, at once: a click is a deliberate choice
function focusSelection() {
  const names = [...App.selected].filter(n => App.lay?.nodes.has(n));
  if (!names.length) return false;
  const key = 's:' + names.sort().join(',');
  const chain = chainOfAll(names);
  focusEdges(key, chain);
  focusNodes(key, chain);
  return true;
}

export function clearFocus() {
  clearTimeout(nodeFocusPending);
  nodeFocusPending = null;
  if (focusSelection()) return;  // back to the selection, not to nothing
  if (edgeFocus !== null) {
    edgeFocus = null;
    for (const e of App.edgeList) e.hl = false;
  }
  if (nodeFocus !== null) {
    nodeFocus = null;
    for (const n of App.lay?.nodes.values() || []) n.hl = false;
  }
  requestDraw();
}

// click: select only this package; additive (Ctrl/Cmd/Shift+click): add
// it to the selection, or take it out again
export function selectPkg(name, additive = false) {
  if (!additive) App.selected = new Set([name]);
  else if (App.selected.has(name)) App.selected.delete(name);
  else App.selected.add(name);
  clearFocus();  // shows the selection, or clears the focus when it is empty
  emit('selection-changed');
}

export function clearSelection() {
  if (!App.selected.size) return;
  App.selected = new Set();
  clearFocus();
  emit('selection-changed');
}


/* tooltip */
export function showNodeTooltip(name, ev) {
  const p = App.pkgs[name];
  const meta = App.graph?.[name] || {};
  const rows = [];
  if (p) {
    let st = p.s;
    if (p.s === 'building' && p.ph) st += ` · ${p.ph}` + (p.pct != null ? ` ${p.pct}%` : '');
    if (p.s === 'failed') st += ` · ${failNote(p)}`;
    rows.push(`state <b>${st}</b>`);
    const dur = p.t1 ? p.t1 - p.t0
      : p.t0 && App.active ? (Date.now() / 1000 - p.t0) : null;
    if (dur != null) {
      let row = `time <b>${fmtDur(dur)}</b>`;
      const prevDur = App.prev?.durations?.[name];
      if (prevDur != null) {
        // the median of the last runs, or the last run when there is one
        row += App.prev.runs > 1 ? ` · usually ${fmtDur(prevDur)}` : ` · last build ${fmtDur(prevDur)}`;
        if (dur > prevDur * 1.5 && dur - prevDur > 10)
          row += ' <span class="treg">slower</span>';
      }
      rows.push(row);
    }
    if (p.err) rows.push(`stderr lines <b>${p.err}</b>`);
    if (p.warn) rows.push(`warnings <b>${p.warn}</b>`);
    if (p.tr) {
      const bad = p.tr.f + p.tr.e;
      rows.push(`tests <b>${p.tr.t}</b>` + (bad ? ` · <b>${bad} failed</b>` : '')
                + (p.tr.s ? ` · ${p.tr.s} skipped` : ''));
    }
    if (App.prev?.failed) {
      const was = App.prev.failed.includes(name);
      if (p.s === 'failed' && !was) rows.push('<b>new failure</b> since the last run');
      else if (p.s === 'done' && was) rows.push('<b>fixed</b>: it failed in the last run');
    }
    if (p.s === 'failed' && p.cmd) rows.push(`failed command <span class="mono">${esc(p.cmd)}</span>`);
  } else {
    rows.push(meta.in_build ? 'state <b>pending</b>' : 'not part of this build');
  }
  if (App.doomedSet?.has(name))
    rows.push('<b>blocked</b>: a failed package is upstream');
  if (meta.build_type) rows.push(`type <b>${meta.build_type}</b>`);
  if (meta.path) rows.push(`<span class="mono">${meta.path}</span>`);
  const tip = $('#tooltip');
  tip.innerHTML = `<div class="tname">${name}</div>` +
    rows.map(r => `<div class="trow">${r}</div>`).join('');
  tip.hidden = false;
}
export function hideTooltip() { $('#tooltip').hidden = true; }

on('graph', () => {
  // new prefixes relabel the tabs and the timeline too (labels-changed),
  // and the graph rebuilds in its own labels-changed handler below
  if (computePrefix()) emit('labels-changed');
  else buildGraphView();
});

on('state', () => updateNodes());

on('labels-changed', () => buildGraphView());

// Esc clears the selection, unless an overlay or a text box takes it
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape' || !App.selected.size) return;
  if (ev.target.closest?.('input, textarea, select')) return;
  if (document.querySelector('#bpick:not([hidden]), #confirm:not([hidden]), #help:not([hidden])')) return;
  clearSelection();
});

