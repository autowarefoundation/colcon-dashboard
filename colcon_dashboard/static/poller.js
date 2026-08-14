import { emit } from './bus.js';
import { setBadge, updateSysMeters } from './header.js';
import { mode } from './modes.js';
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
  // set before build-changed: its handlers open panes that render paths
  App.workspace = s.workspace || App.workspace;
  if (s.build_id !== App.buildId) {
    const first = App.buildId === null;
    App.buildId = s.build_id;
    App.failedSeen = new Set(
      Object.entries(s.packages).filter(([, p]) => p.s === 'failed').map(([n]) => n));
    if (!first) toast(`New build started: <b>${s.build_id}</b>`, 'info');
    emit('build-changed', s, first);
    await fetchGraph();
  }
  App.pkgs = s.packages;
  App.active = s.active;
  App.ai = !!s.ai;
  App.total = s.total;
  App.buildStarted = s.build_started;
  App.elapsedBase = s.elapsed;
  App.elapsedAt = Date.now();
  emit('state', s);
  for (const [name, p] of Object.entries(App.pkgs)) {
    if (p.s === 'failed' && !App.failedSeen.has(name)) {
      App.failedSeen.add(name);
      emit('pkg-failed', name);
    }
  }
  if (App.followBuild && App.active && App.view !== 'gantt') {
    mode().followFrontier();
  }
  // jobs can register moments after the graph was fetched
  if (App.graphJobCount !== s.total && Date.now() - App.lastGraphFetch > 10000) {
    await fetchGraph();
    emit('state', s);
  }
}

export async function fetchGraph() {
  const g = await (await fetch(`/api/graph${wsParam()}`)).json();
  App.graph = g.packages;
  App.prev = g.prev || null;
  App.lastGraphFetch = Date.now();
  App.graphJobCount = Object.values(g.packages).filter(p => p.in_build).length;
  emit('graph');
}

/* ---------------- boot ---------------- */

export function tickElapsed() {
  let e = App.elapsedBase;
  if (App.active) e += (Date.now() - App.elapsedAt) / 1000;
  $('#t-elapsed').textContent = fmtDur(e);
}
