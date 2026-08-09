import { frontierView } from './camera.js';
import { activatePane, openPane, resetPane } from './dock.js';
import { frontier3d } from './g3d.js';
import { buildGraphView, computePrefix } from './graph.js';
import { applyState, setBadge, updateSysMeters } from './header.js';
import { App } from './state.js';
import { toast } from './toasts.js';
import { $, fmtDur, wsParam } from './util.js';

/* ---------------- polling ---------------- */

export async function pollState() {
  let s;
  try {
    s = await (await fetch(`/api/state${wsParam()}`)).json();
  } catch (e) {
    setBadge('offline', App.stopped
      ? 'STOPPED — the server was shut down'
      : 'OFFLINE — the server does not answer');
    return;
  }
  if (s.nows) {
    setBadge('idle', 'PICK A WORKSPACE');
    $('#ws').textContent = 'pick a workspace';
    $('#buildid').textContent = 'builds';
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
    if (first && App.failedSeen.size) {
      // a page opened on a failed build lands on the failures,
      // earliest first: later failures are usually its cascade
      const failed = Object.entries(s.packages)
        .filter(([, p]) => p.s === 'failed')
        .sort((a, b) => (a[1].t1 ?? 0) - (b[1].t1 ?? 0))
        .slice(0, 6).map(([n]) => n);
      for (const name of failed) openPane(name);
      activatePane(failed[0]);
    }
    if (!first) {
      toast(`New build started: <b>${s.build_id}</b>`, 'info');
      for (const pane of App.panes.values()) resetPane(pane);
    }
    await fetchGraph();
  }
  App.pkgs = s.packages;
  App.active = s.active;
  App.ai = !!s.ai;
  App.total = s.total;
  App.buildStarted = s.build_started;
  App.elapsedBase = s.elapsed;
  App.elapsedAt = Date.now();
  applyState(s);
  if (App.followBuild && App.active && App.view !== 'gantt') {
    App.layoutMode === '3d' ? frontier3d() : frontierView();
  }
  // jobs can register moments after the graph was fetched
  if (App.graphJobCount !== s.total && Date.now() - App.lastGraphFetch > 10000) {
    await fetchGraph();
    applyState(s);
  }
}

export async function fetchGraph() {
  const g = await (await fetch(`/api/graph${wsParam()}`)).json();
  App.graph = g.packages;
  App.lastGraphFetch = Date.now();
  App.graphJobCount = Object.values(g.packages).filter(p => p.in_build).length;
  computePrefix();
  buildGraphView();
}

/* ---------------- boot ---------------- */

export function tickElapsed() {
  let e = App.elapsedBase;
  if (App.active) e += (Date.now() - App.elapsedAt) / 1000;
  $('#t-elapsed').textContent = fmtDur(e);
}
