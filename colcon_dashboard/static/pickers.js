import { label } from './graph.js';
import { setBadge } from './header.js';
import { App } from './state.js';
import { toast } from './toasts.js';
import { $, esc, fmtAgo, fmtBytes, fmtDur, PINNED_BUILD, WS, wsParam } from './util.js';

export const WS_SORTS = {
  // a workspace building now has the newest build, so "last built"
  // naturally keeps it on top; the active key covers stats-cache lag
  built:     w => [!w.active, -(w.last_build || 0)],
  favorites: w => [!w.fav, !w.active, -(w.last_used || 0)],
  builds:    w => [-(w.builds || 0), !w.active],
  logs:      w => [-(w.log_size || 0), !w.active],
};

export function sortWs(items) {
  const by = WS_SORTS[localStorage.getItem('cmc-wssort') || 'built']
             || WS_SORTS.built;
  return [...items].sort((a, b) => {
    const ka = by(a), kb = by(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });
}

export function renderWsList(items) {
  const list = $('#wslist');
  list.innerHTML = '';
  items = sortWs(items);
  if (!items.length) {
    list.innerHTML =
      '<div class="wsempty">No workspaces yet. Open a path below, or scan your home directory.</div>';
    return;
  }
  for (const w of items) {
    const a = document.createElement('a');
    a.className = 'wsrow' + (WS === w.path ? ' cur' : '');
    a.href = `?ws=${encodeURIComponent(w.path)}`;
    const bits = [];
    if (w.active) bits.push(`<span class="live">building ${w.done ?? '?'}/${w.total ?? '?'}</span>`);
    if (w.builds) bits.push(`${w.builds} builds · ${fmtBytes(w.log_size)} logs`);
    if (w.last_build) bits.push(`built ${fmtAgo(w.last_build)}`);
    if (w.found) bits.push('found');
    if (w.exists === false) bits.push('missing');
    a.innerHTML =
      `<button class="star${w.fav ? ' on' : ''}" title="favorite">★</button>` +
      `<span class="wpath">${w.path}</span>` +
      `<span class="wmeta">${bits.join(' · ')}</span>`;
    a.querySelector('.star').onclick = async ev => {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        await fetch(`/api/favorite?ws=${encodeURIComponent(w.path)}` +
                    `&fav=${w.fav ? 0 : 1}`, { method: 'POST' });
      } catch (e) { /* server gone */ }
      openWsPicker();
    };
    list.appendChild(a);
  }
}

export let wsItems = [];

export function showUpdateNote(update) {
  $('#updnote')?.remove();
  if (!update
      || localStorage.getItem('cmc-upd-dismissed') === update.latest) return;
  const note = document.createElement('div');
  note.id = 'updnote';
  note.innerHTML =  // the versions come from a remote response: escape
    `colcon-dashboard <b>${esc(update.latest)}</b> is available ` +
    `(installed ${esc(update.current)}) - ` +
    `<a href="https://github.com/autowarefoundation/colcon-dashboard/releases"` +
    ` target="_blank" rel="noopener">release notes</a>` +
    `<button class="dismiss" title="hide until the next release">✕</button>`;
  note.querySelector('.dismiss').onclick = () => {
    localStorage.setItem('cmc-upd-dismissed', update.latest);
    note.remove();
  };
  $('#wspick .wshead').after(note);
}

export async function openWsPicker() {
  $('#wspick').hidden = false;
  const list = $('#wslist');
  list.innerHTML = '<div class="wsempty">loading…</div>';
  try {
    const d = await (await fetch('/api/workspaces')).json();
    wsItems = d.workspaces || [];
    renderWsList(wsItems);
    showUpdateNote(d.update);
  } catch (e) {
    list.innerHTML = '<div class="wsempty">The server does not answer.</div>';
  }
}

