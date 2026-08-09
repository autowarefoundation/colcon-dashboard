import { on } from './bus.js';
import { $, fmtGB } from './util.js';

/* ---------------- header + tiles ---------------- */

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

  const seg = (cls, n) =>
    $(`#meter .seg.${cls}`).style.flexBasis = (s.total ? (100 * n / s.total) : 0) + '%';
  seg('done', done); seg('failed', failed); seg('aborted', aborted); seg('building', building);
}

on('state', applyState);
