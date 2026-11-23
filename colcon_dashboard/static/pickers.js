import { label } from './graph.js';
import { setBadge } from './header.js';
import { App } from './state.js';
import { toast } from './toasts.js';
import { $, copyText, esc, fmtAgo, fmtBytes, fmtDur, icon, initPanel, PINNED_BUILD, restartServer, WS, wsParam } from './util.js';

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
let rescanAfter = false;  // the scan places changed while a scan ran
let scanGen = 0;  // a change of the scan places makes a running scan stale
// The answer to "scan your home folder?": ask, yes, or no. The server
// keeps it in config.ini, so every browser and the app window share it.
let scanHome = 'ask';
let scanRoots = [];  // the extra_roots list as the server last reported it
let scanSearched = [];  // the directories that the last scan searched
let wsQuery = '';
let wsHome = '';
const openGroups = new Set();  // expanded parent directories
const GROUP_MIN = 3;  // this many finds in one directory fold into a group

export function tildePath(p) {
  return wsHome && (p === wsHome || p.startsWith(wsHome + '/'))
    ? '~' + p.slice(wsHome.length) : p;
}

const parentDir = p => p.slice(0, p.lastIndexOf('/')) || '/';
const looksLikePath = q => /^[/~]/.test(q) || /^(?:docker\+)?ssh:\/\//.test(q);

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
    right;
  // the star sits next to the link, not inside it: a button inside a link
  // is invalid HTML, and screen readers read the row as one link
  const item = document.createElement('div');
  item.className = 'wsitem';
  const star = document.createElement('button');
  star.className = 'star' + (w.fav ? ' on' : '');
  star.title = w.fav ? 'unstar' : 'star';
  star.setAttribute('aria-label', `${w.fav ? 'unstar' : 'star'} ${shown}`);
  star.innerHTML = icon('star');
  item.append(a, star);
  star.onclick = async ev => {
    ev.preventDefault();
    ev.stopPropagation();
    try {
      await fetch(`/api/favorite?ws=${encodeURIComponent(w.path)}` +
                  `&fav=${w.fav ? 0 : 1}`, { method: 'POST' });
    } catch (e) { /* server gone */ }
    openWsPicker();
  };
  return item;
}

function wsSection(list, title, extra) {
  const h = document.createElement('div');
  h.className = 'wssec';
  h.innerHTML = `<span>${title}</span>`;
  if (extra) h.appendChild(extra);
  list.appendChild(h);
}

// the picker scans by itself only where the user allowed it
const canScan = () => scanHome === 'yes' || scanRoots.length > 0;

