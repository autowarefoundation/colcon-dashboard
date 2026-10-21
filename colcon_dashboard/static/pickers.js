import { label } from './graph.js';
import { setBadge } from './header.js';
import { App } from './state.js';
import { toast } from './toasts.js';
import { $, esc, fmtAgo, fmtBytes, fmtDur, PINNED_BUILD, WS, wsParam } from './util.js';

export const WS_SORTS = {
  // a workspace building now has the newest build, so "last built"
  // naturally keeps it on top; the active key covers stats-cache lag
  built:  w => [!w.active, -(w.last_build || 0)],
  builds: w => [-(w.builds || 0), !w.active],
  logs:   w => [-(w.log_size || 0), !w.active],
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

export let wsItems = [];  // the recents, plus the scan's finds
// the last scan result, kept for the page's lifetime: a scan walks the
// whole home directory, so reopening the picker reuses it
let foundItems = null;
let wsScanning = false;
let wsQuery = '';
let wsHome = '';
const openGroups = new Set();  // expanded parent directories
const GROUP_MIN = 3;  // this many finds in one directory fold into a group

export function tildePath(p) {
  return wsHome && (p === wsHome || p.startsWith(wsHome + '/'))
    ? '~' + p.slice(wsHome.length) : p;
}

const parentDir = p => p.slice(0, p.lastIndexOf('/')) || '/';
const looksLikePath = q => /^[/~]/.test(q);

function wsRow(w, inGroup) {
  const a = document.createElement('a');
  a.className = 'wsrow' + (WS === w.path ? ' cur' : '') + (inGroup ? ' sub' : '');
  a.href = `?ws=${encodeURIComponent(w.path)}`;
  const shown = tildePath(w.path);
  const cut = shown.lastIndexOf('/') + 1;
  const state = w.active ? 'live'
              : w.exists === false ? 'missing' : (w.last_outcome || 'none');
  const tip = [shown];
  if (w.active) tip.push(`building ${w.done ?? '?'}/${w.total ?? '?'}`);
  else if (w.last_outcome) tip.push(`last build ${w.last_outcome}`);
  if (w.builds) tip.push(`${w.builds} builds, ${fmtBytes(w.log_size)} logs`);
  a.title = tip.join('\n');
  let right;
  if (w.active && w.total) {
    const pct = Math.round(100 * (w.done || 0) / w.total);
    right = `<span class="wprog"><span style="width:${pct}%"></span></span>`;
  } else {
    right = `<span class="wmeta">${w.exists === false ? 'missing'
      : w.last_build ? fmtAgo(w.last_build) : 'never built'}</span>`;
  }
  a.innerHTML =
    `<span class="wdot ${state}"></span>` +
    `<span class="wname">${esc(shown.slice(cut))}</span>` +
    // rtl cuts a long directory from the left; the marks keep "/" in place
    `<span class="wdir">${inGroup ? '' : `&lrm;${esc(shown.slice(0, cut))}&lrm;`}</span>` +
    right +
    `<button class="star${w.fav ? ' on' : ''}" title="${w.fav ? 'unstar' : 'star'}">★</button>`;
  a.querySelector('.star').onclick = async ev => {
    ev.preventDefault();
    ev.stopPropagation();
    try {
      await fetch(`/api/favorite?ws=${encodeURIComponent(w.path)}` +
                  `&fav=${w.fav ? 0 : 1}`, { method: 'POST' });
    } catch (e) { /* server gone */ }
    openWsPicker();
  };
  return a;
}

function wsSection(list, title, extra) {
  const h = document.createElement('div');
  h.className = 'wssec';
  h.innerHTML = `<span>${title}</span>`;
  if (extra) h.appendChild(extra);
  list.appendChild(h);
}

function renderFound(list, found) {
  const rescan = document.createElement('button');
  rescan.className = 'linkbtn';
  rescan.textContent = wsScanning ? 'scanning…' : 'rescan';
  rescan.disabled = wsScanning;
  rescan.onclick = scanWs;
  wsSection(list, `Found on disk${found.length ? ` (${found.length})` : ''}`, rescan);
  const byDir = new Map();
  for (const w of found) {
    const d = parentDir(w.path);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(w);
  }
  const done = new Set();
  for (const w of found) {
    const d = parentDir(w.path);
    const members = byDir.get(d);
    if (members.length < GROUP_MIN) {
      list.appendChild(wsRow(w));
      continue;
    }
    if (done.has(d)) continue;
    done.add(d);
    const open = openGroups.has(d) || !!wsQuery;  // a search shows its hits
    const g = document.createElement('div');
    g.className = 'wsgroup' + (open ? ' open' : '');
    g.tabIndex = -1;
    const newest = Math.max(...members.map(m => m.last_build || 0));
    g.innerHTML =
      '<span class="caret">▸</span>' +
      `<span class="wname">${esc(tildePath(d))}/</span>` +
      `<span class="wcount">${members.length} workspaces</span>` +
      `<span class="wmeta">${newest ? fmtAgo(newest) : ''}</span>`;
    g.onclick = () => {
      if (openGroups.has(d)) openGroups.delete(d); else openGroups.add(d);
      renderWsList();
    };
    list.appendChild(g);
    if (open) for (const m of members) list.appendChild(wsRow(m, true));
  }
  if (!found.length && !wsScanning && !wsQuery) {
    list.insertAdjacentHTML('beforeend',
      '<div class="wsempty">No other workspaces found. Add a scan root to search more directories.</div>');
  }
}

export function renderWsList() {
  const list = $('#wslist');
  list.innerHTML = '';
  const q = wsQuery.toLowerCase();
  const match = w => !q || w.path.toLowerCase().includes(q)
                     || tildePath(w.path).toLowerCase().includes(q);
  const items = sortWs(wsItems.filter(match));
  const starred = items.filter(w => w.fav);
  const recent = items.filter(w => !w.fav && !w.found);
  const found = items.filter(w => !w.fav && w.found);
  if (starred.length) {
    wsSection(list, 'Starred');
    starred.forEach(w => list.appendChild(wsRow(w)));
  }
  if (recent.length) {
    wsSection(list, 'Recent');
    recent.forEach(w => list.appendChild(wsRow(w)));
  }
  if (q && !items.length) {
    list.innerHTML = looksLikePath(wsQuery)
      ? `<div class="wsempty">No workspace matches. Press Enter to open <b>${esc(wsQuery)}</b>.</div>`
      : '<div class="wsempty">No workspace matches.</div>';
    return;
  }
  if (!q || found.length) renderFound(list, found);
}

function mergeFound() {
  const known = new Set(wsItems.map(w => w.path));
  for (const w of foundItems) {
    if (!known.has(w.path)) wsItems.push({ ...w, exists: true, found: true });
  }
}

export async function scanWs() {
  if (wsScanning) return;
  wsScanning = true;
  renderWsList();
  try {
    const d = await (await fetch('/api/discover')).json();
    foundItems = d.workspaces || [];
    wsItems = wsItems.filter(w => !w.found);  // a removed root drops its finds
    mergeFound();
  } catch (e) { /* server gone */ }
  wsScanning = false;
  renderWsList();
}

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
  const first = $('#wspick').hidden;
  $('#wspick').hidden = false;
  const list = $('#wslist');
  if (first) {
    showScanRoots(false);
    $('#wsinput').focus();
  }
  if (!wsItems.length) list.innerHTML = '<div class="wsempty">loading…</div>';
  try {
    const d = await (await fetch('/api/workspaces')).json();
    wsHome = d.home || '';
    wsItems = d.workspaces || [];
    if (foundItems) mergeFound();
    renderWsList();
    showUpdateNote(d.update);
    if (!foundItems) scanWs();  // the first open scans by itself
  } catch (e) {
    list.innerHTML = '<div class="wsempty">The server does not answer.</div>';
  }
}

