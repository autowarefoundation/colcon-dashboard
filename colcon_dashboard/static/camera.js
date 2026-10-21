import { emit } from './bus.js';
import { Force, forceTick, stopForce } from './force.js';
import { buildGraphView, clearFocus, cullEdges, hideTooltip, hoverFocus, showNodeTooltip,
         uncullEdges } from './graph.js';
import { mode, registerMode } from './modes.js';
import { App } from './state.js';
import { $ } from './util.js';

export function svgCoords(ev) {
  return clientToWorld(ev.clientX, ev.clientY);
}

/* pan / zoom */

export function viewScale(vb, r) {
  // the uniform scale SVG really renders with (preserveAspectRatio meet)
  return Math.min(r.width / vb.w, r.height / vb.h);
}

export function clientToWorld(clientX, clientY) {
  const r = $('#graph').getBoundingClientRect();
  const vb = App.vb;
  const s = viewScale(vb, r);
  const ox = (r.width - vb.w * s) / 2;   // letterbox centering offsets
  const oy = (r.height - vb.h * s) / 2;
  return [vb.x + (clientX - r.left - ox) / s,
          vb.y + (clientY - r.top - oy) / s];
}

export function setViewBox(vb) {
  App.vb = vb;
  const svg = $('#graph');
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  // zoomed very far out, the 11px labels shrink below 1.5px and are only
  // smudges: then draw the nodes as plain colored boxes and fade the
  // finished edges. Small but still readable labels stay.
  const s = Math.min(svg.clientWidth / vb.w, svg.clientHeight / vb.h);
  svg.classList.toggle('far', s > 0 && s * 11 < 1.5);
  mode().onViewBox?.(vb);
}
export function bboxOf(names) {
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
export function fitGraph() {
  const bb = bboxOf(App.lay ? App.lay.nodes.keys() : []);
  if (bb) setViewBox(bb);
}
export function frontierView() {
  const hot = Object.keys(App.pkgs)
    .filter(n => ['building', 'ready', 'failed'].includes(App.pkgs[n].s));
  const bb = bboxOf(hot);
  if (bb) setViewBox(bb); else fitGraph();
}

export function breakFollow() {
  if (!App.followBuild) return;
  App.followBuild = false;
  $('#followBuildBtn').classList.remove('on');
}

/* double-click a dock tab: fly the selected view to that package */
export function zoomToPkg(name) {
  breakFollow();
  Force.autoFit = false;  // stay on the package while the layout settles
  if (App.view === 'gantt') {
    const wrap = $('#ganttwrap');
    const bar = $('#gantt').querySelector(
      `.gbar[data-name="${CSS.escape(name)}"]`);
    if (!bar) return;
    wrap.scrollTop = Math.max(0, bar.y.baseVal.value - wrap.clientHeight / 2);
    wrap.scrollLeft = Math.max(0, bar.x.baseVal.value - wrap.clientWidth / 2);
    bar.classList.add('flash');
    setTimeout(() => bar.classList.remove('flash'), 2000);
    return;
  }
  const focus = mode().focusPkg;
  if (focus) return focus(name);
  const nd = App.lay?.nodes.get(name);
  if (!nd || !App.vb) return;
  const r = $('#graph').getBoundingClientRect();
  const w = 700;
  const h = w * (r.height && r.width ? r.height / r.width : 0.66);
  setViewBox({ x: nd.x + nd.w / 2 - w / 2, y: nd.y - h / 2, w, h });
  const el = App.nodeEls.get(name);
  if (el) {
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 2000);
  }
}