// "a", "a and b", "a, b, and c"
function listText(items) {
  if (items.length < 3) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

// The question that the picker asks once, before it reads anything in
// the home folder. The answer goes to config.ini, so it never comes back.
function scanCard() {
  const card = document.createElement('div');
  card.className = 'scancard';
  card.setAttribute('role', 'group');
  card.setAttribute('aria-labelledby', 'scancard-title');
  card.innerHTML =
    `<div class="sc-art" aria-hidden="true">${icon('folder')}</div>` +
    '<div class="sc-body">' +
      '<h2 id="scancard-title">Find your workspaces</h2>' +
      '<p>The picker can scan your home folder (<code>~</code>) for colcon workspaces and list them here.</p>' +
      `<p class="sc-safe">${icon('lock')}<span>It reads folder names only, 4 levels deep, and never sends them to the internet.</span></p>` +
      '<div class="sc-btns">' +
        `<button class="primary sc-yes">${icon('search')}Scan my home folder</button>` +
        '<button class="sc-pick" title="scan only the folders that you add">Choose folders…</button>' +
        '<button class="linkbtn sc-no">Not now</button>' +
      '</div>' +
      '<p class="sc-note">The picker remembers your answer and does not ask again. You can change it later in Scan roots.</p>' +
    '</div>';
  card.querySelector('.sc-yes').onclick = () => saveScanHome(true);
  card.querySelector('.sc-pick').onclick = async () => {
    if (await saveScanHome(false)) showScanRoots(true);
  };
  card.querySelector('.sc-no').onclick = () => saveScanHome(false);
  return card;
}

// after "Not now": one quiet line, so that the scan stays easy to find
function scanOffRow() {
  const row = document.createElement('div');
  row.className = 'scanoff';
  row.innerHTML = `${icon('folder')}<span>The picker does not scan your home folder.</span>` +
    `<button class="sc-yes" title="scan the home folder from now on">${icon('search')}Turn on</button>` +
    '<button class="linkbtn sc-pick">Choose folders…</button>';
  row.querySelector('.sc-yes').onclick = () => saveScanHome(true);
  row.querySelector('.sc-pick').onclick = () => showScanRoots(true);
  return row;
}

// below the finds: where the picker looks by itself, so that a saved
// "yes" stays visible and easy to take back
function scanScope() {
  const div = document.createElement('div');
  div.className = 'scanscope';
  const names = scanSearched.map(p => p === wsHome
    ? 'your home folder' : `<code>${esc(tildePath(p))}</code>`);
  div.innerHTML = `<span>Scans ${listText(names)} automatically.</span>` +
    '<button class="linkbtn">Change…</button>';
  div.querySelector('button').onclick = () => showScanRoots(true);
  return div;
}

function renderFound(list, found) {
  if (scanHome === 'ask' && !wsQuery) list.appendChild(scanCard());
  if (!canScan()) {
    if (scanHome === 'no' && !wsQuery) {
      wsSection(list, 'Found on disk');
      list.appendChild(scanOffRow());
    }
    return;
  }
  const rescan = document.createElement('button');
  rescan.className = 'linkbtn';
  rescan.textContent = wsScanning ? 'Scanning…' : 'Rescan';
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
  if (!found.length && wsScanning) {
    list.insertAdjacentHTML('beforeend',
      '<div class="wsempty scanning"><span class="spin"></span>Scanning…</div>');
  } else if (!found.length && !wsQuery) {
    list.insertAdjacentHTML('beforeend',
      '<div class="wsempty">No other workspaces found. Add a scan root to search more folders.</div>');
  }
  if (!wsQuery && !wsScanning && scanSearched.length) list.appendChild(scanScope());
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
  if (wsScanning) {
    rescanAfter = true;  // the running scan uses the old places
    return;
  }
  wsScanning = true;
  const gen = scanGen;
  renderWsList();
  try {
    const d = await (await fetch('/api/discover')).json();
    if (gen === scanGen) {  // else the places changed during the scan
      foundItems = d.workspaces || [];
      scanSearched = d.searched || [];
      if (d.scan_home) scanHome = d.scan_home;
      wsItems = wsItems.filter(w => !w.found);  // a removed root drops its finds
      mergeFound();
    }
  } catch (e) { /* server gone */ }
  wsScanning = false;
  if (rescanAfter) {
    rescanAfter = false;
    return scanWs();
  }
  renderWsList();
}

// scan again after a change of the places, or drop the finds when the
// picker may not scan anywhere now
function refreshFound() {
  scanGen++;
  if (canScan()) return scanWs();
  foundItems = null;
  scanSearched = [];
  wsItems = wsItems.filter(w => !w.found);
  renderWsList();
}

export async function saveScanHome(on) {
  try {
    const r = await (await fetch(`/api/scan-home/set?value=${on ? 'yes' : 'no'}`,
                                 { method: 'POST' })).json();
    if (!r.ok) {
      toast(`Not saved: ${esc(r.error)}`);
      return false;
    }
    scanHome = r.scan_home;
    if (r.saved === false) {
      toast(`The answer applies until the server restarts, because the server cannot save it in ${esc(r.config_path)}.`, 'info');
    }
  } catch (e) { return false; /* server gone */ }
  if (rootBoxes.size) loadScanRoots();
  refreshFound();
  return true;
}

export function showUpdateNote(update) {
  $('#updnote')?.remove();
  const restart = update?.kind === 'restart';
  // a dismissed upgrade note keeps the plain version as its key
  const key = update && (restart ? `restart:${update.latest}` : update.latest);
  if (!update || localStorage.getItem('cmc-upd-dismissed') === key) return;
  const note = document.createElement('div');
  note.id = 'updnote';
  const notes = `<a href="https://github.com/autowarefoundation/colcon-dashboard/releases"` +
    ` target="_blank" rel="noopener">release notes</a>`;
  // the versions come from a remote response: escape
  note.innerHTML = (restart
    ? `<span>colcon-dashboard <b>${esc(update.latest)}</b> is installed, but the server still runs ` +
      `${esc(update.current)} (${notes}).` +
      (update.auto ? ' It restarts by itself when no build runs.' : '') + '</span>' +
      `<button class="updrestart" title="restart the dashboard server to run the new version">` +
      `${update.auto ? 'Restart now' : 'Restart the server'}</button>`
    : `<span>colcon-dashboard <b>${esc(update.latest)}</b> is available ` +
      `(installed ${esc(update.current)}, ${notes}).` +
      (update.command ? ` Upgrade with <code>${esc(update.command)}</code>` +
        `<button class="updcopy" title="copy the command" aria-label="copy the command">${icon('copy')}</button>` : '') +
      `</span>`) +
    `<button class="dismiss" title="${restart ? 'hide until the next version' : 'hide until the next release'}" aria-label="hide">${icon('close')}</button>`;
  note.querySelector('.dismiss').onclick = () => {
    localStorage.setItem('cmc-upd-dismissed', key);
    note.remove();
  };
  const copy = note.querySelector('.updcopy');
  if (copy) copy.onclick = async () => {
    toast(await copyText(update.command) ? 'Copied the upgrade command' : 'The browser refused the clipboard.', 'info');
  };
  const btn = note.querySelector('.updrestart');
  if (btn) btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Restarting…';
    if (await restartServer()) return;
    btn.disabled = false;
    btn.textContent = update.auto ? 'Restart now' : 'Restart the server';
    toast('The server did not come back. Start it from the tray icon or a terminal.', 'info');
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
  if (!wsItems.length) list.innerHTML = '<div class="wsempty">Loading…</div>';
  try {
    const d = await (await fetch('/api/workspaces')).json();
    wsHome = d.home || '';
    // A server older than this page (an upgrade without a restart) sends
    // no answer: it scans the home folder by itself and cannot save one.
    scanHome = 'scan_home' in d ? d.scan_home : 'yes';
    scanRoots = d.scan_roots || [];
    wsItems = d.workspaces || [];
    if (foundItems) mergeFound();
    renderWsList();
    showUpdateNote(d.update);
    // a new user has nothing to search yet: the question is the next step
    const yes = $('#wslist .scancard .sc-yes');
    if (first && yes && !$('#wslist .wsrow')) yes.focus();
    if (!foundItems && canScan()) scanWs();  // the first open scans by itself
  } catch (e) {
    list.innerHTML = '<div class="wsempty">The server does not answer.</div>';
  }
}

// Scan root editors: the workspace picker holds one, the settings dialog
// another. A save renders every one of them.
const rootBoxes = new Set();

export function mountScanRoots(box) {
  box.classList.add('roots');
  box.innerHTML = `<div class="rootlist"></div>
    <div class="wsadd">
      <input class="rootinput" type="text" placeholder="/mnt/data" spellcheck="false">
      <button class="rootadd">Add</button>
    </div>
    <div class="rootnote"></div>`;
  const input = box.querySelector('.rootinput');
  const add = async () => {
    const p = input.value.trim();
    if (p && await saveScanRoots([...scanRoots, p])) input.value = '';
  };
  box.querySelector('.rootadd').onclick = add;
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') add();
  });
  rootBoxes.add(box);
}

