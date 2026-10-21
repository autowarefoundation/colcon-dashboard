import { emit } from './bus.js';
import { Force, forceTick, stopForce } from './force.js';
import { requestDraw, View } from './draw.js';
import { buildGraphView, clearFocus, clearSelection, hideTooltip, hoverFocus,
         selectPkg, showNodeTooltip } from './graph.js';
import { mode, registerMode } from './modes.js';
import { App } from './state.js';
import { $ } from './util.js';

export function svgCoords(ev) {
  return clientToWorld(ev.clientX, ev.clientY);
}

/* pan / zoom. App.vb is the world rect in view. It fits the canvas like
   an SVG viewBox with preserveAspectRatio "meet": one uniform scale, and
   the spare room split evenly on both sides. */

export function viewScale(vb, r) {
  return Math.min(r.width / vb.w, r.height / vb.h);
}

// the package under a client point, or null
export function nodeAt(clientX, clientY) {
  if (!App.lay || !App.vb) return null;
  const [x, y] = clientToWorld(clientX, clientY);
  const h = App.lay.H / 2;
  let hit = null;
  for (const [name, n] of App.lay.nodes)  // the last drawn is on top
    if (x >= n.x && x <= n.x + n.w && y >= n.y - h && y <= n.y + h) hit = name;
  return hit;
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
  const cv = $('#graph');
  // zoomed very far out, the 11px labels shrink below 1.5px and are only
  // smudges: then draw the nodes as plain colored boxes and fade the
  // finished edges. Small but still readable labels stay.
  const s = Math.min(cv.clientWidth / vb.w, cv.clientHeight / vb.h);
  View.far = s > 0 && s * 11 < 1.5;
  mode().onViewBox?.(vb);
  requestDraw();
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
  nd.flashUntil = performance.now() + 2000;  // draw.js flashes its outline
  requestDraw();
}

export function initPanZoom() {
  const cv = $('#graph');
  let moved = 0;
  let downNode = null;  // pointer capture retargets `click`, so remember the node
  const setHover = name => {
    if (View.hover === name) return;
    View.hover = name;
    cv.style.cursor = name ? 'pointer' : '';
    requestDraw();
  };
  cv.addEventListener('click', ev => {
    if (moved > 4) return;  // the end of a drag, not a click
    if (!downNode) return clearSelection();  // a click on empty space
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return selectPkg(downNode, true);
    selectPkg(downNode);
    emit('open-pkg', downNode);
  });
  cv.addEventListener('pointerleave', () => { setHover(null); hideTooltip(); clearFocus(); });
  const wrapRect = () => cv.getBoundingClientRect();

  cv.addEventListener('wheel', ev => {
    ev.preventDefault();
    if (!App.vb || drag) return;  // no zoom while a pan moves the view
    breakFollow();
    Force.autoFit = false;
    const vb = App.vb;
    const r = wrapRect();
    const s = viewScale(vb, r);
    const wx = vb.x + (ev.clientX - r.left - (r.width - vb.w * s) / 2) / s;
    const wy = vb.y + (ev.clientY - r.top - (r.height - vb.h * s) / 2) / s;
    // the zoom follows the wheel distance: a mouse notch (about 100 px)
    // zooms about 25%, and a trackpad zooms smoothly in small steps
    const px = ev.deltaY * (ev.deltaMode === 1 ? 33 : ev.deltaMode === 2 ? 400 : 1);
    const f = Math.min(Math.max(Math.exp(px * 0.0022), 0.5, 120 / vb.w), 2, 200000 / vb.w);
    // keep the world point under the cursor fixed while scaling
    setViewBox({ x: wx + (vb.x - wx) * f, y: wy + (vb.y - wy) * f, w: vb.w * f, h: vb.h * f });
  }, { passive: false });
  let drag = null;
  cv.addEventListener('pointerdown', ev => {
    if (!App.vb) return;
    downNode = nodeAt(ev.clientX, ev.clientY);
    // a drag captures the pointer: the grabbed node stays lit as View.hot
    View.hot = downNode;
    moved = 0;
    Force.autoFit = false;
    if (App.layoutMode === 'force' && downNode) {
      const n = App.lay?.nodes.get(downNode);
      if (n) {
        Force.dragging = n;
        [n.fx, n.fy] = svgCoords(ev);
        Force.alpha = Math.max(Force.alpha, 0.3);
        if (!Force.raf) Force.raf = requestAnimationFrame(forceTick);
        cv.setPointerCapture(ev.pointerId);
        return;
      }
    }
    breakFollow();  // a manual pan releases the build-follow camera
    drag = { x: ev.clientX, y: ev.clientY, vb: { ...App.vb },
             s: viewScale(App.vb, wrapRect()) };
    cv.classList.add('panning');
    cv.setPointerCapture(ev.pointerId);
  });
  cv.addEventListener('pointermove', ev => {
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
      setViewBox({ ...drag.vb,
                   x: drag.vb.x - (ev.clientX - drag.x) / drag.s,
                   y: drag.vb.y - (ev.clientY - drag.y) / drag.s });
      return;
    }
    const name = nodeAt(ev.clientX, ev.clientY);
    setHover(name);
    if (name) { showNodeTooltip(name, ev); hoverFocus(name); }
    else { hideTooltip(); clearFocus(); }
  });
  const end = () => {
    if (View.hot) { View.hot = null; requestDraw(); }
    if (Force.dragging) { Force.dragging.fx = Force.dragging.fy = null; Force.dragging = null; }
    drag = null;
    cv.classList.remove('panning');
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
}

registerMode('layered', {
  activate: () => { stopForce(); App.vb = null; buildGraphView(); },
  fit: fitGraph,
  followFrontier: frontierView,
});
