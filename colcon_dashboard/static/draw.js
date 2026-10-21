import { on } from './bus.js';
import { edgeFocus, FLOW_SPACING, FLOW_SPEED, label, nodeFocus } from './graph.js';
import { GS } from './gsearch.js';
import { App } from './state.js';
import { $, hexRgb, mixColor } from './util.js';

/* ---------------- the 2D graph, on a canvas ----------------
   The layered and force layouts draw here (3D draws in g3d.js). A frame
   draws everything from the layout and from the flags that graph.js sets
   on the nodes and edges. The camera is App.vb, fitted into the canvas
   like an SVG viewBox with preserveAspectRatio "meet", so camera.js keeps
   its math. A frame runs on request (requestDraw), and the frames go on
   while something moves: a building package breathes, droplets flow, a
   fade eases. Ambient motion draws at most 30 times a second, and input
   at the full frame rate. */

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
const TAU = Math.PI * 2;

// what the pointer does to the drawing: the node under it, the node a
// drag holds, and the far zoom level (camera.js sets these)
export const View = { hover: null, hot: null, far: false };

let cv = null, ctx = null, dpr = 1, cw = 0, ch = 0;
let raf = null, urgent = false, lastDraw = 0;
let pal = null;
const styleCache = new Map();

/* ---- colors: the CSS tokens of the theme, read once per theme ---- */

function rgba(color, a) {
  const [r, g, b] = hexRgb(color);
  return `rgba(${r},${g},${b},${a})`;
}

// the CSS filter brightness(f) on a fill color
function brighten(color, f) {
  return `rgb(${hexRgb(color).map(x => Math.min(255, Math.round(x * f))).join(',')})`;
}

function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  const c = {
    surface: v('--surface'), ink: v('--ink'), ink2: v('--ink2'), muted: v('--muted'),
    grid: v('--grid'), baseline: v('--baseline'), accent: v('--accent'), good: v('--good'),
    critical: v('--critical'), serious: v('--serious'), mono: v('--mono'),
  };
  const mix = (b, t) => mixColor(c.surface, b, t);
  const base = { fill: c.surface, stroke: c.baseline, w: 1, text: c.ink2, glow: c.baseline };
  const S = (o) => ({ ...base, ...o });
  pal = {
    c,
    dark: document.documentElement.dataset.theme === 'dark',
    // style.css had these as .node.<state> rules; the same values
    state: {
      base,
      excluded: base,
      done: S({ fill: mix(c.good, 0.14), stroke: c.good, text: c.ink, glow: c.good }),
      building: S({ fill: mix(c.accent, 0.08), stroke: c.accent, w: 1.5, text: c.ink, bold: true,
                    glow: c.accent }),
      ready: S({ stroke: c.accent, dash: [4, 3], text: c.ink, glow: c.accent }),
      waiting: S({ stroke: c.grid, text: c.muted }),
      failed: S({ fill: mix(c.critical, 0.18), stroke: c.critical, w: 1.5, text: c.ink, bold: true,
                  glow: c.critical }),
      aborted: S({ fill: mix(c.serious, 0.14), stroke: c.serious, dash: [5, 2], glow: c.serious }),
      blocked: S({ stroke: c.critical, dash: [3, 3], text: c.muted, glow: c.critical }),
      skipped: S({ stroke: c.grid, text: c.muted, strike: true }),
    },
    next: { stroke: c.accent, dash: [4, 3], text: c.ink, pulse: true },
    doomed: { fill: mix(c.critical, 0.07), stroke: c.critical, dash: [3, 3], text: c.ink2 },
    // zoomed far out, the labels go and the boxes carry the state
    far: {
      done: { fill: mix(c.good, 0.45), stroke: null },
      failed: { w: 4 },
      aborted: { w: 3, dash: [6, 3] },
      waiting: { fill: c.grid },
      skipped: { fill: c.grid },
    },
    pbar: mix(c.accent, 0.28),
    edge: {
      '': { color: c.grid, a: 1, w: 1 },
      doomed: { color: c.critical, a: 0.45, w: 1 },
      feed: { color: c.accent, a: 0.55, w: 1.4, dash: [6, 6] },
      active: { color: c.accent, a: 0.55, w: 1.2 },
      edone: { color: c.good, a: 0.3, w: 1 },
    },
    glowGrad: null,
  };
  styleCache.clear();
}