function rootRow(root, i) {
  const div = document.createElement('div');
  div.className = 'wsrow';
  div.innerHTML =
    '<input class="rootedit" type="text" spellcheck="false" title="edit, then press Enter">' +
    `<button class="rootdel" title="remove this scan root" aria-label="remove">${icon('close')}</button>`;
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
  return div;
}

function renderScanRoots(d) {
  scanRoots = d.roots || [];
  scanHome = d.scan_home || scanHome;
  for (const box of rootBoxes) {
    const list = box.querySelector('.rootlist');
    list.innerHTML = '';
    // the home folder: a switch, because it is the user's private space
    const home = document.createElement('label');
    home.className = 'wsrow homerow';
    home.title = 'scan the home folder for workspaces';
    home.innerHTML = `<input type="checkbox"${scanHome === 'yes' ? ' checked' : ''}>` +
      `<span class="wpath">${esc(d.home)}</span>` +
      '<span class="tag">home folder</span>';
    const check = home.querySelector('input');
    check.onchange = async () => {
      if (!await saveScanHome(check.checked)) check.checked = !check.checked;
    };
    list.appendChild(home);
    scanRoots.forEach((root, i) => list.appendChild(rootRow(root, i)));
    box.querySelector('.rootnote').textContent =
      `Saved in ${d.config_path}. A change applies at once.`;
  }
}

