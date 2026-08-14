import { on } from './bus.js';
import { breakFollow, zoomToPkg } from './camera.js';
import { applySpread } from './force.js';
import { drawGantt } from './gantt.js';
import { buildGraphView } from './graph.js';
import { mode } from './modes.js';
import { App } from './state.js';
import { $ } from './util.js';

/* ---------------- view switching, dock resize ---------------- */

/* Deep links: #pkg=<name>&view=<view> mirrors the open log pane and
   the picked view, so a pasted address restores both. The ws and
   build query params already pin the workspace and the build. */

export function syncHash() {
  const params = new URLSearchParams();
  const pane = App.panes.get(App.activePane);
  if (pane && !pane.fixed && !pane.ai && !pane.summary)
    params.set('pkg', pane.name);
  // with a pkg the view is always encoded, so a shared link restores
  // both; without one, only a non-default view earns a hash
  if (params.has('pkg') || App.view !== 'split')
    params.set('view', App.view);
  const h = params.toString();
  history.replaceState(null, '',
    location.pathname + location.search + (h ? '#' + h : ''));
}

export function setView(v) {
  App.view = v;
  localStorage.setItem('cmc-view', v);
  document.querySelectorAll('.vtab').forEach(x =>
    x.classList.toggle('on', x.dataset.view === v));
  const showGraph = v !== 'gantt';
  const showGantt = v !== 'graph';
  $('#graphwrap').hidden = !showGraph;
  $('#ganttwrap').hidden = !showGantt;
  $('#vsplit').hidden = v !== 'split';
  $('#viz').classList.toggle('split', v === 'split');
  $('#fitBtn').style.display = showGraph ? '' : 'none';
  $('#followBuildBtn').style.display = showGraph ? '' : 'none';
  $('#scopeCtl').style.display = showGraph ? '' : 'none';
  $('#layoutSel').style.display = showGraph ? '' : 'none';
  document.querySelectorAll('.vsep.gonly')
    .forEach(x => x.style.display = showGraph ? '' : 'none');
  document.querySelectorAll('.vsep.bothonly')  // between the two control groups
    .forEach(x => x.style.display = v === 'split' ? '' : 'none');
  $('#gfollowBtn').style.display = showGantt ? '' : 'none';
  $('#gsortSel').style.display = showGantt ? '' : 'none';
  updateForceCtl();
  syncHash();
  dispatchEvent(new Event('resize'));  // both panels take their new sizes
  if (showGantt) drawGantt();
  if (!showGraph) mode().hide?.();
  else mode().show?.();
}

export function updateForceCtl() {
  $('#forceCtl').hidden =
    !(App.view !== 'gantt' && App.layoutMode !== 'layered');
}

export function setLayoutMode(m) {
  const prev = mode();
  App.layoutMode = m;
  localStorage.setItem('cmc-layout', m);
  $('#layoutSelect').value = m;
  $('#graphwrap').classList.toggle('mode3d', m === '3d');
  updateForceCtl();
  const next = mode();
  if (next !== prev) prev.deactivate?.();
  next.activate?.();
}

export function initViews() {
  for (const b of document.querySelectorAll('.vtab')) {
    b.onclick = () => setView(b.dataset.view);
  }
  const hash = new URLSearchParams(location.hash.slice(1));
  const hashView = hash.get('view');
  setView(['graph', 'gantt', 'split'].includes(hashView)
    ? hashView : (localStorage.getItem('cmc-view') || 'split'));
  const hashPkg = hash.get('pkg');
  // the hash is untrusted input, so it must look like a package name;
  // returned so the caller opens it after the build-log pane
  const deepPkg = hashPkg && /^[\w.+-]+$/.test(hashPkg) ? hashPkg : null;
  $('#fitBtn').onclick = () => {
    breakFollow();
    mode().fit();
  };
  const fb = $('#followBuildBtn');
  fb.onclick = () => {
    App.followBuild = !App.followBuild;
    fb.classList.toggle('on', App.followBuild);
    if (App.followBuild) mode().followFrontier();
  };
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
  App.ganttSort = localStorage.getItem('cmc-gsort') || 'start';
  const gsort = $('#gsortSelect');
  gsort.value = App.ganttSort;
  gsort.onchange = () => {
    App.ganttSort = gsort.value;
    localStorage.setItem('cmc-gsort', gsort.value);
    drawGantt();
  };
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
  const setScope = scope => {
    if (App.scope === scope) return;
    App.scope = scope;
    $('#scopeBuild').classList.toggle('on', scope === 'build');
    $('#scopeAll').classList.toggle('on', scope === 'all');
    App.vb = null;  // refit to the new extent
    buildGraphView();
  };
  $('#scopeBuild').onclick = () => setScope('build');
  $('#scopeAll').onclick = () => setScope('all');

  const vs = $('#vsplit');
  const viz = $('#viz');
  const savedSplit = localStorage.getItem('cmc-split');
  if (savedSplit) viz.style.setProperty('--split-w', savedSplit);
  vs.addEventListener('pointerdown', ev => {
    ev.preventDefault();
    const move = e => {
      const r = viz.getBoundingClientRect();
      const pct = Math.min(85, Math.max(15,
        (e.clientX - r.left) / r.width * 100));
      viz.style.setProperty('--split-w', pct.toFixed(1) + '%');
      dispatchEvent(new Event('resize'));
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      localStorage.setItem('cmc-split',
        viz.style.getPropertyValue('--split-w'));
      drawGantt();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });

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
  return deepPkg;
}

on('state', () => mode().onState?.());

on('pane-changed', syncHash);

on('focus-pkg', name => {
  if (App.view === 'gantt') setView('split');  // bring the graph in
  zoomToPkg(name);
});
