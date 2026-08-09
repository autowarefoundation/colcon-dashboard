import { openPane } from './dock.js';
import { Force, forceTick } from './force.js';
import { G3 } from './g3d.js';
import { clearFocus, hideTooltip, hoverFocus, showNodeTooltip } from './graph.js';
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
  $('#graph').setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
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
  if (App.layoutMode === '3d') {
    const n = Force.nodes.find(f => f.name === name);
    if (!n) return;
    G3.auto = false;  // keep the camera where we point it
    G3.tx = n.cx; G3.ty = n.cy; G3.tz = n.cz;
    G3.dist = 500;
    return;
  }
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
    if (moved <= 4 && downNode) openPane(downNode);
  });
  svg.addEventListener('pointerleave', () => { hideTooltip(); clearFocus(); });
  svg.addEventListener('wheel', ev => {
    ev.preventDefault();
    if (!App.vb) return;
    breakFollow();
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
    breakFollow();  // a manual pan releases the build-follow camera
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