function nodeStyle(n, far) {
  const key = `${n.st}|${n.doomed ? 1 : 0}|${n.next ? 1 : 0}|${far ? 1 : 0}`;
  let st = styleCache.get(key);
  if (!st) {
    st = { ...(pal.state[n.st] || pal.state.base) };
    if (n.next) Object.assign(st, pal.next);
    if (n.doomed) Object.assign(st, pal.doomed);
    if (far && pal.far[n.st]) Object.assign(st, pal.far[n.st]);
    styleCache.set(key, st);
  }
  return st;
}

/* ---- the canvas and the frame loop ---- */

function setup() {
  if (cv) return true;
  cv = $('#graph');
  if (!cv) return false;
  ctx = cv.getContext('2d');
  new ResizeObserver(() => { sizeCanvas(); requestDraw(); }).observe(cv);
  sizeCanvas();
  return true;
}

function sizeCanvas() {
  const r = cv.getBoundingClientRect();
  dpr = devicePixelRatio || 1;
  cw = r.width; ch = r.height;
  const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
  if (cv.width !== W) cv.width = W;
  if (cv.height !== H) cv.height = H;
}

// a frame for input: pan, zoom, hover, a layout step. Ambient motion
// keeps its own slower frames going.
export function requestDraw() {
  urgent = true;
  if (!raf && setup()) raf = requestAnimationFrame(frame);
}

function shown() {
  return cv.offsetParent !== null && App.layoutMode !== '3d' && cw > 0 && ch > 0;
}

function frame(now) {
  raf = null;
  if (!shown()) return;  // a hidden pane draws again when its size returns
  if (!urgent && now - lastDraw < 32) {
    raf = requestAnimationFrame(frame);
    return;
  }
  if ((devicePixelRatio || 1) !== dpr) sizeCanvas();  // moved to another screen
  const dt = lastDraw ? Math.min(0.1, (now - lastDraw) / 1000) : 0;
  lastDraw = now;
  urgent = false;
  const more = draw(now, dt);
  if (more === 'fade') urgent = true;  // fades ease at the full frame rate
  if (more) raf = requestAnimationFrame(frame);
}

/* ---- geometry helpers ---- */

function boxPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// the edge curve of a layered graph: out of the right side of a, into
// the left side of b, with horizontal handles
function edgeEnds(na, nb) {
  const x1 = na.x + na.w, y1 = na.y, x2 = nb.x, y2 = nb.y;
  return [x1, y1, x2, y2, Math.max(24, Math.min(60, (x2 - x1) / 2))];
}

// an arc length table for the curve, so droplets move at a constant speed
const LUT_N = 32;
function edgeLut(e, x1, y1, x2, y2, dx) {
  const key = `${x1},${y1},${x2},${y2}`;
  if (e.lutKey === key) return e.lut;
  const xs = new Float32Array(LUT_N + 1), ys = new Float32Array(LUT_N + 1);
  const cum = new Float32Array(LUT_N + 1);
  for (let i = 0; i <= LUT_N; i++) {
    const u = i / LUT_N, m = 1 - u;
    const a = m * m * m, b = 3 * m * m * u, c = 3 * m * u * u, d = u * u * u;
    xs[i] = a * x1 + b * (x1 + dx) + c * (x2 - dx) + d * x2;
    ys[i] = a * y1 + b * y1 + c * y2 + d * y2;
    if (i) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  }
  e.lutKey = key;
  e.lut = { xs, ys, cum, len: cum[LUT_N] };
  return e.lut;
}

function pointAt(lut, d) {
  const { xs, ys, cum } = lut;
  let lo = 0, hi = LUT_N;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < d) lo = mid; else hi = mid;
  }
  const span = cum[hi] - cum[lo] || 1, f = (d - cum[lo]) / span;
  return [xs[lo] + (xs[hi] - xs[lo]) * f, ys[lo] + (ys[hi] - ys[lo]) * f];
}

// 0 at the start of a CSS ease-in-out cycle, 1 halfway, 0 again at the end
const wave = (t, period, phase = 0) => 0.5 - 0.5 * Math.cos(TAU * (t / period + phase));

/* ---- one frame ---- */