export function initPanZoom() {
  const svg = $('#graph');
  let moved = 0;
  let downNode = null;  // pointer capture retargets `click`, so remember the node
  svg.addEventListener('click', () => {
    if (moved <= 4 && downNode) emit('open-pkg', downNode);
  });
  svg.addEventListener('pointerleave', () => { hideTooltip(); clearFocus(); });
  // Pan and zoom do not change the view box on each step: that redraws
  // every edge at screen scale, which lags when zoomed in. They draw a
  // picture three views wide once, show the moving view over it with a
  // CSS transform, and set the real view box once when the gesture ends.
  let pic = null;  // { big: the drawn view box, vb: the view shown now }
  const wrapRect = () => svg.parentElement.getBoundingClientRect();
  const picStart = vb => {
    const big = { x: vb.x - vb.w, y: vb.y - vb.h, w: 3 * vb.w, h: 3 * vb.h };
    svg.classList.add('bigpan');
    svg.setAttribute('viewBox', `${big.x} ${big.y} ${big.w} ${big.h}`);
    mode().onViewBox?.(big);
    pic = { big, vb };
  };
  const picShow = vb => {
    if (!pic) picStart(vb);
    const b = pic.big;
    // a view that leaves the drawn picture: draw it again around this view
    if (vb.x < b.x || vb.y < b.y || vb.x + vb.w > b.x + b.w || vb.y + vb.h > b.y + b.h) {
      picEnd();
      picStart(vb);
    }
    pic.vb = vb;
    // the transform that makes the drawn picture (3x the wrapper, at -1x,
    // -1x) look like the view vb in the wrapper
    const r = wrapRect();
    const W = r.width, H = r.height, D = pic.big;
    const sD = Math.min(3 * W / D.w, 3 * H / D.h);
    const s = Math.min(W / vb.w, H / vb.h);
    const S = s / sD;
    const tx = (W - vb.w * s) / 2 + W - S * (3 * W - D.w * sD) / 2 + s * (D.x - vb.x);
    const ty = (H - vb.h * s) / 2 + H - S * (3 * H - D.h * sD) / 2 + s * (D.y - vb.y);
    svg.style.transform = `translate(${tx}px, ${ty}px) scale(${S})`;
  };
  const picEnd = () => {
    if (!pic) return;
    const vb = pic.vb;
    pic = null;
    svg.classList.remove('bigpan');
    svg.style.transform = '';
    setViewBox(vb);
  };
  const shownVb = () => pic?.vb || App.vb;

  let wheelTimer = null;
  svg.addEventListener('wheel', ev => {
    ev.preventDefault();
    if (!App.vb || drag) return;  // no zoom while a pan moves the picture
    breakFollow();
    Force.autoFit = false;
    const vb = shownVb();
    const r = wrapRect();
    const s = viewScale(vb, r);
    const wx = vb.x + (ev.clientX - r.left - (r.width - vb.w * s) / 2) / s;
    const wy = vb.y + (ev.clientY - r.top - (r.height - vb.h * s) / 2) / s;
    // the zoom follows the wheel distance: a mouse notch (about 100 px)
    // zooms about 25%, and a trackpad zooms smoothly in small steps
    const px = ev.deltaY * (ev.deltaMode === 1 ? 33 : ev.deltaMode === 2 ? 400 : 1);
    const f = Math.min(Math.max(Math.exp(px * 0.0022), 0.5, 120 / vb.w), 2, 200000 / vb.w);
    // keep the world point under the cursor fixed while scaling
    picShow({ x: wx + (vb.x - wx) * f, y: wy + (vb.y - wy) * f, w: vb.w * f, h: vb.h * f });
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(picEnd, 160);  // the gesture rests: draw it sharp
  }, { passive: false });
  let drag = null;
  svg.addEventListener('pointerdown', ev => {
    if (!App.vb) return;
    downNode = ev.target.closest('.node')?.dataset.name || null;
    moved = 0;
    Force.autoFit = false;
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
    breakFollow();  // a manual pan releases the build-follow camera
    clearTimeout(wheelTimer);
    picEnd();  // a zoom still on the picture: settle it first
    drag = { x: ev.clientX, y: ev.clientY, vb: { ...App.vb },
             s: viewScale(App.vb, wrapRect()) };
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
      picShow({ ...drag.vb,
                x: drag.vb.x - (ev.clientX - drag.x) / drag.s,
                y: drag.vb.y - (ev.clientY - drag.y) / drag.s });
      return;
    }
    const g = ev.target.closest('.node');
    if (g) { showNodeTooltip(g.dataset.name, ev); hoverFocus(g.dataset.name); }
    else { hideTooltip(); clearFocus(); }
  });
  const end = () => {
    if (Force.dragging) { Force.dragging.fx = Force.dragging.fy = null; Force.dragging = null; }
    if (drag) picEnd();
    drag = null;
    svg.classList.remove('panning');
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
}

registerMode('layered', {
  activate: () => { stopForce(); App.vb = null; buildGraphView(); },
  deactivate: uncullEdges,  // force mode moves every edge, so it shows them all
  onViewBox: cullEdges,
  fit: fitGraph,
  followFrontier: frontierView,
});