// the extra_roots list as the server last reported it
let scanRoots = [];

export function renderScanRoots(d) {
  scanRoots = d.roots || [];
  const list = $('#rootlist');
  list.innerHTML = '';
  const home = document.createElement('div');
  home.className = 'wsrow';
  home.innerHTML = `<span class="wpath">${esc(d.home)}</span>` +
    '<span class="tag">home</span>';
  list.appendChild(home);
  scanRoots.forEach((root, i) => {
    const div = document.createElement('div');
    div.className = 'wsrow';
    div.innerHTML =
      '<input class="rootedit" type="text" spellcheck="false" title="edit, then press Enter">' +
      '<button class="rootdel" title="remove this scan root">✕</button>';
    const input = div.querySelector('.rootedit');
    input.value = root;
    const commit = () => {
      const p = input.value.trim();
      if (p === root) return;
      const next = [...scanRoots];
      if (p) next[i] = p; else next.splice(i, 1);
      saveScanRoots(next).then(ok => { if (!ok) input.value = root; });
    };
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') input.blur();
      if (ev.key === 'Escape') { input.value = root; input.blur(); }
    });
    input.addEventListener('change', commit);
    div.querySelector('.rootdel').onclick =
      () => saveScanRoots(scanRoots.filter((_, j) => j !== i));
    list.appendChild(div);
  });
  $('#rootnote').textContent = `Saved as extra_roots in ${d.config_path}`;
}