export function initWsPicker() {
  $('#ws').title = 'switch workspace';
  $('#ws').onclick = openWsPicker;
  const sortSel = $('#wssort');
  const savedSort = localStorage.getItem('cmc-wssort');
  sortSel.value = WS_SORTS[savedSort] ? savedSort : 'built';
  sortSel.onchange = () => {
    localStorage.setItem('cmc-wssort', sortSel.value);
    renderWsList(wsItems);
  };
  const overlay = $('#wspick');
  overlay.addEventListener('click', ev => {
    if (ev.target === overlay && WS) overlay.hidden = true;
  });
  const go = () => {
    const p = $('#wsinput').value.trim();
    if (p) location.search = `?ws=${encodeURIComponent(p)}`;
  };
  $('#wsopen').onclick = go;
  $('#wsinput').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') go();
  });
  $('#wsscan').onclick = async () => {
    $('#wsscan').textContent = 'Scanning…';
    $('#wsscan').disabled = true;
    try {
      const d = await (await fetch('/api/discover')).json();
      const known = new Set(wsItems.map(w => w.path));
      for (const w of d.workspaces || []) {
        if (!known.has(w.path)) {
          wsItems.push({ ...w, exists: true, found: true });
        }
      }
      renderWsList(wsItems);
    } catch (e) { /* server gone */ }
    $('#wsscan').textContent = 'Scan home';
    $('#wsscan').disabled = false;
  };
  if (!WS) openWsPicker();
}

/* ---- build picker: browse and manage previous builds ---- */

export function buildHref(id) {
  let s = `?ws=${encodeURIComponent(WS)}`;
  if (id) s += `&build=${encodeURIComponent(id)}`;
  return s;
}

export function outcomeHtml(b) {
  if (!b.outcome) return '';
  const label = b.outcome === 'passed' ? 'passed'
              : b.outcome === 'failed' ? 'failed'
              : b.outcome === 'aborted' ? 'aborted' : 'empty';
  let h = `<span class="btag ${label}">${label}</span>`;
  if (b.total) {
    const parts = [`${b.done}/${b.total}`];
    if (b.failed) parts.push(`${b.failed} failed`);
    if (b.aborted) parts.push(`${b.aborted} aborted`);
    if (b.skipped) parts.push(`${b.skipped} skipped`);
    h += `<span class="wmeta bstats">${parts.join(' · ')}</span>`;
  }
  return h;
}

export async function openBuildPicker(retry) {
  if (!WS) return;
  const tries = typeof retry === 'number' ? retry : 0;  // onclick passes an event
  $('#bpick').hidden = false;
  const list = $('#blist');
  if (!tries) list.innerHTML = '<div class="wsempty">loading…</div>';
  let d;
  try {
    d = await (await fetch(`/api/builds${wsParam()}`)).json();
  } catch (e) {
    list.innerHTML = '<div class="wsempty">The server does not answer.</div>';
    return;
  }
  list.innerHTML = '';
  const builds = d.builds || [];
  // what the live view follows: the newest entry can be a test run,
  // and a pinned monitor reports no latest at all
  const latest = d.latest
    || builds.find(b => b.id.startsWith('build_'))?.id || null;
  // Outcomes compute in the background on first sight of old builds.
  if (builds.some(b => !b.outcome) && tries < 8) {
    setTimeout(() => {
      if (!$('#bpick').hidden) openBuildPicker(tries + 1);
    }, 1200);
  }
  const live = document.createElement('a');
  live.className = 'wsrow' + (!PINNED_BUILD ? ' cur' : '');
  live.href = buildHref(null);
  live.innerHTML = '<span class="wpath">latest</span>' +
                   '<span class="tag">live</span>';
  list.appendChild(live);
  // total duration, and the delta against the previous run of the
  // same kind (test runs never compare against builds)
  const olderDuration = i => {
    const kind = builds[i].id.split('_')[0];
    for (let j = i + 1; j < builds.length; j++) {
      if (builds[j].id.split('_')[0] === kind
          && builds[j].duration != null) return builds[j].duration;
    }
    return null;
  };
  builds.forEach((b, i) => {
    const a = document.createElement('a');
    a.className = 'wsrow' + (PINNED_BUILD === b.id ? ' cur' : '');
    a.href = buildHref(b.id);
    let durHtml = '';
    if (b.duration != null) {
      durHtml = `<span class="wmeta">${fmtDur(b.duration)}</span>`;
      const prev = olderDuration(i);
      if (prev != null && Math.abs(b.duration - prev) >= 2) {
        const d = b.duration - prev;
        durHtml += `<span class="wdelta ${d > 0 ? 'dplus' : 'dminus'}"` +
          ` title="against the previous run">` +
          `${d > 0 ? '+' : '−'}${fmtDur(Math.abs(d))}</span>`;
      }
    }
    a.innerHTML =
      `<span class="wpath">${b.id}</span>` +
      (b.id.startsWith('test_') ? '<span class="tag">test</span>' : '') +
      (b.id === latest ? '<span class="tag">latest</span>' : '') +
      outcomeHtml(b) +
      durHtml +
      `<span class="wmeta">${fmtBytes(b.size)}</span>` +
      `<button class="del" title="delete this build's logs">🗑</button>`;
    const del = a.querySelector('.del');
    del.onclick = async ev => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!del.classList.contains('sure')) {  // ask once, then act
        del.classList.add('sure');
        del.textContent = 'delete?';
        setTimeout(() => {
          del.classList.remove('sure');
          del.textContent = '🗑';
        }, 2500);
        return;
      }
      const r = await (await fetch(
        `/api/builds/delete?ws=${encodeURIComponent(WS)}` +
        `&build=${encodeURIComponent(b.id)}`, { method: 'POST' })).json();
      toast(r.ok ? `Deleted <b>${b.id}</b>, freed ${fmtBytes(r.freed)}.`
                 : `Not deleted: ${r.error}`, r.ok ? 'info' : '');
      openBuildPicker();
    };
    list.appendChild(a);
  });
}

