'use strict';

const $ = s => document.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

const App = {
  buildId: null,
  graph: null,          // /api/graph packages
  graphJobCount: 0,
  lastGraphFetch: 0,
  pkgs: {},             // /api/state packages
  active: false,
  total: 0,
  scope: 'build',       // 'build' | 'all'
  view: 'graph',
  ganttFollow: true,
  layoutMode: localStorage.getItem('cmc-layout') || 'layered',
  prefix: '',
  lay: null,
  nodeEls: new Map(),
  edgeList: [],
  adjIn: new Map(),
  adjOut: new Map(),
  vb: null,             // graph viewBox
  elapsedBase: 0, elapsedAt: 0, buildStarted: 0,
  failedSeen: new Set(),
  panes: new Map(),
  activePane: null,
  pollTick: 0,
};

/* ---------------- theme ---------------- */

function initTheme() {
  const saved = localStorage.getItem('cmc-theme') || 'auto';
  applyTheme(saved);
  $('#themeBtn').onclick = () => {
    const cur = localStorage.getItem('cmc-theme') || 'auto';
    const next = cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto';
    localStorage.setItem('cmc-theme', next);
    applyTheme(next);
  };
}
function applyTheme(mode) {
  if (mode === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
  $('#themeBtn').textContent = mode === 'auto' ? '◐' : mode === 'light' ? '☀' : '☾';
  if (G3.colors) tokens3d();  // refresh the 3D canvas palette
}

/* ---------------- polling ---------------- */

async function pollState() {
  let s;
  try {
    s = await (await fetch('/api/state')).json();
  } catch (e) {
    setBadge('offline', App.stopped
      ? 'STOPPED — the server was shut down'
      : 'OFFLINE — the server does not answer');
    return;
  }
  if (s.error) {
    setBadge('idle', 'WAITING');
    $('#buildid').textContent = s.error;
    updateSysMeters(s.sys);
    return;
  }
  if (s.build_id !== App.buildId) {
    const first = App.buildId === null;
    App.buildId = s.build_id;
    App.failedSeen = new Set(
      Object.entries(s.packages).filter(([, p]) => p.s === 'failed').map(([n]) => n));
    if (!first) {
      toast(`New build started: <b>${s.build_id}</b>`, 'info');
      for (const pane of App.panes.values()) resetPane(pane);
    }
    await fetchGraph();
  }
  App.pkgs = s.packages;
  App.active = s.active;
  App.total = s.total;
  App.buildStarted = s.build_started;
  App.elapsedBase = s.elapsed;
  App.elapsedAt = Date.now();
  applyState(s);
  // jobs can register moments after the graph was fetched
  if (App.graphJobCount !== s.total && Date.now() - App.lastGraphFetch > 10000) {
    await fetchGraph();
    applyState(s);
  }
}

async function fetchGraph() {
  const g = await (await fetch('/api/graph')).json();
  App.graph = g.packages;
  App.lastGraphFetch = Date.now();
  App.graphJobCount = Object.values(g.packages).filter(p => p.in_build).length;
  computePrefix();
  buildGraphView();
}

/* ---------------- header + tiles ---------------- */

function setBadge(cls, text) {
  const b = $('#livebadge');
  b.className = 'badge ' + (cls === 'live' ? 'live'
    : cls === 'failed' ? 'failed' : cls === 'offline' ? 'off' : '');
  b.innerHTML = `<span class="dot">●</span> ${text}`;
  document.body.classList.toggle('offline', cls === 'offline');
}

function fmtDur(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
           : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtGB(kb) {
  const gb = kb / 1048576;
  return gb >= 100 ? Math.round(gb) : gb.toFixed(1).replace(/\.0$/, '');
}

function setMeter(id, pct, text, warnAt, critAt, title) {
  const el = $(id);
  const fill = el.querySelector('.smfill');
  fill.style.width = Math.min(100, pct) + '%';
  fill.classList.toggle('warn', pct >= warnAt && pct < critAt);
  fill.classList.toggle('crit', pct >= critAt);
  el.classList.toggle('crit', pct >= critAt);
  el.querySelector('.v').textContent = text;
  if (title) el.title = title;
}

function updateSysMeters(sys) {
  const box = $('#sysmeters');
  if (!sys) { box.hidden = true; return; }
  box.hidden = false;
  if (sys.cpu != null)
    setMeter('#sm-cpu', sys.cpu, Math.round(sys.cpu) + '%', 85, 96,
             `CPU ${sys.cpu}% · load ${sys.load ?? '?'}`);
  const grid = document.querySelector('#sm-cores .coregrid');
  if (sys.cores && sys.cores.length) {
    $('#sm-cores').hidden = false;
    while (grid.children.length < sys.cores.length)
      grid.appendChild(Object.assign(document.createElement('div'),
                                     { className: 'core' }));
    while (grid.children.length > sys.cores.length) grid.lastChild.remove();
    sys.cores.forEach((p, i) => {
      const cell = grid.children[i];
      cell.style.background =
        `color-mix(in srgb, var(--accent) ${Math.round(p)}%, var(--grid))`;
      cell.title = `core ${i}: ${Math.round(p)}%`;
    });
  } else {
    $('#sm-cores').hidden = true;
  }
  if (sys.mem_total) {
    const pct = 100 * sys.mem_used / sys.mem_total;
    setMeter('#sm-ram', pct, `${fmtGB(sys.mem_used)}/${fmtGB(sys.mem_total)}G`,
             75, 90, `RAM ${pct.toFixed(1)}% used`);
  }
  const swapEl = $('#sm-swap');
  if (sys.swap_total) {
    swapEl.hidden = false;
    const pct = 100 * sys.swap_used / sys.swap_total;
    setMeter('#sm-swap', pct, `${fmtGB(sys.swap_used)}/${fmtGB(sys.swap_total)}G`,
             30, 70, `swap ${pct.toFixed(1)}% used`);
  } else {
    swapEl.hidden = true;
  }
}

function applyState(s) {
  const c = s.counts || {};
  const done = c.done || 0, failed = c.failed || 0, aborted = c.aborted || 0;
  const building = c.building || 0, ready = c.ready || 0, waiting = c.waiting || 0;
  const skipped = c.skipped || 0, blocked = c.blocked || 0;

  $('#ws').textContent = s.workspace;
  $('#buildid').textContent = s.build_id;
  updateSysMeters(s.sys);
  $('#workers').textContent = s.workers ? `${s.workers} workers` : '';
  if (s.active) setBadge('live', 'LIVE');
  else if (failed) setBadge('failed', 'FAILED');
  else if (done === s.total && s.total > 0) setBadge('idle', 'COMPLETE');
  else setBadge('idle', 'STOPPED');

  $('#t-done').textContent = done;
  $('#t-total').textContent = ` / ${s.total}`;
  $('#t-building').textContent = building;
  $('#t-ready').textContent = ready;
  $('#t-waiting').innerHTML = waiting + (blocked ? `<small> +${blocked} blocked</small>` : '');
  $('#t-failed').textContent = failed;
  $('#t-aborted').textContent = aborted;
  $('#t-skipped').textContent = skipped;
  const rate = s.elapsed > 30 ? (done / (s.elapsed / 60)) : null;
  $('#t-rate').innerHTML = (rate ? rate.toFixed(1) : '–') + '<small> pkg/min</small>';

  const seg = (cls, n) =>
    $(`#meter .seg.${cls}`).style.flexBasis = (s.total ? (100 * n / s.total) : 0) + '%';
  seg('done', done); seg('failed', failed); seg('aborted', aborted); seg('building', building);

  updateNodes();
  if (App.layoutMode === '3d') update3dPlanes();
  updatePaneHeads();
  if (App.view === 'gantt' && (App.pollTick++ % 2 === 0)) drawGantt();

  for (const [name, p] of Object.entries(App.pkgs)) {
    if (p.s === 'failed' && !App.failedSeen.has(name)) {
      App.failedSeen.add(name);
      toast(`<b>${name}</b> failed (rc ${p.rc ?? '?'}) — click to open its log`, '',
            () => openPane(name));
      openPane(name);
    }
  }
}

/* ---------------- graph ---------------- */

function computePrefix() {
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

const measureCtx = document.createElement('canvas').getContext('2d');
measureCtx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

function label(name) {
  return App.prefix && name.startsWith(App.prefix) ? name.slice(App.prefix.length) : name;
}

function buildGraphView() {
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

function edgePathD(na, nb) {
  const x1 = na.x + na.w, y1 = na.y, x2 = nb.x, y2 = nb.y;
  const dx = Math.max(24, Math.min(60, (x2 - x1) / 2));
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function renderGraph() {
  const svg = $('#graph');
  svg.innerHTML = '';
  App.nodeEls.clear();
  App.edgeList = [];
  if (!App.lay || App.lay.nodes.size === 0) return;
  const { nodes, edges, H } = App.lay;

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
  if (App.vb) setViewBox(App.vb);
  else fitGraph();
  if (App.layoutMode === 'force') startForce();
  else if (App.layoutMode === '3d') enter3d();
}

function computeDoomed() {
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

function computeNext() {
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

function updateNodes() {
  if (!App.nodeEls.size) return;
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
}

/* ---------------- force layout mode ----------------
   Live spring simulation over the same nodes: Barnes-Hut repulsion,
   degree-weighted link springs, an x-anchor to each node's dependency
   layer (keeps left-to-right causality), and label-aware collision. */

const Force = {
  nodes: [], links: [], alpha: 0, raf: null, dragging: null,
  REPULSE: 1600, LINK_DIST: 200, LINK_S: 0.5, AX: 0.035, AY: 0.0035,
  FRICTION: 0.6, DECAY: 0.972, MAXD2: 1300 * 1300, THETA2: 0.72,
  BASE: { REPULSE: 1600, LINK_DIST: 200, MAXD: 1300 },
};

function applySpread(m, reheat = true) {
  Force.REPULSE = Force.BASE.REPULSE * m;
  Force.LINK_DIST = Force.BASE.LINK_DIST * Math.sqrt(m);
  Force.MAXD2 = (Force.BASE.MAXD * Math.sqrt(m)) ** 2;
  if (reheat && App.layoutMode !== 'layered') {
    Force.alpha = Math.max(Force.alpha, 0.5);
    if (App.layoutMode === 'force' && !Force.raf)
      Force.raf = requestAnimationFrame(forceTick);
  }
}

function startForce(alpha = 1, is3d = false, keep = false) {
  if (!App.lay || !App.lay.nodes.size) return;
  Force.is3d = is3d;
  Force.nodes = [...App.lay.nodes.values()];
  for (const n of Force.nodes) {
    if (!keep || n.cx == null) { n.cx = n.x + n.w / 2; n.cy = n.y; }
    if (is3d) {
      if (!n.cz) n.cz = Math.random() * 300 - 150;
    } else n.cz = 0;
    n.vx = 0; n.vy = 0; n.vz = 0; n.fx = null; n.fy = null;
    n.r = Math.max(36, n.w * 0.7);
  }
  const deg = new Map();
  for (const e of App.edgeList) {
    deg.set(e.a, (deg.get(e.a) || 0) + 1);
    deg.set(e.b, (deg.get(e.b) || 0) + 1);
  }
  Force.links = App.edgeList.map(e => {
    const na = App.lay.nodes.get(e.a), nb = App.lay.nodes.get(e.b);
    const da = deg.get(e.a), db = deg.get(e.b);
    return { na, nb, s: Force.LINK_S / Math.min(da, db), bias: da / (da + db) };
  }).filter(l => l.na && l.nb);
  Force.alpha = alpha;
  if (is3d) {
    update3dPlanes(false);
    return;  // the 3D render loop steps the physics itself
  }
  if (!Force.raf) Force.raf = requestAnimationFrame(forceTick);
}

const GAP3 = 380;

function update3dPlanes(reheat = true) {
  // The wavefront: finished packages left of the plane of building ones,
  // not-yet-started ones to the right, ordered by dependency depth.
  if (!App.lay || App.layoutMode !== '3d') return;
  let maxDoneL = -1, minPendL = 1e9;
  for (const [name, n] of App.lay.nodes) {
    const s = App.pkgs[name]?.s;
    if (s === 'done') maxDoneL = Math.max(maxDoneL, n.layer);
    else if (s === 'waiting' || s === 'blocked' || s === 'skipped')
      minPendL = Math.min(minPendL, n.layer);
  }
  let changed = false, maxW = 2;
  for (const [, n] of App.lay.nodes) n.wIdx = null;
  for (const [name, n] of App.lay.nodes) {
    const s = App.pkgs[name]?.s;
    if (s === 'done') n.wIdx = -1 - (maxDoneL - n.layer);
    else if (s === 'building' || s === 'failed' || s === 'aborted') n.wIdx = 0;
    else if (s === 'ready') n.wIdx = 1;
    else if (s === 'waiting' || s === 'blocked' || s === 'skipped')
      n.wIdx = 2 + (n.layer - (minPendL === 1e9 ? 0 : minPendL));
    if (n.wIdx !== null) maxW = Math.max(maxW, n.wIdx);
  }
  for (const [, n] of App.lay.nodes) {
    if (n.wIdx === null) n.wIdx = maxW + 2;  // excluded: far right
    const ax3 = n.wIdx * GAP3;
    if (n.ax3 !== ax3) { n.ax3 = ax3; changed = true; }
  }
  if (changed && reheat) Force.alpha = Math.max(Force.alpha, 0.18);
}

function stopForce() {
  if (Force.raf) cancelAnimationFrame(Force.raf);
  Force.raf = null;
  Force.alpha = 0;
  for (const e of App.edgeList) e.len = null;  // flows use settled lengths
}

function buildQuad(nodes) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const n of nodes) {
    if (n.cx < x0) x0 = n.cx; if (n.cx > x1) x1 = n.cx;
    if (n.cy < y0) y0 = n.cy; if (n.cy > y1) y1 = n.cy;
  }
  const root = { x: x0, y: y0, s: Math.max(x1 - x0, y1 - y0) || 1,
                 m: 0, sx: 0, sy: 0, kids: null, leaf: null };
  const insert = (q, n, depth) => {
    q.m++; q.sx += n.cx; q.sy += n.cy;
    if (q.m === 1) { q.leaf = n; return; }
    if (depth > 11) return;  // clumped points: keep as aggregate
    if (!q.kids) {
      q.kids = [null, null, null, null];
      const old = q.leaf;
      q.leaf = null;
      placeInsert(q, old, depth);  // old already counted at this level
    }
    placeInsert(q, n, depth);
  };
  const placeInsert = (q, n, depth) => {
    const h = q.s / 2;
    const i = (n.cx >= q.x + h ? 1 : 0) + (n.cy >= q.y + h ? 2 : 0);
    if (!q.kids[i]) {
      q.kids[i] = { x: q.x + (i & 1 ? h : 0), y: q.y + (i & 2 ? h : 0),
                    s: h, m: 0, sx: 0, sy: 0, kids: null, leaf: null };
    }
    insert(q.kids[i], n, depth + 1);
  };
  for (const n of nodes) insert(root, n, 0);
  return root;
}

function physics3d() {
  const F = Force, alpha = F.alpha, N = F.nodes;
  for (const l of F.links) {
    let dx = l.nb.cx - l.na.cx, dy = l.nb.cy - l.na.cy, dz = l.nb.cz - l.na.cz;
    const d = Math.hypot(dx, dy, dz) || 1;
    const f = (d - F.LINK_DIST) / d * l.s * alpha;
    dx *= f; dy *= f; dz *= f;
    l.nb.vx -= dx * l.bias; l.nb.vy -= dy * l.bias; l.nb.vz -= dz * l.bias;
    l.na.vx += dx * (1 - l.bias); l.na.vy += dy * (1 - l.bias); l.na.vz += dz * (1 - l.bias);
  }
  const R = F.REPULSE * 1.3 * alpha;
  for (let i = 0; i < N.length; i++) {
    const a = N[i];
    for (let j = i + 1; j < N.length; j++) {
      const b = N[j];
      let dx = b.cx - a.cx, dy = b.cy - a.cy, dz = b.cz - a.cz;
      let d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > F.MAXD2) continue;
      if (d2 < 1) { dx = 0.5; dy = 0.5; dz = 0.5; d2 = 1; }
      const w = R / d2;
      a.vx -= dx * w; a.vy -= dy * w; a.vz -= dz * w;
      b.vx += dx * w; b.vy += dy * w; b.vz += dz * w;
      const d = Math.sqrt(d2), min = (a.r + b.r) * 0.6;
      if (d < min) {
        const push = (min - d) / d / 2;
        a.cx -= dx * push; a.cy -= dy * push; a.cz -= dz * push;
        b.cx += dx * push; b.cy += dy * push; b.cz += dz * push;
      }
    }
    a.vy += (0 - a.cy) * F.AY * alpha;
    a.vz += (0 - a.cz) * F.AY * alpha;
  }
  for (const n of N) {
    n.vy *= F.FRICTION; n.vz *= F.FRICTION;
    n.cy += n.vy; n.cz += n.vz;
    // glide toward the state plane, so plane changes animate
    if (n.ax3 != null) n.cx += (n.ax3 - n.cx) * 0.15;
    n.vx = 0;
  }
}

function forcePhysics() {
  if (Force.is3d) return physics3d();
  const F = Force, alpha = F.alpha;

  for (const l of F.links) {
    let dx = l.nb.cx - l.na.cx, dy = l.nb.cy - l.na.cy;
    const d = Math.hypot(dx, dy) || 1;
    const f = (d - F.LINK_DIST) / d * l.s * alpha;
    dx *= f; dy *= f;
    l.nb.vx -= dx * l.bias; l.nb.vy -= dy * l.bias;
    l.na.vx += dx * (1 - l.bias); l.na.vy += dy * (1 - l.bias);
  }

  const root = buildQuad(F.nodes);
  const stack = [];
  for (const n of F.nodes) {
    stack.length = 0;
    stack.push(root);
    while (stack.length) {
      const q = stack.pop();
      if (!q || !q.m) continue;
      let dx = q.sx / q.m - n.cx, dy = q.sy / q.m - n.cy;
      let d2 = dx * dx + dy * dy;
      if (q.kids && q.s * q.s > d2 * F.THETA2) { stack.push(...q.kids); continue; }
      if (q.leaf === n) continue;
      if (d2 > F.MAXD2) continue;
      if (d2 < 1) { dx = 0.5; dy = 0.5; d2 = 1; }
      const w = F.REPULSE * alpha * q.m / d2;
      n.vx -= dx * w; n.vy -= dy * w;
    }
    n.vx += (n.ax + n.w / 2 - n.cx) * F.AX * alpha;
    n.vy += (0 - n.cy) * F.AY * alpha;
  }

  for (const n of F.nodes) {
    if (n.fx != null) { n.cx = n.fx; n.cy = n.fy; n.vx = 0; n.vy = 0; continue; }
    n.vx *= F.FRICTION; n.vy *= F.FRICTION;
    n.cx += n.vx; n.cy += n.vy;
  }

  // label-aware collision: ellipses, wide and flat like the node boxes
  const CELL = 230, YW = 2.0, grid = new Map();
  F.nodes.forEach((n, i) => {
    const k = Math.floor(n.cx / CELL) + ':' + Math.floor(n.cy * YW / CELL);
    (grid.get(k) || grid.set(k, []).get(k)).push(i);
  });
  F.nodes.forEach((n, i) => {
    const gx = Math.floor(n.cx / CELL), gy = Math.floor(n.cy * YW / CELL);
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      for (const j of grid.get((gx + ox) + ':' + (gy + oy)) || []) {
        if (j <= i) continue;
        const m = F.nodes[j];
        const dx = m.cx - n.cx, dyr = (m.cy - n.cy) * YW;
        const d = Math.hypot(dx, dyr) || 1;
        const overlap = n.r + m.r - d;
        if (overlap <= 0) continue;
        const push = overlap / d / 2;
        const px = dx * push, py = dyr * push / YW;
        if (n.fx == null) { n.cx -= px; n.cy -= py; }
        if (m.fx == null) { m.cx += px; m.cy += py; }
      }
    }
  });
}

function forceTick() {
  Force.raf = null;
  if (App.layoutMode !== 'force' || !App.lay) return;
  forcePhysics();
  for (const n of Force.nodes) { n.x = n.cx - n.w / 2; n.y = n.cy; }
  const H = App.lay.H;
  for (const [name, n] of App.lay.nodes) {
    const g = App.nodeEls.get(name);
    if (g) g.setAttribute('transform', `translate(${n.x},${n.y - H / 2})`);
  }
  for (const e of App.edgeList) {
    const na = App.lay.nodes.get(e.a), nb = App.lay.nodes.get(e.b);
    if (na && nb) e.el.setAttribute('d', edgePathD(na, nb));
  }
  Force.alpha *= Force.DECAY;
  if (Force.alpha < 0.004 && !Force.dragging) { stopForce(); return; }
  Force.raf = requestAnimationFrame(forceTick);
}

function svgCoords(ev) {
  return clientToWorld(ev.clientX, ev.clientY);
}

function updateForceCtl() {
  $('#forceCtl').hidden =
    !(App.view === 'graph' && App.layoutMode !== 'layered');
}

function setLayoutMode(mode) {
  const prev = App.layoutMode;
  App.layoutMode = mode;
  localStorage.setItem('cmc-layout', mode);
  $('#layoutSelect').value = mode;
  $('#graphwrap').classList.toggle('mode3d', mode === '3d');
  updateForceCtl();
  if (prev === '3d' && mode !== '3d') exit3d();
  if (mode === 'force') startForce();
  else if (mode === '3d') enter3d();
  else { stopForce(); App.vb = null; buildGraphView(); }
}

/* ---------------- 3D mode: perspective canvas over the same simulation ---- */

const G3 = {
  yaw: -0.6, pitch: 0.28, dist: 2600, tx: 0, ty: 0, tz: 0, F: 560,
  raf: null, auto: true, hovered: null, downNode: null, drag: null, moved: 0,
  colors: null, pal: null, particles: new Map(), lastT: 0, bound: false,
};

function hexRgb(h) {
  h = h.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
          parseInt(h.slice(4, 6), 16)];
}
function mix3d(a, b, t) {
  const A = hexRgb(a), B = hexRgb(b);
  return `rgb(${A.map((x, i) => Math.round(x + (B[i] - x) * t)).join(',')})`;
}

function tokens3d() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  const c = G3.colors = {
    surface: v('--surface'), ink: v('--ink'), muted: v('--muted'),
    grid: v('--grid'), baseline: v('--baseline'), accent: v('--accent'),
    good: v('--good'), critical: v('--critical'), serious: v('--serious'),
  };
  G3.pal = {
    done: { fill: mix3d(c.surface, c.good, 0.16), stroke: c.good, text: c.ink },
    building: { fill: mix3d(c.surface, c.accent, 0.2), stroke: c.accent, text: c.ink },
    ready: { fill: c.surface, stroke: c.accent, text: c.ink, dash: [4, 3] },
    waiting: { fill: c.surface, stroke: c.grid, text: c.muted },
    failed: { fill: mix3d(c.surface, c.critical, 0.2), stroke: c.critical, text: c.ink },
    aborted: { fill: mix3d(c.surface, c.serious, 0.15), stroke: c.serious, text: c.ink },
    skipped: { fill: c.surface, stroke: c.grid, text: c.muted },
    blocked: { fill: c.surface, stroke: c.critical, text: c.muted, dash: [3, 3] },
    excluded: { fill: c.surface, stroke: c.grid, text: c.muted },
  };
}

function resize3d() {
  const cv = G3.cv;
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  G3.dpr = devicePixelRatio || 1;
  G3.cw = r.width; G3.ch = r.height;
  G3.w2 = r.width / 2; G3.h2 = r.height / 2;
  cv.width = Math.round(r.width * G3.dpr);
  cv.height = Math.round(r.height * G3.dpr);
}

function enter3d(alpha = 1, keep = false) {
  if (!App.lay || !App.lay.nodes.size) return;
  G3.cv = $('#graph3d');
  G3.ctx = G3.cv.getContext('2d');
  $('#graphwrap').classList.add('mode3d');
  resize3d();
  tokens3d();
  startForce(alpha, true, keep);
  if (!keep) fit3d();
  if (!G3.bound) bind3d();
  if (!G3.raf && App.view === 'graph') {
    G3.lastT = performance.now();
    G3.raf = requestAnimationFrame(loop3d);
  }
}

function exit3d() {
  if (G3.raf) cancelAnimationFrame(G3.raf);
  G3.raf = null;
  G3.hovered = null;
  G3.particles.clear();
}

function fit3d() {
  const ns = Force.nodes;
  if (!ns.length) return;
  let sx = 0, sy = 0, sz = 0;
  for (const n of ns) { sx += n.cx; sy += n.cy; sz += n.cz; }
  G3.tx = sx / ns.length; G3.ty = sy / ns.length; G3.tz = sz / ns.length;
  let r = 0;
  for (const n of ns)
    r = Math.max(r, Math.hypot(n.cx - G3.tx, n.cy - G3.ty, n.cz - G3.tz));
  // fit the long axis to the viewport width, but keep the whole cloud
  // in front of the camera so nothing clips while it orbits
  G3.dist = Math.max(600, r * 1.15, r * G3.F / ((G3.w2 || 400) * 0.8));
  G3.auto = true;
}

function frontier3d() {
  const hot = Force.nodes.filter(n =>
    ['building', 'ready', 'failed'].includes(App.pkgs[n.name]?.s));
  if (!hot.length) return fit3d();
  let sx = 0, sy = 0, sz = 0;
  for (const n of hot) { sx += n.cx; sy += n.cy; sz += n.cz; }
  G3.tx = sx / hot.length; G3.ty = sy / hot.length; G3.tz = sz / hot.length;
  let r = 0;
  for (const n of hot)
    r = Math.max(r, Math.hypot(n.cx - G3.tx, n.cy - G3.ty, n.cz - G3.tz));
  G3.dist = Math.max(450, r * 1.1,
    r * G3.F / ((Math.min(G3.w2, G3.h2) || 300) * 0.85));
}

function project3d(x, y, z) {
  const cyw = Math.cos(G3.yaw), syw = Math.sin(G3.yaw);
  const cp = Math.cos(G3.pitch), sp = Math.sin(G3.pitch);
  x -= G3.tx; y -= G3.ty; z -= G3.tz;
  const x1 = x * cyw + z * syw, z1 = -x * syw + z * cyw;
  const y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
  const depth = z2 + G3.dist;
  if (depth < 60) return null;
  const s = G3.F / depth;
  return [G3.w2 + x1 * s, G3.h2 + y1 * s, s, depth];
}

function stepParticles3d(dt) {
  const seen = new Set();
  for (const e of App.edgeList) {
    if (!e.cls || !e.cls.includes(' active')) continue;
    const na = App.lay.nodes.get(e.a), nb = App.lay.nodes.get(e.b);
    if (!na || !nb) continue;
    seen.add(e.idx);
    const len = Math.hypot(nb.cx - na.cx, nb.cy - na.cy, nb.cz - na.cz) || 1;
    const count = Math.min(8, Math.max(1, Math.round(len / FLOW_SPACING)));
    let P = G3.particles.get(e.idx);
    if (!P || P.ts.length !== count) {
      P = { ts: Array.from({ length: count }, (_, i) => i / count), na, nb, len };
      G3.particles.set(e.idx, P);
    }
    P.na = na; P.nb = nb; P.len = len;
    const v = dt * FLOW_SPEED / len;
    for (let i = 0; i < P.ts.length; i++) P.ts[i] = (P.ts[i] + v) % 1;
  }
  for (const k of [...G3.particles.keys()]) if (!seen.has(k)) G3.particles.delete(k);
}

function loop3d(now) {
  G3.raf = null;
  if (App.layoutMode !== '3d' || App.view !== 'graph') return;
  const dt = Math.min(0.1, (now - G3.lastT) / 1000 || 0.016);
  G3.lastT = now;
  if (Force.alpha > 0.004) {
    forcePhysics();
    Force.alpha *= Force.DECAY;
  }
  if (G3.auto && !G3.drag) G3.yaw += dt * 0.1;
  stepParticles3d(dt);
  draw3d(now);
  G3.raf = requestAnimationFrame(loop3d);
}

function draw3d(now) {
  const ctx = G3.ctx, c = G3.colors;
  G3.refS = G3.F / G3.dist;  // apparent scale at the camera target
  ctx.setTransform(G3.dpr, 0, 0, G3.dpr, 0, 0);
  ctx.clearRect(0, 0, G3.cw, G3.ch);
  const chainNow = G3.hovered ? chainOf(G3.hovered) : null;
  if (chainNow) G3.lastChain = chainNow;
  G3.dimEase = (G3.dimEase || 0) + ((chainNow ? 1 : 0) - (G3.dimEase || 0)) * 0.12;
  if (!chainNow && G3.dimEase < 0.02) G3.lastChain = null;
  const chain = G3.dimEase > 0.02 ? G3.lastChain : null;
  const dimMul = 1 - 0.9 * G3.dimEase;    // eased focus dim
  const discMul = 1 - 0.65 * G3.dimEase;
  const proj = new Map();
  for (const [name, n] of App.lay.nodes) {
    const pr = project3d(n.cx, n.cy, n.cz);
    if (pr) proj.set(name, pr);
  }

  // faint disc outline per wavefront plane: the hierarchy skeleton
  {
    const groups = new Map();
    for (const [, n] of App.lay.nodes) {
      if (n.wIdx == null) continue;
      (groups.get(n.wIdx) || groups.set(n.wIdx, []).get(n.wIdx)).push(n);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = c.baseline;
    for (const ns of groups.values()) {
      if (ns.length < 2) continue;
      const lx = ns[0].ax3 ?? ns[0].cx;
      let r = 0;
      for (const n of ns) r = Math.max(r, Math.hypot(n.cy, n.cz));
      r += 45;
      let started = false, sMax = 0;
      ctx.beginPath();
      for (let i = 0; i <= 32; i++) {
        const th = i / 32 * 6.2832;
        const pr = project3d(lx, Math.cos(th) * r, Math.sin(th) * r);
        if (!pr) { started = false; continue; }
        if (!started) { ctx.moveTo(pr[0], pr[1]); started = true; }
        else ctx.lineTo(pr[0], pr[1]);
        sMax = Math.max(sMax, pr[2]);
      }
      ctx.globalAlpha = Math.min(0.3, sMax / G3.refS * 0.22) * (chain ? discMul : 1);
      ctx.stroke();
    }
  }

  for (const e of App.edgeList) {
    const a = proj.get(e.a), b = proj.get(e.b);
    if (!a || !b) continue;
    const cls = e.cls || '';
    let col = c.grid, alpha = 0.5, w = 1, dash = null;
    if (cls.includes('doomed')) { col = c.critical; alpha = 0.4; dash = [4, 4]; }
    else if (cls.includes('feed')) { col = c.accent; alpha = 0.55; dash = [5, 5]; }
    else if (cls.includes('active')) { col = c.accent; alpha = 0.55; w = 1.3; }
    else if (cls.includes('edone')) { col = c.good; alpha = 0.3; }
    let al = alpha * Math.min(1, (a[2] + b[2]) / (2 * G3.refS) * 1.05);
    if (chain && !(chain.has(e.a) && chain.has(e.b))) al *= dimMul;
    ctx.globalAlpha = al;
    ctx.strokeStyle = col;
    ctx.lineWidth = w;
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.fillStyle = c.accent;
  for (const P of G3.particles.values()) {
    for (const t of P.ts) {
      const pr = project3d(P.na.cx + (P.nb.cx - P.na.cx) * t,
                           P.na.cy + (P.nb.cy - P.na.cy) * t,
                           P.na.cz + (P.nb.cz - P.na.cz) * t);
      if (!pr) continue;
      ctx.globalAlpha = 0.85 * Math.min(1, pr[2] / G3.refS * 1.1);
      if (chain && !(chain.has(P.na.name) && chain.has(P.nb.name)))
        ctx.globalAlpha *= dimMul;
      ctx.beginPath();
      ctx.arc(pr[0], pr[1], Math.max(0.8, 2.4 * pr[2] * 3), 0, 6.2832);
      ctx.fill();
    }
  }

  const order = [...proj.entries()].sort((A, B) => B[1][3] - A[1][3]);
  ctx.textBaseline = 'middle';
  for (const [name, [sx, sy, s]] of order) {
    const n = App.lay.nodes.get(name);
    const p = App.pkgs[name];
    const stKey = p ? p.s : (App.graph?.[name]?.in_build ? 'waiting' : 'excluded');
    const pal = G3.pal[stKey] || G3.pal.waiting;
    const w = n.w * s, h = 22 * s, rad = 5 * s;
    const doomed = App.doomedSet?.has(name);
    const isNext = App.nextSet?.has(name);
    let alpha = Math.min(1, s / G3.refS * 1.15);
    if (chain && !chain.has(name)) alpha *= dimMul;
    if (stKey === 'excluded') alpha *= 0.35;

    ctx.globalAlpha = alpha;
    ctx.fillStyle = doomed ? mix3d(c.surface, c.critical, 0.08) : pal.fill;
    ctx.beginPath();
    ctx.roundRect(sx - w / 2, sy - h / 2, w, h, rad);
    ctx.fill();

    let strokeAlpha = alpha;
    if (stKey === 'building') strokeAlpha *= 0.7 + 0.3 * Math.sin(now / 240);
    if (isNext) strokeAlpha *= 0.55 + 0.45 * Math.sin(now / 330);
    ctx.globalAlpha = strokeAlpha;
    ctx.strokeStyle = doomed ? c.critical : (isNext ? c.accent : pal.stroke);
    ctx.lineWidth = Math.max(0.5,
      (stKey === 'building' || stKey === 'failed' ? 1.5 : 1) * s * 1.4);
    const dash = isNext ? [4, 3] : (pal.dash || (doomed ? [3, 3] : null));
    ctx.setLineDash(dash ? dash.map(d => d * s * 2) : []);
    ctx.beginPath();
    ctx.roundRect(sx - w / 2, sy - h / 2, w, h, rad);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.globalAlpha = alpha;
    if (stKey === 'building' && p?.pct != null) {
      ctx.fillStyle = c.accent;
      ctx.fillRect(sx - w / 2 + 1.5 * s, sy + h / 2 - 4 * s,
                   (w - 3 * s) * p.pct / 100, 2.5 * s);
    }
    const fontPx = 11 * s;
    if (fontPx > 4.5) {
      ctx.font = `${stKey === 'building' || stKey === 'failed' ? '600 ' : ''}` +
                 `${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.fillStyle = pal.text;
      ctx.fillText(label(name), sx - w / 2 + 9 * s, sy + 0.5);
    }
  }
  ctx.globalAlpha = 1;
}

function cvCoords(ev) {
  const r = G3.cv.getBoundingClientRect();
  return [ev.clientX - r.left, ev.clientY - r.top];
}

function pick3d(mx, my) {
  let best = null, bestDepth = 1e12;
  for (const [name, n] of App.lay.nodes) {
    const pr = project3d(n.cx, n.cy, n.cz);
    if (!pr) continue;
    const [sx, sy, s, depth] = pr;
    if (Math.abs(mx - sx) <= n.w * s / 2 + 2 &&
        Math.abs(my - sy) <= 11 * s + 2 && depth < bestDepth) {
      best = name;
      bestDepth = depth;
    }
  }
  return best;
}

function bind3d() {
  G3.bound = true;
  const cv = G3.cv;
  cv.addEventListener('contextmenu', ev => ev.preventDefault());
  cv.addEventListener('pointerdown', ev => {
    if (ev.button === 1) ev.preventDefault();  // no middle-click autoscroll
    G3.auto = false;
    G3.downNode = pick3d(...cvCoords(ev));
    G3.drag = {
      x: ev.clientX, y: ev.clientY, yaw: G3.yaw, pitch: G3.pitch,
      pan: ev.button === 1 || ev.button === 2 || ev.shiftKey,
      tx: G3.tx, ty: G3.ty, tz: G3.tz,
    };
    G3.moved = 0;
    cv.classList.add('panning');
    cv.setPointerCapture(ev.pointerId);
  });
  cv.addEventListener('pointermove', ev => {
    if (G3.drag) {
      const dx = ev.clientX - G3.drag.x, dy = ev.clientY - G3.drag.y;
      G3.moved = Math.max(G3.moved, Math.abs(dx) + Math.abs(dy));
      if (G3.drag.pan) {
        // translate the target along the view plane, scene follows the cursor
        const s = G3.F / G3.dist;
        const cy1 = Math.cos(G3.drag.yaw), sy1 = Math.sin(G3.drag.yaw);
        const cp = Math.cos(G3.drag.pitch), sp = Math.sin(G3.drag.pitch);
        const rt = [cy1, 0, sy1];              // screen-right in world space
        const up = [sy1 * sp, cp, -cy1 * sp];  // screen-down in world space
        G3.tx = G3.drag.tx - (rt[0] * dx + up[0] * dy) / s;
        G3.ty = G3.drag.ty - (rt[1] * dx + up[1] * dy) / s;
        G3.tz = G3.drag.tz - (rt[2] * dx + up[2] * dy) / s;
      } else {
        G3.yaw = G3.drag.yaw - dx * 0.005;
        G3.pitch = Math.max(-1.35, Math.min(1.35, G3.drag.pitch + dy * 0.005));
      }
      return;
    }
    const hit = pick3d(...cvCoords(ev));
    if (hit !== G3.hoverTarget) {  // hover intent, like the SVG graph
      G3.hoverTarget = hit;
      clearTimeout(G3.hoverTimer);
      if (hit) G3.hoverTimer = setTimeout(() => { G3.hovered = hit; }, 280);
      else G3.hovered = null;
    }
    if (hit) showNodeTooltip(hit, ev);
    else hideTooltip();
  });
  const up = () => { G3.drag = null; cv.classList.remove('panning'); };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('pointerleave', () => {
    clearTimeout(G3.hoverTimer);
    G3.hoverTarget = null;
    G3.hovered = null;
    hideTooltip();
  });
  cv.addEventListener('click', () => {
    if (G3.moved <= 4 && G3.downNode) openPane(G3.downNode);
  });
  cv.addEventListener('wheel', ev => {
    ev.preventDefault();
    G3.dist = Math.max(300, Math.min(30000,
      G3.dist * (ev.deltaY > 0 ? 1.15 : 1 / 1.15)));
  }, { passive: false });
}

/* chain highlight */
function chainOf(name) {
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
const XLINK = 'http://www.w3.org/1999/xlink';

const FLOW_SPEED = 110;    // svg units per second: constant velocity on every edge
const FLOW_SPACING = 130;  // svg units between droplets: constant density

function setEdgeFlow(e, on) {
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

let edgeFocus = null;
let nodeFocus = null;
let nodeFocusPending = null;
let chainCache = { name: null, set: null };

function chainSetFor(name) {
  if (chainCache.name !== name) chainCache = { name, set: chainOf(name) };
  return chainCache.set;
}

function hoverFocus(name) {
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

function clearFocus() {
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

/* pan / zoom */

function viewScale(vb, r) {
  // the uniform scale SVG really renders with (preserveAspectRatio meet)
  return Math.min(r.width / vb.w, r.height / vb.h);
}

function clientToWorld(clientX, clientY) {
  const r = $('#graph').getBoundingClientRect();
  const vb = App.vb;
  const s = viewScale(vb, r);
  const ox = (r.width - vb.w * s) / 2;   // letterbox centering offsets
  const oy = (r.height - vb.h * s) / 2;
  return [vb.x + (clientX - r.left - ox) / s,
          vb.y + (clientY - r.top - oy) / s];
}

function setViewBox(vb) {
  App.vb = vb;
  $('#graph').setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
}
function bboxOf(names) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const n of names) {
    const nd = App.lay.nodes.get(n);
    if (!nd) continue;
    x0 = Math.min(x0, nd.x); y0 = Math.min(y0, nd.y - 20);
    x1 = Math.max(x1, nd.x + nd.w); y1 = Math.max(y1, nd.y + 20);
  }
  if (x0 > x1) return null;
  return { x: x0 - 60, y: y0 - 40, w: x1 - x0 + 120, h: y1 - y0 + 80 };
}
function fitGraph() {
  const bb = bboxOf(App.lay ? App.lay.nodes.keys() : []);
  if (bb) setViewBox(bb);
}
function frontierView() {
  const hot = Object.keys(App.pkgs)
    .filter(n => ['building', 'ready', 'failed'].includes(App.pkgs[n].s));
  const bb = bboxOf(hot);
  if (bb) setViewBox(bb); else fitGraph();
}
function initPanZoom() {
  const svg = $('#graph');
  let moved = 0;
  let downNode = null;  // pointer capture retargets `click`, so remember the node
  svg.addEventListener('click', () => {
    if (moved <= 4 && downNode) openPane(downNode);
  });
  svg.addEventListener('pointerleave', () => { hideTooltip(); clearFocus(); });
  svg.addEventListener('wheel', ev => {
    ev.preventDefault();
    if (!App.vb) return;
    const [wx, wy] = clientToWorld(ev.clientX, ev.clientY);
    const vb = App.vb;
    const f = Math.min(Math.max((ev.deltaY > 0 ? 1.18 : 1 / 1.18),
                                120 / vb.w), 200000 / vb.w);
    // keep the world point under the cursor fixed while scaling
    setViewBox({
      x: wx + (vb.x - wx) * f,
      y: wy + (vb.y - wy) * f,
      w: vb.w * f,
      h: vb.h * f,
    });
  }, { passive: false });
  let drag = null;
  svg.addEventListener('pointerdown', ev => {
    if (!App.vb) return;
    downNode = ev.target.closest('.node')?.dataset.name || null;
    moved = 0;
    if (App.layoutMode === 'force' && downNode) {
      const n = App.lay?.nodes.get(downNode);
      if (n) {
        Force.dragging = n;
        [n.fx, n.fy] = svgCoords(ev);
        Force.alpha = Math.max(Force.alpha, 0.3);
        if (!Force.raf) Force.raf = requestAnimationFrame(forceTick);
        svg.setPointerCapture(ev.pointerId);
        return;
      }
    }
    drag = { x: ev.clientX, y: ev.clientY, vb: { ...App.vb } };
    svg.classList.add('panning');
    svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener('pointermove', ev => {
    if (Force.dragging) {
      const n = Force.dragging;
      const [cx, cy] = svgCoords(ev);
      moved = Math.max(moved, Math.abs(cx - n.fx) + Math.abs(cy - n.fy));
      [n.fx, n.fy] = [cx, cy];
      Force.alpha = Math.max(Force.alpha, 0.3);
      if (!Force.raf) Force.raf = requestAnimationFrame(forceTick);
      return;
    }
    if (drag && App.vb) {
      moved = Math.max(moved,
        Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y));
      const s = viewScale(drag.vb, svg.getBoundingClientRect());
      setViewBox({
        ...drag.vb,
        x: drag.vb.x - (ev.clientX - drag.x) / s,
        y: drag.vb.y - (ev.clientY - drag.y) / s,
      });
      return;
    }
    const g = ev.target.closest('.node');
    if (g) { showNodeTooltip(g.dataset.name, ev); hoverFocus(g.dataset.name); }
    else { hideTooltip(); clearFocus(); }
  });
  const end = () => {
    if (Force.dragging) { Force.dragging.fx = Force.dragging.fy = null; Force.dragging = null; }
    drag = null;
    svg.classList.remove('panning');
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
}

/* tooltip */
function showNodeTooltip(name, ev) {
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
    if (dur != null) rows.push(`time <b>${fmtDur(dur)}</b>`);
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
function hideTooltip() { $('#tooltip').hidden = true; }

/* ---------------- gantt ---------------- */

function drawGantt() {
  const svg = $('#gantt');
  const wrap = $('#ganttwrap');
  const rows = Object.entries(App.pkgs)
    .filter(([, p]) => p.t0)
    .sort((a, b) => a[1].t0 - b[1].t0);
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
    const end = p.t1 || (App.active ? nowS : p.t0 + 1);
    const bar = svgEl('rect', {
      class: 'gbar ' + p.s,
      x: GUT + (p.t0 - t0) * k, y: y + 2,
      width: Math.max(2, (end - p.t0) * k), height: ROW - 5, rx: 3,
    }, svg);
    bar.dataset.name = name;
  });

  if (App.active) {
    const x = GUT + (nowS - t0) * k;
    svgEl('line', { class: 'gnow', x1: x, y1: TOP - 4, x2: x, y2: H }, svg);
  }
  if (App.ganttFollow) wrap.scrollTop = wrap.scrollHeight;

  svg.onclick = ev => {
    const b = ev.target.closest('.gbar');
    if (b) openPane(b.dataset.name);
  };
  svg.onpointermove = ev => {
    const b = ev.target.closest('.gbar');
    if (b) showNodeTooltip(b.dataset.name, ev); else hideTooltip();
  };
  svg.onpointerleave = hideTooltip;
}

/* ---------------- log dock ---------------- */

const STATE_DOT = { done: 'c-done', building: 'c-building', ready: 'c-ready',
  waiting: 'c-waiting', failed: 'c-failed', aborted: 'c-aborted',
  skipped: 'c-skipped', blocked: 'c-failed' };

const BUILD_PANE = ' build';  // the pinned whole-build terminal view

function openPane(name) {
  if (!App.panes.has(name)) createPane(name);
  activatePane(name);
}

function createPane(name) {
  const fixed = name === BUILD_PANE;
  $('#panes .placeholder')?.remove();
  const tab = document.createElement('div');
  tab.className = 'ltab';
  tab.innerHTML =
    `<span class="dot ${fixed ? 'c-building' : 'c-waiting'}"></span>` +
    `<span>${fixed ? 'build log' : label(name)}</span>` +
    (fixed ? '' : `<button class="x" title="close">✕</button>`);
  tab.onclick = ev => {
    if (ev.target.classList.contains('x')) closePane(name);
    else activatePane(name);
  };
  $('#logtabs').appendChild(tab);

  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.innerHTML = `
    <div class="phead">
      <span class="pname">${fixed ? 'colcon build' : name}</span>
      <span class="chip">…</span>
      <span class="ph"></span>
      <span class="errn"></span>
      <span class="grow"></span>
      <input class="search" type="text" placeholder="search" spellcheck="false">
      <span class="scount"></span>
      <button class="sprev" title="previous match">↑</button>
      <button class="snext" title="next match">↓</button>
      ${fixed ? '' : `<label>file <select class="fsel">
        <option value="streams">output (timestamped)</option>
        <option value="combined">stdout+stderr</option>
        <option value="stderr">stderr</option>
        <option value="stdout">stdout</option>
        <option value="command">commands</option>
      </select></label>`}
      <button class="tsbtn on" title="show or hide timestamps">🕒 ts</button>
      <button class="earlier" style="display:none" title="load the whole log from the start">⤒ load all</button>
      <button class="follow on" title="auto-scroll to the end">⤓ follow</button>
      ${fixed ? '' : `<button class="close" title="close pane">✕</button>`}
    </div>
    <pre tabindex="0" class="showts"></pre>`;
  $('#panes').appendChild(pane);

  const p = {
    name, el: pane, tabEl: tab, pre: pane.querySelector('pre'), fixed,
    offset: -1, buf: '', file: fixed ? 'combined' : 'streams',
    follow: true, lines: 0, fetching: false,
    sgr: newSgr(), start: null, noTrim: false, loadingEarlier: false,
    earlierBtn: pane.querySelector('.earlier'),
  };
  p.earlierBtn.onclick = () => loadEarlier(p);
  const tsBtn = pane.querySelector('.tsbtn');
  tsBtn.onclick = () => {
    const on = p.pre.classList.toggle('showts');
    tsBtn.classList.toggle('on', on);
    if (p.follow) p.pre.scrollTop = p.pre.scrollHeight;
  };
  initSearch(p);
  pane.querySelector('.fsel')?.addEventListener('change', ev => {
    p.file = ev.target.value;
    resetPane(p);
  });
  const followBtn = pane.querySelector('.follow');
  followBtn.onclick = () => {
    p.follow = !p.follow;
    followBtn.classList.toggle('on', p.follow);
    if (p.follow) p.pre.scrollTop = p.pre.scrollHeight;
  };
  p.pre.addEventListener('scroll', () => {
    const atEnd = p.pre.scrollTop + p.pre.clientHeight >= p.pre.scrollHeight - 24;
    if (p.follow !== atEnd) {
      p.follow = atEnd;
      followBtn.classList.toggle('on', atEnd);
    }
  });
  pane.querySelector('.close')?.addEventListener('click', () => closePane(name));
  App.panes.set(name, p);
  pollPane(p);
}

function resetPane(p) {
  p.offset = -1;
  p.buf = '';
  p.lines = 0;
  p.sgr = newSgr();
  p.start = null;
  p.noTrim = false;
  p.pre.textContent = '';
}

function updateEarlierBtn(p) {
  p.earlierBtn.style.display = p.start > 0 ? '' : 'none';
}

/* ---- per-pane log search ---- */

function initSearch(p) {
  const input = p.el.querySelector('.search');
  let timer = null;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => runSearch(p), 250);
  };
  input.onkeydown = ev => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      stepHit(p, ev.shiftKey ? -1 : 1);
    } else if (ev.key === 'Escape') {
      input.value = '';
      runSearch(p);
      input.blur();
    }
  };
  p.el.querySelector('.sprev').onclick = () => stepHit(p, -1);
  p.el.querySelector('.snext').onclick = () => stepHit(p, 1);
}

function markHit(p, node) {
  if (node.nodeType === 3) {  // bare text line: wrap it so it can carry a class
    const s = document.createElement('span');
    node.replaceWith(s);
    s.appendChild(node);
    node = s;
  }
  node.classList.add('hit');
  p.hits.push(node);
  return node;
}

function runSearch(p) {
  const q = p.el.querySelector('.search').value.toLowerCase();
  for (const el of p.hits || []) el.classList.remove('hit', 'hit-cur');
  p.query = q || null;
  p.hits = [];
  p.hitIdx = -1;
  if (q) {
    for (const node of [...p.pre.childNodes]) {
      if (node.classList?.contains('ts')) continue;
      if (node.textContent.toLowerCase().includes(q)) markHit(p, node);
    }
    if (p.hits.length) {
      p.hitIdx = p.hits.length - 1;  // start at the most recent match
      focusHit(p);
    }
  }
  updateSearchCount(p);
}

function focusHit(p) {
  p.hits.forEach((h, i) => h.classList.toggle('hit-cur', i === p.hitIdx));
  const cur = p.hits[p.hitIdx];
  if (cur) {
    if (p.follow) {
      p.follow = false;
      p.el.querySelector('.follow').classList.remove('on');
    }
    cur.scrollIntoView({ block: 'center' });
  }
}

function stepHit(p, dir) {
  if (p.hits?.length) {
    p.hits = p.hits.filter(h => h.isConnected);  // drop trimmed lines
    if (p.hitIdx >= p.hits.length) p.hitIdx = p.hits.length - 1;
  }
  if (!p.hits?.length) return;
  p.hitIdx = (p.hitIdx + dir + p.hits.length) % p.hits.length;
  focusHit(p);
  updateSearchCount(p);
}

function updateSearchCount(p) {
  p.el.querySelector('.scount').textContent =
    p.query ? `${p.hits.length ? p.hitIdx + 1 : 0}/${p.hits.length}` : '';
}

async function loadEarlier(p) {
  // prepend the whole history before p.start, keeping the view in place
  if (p.loadingEarlier || !p.start) return;
  p.loadingEarlier = true;
  p.earlierBtn.textContent = '⤒ loading…';
  const base = p.fixed
    ? `/api/buildlog?`
    : `/api/log/${encodeURIComponent(p.name)}?file=${p.file}&`;
  try {
    const parts = [];
    let start = p.start;
    while (start > 0) {
      const from = Math.max(0, start - 512 * 1024);
      const r = await (await fetch(
        `${base}offset=${from}&limit=${start - from}` +
        `&align=${from > 0 ? 1 : 0}`)).json();
      parts.unshift(r.data);
      if (!(r.start < start)) break;  // no progress: stop
      start = r.start;
    }
    const all = parts.join('');
    if (all) {
      const frag = document.createDocumentFragment();
      const ctx = { sgr: newSgr() };  // ANSI state starts fresh at line zero
      const lines = all.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      for (const line of lines) renderLogLine(ctx, line, frag);
      const before = p.pre.scrollHeight;
      p.pre.insertBefore(frag, p.pre.firstChild);
      p.pre.scrollTop += p.pre.scrollHeight - before;
      p.lines += lines.length;
      p.noTrim = true;  // keep the history the user asked for
    }
    p.start = start;
    updateEarlierBtn(p);
  } catch (e) { /* transient */ }
  p.earlierBtn.textContent = '⤒ load all';
  p.loadingEarlier = false;
}

function activatePane(name) {
  App.activePane = name;
  for (const [n, p] of App.panes) {
    p.el.classList.toggle('on', n === name);
    p.tabEl.classList.toggle('on', n === name);
  }
}

function closePane(name) {
  const p = App.panes.get(name);
  if (!p || p.fixed) return;
  p.el.remove();
  p.tabEl.remove();
  App.panes.delete(name);
  if (App.activePane === name) {
    const last = [...App.panes.keys()].pop();
    if (last) activatePane(last);
    else {
      App.activePane = null;
      const ph = document.createElement('div');
      ph.className = 'placeholder';
      ph.textContent = 'Click a package in the graph or timeline to open its build log.';
      $('#panes').appendChild(ph);
    }
  }
}

const ERR_RE = /\berror\b|\bfatal\b|FAILED/i;
const WARN_RE = /\bwarning\b/i;

/* ---- ANSI (SGR) rendering: real terminal colors in the log panes ---- */

const SGR_SPLIT_RE = /(\x1b\[[0-9;]*m)/;
const CSI_OTHER_RE = /\x1b\[[0-9;?]*[A-LN-Za-ln-z]/g;  // CSI codes other than SGR
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;

function newSgr() { return { bold: false, fg: null, bg: null }; }

function applySgr(st, codes) {
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

function xterm256(n) {  // 16..255 -> rgb triple
  if (n >= 232) { const v = 8 + (n - 232) * 10; return [v, v, v]; }
  const m = n - 16;
  return [Math.floor(m / 36), Math.floor(m / 6) % 6, m % 6]
    .map(v => (v ? 55 + v * 40 : 0));
}

function sgrSpan(st) {
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

const TS_RE = /^\[\s*\d+(?:\.\d+)?s?\] /;

function renderLogLine(p, line, frag) {
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

async function pollPane(p) {
  if (p.fetching) return;
  p.fetching = true;
  try {
    const url = p.fixed
      ? `/api/buildlog?offset=${p.offset}`
      : `/api/log/${encodeURIComponent(p.name)}?offset=${p.offset}&file=${p.file}`;
    const r = await (await fetch(url)).json();
    if (r.reset) {
      p.pre.textContent = '';
      p.buf = '';
      p.lines = 0;
      p.sgr = newSgr();
      p.noTrim = false;
      p.start = r.start ?? 0;
      updateEarlierBtn(p);
    } else if (p.start == null) {
      p.start = r.start ?? 0;
      updateEarlierBtn(p);
    }
    p.offset = r.offset;
    if (r.data) appendLog(p, r.data);
  } catch (e) { /* transient */ }
  p.fetching = false;
}

function appendLog(p, data) {
  p.buf += data;
  const lines = p.buf.split('\n');
  p.buf = lines.pop();
  if (!lines.length) return;
  const frag = document.createDocumentFragment();
  for (const line of lines) renderLogLine(p, line, frag);
  p.lines += lines.length;
  const firstNew = p.pre.childNodes.length;
  p.pre.appendChild(frag);
  if (p.query) {  // keep the search live as the log streams
    const nodes = p.pre.childNodes;
    for (let i = firstNew; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.classList?.contains('ts')) continue;
      if (node.textContent.toLowerCase().includes(p.query)) markHit(p, node);
    }
    updateSearchCount(p);
  }
  while (!p.noTrim && p.lines > 6000 && p.pre.firstChild) {
    p.pre.removeChild(p.pre.firstChild);
    p.lines--;
  }
  if (p.follow) p.pre.scrollTop = p.pre.scrollHeight;
}

function updatePaneHeads() {
  for (const [name, p] of App.panes) {
    if (p.fixed) {
      const chip = p.el.querySelector('.chip');
      chip.textContent = App.active ? 'live' : 'stopped';
      chip.className = 'chip ' + (App.active ? 'building' : 'aborted');
      p.tabEl.querySelector('.dot').className =
        'dot ' + (App.active ? 'c-building' : 'c-skipped');
      continue;
    }
    const st = App.pkgs[name];
    const chip = p.el.querySelector('.chip');
    const s = st ? st.s : 'waiting';
    chip.textContent = s + (st?.rc != null && s === 'failed' ? ` rc ${st.rc}` : '');
    chip.className = 'chip ' + s;
    p.el.querySelector('.ph').textContent =
      st && st.s === 'building'
        ? (st.ph || '') + (st.pct != null ? ` ${st.pct}%` : '') : '';
    p.el.querySelector('.errn').textContent = st?.err ? `${st.err} stderr lines` : '';
    const dot = p.tabEl.querySelector('.dot');
    dot.className = 'dot ' + (STATE_DOT[s] || 'c-waiting');
  }
}

function pollAllPanes() {
  for (const p of App.panes.values()) {
    const st = App.pkgs[p.name];
    const busy = p.fixed ? App.active : st && (st.s === 'building' || st.t1 == null);
    // active pane always; background panes only while their package still writes
    if (p.name === App.activePane || busy || p.offset === -1) pollPane(p);
  }
}

/* ---------------- toasts ---------------- */

function toast(html, cls = '', onclick = null, ttl = 9000) {
  const t = document.createElement('div');
  t.className = 'toast ' + cls;
  t.innerHTML = html;
  t.onclick = () => { if (onclick) onclick(); t.remove(); };
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ttl);
}

/* ---------------- view switching, dock resize ---------------- */

function initViews() {
  for (const b of document.querySelectorAll('.vtab')) {
    b.onclick = () => {
      App.view = b.dataset.view;
      document.querySelectorAll('.vtab').forEach(x => x.classList.toggle('on', x === b));
      $('#graphwrap').hidden = App.view !== 'graph';
      $('#ganttwrap').hidden = App.view !== 'gantt';
      const graphBtns = App.view === 'graph';
      $('#fitBtn').style.display = graphBtns ? '' : 'none';
      $('#frontierBtn').style.display = graphBtns ? '' : 'none';
      $('#scopeBtn').style.display = graphBtns ? '' : 'none';
      $('#layoutSel').style.display = graphBtns ? '' : 'none';
      $('#gfollowBtn').style.display = App.view === 'gantt' ? '' : 'none';
      updateForceCtl();
      if (App.view === 'gantt') { stopForce(); exit3d(); drawGantt(); }
      else if (App.layoutMode === 'force' && !Force.raf) startForce(0.15);
      else if (App.layoutMode === '3d' && !G3.raf) enter3d(0.15, true);
    };
  }
  $('#fitBtn').onclick = () => App.layoutMode === '3d' ? fit3d() : fitGraph();
  $('#frontierBtn').onclick = () =>
    App.layoutMode === '3d' ? frontier3d() : frontierView();
  $('#layoutSelect').value = App.layoutMode;
  $('#graphwrap').classList.toggle('mode3d', App.layoutMode === '3d');
  const slider = $('#spreadSlider');
  slider.value = localStorage.getItem('cmc-spread') || '1';
  applySpread(parseFloat(slider.value), false);
  slider.oninput = () => {
    localStorage.setItem('cmc-spread', slider.value);
    applySpread(parseFloat(slider.value));
  };
  updateForceCtl();
  $('#layoutSelect').onchange = ev => setLayoutMode(ev.target.value);
  const gf = $('#gfollowBtn');
  const gwrap = $('#ganttwrap');
  gf.onclick = () => {
    App.ganttFollow = !App.ganttFollow;
    gf.classList.toggle('on', App.ganttFollow);
    if (App.ganttFollow) gwrap.scrollTop = gwrap.scrollHeight;
  };
  gwrap.addEventListener('scroll', () => {
    const atEnd = gwrap.scrollTop + gwrap.clientHeight >= gwrap.scrollHeight - 30;
    if (App.ganttFollow !== atEnd) {
      App.ganttFollow = atEnd;
      gf.classList.toggle('on', atEnd);
    }
  });
  $('#scopeBtn').onclick = () => {
    App.scope = App.scope === 'build' ? 'all' : 'build';
    $('#scopeBtn').textContent = App.scope === 'build' ? 'This build' : 'All packages';
    App.vb = null;  // refit to the new extent
    buildGraphView();
  };

  const bar = $('#dockbar');
  bar.addEventListener('pointerdown', ev => {
    ev.preventDefault();
    const startY = ev.clientY;
    const startH = $('#dock').getBoundingClientRect().height;
    const move = e => {
      const h = Math.min(innerHeight * 0.75, Math.max(90, startH + (startY - e.clientY)));
      document.documentElement.style.setProperty('--dock-h', h + 'px');
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
}

/* ---------------- boot ---------------- */

function tickElapsed() {
  let e = App.elapsedBase;
  if (App.active) e += (Date.now() - App.elapsedAt) / 1000;
  $('#t-elapsed').textContent = fmtDur(e);
}

function initStop() {
  const overlay = $('#confirm');
  const text = overlay.querySelector('.ctext');
  const btns = overlay.querySelector('.cbtns');
  $('#stopBtn').onclick = () => {
    text.textContent =
      `Stop the dashboard server for ${$('#ws').textContent || 'this workspace'}? ` +
      'The page goes offline until you start the server again.';
    btns.hidden = false;
    overlay.hidden = false;
  };
  overlay.querySelector('.cancel').onclick = () => { overlay.hidden = true; };
  overlay.addEventListener('click', ev => {
    if (ev.target === overlay) overlay.hidden = true;
  });
  const ok = overlay.querySelector('.ok');
  ok.onclick = async () => {
    ok.disabled = true;
    ok.textContent = 'Stopping…';
    try { await fetch('/api/stop', { method: 'POST' }); } catch (e) { /* dying */ }
    // believe it only when the server really stops answering
    const deadline = Date.now() + 6000;
    let gone = false;
    while (Date.now() < deadline) {
      try {
        await fetch('/api/state', { cache: 'no-store' });
      } catch (e) {
        gone = true;
        break;
      }
      await new Promise(r => setTimeout(r, 300));
    }
    ok.disabled = false;
    ok.textContent = 'Stop the server';
    if (gone) {
      App.stopped = true;
      setBadge('offline', 'STOPPED');
      text.innerHTML = '<b>Server stopped.</b> The page is now offline. ' +
        'Start the server again with <code>colcon-dashboard</code>, ' +
        'or run a build with the plugin switched on, then reload this page.';
      btns.hidden = true;
    } else {
      text.textContent =
        'The server still answers. Try colcon-dashboard --stop in a terminal.';
    }
  };
}

initTheme();
initViews();
initPanZoom();
initStop();
openPane(BUILD_PANE);  // the pinned whole-build terminal view
pollState();
setInterval(pollState, 1000);
setInterval(pollAllPanes, 1200);
setInterval(tickElapsed, 1000);
addEventListener('resize', () => {
  if (App.view === 'gantt') drawGantt();
  if (App.layoutMode === '3d') resize3d();
});
