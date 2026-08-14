import { on } from './bus.js';
import { fitGraph, setViewBox } from './camera.js';
import { GS, runGraphSearch } from './gsearch.js';
import { mode } from './modes.js';
import { App } from './state.js';
import { $, fmtDur, svgEl } from './util.js';

/* ---------------- graph ---------------- */

export function computePrefix() {
  const names = Object.keys(App.graph).filter(n => App.graph[n].in_build);
  const freq = {};
  for (const n of names) {
    const i = n.indexOf('_');
    if (i > 0) { const t = n.slice(0, i + 1); freq[t] = (freq[t] || 0) + 1; }
  }
  const best = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
  App.prefix = (best && best[1] > names.length * 0.5) ? best[0] : '';
  $('#prefixHint').textContent = App.prefix
    ? `“${App.prefix}” prefix hidden in labels` : '';
}

export const measureCtx = document.createElement('canvas').getContext('2d');
measureCtx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export function label(name) {
  return App.prefix && name.startsWith(App.prefix) ? name.slice(App.prefix.length) : name;
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

export function edgePathD(na, nb) {
  const x1 = na.x + na.w, y1 = na.y, x2 = nb.x, y2 = nb.y;
  const dx = Math.max(24, Math.min(60, (x2 - x1) / 2));
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

export function renderGraph() {
  const svg = $('#graph');
  svg.innerHTML = '';
  App.nodeEls.clear();
  App.edgeList = [];
  if (!App.lay || App.lay.nodes.size === 0) return;
  const { nodes, edges, H } = App.lay;

  const defs = svgEl('defs', {}, svg);
  defs.innerHTML = `<radialGradient id="glowGrad">
    <stop offset="0" class="gs0"/>
    <stop offset="0.55" class="gs1"/>
    <stop offset="1" class="gs2"/>
  </radialGradient>`;
  App.glowLayer = svgEl('g', { id: 'glowlayer' }, svg);  // halos, backmost
  App.glowEls = new Map();
  const gE = svgEl('g', {}, svg);
  const gP = svgEl('g', { id: 'pktlayer' }, svg);  // flow particles, above edges
  const gN = svgEl('g', {}, svg);

  edges.forEach(([a, b], i) => {
    const p = svgEl('path', {
      class: 'edge', id: 'ge' + i,
      d: edgePathD(nodes.get(a), nodes.get(b)),
    }, gE);
    App.edgeList.push({ a, b, el: p, id: 'ge' + i, idx: i, flow: null });
  });

  for (const [name, n] of nodes) {
    const g = svgEl('g', {
      class: 'node', transform: `translate(${n.x},${n.y - H / 2})`,
    }, gN);
    g.dataset.name = name;
    const inner = svgEl('g', { class: 'inner' }, g);
    svgEl('rect', { class: 'box', width: n.w, height: H, rx: 5 }, inner);
    svgEl('rect', { class: 'pbar', width: 0, height: H, rx: 5 }, inner);
    const t = svgEl('text', { x: 9, y: H / 2 + 0.5 }, inner);
    t.textContent = label(name);
    App.nodeEls.set(name, g);
  }

  updateNodes();
  if (GS.q) runGraphSearch();  // recompute matches for the new node set
  if (App.vb) setViewBox(App.vb);
  else fitGraph();
  mode().onLayout?.();
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

export function syncGlow() {
  // a faint accent halo behind every building package, on the backmost layer
  if (!App.glowLayer || !App.lay) return;
  const want = new Set();
  for (const [name, p] of Object.entries(App.pkgs)) {
    if (p.s !== 'building') continue;
    const n = App.lay.nodes.get(name);
    if (!n) continue;
    want.add(name);
    let el = App.glowEls.get(name);
    if (!el) {
      el = svgEl('ellipse', { class: 'glow', fill: 'url(#glowGrad)' },
                 App.glowLayer);
      el.style.animationDelay = `-${(Math.random() * 2.6).toFixed(2)}s`;
      App.glowEls.set(name, el);
    }
    el.setAttribute('cx', n.x + n.w / 2);
    el.setAttribute('cy', n.y);
    el.setAttribute('rx', n.w / 2 + 70);
    el.setAttribute('ry', 62);
  }
  for (const [name, el] of App.glowEls)
    if (!want.has(name)) { el.remove(); App.glowEls.delete(name); }
}

export function updateNodes() {
  if (!App.nodeEls.size) return;
  if (GS.states.size) runGraphSearch();  // states move: refresh the chips
  const { failed, doomed } = computeDoomed();
  const next = computeNext();
  App.doomedSet = doomed;
  App.nextSet = next;
  for (const [name, g] of App.nodeEls) {
    const p = App.pkgs[name];
    const inBuild = App.graph?.[name]?.in_build;
    let cls = 'node ';
    if (!p) cls += inBuild ? 'waiting' : 'excluded';
    else cls += p.s;
    if (doomed.has(name)) cls += ' doomed';
    if (next.has(name)) cls += ' next';
    if (g.classList.contains('hl')) cls += ' hl';  // keep the hover highlight
    if (GS.set?.has(name)) cls += ' smatch';       // keep the search highlight
    if (g.getAttribute('class') !== cls) g.setAttribute('class', cls);
    const inner = g.firstChild;
    if (p?.s === 'building' && !inner.style.animationDelay) {
      // desync the breathing so the frontier shimmers instead of blinking
      inner.style.animationDelay = `-${(Math.random() * 1.5).toFixed(2)}s`;
    }
    const bar = inner.children[1];
    const w = App.lay.nodes.get(name)?.w || 40;
    const pct = p && p.s === 'building' && p.pct != null ? p.pct : 0;
    bar.setAttribute('width', pct ? Math.max(6, w * pct / 100).toFixed(1) : 0);
  }
  for (const e of App.edgeList) {
    const sa = App.pkgs[e.a]?.s, sb = App.pkgs[e.b]?.s;
    let ec = 'edge';
    if (doomed.has(e.b) && (doomed.has(e.a) || failed.has(e.a))) ec += ' doomed';
    else if (next.has(e.b) && sa === 'building') ec += ' feed';
    else if (sb === 'building') ec += ' active';       // feeds a live build
    else if (sa === 'done' && sb === 'done') ec += ' edone';
    if (e.el.classList.contains('hl')) ec += ' hl';
    e.cls = ec;
    if (e.el.getAttribute('class') !== ec) e.el.setAttribute('class', ec);
    setEdgeFlow(e, ec.includes(' active') && App.layoutMode !== '3d');
  }
  syncGlow();
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
export const XLINK = 'http://www.w3.org/1999/xlink';

export const FLOW_SPEED = 110;    // svg units per second: constant velocity on every edge
export const FLOW_SPACING = 130;  // svg units between droplets: constant density

export function setEdgeFlow(e, on) {
  // droplets that travel the edge curve into a building package
  if (on && !e.flow) {
    if (e.len == null) e.len = e.el.getTotalLength();
    const dur = e.len / FLOW_SPEED;
    const n = Math.min(12, Math.max(1, Math.round(e.len / FLOW_SPACING)));
    const g = svgEl('g', { class: 'pktg' }, $('#pktlayer'));
    if (e.el.classList.contains('hl')) g.classList.add('hl');
    const jitter = (e.idx % 7) * 0.23;
    for (let i = 0; i < n; i++) {
      const c = svgEl('circle', { class: 'pkt', r: 2.2 }, g);
      const am = svgEl('animateMotion', {
        dur: dur.toFixed(2) + 's', repeatCount: 'indefinite',
        begin: `${(-(i * dur / n + jitter)).toFixed(2)}s`,
      }, c);
      const mp = svgEl('mpath', { href: '#' + e.id }, am);
      mp.setAttributeNS(XLINK, 'xlink:href', '#' + e.id);
    }
    e.flow = g;
  } else if (!on && e.flow) {
    e.flow.remove();
    e.flow = null;
  }
}

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

export function hoverFocus(name) {
  if (edgeFocus !== name) {  // edges: instant
    edgeFocus = name;
    const chain = chainSetFor(name);
    $('#graph').classList.add('efocus');
    for (const e of App.edgeList) {
      const on = chain.has(e.a) && chain.has(e.b);
      e.el.classList.toggle('hl', on);
      if (e.flow) e.flow.classList.toggle('hl', on);
    }
  }
  if (nodeFocus === name) {  // nodes: rest delay, then eased dim
    clearTimeout(nodeFocusPending);
    nodeFocusPending = null;
    return;
  }
  clearTimeout(nodeFocusPending);
  nodeFocusPending = setTimeout(() => {
    nodeFocusPending = null;
    nodeFocus = name;
    const chain = chainSetFor(name);
    $('#graph').classList.add('nfocus');
    for (const [n, g] of App.nodeEls) g.classList.toggle('hl', chain.has(n));
  }, 280);
}

export function clearFocus() {
  clearTimeout(nodeFocusPending);
  nodeFocusPending = null;
  if (edgeFocus !== null) {
    edgeFocus = null;
    $('#graph').classList.remove('efocus');
    for (const e of App.edgeList) {
      e.el.classList.remove('hl');
      if (e.flow) e.flow.classList.remove('hl');
    }
  }
  if (nodeFocus !== null) {
    nodeFocus = null;
    $('#graph').classList.remove('nfocus');
    for (const [, g] of App.nodeEls) g.classList.remove('hl');
  }
}

/* tooltip */
export function showNodeTooltip(name, ev) {
  const p = App.pkgs[name];
  const meta = App.graph?.[name] || {};
  const rows = [];
  if (p) {
    let st = p.s;
    if (p.s === 'building' && p.ph) st += ` · ${p.ph}` + (p.pct != null ? ` ${p.pct}%` : '');
    if (p.s === 'failed') st += ` · rc ${p.rc ?? '?'}`;
    rows.push(`state <b>${st}</b>`);
    const dur = p.t1 ? p.t1 - p.t0
      : p.t0 && App.active ? (Date.now() / 1000 - p.t0) : null;
    if (dur != null) {
      let row = `time <b>${fmtDur(dur)}</b>`;
      const prevDur = App.prev?.durations?.[name];
      if (prevDur != null) {
        row += ` · last build ${fmtDur(prevDur)}`;
        if (dur > prevDur * 1.5 && dur - prevDur > 10)
          row += ' <span class="treg">slower</span>';
      }
      rows.push(row);
    }
    if (p.err) rows.push(`stderr lines <b>${p.err}</b>`);
  } else {
    rows.push(meta.in_build ? 'state <b>pending</b>' : 'not part of this build');
  }
  if (App.nodeEls.get(name)?.classList.contains('doomed'))
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
  computePrefix();
  buildGraphView();
});

on('state', () => updateNodes());