export async function loadScanRoots() {
  try {
    renderScanRoots(await (await fetch('/api/scan-roots')).json());
  } catch (e) {
    for (const box of rootBoxes)
      box.querySelector('.rootlist').innerHTML =
        '<div class="wsempty">The server does not answer.</div>';
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
    scanRoots = r.roots;
  } catch (e) { return false; /* server gone */ }
  loadScanRoots();
  refreshFound();
  return true;
}

// the scan roots panel takes the place of the list while it is open
function showScanRoots(on) {
  $('#wsroots').hidden = !on;
  $('#wslist').hidden = on;
  $('#wsinput').hidden = on;
  $('#wspick .wssort').hidden = on;
  $('#rootsbtn').textContent = on ? 'Done' : 'Scan roots…';
  if (on) {
    loadScanRoots();
    $('#wsrootbox .rootinput').focus();
  } else if (!$('#wspick').hidden) $('#wsinput').focus();
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
  // a second click on the switcher closes the dropdown
  $('#ws').onclick = () => { if ($('#wspick').hidden) openWsPicker(); else $('#wspick').hidden = true; };
  // the start page shows the picker as its content, in place
  initPanel($('#wspick'), $('#ws'), { inPlace: () => document.body.classList.contains('nows') });
  const sortSel = $('#wssort');
  const savedSort = localStorage.getItem('cmc-wssort');
  sortSel.value = WS_SORTS[savedSort] ? savedSort : 'built';
  sortSel.onchange = () => {
    localStorage.setItem('cmc-wssort', sortSel.value);
    renderWsList();
  };
  const overlay = $('#wspick');
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
  mountScanRoots($('#wsrootbox'));
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
    if (b.test_failed) parts.push(`${b.test_failed} with failing tests`);
    if (b.aborted) parts.push(`${b.aborted} aborted`);
    if (b.skipped) parts.push(`${b.skipped} skipped`);
    if (b.warnings) parts.push(`${b.warnings} warning${b.warnings === 1 ? '' : 's'}`);
    h += `<span class="wmeta bstats">${parts.join(' · ')}</span>`;
  }
  return h;
}

