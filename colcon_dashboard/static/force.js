import { fitGraph, frontierView } from './camera.js';
import { edgePathD, syncGlow } from './graph.js';
import { registerMode } from './modes.js';
import { App } from './state.js';

export const Force = {
  nodes: [], links: [], alpha: 0, raf: null, dragging: null,
  REPULSE: 1600, LINK_DIST: 200, LINK_S: 0.5, AX: 0.035, AY: 0.0035,
  FRICTION: 0.6, DECAY: 0.972, MAXD2: 1300 * 1300, THETA2: 0.72,
  BASE: { REPULSE: 1600, LINK_DIST: 200, MAXD: 1300 },
};

export function applySpread(m, reheat = true) {
  Force.REPULSE = Force.BASE.REPULSE * m;
  Force.LINK_DIST = Force.BASE.LINK_DIST * Math.sqrt(m);
  Force.MAXD2 = (Force.BASE.MAXD * Math.sqrt(m)) ** 2;
  if (reheat && App.layoutMode !== 'layered') {
    Force.alpha = Math.max(Force.alpha, 0.5);
    if (App.layoutMode === 'force' && !Force.raf)
      Force.raf = requestAnimationFrame(forceTick);
  }
}

export function startForce(alpha = 1, is3d = false, keep = false) {
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

export const GAP3 = 380;

export function update3dPlanes(reheat = true) {
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

export function stopForce() {
  if (Force.raf) cancelAnimationFrame(Force.raf);
  Force.raf = null;
  Force.alpha = 0;
  for (const e of App.edgeList) e.len = null;  // flows use settled lengths
}

export function buildQuad(nodes) {
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

export function physics3d() {
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

export function forcePhysics() {
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

export function forceTick() {
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
  syncGlow();  // halos ride along with the moving nodes
  Force.alpha *= Force.DECAY;
  if (Force.alpha < 0.004 && !Force.dragging) { stopForce(); return; }
  Force.raf = requestAnimationFrame(forceTick);
}

registerMode('force', {
  activate: () => startForce(),
  onLayout: () => startForce(),
  show: () => { if (!Force.raf) startForce(0.15); },
  hide: stopForce,
  fit: fitGraph,
  followFrontier: frontierView,
});