export function initBuildPicker() {
  $('#buildid').onclick = openBuildPicker;
  $('#buildid').title = 'browse this workspace’s builds';
  if (PINNED_BUILD) $('#buildid').classList.add('pinned');
  const overlay = $('#bpick');
  overlay.addEventListener('click', ev => {
    if (ev.target === overlay) overlay.hidden = true;
  });
  const prune = $('#bprune');
  prune.onclick = async () => {
    if (!prune.classList.contains('sure')) {
      prune.classList.add('sure');
      prune.textContent = 'Really delete all but the last 3 of each kind?';
      setTimeout(() => {
        prune.classList.remove('sure');
        prune.textContent = 'Keep the last 3 of each kind, delete the rest';
      }, 3000);
      return;
    }
    prune.classList.remove('sure');
    prune.textContent = 'Keep the last 3 of each kind, delete the rest';
    const r = await (await fetch(
      `/api/builds/prune?ws=${encodeURIComponent(WS)}&keep=3`,
      { method: 'POST' })).json();
    toast(r.ok ? `Deleted ${r.deleted} builds, freed ${fmtBytes(r.freed)}.`
               : `Not deleted: ${r.error}`, r.ok ? 'info' : '');
    openBuildPicker();
  };
}

export function initStop() {
  const overlay = $('#confirm');
  const text = overlay.querySelector('.ctext');
  const btns = overlay.querySelector('.cbtns');
  $('#stopBtn').onclick = () => {
    text.textContent =
      'Stop the dashboard server? It serves every workspace on this machine, ' +
      'and all dashboard pages go offline until you start it again.';
    btns.hidden = false;
    overlay.hidden = false;
  };
  overlay.querySelector('.cancel').onclick = () => { overlay.hidden = true; };
  overlay.addEventListener('click', ev => {
    if (ev.target === overlay) overlay.hidden = true;
  });
  const ok = overlay.querySelector('.ok');
  ok.onclick = async () => {
    ok.disabled = true;
    ok.textContent = 'Stopping…';
    try { await fetch('/api/stop', { method: 'POST' }); } catch (e) { /* dying */ }
    // believe it only when the server really stops answering
    const deadline = Date.now() + 6000;
    let gone = false;
    while (Date.now() < deadline) {
      try {
        await fetch('/api/state', { cache: 'no-store' });
      } catch (e) {
        gone = true;
        break;
      }
      await new Promise(r => setTimeout(r, 300));
    }
    ok.disabled = false;
    ok.textContent = 'Stop the server';
    if (gone) {
      App.stopped = true;
      setBadge('offline', 'STOPPED');
      text.innerHTML = '<b>Server stopped.</b> The page is now offline. ' +
        'Start the server again with <code>colcon-dashboard</code>, ' +
        'or run a build with the plugin switched on, then reload this page.';
      btns.hidden = true;
    } else {
      text.textContent =
        'The server still answers. Try colcon-dashboard --stop in a terminal.';
    }
  };
}
