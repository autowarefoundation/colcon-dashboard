import { emit } from './bus.js';
import { setBadge, updateSysMeters } from './header.js';
import { mode } from './modes.js';
import { App } from './state.js';
import { toast } from './toasts.js';
import { $, fmtDur, wsParam } from './util.js';

/* ---------------- polling ---------------- */

// One poll at a time: the next one starts after the last one ends, so
// slow answers cannot pile up or land out of order.
export function startStatePolling() {
  const loop = async () => {
    let ok = false;
    try { ok = await pollState(); } catch (e) { /* keep polling */ }
    setTimeout(loop, ok === false ? 2000 : 1000);  // slower while offline
  };
  loop();
}

// The version of the server that this page started with. When the
// server restarts into an upgrade, this page's code is old: load the new
// code, and say why after the reload.
let serverVersion = null;
function followServerVersion(v) {
  if (!v) return;  // a server older than this page sends none
  if (serverVersion === null) {
    serverVersion = v;
    let was = null;
    try {
      was = sessionStorage.getItem('cmc-upgraded');
      sessionStorage.removeItem('cmc-upgraded');
    } catch (e) { /* no storage */ }
    if (was === v) toast(`The dashboard restarted with version ${v}.`, 'info');
  } else if (v !== serverVersion) {
    try { sessionStorage.setItem('cmc-upgraded', v); } catch (e) { /* no storage */ }
    location.reload();
  }
}

export async function pollState() {
  let s;
  try {
    const res = await fetch(`/api/state${wsParam()}`);
    followServerVersion(res.headers.get('X-Dashboard-Version'));
    s = await res.json();
  } catch (e) {
    // the build may still run, but nobody can tell: stop the clock
    if (App.active) {
      App.elapsedBase += (Date.now() - App.elapsedAt) / 1000;
      App.active = false;
    }
    setBadge('offline', App.stopped
      ? 'STOPPED - the server was shut down'
      : 'OFFLINE - the server does not answer');
    emit('state-lost');
    return false;
  }
  // only "there is no build" errors: "scanning..." comes first on every load
  const visibleError = /^(?:no (?:colcon build logs|events\.log)|remote workspace:)/
    .test(s.error || '');
  $('#vizEmpty').hidden = s.nows || !visibleError;
  if (s.nows) {
    setBadge('idle', 'PICK A WORKSPACE');
    // write into the switchers' value lines: header.js fills their parts
    $('#ws .sw-val').textContent = 'Pick a workspace';
    $('#buildid .sw-val').textContent = 'No build';
    emit('state-lost');
    return;
  }
  if (s.error) {
    $('#vizEmpty .why').textContent = s.error;
    const loading = s.error.startsWith('scanning');
    setBadge('idle', loading ? 'LOADING' : 'WAITING');
    $('#buildid .sw-val').textContent = loading ? 'Loading…' : 'No build yet';
    $('#buildid').title = s.error;
    updateSysMeters(s.sys);
    emit('state-lost');
    return;
  }
  // set before build-changed: its handlers open panes that render paths
  App.workspace = s.workspace || App.workspace;
  App.remote = s.remote || null;
  App.capabilities = s.capabilities || {};
  App.runRoot = s.run_root || '';
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
  } else if (s.prev_id && s.prev_id !== App.prev?.id && App.prevAsked !== s.prev_id) {
    // the server read the previous run after the graph came: once per run
    App.prevAsked = s.prev_id;
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
  const el = $('#t-elapsed');  // only a live build shows the clock
  if (el) el.textContent = fmtDur(e);
}
