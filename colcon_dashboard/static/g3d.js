import { emit, on } from './bus.js';
import { breakFollow } from './camera.js';
import { Force, forcePhysics, startForce, stopForce, update3dPlanes } from './force.js';
import { chainOf, FLOW_SPACING, FLOW_SPEED, hideTooltip, label, showNodeTooltip } from './graph.js';
import { GS } from './gsearch.js';
import { registerMode } from './modes.js';
import { App } from './state.js';
import { $ } from './util.js';

/* ---------------- 3D mode: perspective canvas over the same simulation ---- */

export const G3 = {
  yaw: -0.6, pitch: 0.28, dist: 2600, tx: 0, ty: 0, tz: 0, F: 560,
  raf: null, auto: true, hovered: null, downNode: null, drag: null, moved: 0,
  colors: null, pal: null, particles: new Map(), lastT: 0, bound: false,
};

export function hexRgb(h) {
  h = h.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
          parseInt(h.slice(4, 6), 16)];
}
export function mix3d(a, b, t) {
  const A = hexRgb(a), B = hexRgb(b);
  return `rgb(${A.map((x, i) => Math.round(x + (B[i] - x) * t)).join(',')})`;
}

export function tokens3d() {
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

export function resize3d() {
  const cv = G3.cv;
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  G3.dpr = devicePixelRatio || 1;
  G3.cw = r.width; G3.ch = r.height;
  G3.w2 = r.width / 2; G3.h2 = r.height / 2;
  cv.width = Math.round(r.width * G3.dpr);
  cv.height = Math.round(r.height * G3.dpr);
}

export function enter3d(alpha = 1, keep = false) {
  if (!App.lay || !App.lay.nodes.size) return;
  G3.cv = $('#graph3d');
  G3.ctx = G3.cv.getContext('2d');
  $('#graphwrap').classList.add('mode3d');
  resize3d();
  tokens3d();
  startForce(alpha, true, keep);
  if (!keep) fit3d();
  if (!G3.bound) bind3d();
  if (!G3.raf && App.view !== 'gantt') {
    G3.lastT = performance.now();
    G3.raf = requestAnimationFrame(loop3d);
  }
}

export function exit3d() {
  if (G3.raf) cancelAnimationFrame(G3.raf);
  G3.raf = null;
  G3.hovered = null;
  G3.particles.clear();
}

export function fit3d() {
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

export function frontier3d() {
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

export function project3d(x, y, z) {
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

export function stepParticles3d(dt) {
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

export function loop3d(now) {
  G3.raf = null;
  if (App.layoutMode !== '3d' || App.view === 'gantt') return;
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

export function draw3d(now) {
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
  const sset = GS.set;                    // active graph search matches
  const proj = new Map();
  for (const [name, n] of App.lay.nodes) {
    const pr = project3d(n.cx, n.cy, n.cz);
    if (pr) proj.set(name, pr);
  }

  // ambient halos first, so they sit behind everything else
  for (const [name, n] of App.lay.nodes) {
    if (App.pkgs[name]?.s !== 'building') continue;
    const pr = proj.get(name);
    if (!pr) continue;
    const [sx, sy, s] = pr;
    const r = (n.w / 2 + 70) * s;
    if (r < 4) continue;
    const pulse = 0.7 + 0.3 * Math.sin(now / 420 + (n.cx + n.cy) * 0.01);
    const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
    grad.addColorStop(0, c.accent);
    grad.addColorStop(1, 'transparent');
    ctx.globalAlpha = 0.16 * pulse * Math.min(1, s / G3.refS);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, 6.2832);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

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
    if (sset && !(sset.has(e.a) && sset.has(e.b))) al *= 0.15;
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
      if (sset && !(sset.has(P.na.name) && sset.has(P.nb.name)))
        ctx.globalAlpha *= 0.15;
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
    if (sset && !sset.has(name)) alpha *= 0.12;
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
    if (sset && sset.has(name)) {  // a search match keeps an accent ring
      ctx.strokeStyle = c.accent;
      ctx.globalAlpha = Math.max(strokeAlpha, 0.9);
      ctx.lineWidth = Math.max(1.4, 2.2 * s * 1.4);
    }
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

export function cvCoords(ev) {
  const r = G3.cv.getBoundingClientRect();
  return [ev.clientX - r.left, ev.clientY - r.top];
}

export function pick3d(mx, my) {
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

export function bind3d() {
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
    if (G3.drag.pan) breakFollow();  // orbiting composes with follow, panning fights it
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
    if (G3.moved <= 4 && G3.downNode) emit('open-pkg', G3.downNode);
  });
  cv.addEventListener('wheel', ev => {
    ev.preventDefault();
    breakFollow();
    G3.dist = Math.max(300, Math.min(30000,
      G3.dist * (ev.deltaY > 0 ? 1.15 : 1 / 1.15)));
  }, { passive: false });
}

registerMode('3d', {
  activate: () => enter3d(),
  deactivate: exit3d,
  onLayout: () => enter3d(),
  show: () => { if (!G3.raf) enter3d(0.15, true); },
  hide: () => { stopForce(); exit3d(); },
  fit: fit3d,
  followFrontier: frontier3d,
  onState: () => update3dPlanes(),
  resize: resize3d,
  focusPkg: name => {
    const n = Force.nodes.find(f => f.name === name);
    if (!n) return;
    G3.auto = false;  // keep the camera where we point it
    G3.tx = n.cx; G3.ty = n.cy; G3.tz = n.cz;
    G3.dist = 500;
  },
});

on('theme-changed', () => {
  if (G3.colors) tokens3d();  // refresh the 3D canvas palette
});