function draw(now, dt) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  const vb = App.vb;
  if (!App.lay || !App.lay.nodes.size || !vb) return false;
  if (!pal) readPalette();
  const motion = !REDUCED.matches;
  const t = now / 1000;
  const s = Math.min(cw / vb.w, ch / vb.h);
  const ox = (cw - vb.w * s) / 2, oy = (ch - vb.h * s) / 2;
  ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (ox - vb.x * s), dpr * (oy - vb.y * s));
  // the world rect the canvas shows, letterbox included
  const X0 = vb.x - ox / s, Y0 = vb.y - oy / s, X1 = X0 + cw / s, Y1 = Y0 + ch / s;
  const { nodes, H } = App.lay;
  const far = View.far;
  const searching = !!GS.set;
  const efocus = edgeFocus !== null, nfocus = nodeFocus !== null;
  let ambient = false, fading = false;

  // halos behind the building packages, backmost
  if (!pal.glowGrad) {
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, rgba(pal.c.accent, 0.3));
    g.addColorStop(0.55, rgba(pal.c.accent, 0.1));
    g.addColorStop(1, rgba(pal.c.accent, 0));
    pal.glowGrad = g;
  }
  for (const n of nodes.values()) {
    if (n.st !== 'building') continue;
    const rx = n.w / 2 + 70, ry = 62, cx = n.x + n.w / 2;
    if (cx + rx < X0 || cx - rx > X1 || n.y + ry < Y0 || n.y - ry > Y1) continue;
    ambient = true;
    const breath = motion ? 0.55 + 0.45 * wave(t, 2.6, n.ph || 0) : 1;
    ctx.save();
    ctx.translate(cx, n.y);
    ctx.scale(rx, ry);
    ctx.globalAlpha = breath * (searching ? 0.15 : 1);
    ctx.fillStyle = pal.glowGrad;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // edges, batched: one path per look
  const groups = new Map();
  const flows = [];
  for (const e of App.edgeList) {
    const na = nodes.get(e.a), nb = nodes.get(e.b);
    if (!na || !nb) continue;
    const [x1, y1, x2, y2, dx] = edgeEnds(na, nb);
    if (Math.max(x2, x1 + dx) < X0 || Math.min(x1, x2 - dx) > X1
        || Math.max(y1, y2) < Y0 || Math.min(y1, y2) > Y1) continue;
    const key = e.kind + (efocus ? (e.hl ? '|hl' : '|dim') : '');
    let g = groups.get(key);
    if (!g) groups.set(key, g = { kind: e.kind, hl: efocus && e.hl, dim: efocus && !e.hl, list: [] });
    g.list.push(x1, y1, x2, y2, dx);
    if (e.kind === 'active' && motion) flows.push([e, x1, y1, x2, y2, dx]);
  }
  for (const g of groups.values()) {
    const st = pal.edge[g.kind] || pal.edge[''];
    let a = st.a;
    if (g.kind === 'active' && motion) { a = 0.55 - 0.3 * wave(t, 1.6); ambient = true; }
    if (g.kind === 'edone' && far) a = 0.1;
    if (g.dim) a *= 0.15;
    if (g.hl) a = 1;
    if (searching) a *= 0.12;
    ctx.globalAlpha = a;
    ctx.strokeStyle = g.hl ? pal.c.accent : st.color;
    ctx.lineWidth = g.hl ? 1.6 : st.w;
    ctx.setLineDash(st.dash || []);
    if (st.dash && motion) { ctx.lineDashOffset = -((t / 0.9) % 1) * 24; ambient = true; }
    // One stroke per edge, as SVG drew them: where translucent edges
    // cross, they add up, and a bundle reads darker. It is also faster:
    // Skia strokes one long path of crossing curves slowly.
    const L = g.list;
    for (let i = 0; i < L.length; i += 5) {
      const x1 = L[i], y1 = L[i + 1], x2 = L[i + 2], y2 = L[i + 3], dx = L[i + 4];
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;

  // droplets that flow along the edges into a building package
  if (flows.length) {
    ambient = true;
    ctx.fillStyle = pal.c.accent;
    for (const dimmed of [false, true]) {
      ctx.globalAlpha = dimmed ? 0.08 : 0.85;
      ctx.beginPath();
      for (const [e, x1, y1, x2, y2, dx] of flows) {
        if (dimmed !== (efocus && !e.hl)) continue;
        const lut = edgeLut(e, x1, y1, x2, y2, dx);
        const dur = lut.len / FLOW_SPEED;
        const k = Math.min(12, Math.max(1, Math.round(lut.len / FLOW_SPACING)));
        const jitter = (e.idx % 7) * 0.23;
        for (let i = 0; i < k; i++) {
          const [px, py] = pointAt(lut, (((t + i * dur / k + jitter) % dur) / dur) * lut.len);
          ctx.moveTo(px + 2.2, py);
          ctx.arc(px, py, 2.2, 0, TAU);
        }
      }
      ctx.fill();
    }
  }

  // nodes
  let font = '';
  const pad = 12;  // the breathing and the glow reach a little past the box
  for (const [name, n] of nodes) {
    if (n.x + n.w + pad < X0 || n.x - pad > X1 || n.y + H / 2 + pad < Y0 || n.y - H / 2 - pad > Y1)
      continue;
    // the fade target: a search hides the rest most, a focus less
    const target = searching && !GS.set.has(name) ? 0.15
      : nfocus && !n.hl ? 0.35 : n.st === 'excluded' ? 0.35 : 1;
    if (n.alpha == null || !motion) n.alpha = target;
    else if (n.alpha !== target) {
      n.alpha += (target - n.alpha) * (1 - Math.exp(-dt / 0.12));
      if (Math.abs(target - n.alpha) < 0.01) n.alpha = target; else fading = true;
    }
    const st = nodeStyle(n, far);
    const sel = App.selected.has(name), hover = View.hover === name || View.hot === name;
    const match = searching && GS.set.has(name);
    let stroke = st.stroke, w = st.w, strokeA = 1, shadow = 0;
    // a search match keeps its state color, with a wider outline; only a
    // plain box takes the accent
    if (match) { w = 2.5; if (st.stroke === pal.state.base.stroke) stroke = pal.c.accent; }
    if (hover) { w = 2.2; shadow = pal.dark ? 4 : 3; }
    if (sel) { stroke = pal.c.accent; w = 2.6; shadow = Math.max(shadow, 4); }
    let scale = 1;
    if (n.st === 'building' && motion) {
      const k = wave(t, 1.5, n.ph || 0);
      scale = 1 + 0.06 * k;
      strokeA = 1 - 0.6 * k;
      ambient = true;
    } else if (st.pulse && motion) {
      strokeA = 1 - 0.75 * wave(t, 2);
      ambient = true;
    }
    if (n.flashUntil > now) {
      const k = wave((now - n.flashUntil + 2000) / 1000, 0.5);
      stroke = k > 0.5 ? pal.c.accent : stroke;
      w += (3.5 - w) * k;
      strokeA = Math.max(strokeA, k);
      ambient = true;
    }
    const x = n.x, y = n.y - H / 2;
    ctx.globalAlpha = n.alpha;
    if (scale !== 1) {
      ctx.save();
      ctx.translate(x + n.w / 2, n.y);
      ctx.scale(scale, scale);
      ctx.translate(-(x + n.w / 2), -n.y);
    }
    ctx.beginPath();
    boxPath(x, y, n.w, H, 5);
    if (shadow) {
      ctx.shadowColor = st.glow;
      ctx.shadowBlur = shadow * s * dpr;
    }
    ctx.fillStyle = hover ? brighten(st.fill, pal.dark ? 1.3 : 1.06) : st.fill;
    ctx.fill();
    if (shadow) ctx.shadowBlur = 0;
    if (stroke) {
      ctx.globalAlpha = n.alpha * strokeA;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = w;
      ctx.setLineDash(st.dash && !match && !sel ? st.dash : []);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = n.alpha;
    }
    if (n.st === 'building' && n.pct) {
      ctx.beginPath();
      boxPath(x, y, Math.max(6, n.w * n.pct / 100), H, 5);
      ctx.fillStyle = pal.pbar;
      ctx.fill();
    }
    if (!far) {
      const f = `${st.bold ? '600 ' : ''}11px ${pal.c.mono}`;
      if (f !== font) { ctx.font = font = f; ctx.textBaseline = 'middle'; }
      ctx.fillStyle = st.text;
      const text = label(name);
      ctx.fillText(text, x + 9, n.y + 0.5);
      if (st.strike) {
        ctx.fillRect(x + 9, n.y, ctx.measureText(text).width, 0.8);
      }
    }
    if (scale !== 1) ctx.restore();
  }
  ctx.globalAlpha = 1;
  return fading ? 'fade' : ambient && motion ? 'ambient' : false;
}

on('theme-changed', () => { pal = null; requestDraw(); });
REDUCED.addEventListener?.('change', () => requestDraw());
