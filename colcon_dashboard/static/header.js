import { on } from './bus.js';
import { App } from './state.js';
import { $, fmtDur, fmtGB } from './util.js';

/* ---------------- header + tiles ---------------- */

export async function initHeaderMeta() {
  // one boot fetch: the server version and the editor-link template
  try {
    App.cfg = await (await fetch('/api/config')).json();
  } catch (e) {
    return;  // offline: the poller reports it
  }
  if (App.cfg.version) {
    const v = `v${App.cfg.version}`;
    $('#stopBtn').title = `stop the dashboard server (${v})`;
    document.querySelector('#topbar .brand').title = `colcon-dashboard ${v}`;
  }
}

export function setBadge(cls, text) {
  const b = $('#livebadge');
  b.className = 'badge ' + (cls === 'live' ? 'live'
    : cls === 'failed' ? 'failed' : cls === 'complete' ? 'complete'
    : cls === 'offline' ? 'off' : '');
  b.innerHTML = `<span class="dot">●</span> ${text}`;
  document.body.classList.toggle('offline', cls === 'offline');
}

export function setMeter(id, pct, text, warnAt, critAt, title) {
  const el = $(id);
  const fill = el.querySelector('.smfill');
  fill.style.width = Math.min(100, pct) + '%';
  fill.classList.toggle('warn', pct >= warnAt && pct < critAt);
  fill.classList.toggle('crit', pct >= critAt);
  el.classList.toggle('crit', pct >= critAt);
  el.querySelector('.v').textContent = text;
  if (title) el.title = title;
}

export function updateSysMeters(sys) {
  const box = $('#sysmeters');
  if (!sys) { box.hidden = true; return; }
  box.hidden = false;
  if (sys.cpu != null)
    setMeter('#sm-cpu', sys.cpu, Math.round(sys.cpu) + '%', 85, 96,
             `CPU ${sys.cpu}% · load ${sys.load ?? '?'}`);
  const grid = document.querySelector('#sm-cores .coregrid');
  if (sys.cores && sys.cores.length) {
    $('#sm-cores').hidden = false;
    while (grid.children.length < sys.cores.length)
      grid.appendChild(Object.assign(document.createElement('div'),
                                     { className: 'core' }));
    while (grid.children.length > sys.cores.length) grid.lastChild.remove();
    sys.cores.forEach((p, i) => {
      const cell = grid.children[i];
      cell.style.background =
        `color-mix(in srgb, var(--accent) ${Math.round(p)}%, var(--grid))`;
      cell.title = `core ${i}: ${Math.round(p)}%`;
    });
  } else {
    $('#sm-cores').hidden = true;
  }
  if (sys.mem_total) {
    const pct = 100 * sys.mem_used / sys.mem_total;
    setMeter('#sm-ram', pct, `${fmtGB(sys.mem_used)}/${fmtGB(sys.mem_total)}G`,
             75, 90, `RAM ${pct.toFixed(1)}% used`);
  }
  const swapEl = $('#sm-swap');
  if (sys.swap_total) {
    swapEl.hidden = false;
    const pct = 100 * sys.swap_used / sys.swap_total;
    setMeter('#sm-swap', pct, `${fmtGB(sys.swap_used)}/${fmtGB(sys.swap_total)}G`,
             30, 70, `swap ${pct.toFixed(1)}% used`);
  } else {
    swapEl.hidden = true;
  }
}

export function estimateEta(s) {
  /* Remaining build time: the longest remaining dependency chain, or
     the remaining work spread over the workers, whichever is larger.
     Per-package durations come from the previous run (App.prev), with
     this run's mean as the fallback. */
  if (!s.active || !s.total || !App.graph) return null;
  const pkgs = s.packages;
  const prev = App.prev?.durations || {};
  const doneDur = [];
  for (const p of Object.values(pkgs))
    if (p.s === 'done' && p.t0 && p.t1) doneDur.push(p.t1 - p.t0);
  const prevVals = Object.values(prev);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const typical = doneDur.length >= 3 ? mean(doneDur)
    : prevVals.length ? mean(prevVals) : null;
  if (typical == null) return null;
  const remOf = n => {
    const p = pkgs[n];
    if (!p || p.s === 'done' || p.s === 'failed' || p.s === 'aborted'
        || p.s === 'skipped' || p.s === 'blocked') return 0;
    const d = prev[n] ?? typical;
    if (p.s === 'building') return Math.max(3, d - (s.now - p.t0));
    return d;
  };
  const memo = new Map();  // longest remaining chain ending at a package
  const chain = n => {
    if (memo.has(n)) return memo.get(n);
    memo.set(n, 0);  // cycle guard
    let deepest = 0;
    for (const d of App.graph[n]?.deps || [])
      if (pkgs[d]) deepest = Math.max(deepest, chain(d));
    const v = remOf(n) + deepest;
    memo.set(n, v);
    return v;
  };
  let critical = 0, work = 0;
  for (const n of Object.keys(pkgs)) {
    critical = Math.max(critical, chain(n));
    work += remOf(n);
  }
  if (!work) return null;
  const workers = s.workers || Math.max(1, s.counts?.building || 1);
  return Math.max(critical, work / workers);
}

export function applyState(s) {
  const c = s.counts || {};
  const done = c.done || 0, failed = c.failed || 0, aborted = c.aborted || 0;
  const building = c.building || 0, ready = c.ready || 0, waiting = c.waiting || 0;
  const skipped = c.skipped || 0, blocked = c.blocked || 0;

  $('#ws').textContent = s.workspace;
  $('#buildid').textContent = s.build_id;
  updateSysMeters(s.sys);
  $('#workers').textContent = s.workers ? `${s.workers} workers` : '';
  if (s.active) setBadge('live', 'LIVE');
  else if (failed) setBadge('failed', 'FAILED');
  else if (done === s.total && s.total > 0) setBadge('complete', 'COMPLETE');
  else setBadge('idle', 'STOPPED');

  $('#t-done').textContent = done;
  $('#t-total').textContent = ` / ${s.total}`;
  $('#t-building').textContent = building;
  $('#t-ready').textContent = ready;
  $('#t-waiting').innerHTML = waiting + (blocked ? `<small> +${blocked} blocked</small>` : '');
  $('#t-failed').textContent = failed;
  $('#t-aborted').textContent = aborted;
  $('#t-skipped').textContent = skipped;
  const rate = s.elapsed > 30 ? (done / (s.elapsed / 60)) : null;
  $('#t-rate').innerHTML = (rate ? rate.toFixed(1) : '–') + '<small> pkg/min</small>';
  const eta = estimateEta(s);
  $('#t-eta').textContent = eta != null ? `~${fmtDur(eta)}` : '–';

  const seg = (cls, n) =>
    $(`#meter .seg.${cls}`).style.flexBasis = (s.total ? (100 * n / s.total) : 0) + '%';
  seg('done', done); seg('failed', failed); seg('aborted', aborted); seg('building', building);
}

on('state', applyState);
