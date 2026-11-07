import { getNotifyMode, notifyBlocked, serverNotifies, setNotifyMode, testNotify } from './notify.js';
import { loadScanRoots, mountScanRoots } from './pickers.js';
import { App } from './state.js';
import { savedTheme, setTheme } from './theme.js';
import { $, copyText, esc, initPanel } from './util.js';

/* ---------------- settings side panel ----------------
   One place for the choices this browser keeps (theme, notifications,
   log panes, layout), the scan roots (saved in config.ini at once), and
   a read-only view of the rest of the server configuration. The header buttons stay as shortcuts; the
   dialog reads their state each time it opens. */

// the keys of the page layout; "reset" forgets them
const LAYOUT_KEYS = ['cmc-view', 'cmc-split', 'cmc-dock-h', 'cmc-layout',
                     'cmc-gsort', 'cmc-spread', 'cmc-scope', 'cmc-wssort'];

const pick = (seg, v) => seg.querySelectorAll('button').forEach(b =>
  b.classList.toggle('on', b.dataset.v === v));

function render() {
  pick($('#setTheme'), savedTheme());
  const mode = getNotifyMode();
  pick($('#setNotify'), mode);
  const blocked = notifyBlocked();
  const note = $('#setNotifyNote');
  note.textContent = blocked ? `Desktop notifications do not work: ${blocked}.`
    : mode !== 'off' && serverNotifies() ? 'The server shows them on this desktop, also with no dashboard open.' : '';
  note.hidden = !note.textContent;
  $('#setNotifyTest').disabled = mode === 'off';
  $('#setTs').checked = localStorage.getItem('cmc-ts') !== '0';
  $('#setWrap').checked = localStorage.getItem('cmc-wrap') === '1';
  loadScanRoots();
  renderServer();
  loadServerInfo();
}

// how the server runs, and the switches for the service and the tray
let serverInfo = null;
async function loadServerInfo() {
  try {
    serverInfo = await (await fetch('/api/server', { cache: 'no-store' })).json();
  } catch (e) {
    serverInfo = null;
  }
  renderServer();
  renderSwitches();
}

function renderSwitches(message) {
  const s = serverInfo;
  const login = $('#setLogin');
  const tray = $('#setTray');
  login.checked = !!s?.login;
  login.disabled = !s?.systemd;
  tray.checked = !!s?.tray?.autostart;
  tray.disabled = !s?.tray?.supported;
  const notes = [];
  if (message) notes.push(message);
  if (s && !s.systemd) notes.push('Start at login needs systemd user services, which this machine does not have.');
  if (s && !s.tray?.supported) notes.push('The tray icon needs PyGObject: sudo apt install python3-gi');
  const note = $('#setServerNote');
  note.textContent = notes.join(' ');
  note.hidden = !notes.length;
}

async function setSwitch(kind, on) {
  try {
    const r = await (await fetch(`/api/server/${kind}?on=${on ? 1 : 0}`, { method: 'POST' })).json();
    const { ok, message, ...info } = r;
    serverInfo = info;
    renderSwitches(ok ? '' : message);
  } catch (e) {
    renderSwitches('The server does not answer.');
  }
}

async function restartServer() {
  const btn = $('#restartBtn');
  const ping = async () => (await fetch('/api/ping', { cache: 'no-store' })).json();
  let before = null;
  try { before = (await ping()).started; } catch (e) { /* offline */ }
  btn.disabled = true;
  btn.textContent = 'Restarting…';
  try { await fetch('/api/server/restart', { method: 'POST' }); } catch (e) { /* going down */ }
  // a new server process (or the same one, after exec) has a new start time
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
    try {
      if ((await ping()).started !== before) { location.reload(); return; }
    } catch (e) { /* not back yet */ }
  }
  btn.disabled = false;
  btn.textContent = 'Restart the server';
  renderSwitches('The server did not come back. Start it from the tray icon or a terminal.');
}

function renderServer() {
  const cfg = App.cfg?.config;
  $('#settings .sver').textContent = App.cfg?.version ? `v${App.cfg.version}` : '';
  if (!cfg) {
    $('#setServer').innerHTML = '<dt>configuration</dt><dd>not loaded</dd>';
    return;
  }
  const unset = s => `<span class="muted">${s}</span>`;
  const keep = cfg.auto_prune_keep;
  const runs = !serverInfo ? unset('unknown')
    : serverInfo.service ? 'as the systemd user service'
      : `as a process that you started (pid ${serverInfo.pid})`;
  const rows = [
    ['runs', runs],
    ['configuration file', `<code>${esc(cfg.path)}</code> <button class="copy" data-copy="${esc(cfg.path)}" title="copy the path">⧉</button>`
      + (cfg.exists ? '' : ` ${unset('(not created yet: every value is the default)')}`)],
    ['address', esc(location.host)],
    ['log directory', cfg.log_base ? `<code>${esc(cfg.log_base)}</code>` : `<code>log</code> ${unset('(default)')}`],
    ['old builds', keep != null && keep >= 0 ? `keep the newest ${keep} of each kind` : unset('kept forever')],
    ['editor links', cfg.editor_url ? `<code>${esc(cfg.editor_url)}</code>` : unset('off')],
    ['claude CLI', cfg.claude_bin ? `<code>${esc(cfg.claude_bin)}</code>` : unset('found on PATH')],
    ['update check', cfg.check_updates ? 'once a day' : unset('off')],
  ];
  $('#setServer').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

export function initSettings() {
  const overlay = $('#settings');
  mountScanRoots($('#setRoots'));
  const close = () => { overlay.hidden = true; };
  $('#settingsBtn').onclick = () => {
    if (overlay.hidden) render();
    overlay.hidden = !overlay.hidden;
  };
  overlay.querySelector('.sclose').onclick = close;
  initPanel(overlay, $('#settingsBtn'), { side: true });
  overlay.addEventListener('click', ev => {
    const copy = ev.target.closest('button.copy');
    if (copy) copyText(copy.dataset.copy);
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && !overlay.hidden && $('#confirm').hidden) close();
  });
  $('#setTheme').onclick = ev => {
    const b = ev.target.closest('button');
    if (b) { setTheme(b.dataset.v); render(); }
  };
  $('#setNotify').onclick = ev => {
    const b = ev.target.closest('button');
    if (b) { setNotifyMode(b.dataset.v); render(); }
  };
  $('#setNotifyTest').onclick = testNotify;
  $('#setLogin').onchange = ev => setSwitch('login', ev.target.checked);
  $('#setTray').onchange = ev => setSwitch('tray', ev.target.checked);
  $('#restartBtn').onclick = restartServer;
  // a log choice holds for the open panes too: their own buttons flip it,
  // and those buttons keep the choice for the next panes
  const logChoice = (id, btn) => {
    $(id).onchange = ev => {
      for (const b of document.querySelectorAll(`#panes .pane ${btn}`)) {
        if (!b.closest('.pane').querySelector('.tsbtn')) continue;  // prose panes keep their wrap
        if (b.classList.contains('on') !== ev.target.checked) b.click();
      }
      localStorage.setItem(btn === '.tsbtn' ? 'cmc-ts' : 'cmc-wrap', ev.target.checked ? '1' : '0');
    };
  };
  logChoice('#setTs', '.tsbtn');
  logChoice('#setWrap', '.wrapbtn');
  $('#setReset').onclick = () => {
    for (const k of LAYOUT_KEYS) localStorage.removeItem(k);
    location.reload();
  };
  $('#stopBtn').addEventListener('click', close);  // the confirmation takes over
}