export async function openBuildPicker(retry) {
  if (!WS) return;
  const tries = typeof retry === 'number' ? retry : 0;  // onclick passes an event
  $('#bpick').hidden = false;
  const list = $('#blist');
  if (!tries) list.innerHTML = '<div class="wsempty">Loading…</div>';
  let d;
  try {
    d = await (await fetch(`/api/builds${wsParam()}`)).json();
  } catch (e) {
    list.innerHTML = '<div class="wsempty">The server does not answer.</div>';
    return;
  }
  list.innerHTML = '';
  const builds = d.builds || [];
  const canDelete = d.capabilities?.delete !== false;
  const canPrune = d.capabilities?.prune !== false;
  $('#bprune').hidden = !canPrune;
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
  // the time of the previous run of the same kind, when it ran every
  // package to its end: an aborted or blocked run is short for no reason
  const olderDuration = i => {
    const kind = builds[i].id.split('_')[0];
    for (let j = i + 1; j < builds.length; j++) {
      if (builds[j].id.split('_')[0] === kind
          && builds[j].duration != null) {
        // a 0.11.1 server sends no "complete": keep its behavior
        return builds[j].complete !== false ? builds[j].duration : null;
      }
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
      const prev = b.complete !== false ? olderDuration(i) : null;
      if (prev != null && Math.abs(b.duration - prev) >= 2) {
        const d = b.duration - prev;
        durHtml += `<span class="wdelta ${d > 0 ? 'dplus' : 'dminus'}"` +
          ` title="against the previous run">` +
          `${d > 0 ? '+' : '−'}${fmtDur(Math.abs(d))}</span>`;
      }
    }
    a.title = b.id;
    a.innerHTML =
      `<span class="wpath">${buildWhen(b)}</span>` +
      (b.id.startsWith('test_') ? '<span class="tag">test</span>' : '') +
      (b.id === latest ? '<span class="tag">latest</span>' : '') +
      outcomeHtml(b) +
      durHtml +
      `<span class="wmeta">${fmtBytes(b.size)}</span>`;
    const item = document.createElement('div');
    item.className = 'wsitem';
    const del = document.createElement('button');
    del.className = 'del';
    del.title = "delete this build's logs";
    del.setAttribute('aria-label', `delete the logs of ${b.id}`);
    del.innerHTML = icon('delete');
    if (canDelete) item.append(a, del);
    else item.append(a);
    del.onclick = async ev => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!del.classList.contains('sure')) {  // ask once, then act
        del.classList.add('sure');
        del.textContent = 'Delete?';
        setTimeout(() => {
          del.classList.remove('sure');
          del.innerHTML = icon('delete');
        }, 2500);
        return;
      }
      const r = await postJson(
        `/api/builds/delete?ws=${encodeURIComponent(WS)}` +
        `&build=${encodeURIComponent(b.id)}`);
      toast(r.ok ? `Deleted <b>${b.id}</b>, freed ${fmtBytes(r.freed)}.`
                 : `Not deleted: ${r.error}`, r.ok ? 'info' : '');
      openBuildPicker();
    };
    list.appendChild(item);
  });
}

// "Oct 20, 16:50 · 2 d ago": the build id is a timestamp, but a long one
// that wraps in the middle; the row's tooltip keeps the id itself
function buildWhen(b) {
  if (!b.time) return esc(b.id);
  const when = new Date(b.time * 1000).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  // the options of this run, when they differ from a plain build
  const args = b.args ? `<span class="bargs" title="${esc(b.args)}">${esc(b.args)}</span>` : '';
  return `<span class="bwhen">${esc(when)}</span> <span class="bago">${fmtAgo(b.time)}</span>${args}`;
}

// a POST that answers { ok: false, error } when the server does not answer
async function postJson(url) {
  try {
    return await (await fetch(url, { method: 'POST' })).json();
  } catch (e) {
    return { ok: false, error: 'the server does not answer' };
  }
}

export function initBuildPicker() {
  $('#buildid').onclick = () => { if ($('#bpick').hidden) openBuildPicker(); else $('#bpick').hidden = true; };
  if (PINNED_BUILD) $('#buildid').classList.add('pinned');
  const overlay = $('#bpick');
  initPanel(overlay, $('#buildid'));
  // Esc closes it, as the help table says for every overlay
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && !overlay.hidden) overlay.hidden = true;
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
    const r = await postJson(
      `/api/builds/prune?ws=${encodeURIComponent(WS)}&keep=3`);
    const stuck = r.failed?.length
      ? ` ${r.failed.length} could not be deleted: another user owns some of their files.` : '';
    toast(r.ok ? `Deleted ${r.deleted} builds, freed ${fmtBytes(r.freed)}.${stuck}`
               : `Not deleted: ${r.error}`, r.ok && !stuck ? 'info' : '');
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
    overlay.querySelector('.cancel').focus();  // Enter cancels, Esc too
  };
  overlay.querySelector('.cancel').onclick = () => { overlay.hidden = true; };
  overlay.addEventListener('click', ev => {
    if (ev.target === overlay) overlay.hidden = true;
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && !overlay.hidden) overlay.hidden = true;
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
        'Start the server again from the tray icon, with <code>colcon-dashboard --start-service</code> ' +
        'if it runs as a service, or with <code>colcon-dashboard</code>. ' +
        'Then reload this page.';
      btns.hidden = true;
    } else {
      text.textContent =
        'The server still answers. Try colcon-dashboard --stop in a terminal.';
    }
  };
}
