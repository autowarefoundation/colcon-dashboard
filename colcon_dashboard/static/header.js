import { emit, on } from './bus.js';
import { App } from './state.js';
import { $, copyText, esc, fmtDur, fmtDurLong, fmtGB, initPanel, PINNED_BUILD } from './util.js';

/* ---------------- header + tiles ---------------- */

export async function initHeaderMeta() {
  initCommand();
  // one boot fetch: the server version and the editor-link template
  try {
    App.cfg = await (await fetch('/api/config')).json();
  } catch (e) {
    return;  // offline: the poller reports it
  }
  if (App.cfg.version) {
    const v = `v${App.cfg.version}`;
    $('#stopBtn').title = `stop the dashboard server (${v})`;
    document.querySelector('#topbar .brand').title = `Colcon Dashboard ${v}`;
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
  // hidden is the dropdown's open state (app.js), nodata the missing /proc
  const box = $('#sysmeters');
  box.classList.toggle('nodata', !sys);
  if (!sys) return;
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

// the packages that printed compiler or CMake warnings, most first
let warnPkgs = [];
let warnNext = 0;

function warnTip() {
  const top = warnPkgs.slice(0, 12).map(([n, p]) => `${n}: ${p.warn}`);
  if (warnPkgs.length > 12) top.push(`and ${warnPkgs.length - 12} more packages`);
  return top.concat(['', warnPkgs.length > 1
    ? 'Click to open the logs at the warnings, one package per click.'
    : 'Click to open the log at the warnings.']).join('\n');
}

// One summary line for every build: a live build counts up in it, and
// a finished build keeps it. The layout never switches, so the page
// below it does not jump when a build starts or ends.
function summaryLine(s, c) {
  const done = c.done || 0;
  const dur = fmtDur(s.elapsed);
  const did = s.verb === 'test' ? 'tested' : 'built';
  const lead = s.active
    ? `${done} of ${s.total} packages ${did} · <span id="t-elapsed">${dur}</span>`
    : done === s.total
      ? `${s.total} package${s.total === 1 ? '' : 's'} ${did} in ${dur}`
      : `${done} of ${s.total} packages ${did} in ${dur}`;
  const pkgs = Object.entries(s.packages || {});
  warnPkgs = pkgs.filter(([, p]) => p.warn)
    .sort((a, b) => b[1].warn - a[1].warn || a[0].localeCompare(b[0]));
  const warned = warnPkgs.reduce((n, [, p]) => n + p.warn, 0);
  // a test run: the test cases, from the JUnit files
  const tests = pkgs.reduce((n, [, p]) => n + (p.tr?.t || 0), 0);
  const badTests = pkgs.reduce((n, [, p]) => n + (p.tr ? p.tr.f + p.tr.e : 0), 0);
  // against the last run of the same kind: what broke, what got fixed
  const before = new Set(App.prev?.failed || []);
  const newly = pkgs.filter(([n, p]) => p.s === 'failed' && App.prev && !before.has(n)).length;
  const fixed = pkgs.filter(([n, p]) => p.s === 'done' && before.has(n)).length;
  const waiting = (c.waiting || 0) + (c.blocked || 0);
  const parts = (s.active
    ? [['building', c.building], ['ready', c.ready], ['waiting', waiting]]
    : []).concat([['failed', c.failed], ['failed', newly, 'newly failing'],
                 ['done', fixed, 'fixed since the last run'],
                 ['done', tests, 'tests'], ['failed', badTests, 'failed tests'],
                 ['aborted', c.aborted],
                 ['warn', warned, 'warnings'],
                 ['skipped', c.skipped]],
                s.active ? [] : [['waiting', waiting + (c.ready || 0), 'not built']])
    .filter(([, n]) => n)
    .map(([cls, n, word]) => cls === 'warn'
      ? `<button type="button" class="part link" id="warnPart" title="${esc(warnTip())}">`
        + `<span class="dot c-warn"></span><b>${n}</b> ${warned === 1 ? 'warning' : 'warnings'}</button>`
      : `<span class="part"><span class="dot c-${cls}"></span><b>${n}</b> ${word || cls}</span>`);
  // hover: the exact time, and when the build started and finished
  const at = t => new Date(t * 1000).toLocaleString();
  const tip = [`Took ${fmtDurLong(s.elapsed)}`].concat(s.build_started
    ? [`Started ${at(s.build_started)}`, `Finished ${at(s.build_started + s.elapsed)}`] : []);
  // a live build: how fast it goes, and how long it still takes
  const meta = [];
  if (s.active) {
    if (s.elapsed > 30) meta.push(`${(done / (s.elapsed / 60)).toFixed(1)} pkg/min`);
    const eta = estimateEta(s);
    if (eta != null) {
      meta.push(`<span title="estimated time left, from the previous build’s package durations">~${fmtDur(eta)} left</span>`);
    }
  }
  return `<span class="lead" title="${tip.join('\n')}">${lead}</span>${parts.join('')}`
    + (meta.length ? `<span class="meta">${meta.join(' · ')}</span>` : '');
}

// The workspace by its folder name, the build by its start time: the
// full path and the build id stay in the tooltips.
function setSwitchers(s) {
  const ws = s.workspace || '';
  $('#ws .sw-val').textContent = ws.replace(/\/+$/, '').split('/').pop() || ws || '…';
  $('#ws').title = `${ws}\nClick to switch the workspace`;
  const id = s.build_id || '';
  const test = id.startsWith('test_');
  $('#buildid .sw-cap').textContent = `${test ? 'Test run' : 'Build'} · ${PINNED_BUILD ? 'pinned' : 'latest'}`;
  $('#buildid .sw-val').textContent = s.build_started
    ? new Date(s.build_started * 1000).toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : (id || 'no builds yet');
  $('#buildid').title = (id ? `${id}\n` : '') + (PINNED_BUILD
    ? 'This page shows this build. Click to switch the build, or to follow the latest one.'
    : 'This page follows the latest build. Click to open an earlier one.');
}

/* ---- the build command: a button with the verb and the option count,
   never cut short, and a dropdown with the whole command ---- */

// a word as the shell reads it back: plain, or in single quotes
const shWord = w => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`);
let cmdKey = '';

function setCommand(s) {
  const verb = s.verb || 'build';
  const opts = s.options || [];
  const btn = $('#bargs');
  // a plain colcon build has nothing to tell
  btn.hidden = verb === 'build' && !opts.length;
  const key = JSON.stringify([verb, opts]);
  if (key === cmdKey) return;
  cmdKey = key;
  btn.querySelector('.bverb').textContent = `colcon ${verb}`;
  btn.querySelector('.bcount').textContent =
    opts.length ? `${opts.length} option${opts.length === 1 ? '' : 's'}` : '';
  // one option per line, with the shell's line continuations, so a
  // selection of the text also pastes into a terminal
  const pre = $('#cmdpanel .cmd');
  pre.textContent = '';
  const lines = [`colcon ${verb}`, ...opts.map(o => '  ' + o.map(shWord).join(' '))];
  lines.forEach((line, i) => {
    pre.append(line);
    if (i < lines.length - 1) {
      const c = document.createElement('span');
      c.className = 'cont';
      c.textContent = ' \\';
      pre.append(c, '\n');
    }
  });
  $('#cmdpanel .cmdnote').hidden = !opts.length;
  $('#cmdpanel').dataset.line = [`colcon ${verb}`, ...opts.map(o => o.map(shWord).join(' '))].join(' ');
}

function initCommand() {
  const panel = $('#cmdpanel');
  const btn = $('#bargs');
  btn.onclick = () => { panel.hidden = !panel.hidden; };
  initPanel(panel, btn);
  const copy = panel.querySelector('.cmdcopy');
  copy.onclick = async () => {
    const ok = await copyText(panel.dataset.line || '');
    copy.lastChild.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { copy.lastChild.textContent = 'Copy'; }, 1200);
  };
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && !panel.hidden) panel.hidden = true;
  });
}

export function applyState(s) {
  const c = s.counts || {};
  const done = c.done || 0, failed = c.failed || 0, aborted = c.aborted || 0;
  const building = c.building || 0;

  setSwitchers(s);
  updateSysMeters(s.sys);
  $('#workers').textContent = s.workers ? `${s.workers} workers` : '';
  setCommand(s);
  if (s.active) setBadge('live', 'LIVE');
  else if (failed) setBadge('failed', 'FAILED');
  else if (done === s.total && s.total > 0) setBadge('complete', 'COMPLETE');
  else setBadge('idle', 'STOPPED');

  if (s.build_id) $('#tsum').innerHTML = summaryLine(s, c);

  const seg = (cls, n) =>
    $(`#meter .seg.${cls}`).style.flexBasis = (s.total ? (100 * n / s.total) : 0) + '%';
  seg('done', done); seg('failed', failed); seg('aborted', aborted); seg('building', building);
}

on('state', applyState);
on('build-changed', () => { warnNext = 0; });

$('#tsum').addEventListener('click', ev => {
  if (!ev.target.closest('#warnPart') || !warnPkgs.length) return;
  const [name] = warnPkgs[warnNext++ % warnPkgs.length];
  // the lines that events.WARNING_RE counts on the server
  emit('find-in-log', name, 'warning', /warning:|CMake Warning/);
});