export async function loadScanRoots() {
  try {
    renderScanRoots(await (await fetch('/api/scan-roots')).json());
  } catch (e) {
    $('#rootlist').innerHTML = '<div class="wsempty">The server does not answer.</div>';
  }
}

export async function saveScanRoots(roots) {
  const qs = roots.map(p => `path=${encodeURIComponent(p)}`).join('&');
  try {
    const r = await (await fetch(`/api/scan-roots/set?${qs}`,
                                 { method: 'POST' })).json();
    if (!r.ok) {
      toast(`Not saved: ${esc(r.error)}`);
      return false;
    }
  } catch (e) { return false; /* server gone */ }
  loadScanRoots();
  scanWs();
  return true;
}

// the scan roots panel takes the place of the list while it is open
function showScanRoots(on) {
  $('#wsroots').hidden = !on;
  $('#wslist').hidden = on;
  $('#wsinput').hidden = on;
  $('#wspick .wssort').hidden = on;
  $('#rootsbtn').textContent = on ? 'Done' : 'Scan roots…';
  if (on) loadScanRoots();
  else if (!$('#wspick').hidden) $('#wsinput').focus();
}

function moveWsHighlight(step) {
  const rows = [...$('#wslist').querySelectorAll('.wsrow, .wsgroup')];
  if (!rows.length) return;
  const at = rows.findIndex(r => r.classList.contains('kbd'));
  rows[at]?.classList.remove('kbd');
  const next = rows[Math.max(0, Math.min(rows.length - 1, at + step))];
  next.classList.add('kbd');
  next.scrollIntoView({ block: 'nearest' });
}

export function initWsPicker() {
  $('#ws').title = 'switch workspace';
  $('#ws').onclick = openWsPicker;
  const sortSel = $('#wssort');
  const savedSort = localStorage.getItem('cmc-wssort');
  sortSel.value = WS_SORTS[savedSort] ? savedSort : 'built';
  sortSel.onchange = () => {
    localStorage.setItem('cmc-wssort', sortSel.value);
    renderWsList();
  };
  const overlay = $('#wspick');
  overlay.addEventListener('click', ev => {
    if (ev.target === overlay && WS) overlay.hidden = true;
  });
  const input = $('#wsinput');
  input.addEventListener('input', () => {
    wsQuery = input.value.trim();
    renderWsList();
  });
  input.addEventListener('keydown', ev => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      moveWsHighlight(ev.key === 'ArrowDown' ? 1 : -1);
    } else if (ev.key === 'Enter') {
      const hit = $('#wslist .kbd');
      const rows = $('#wslist').querySelectorAll('a.wsrow');
      if (hit?.href) location.href = hit.href;
      else if (hit) hit.click();  // a group: fold or unfold it
      else if (looksLikePath(wsQuery)) {
        location.search = `?ws=${encodeURIComponent(wsQuery)}`;
      } else if (rows.length === 1) location.href = rows[0].href;
    } else if (ev.key === 'Escape') {
      if (input.value) {
        input.value = wsQuery = '';
        renderWsList();
      } else if (WS) overlay.hidden = true;
    }
  });
  $('#rootsbtn').onclick = () => showScanRoots($('#wsroots').hidden);
  const addRoot = async () => {
    const p = $('#rootinput').value.trim();
    if (p && await saveScanRoots([...scanRoots, p])) $('#rootinput').value = '';
  };
  $('#rootadd').onclick = addRoot;
  $('#rootinput').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') addRoot();
  });
  if (!WS) {
    document.body.classList.add('nows');  // the start page (style.css)
    openWsPicker();
  }
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
