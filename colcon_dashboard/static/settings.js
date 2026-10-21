import { getNotifyMode, notifyBlocked, setNotifyMode, testNotify } from './notify.js';
import { App } from './state.js';
import { savedTheme, setTheme } from './theme.js';
import { $, copyText, esc } from './util.js';

/* ---------------- settings dialog ----------------
   One place for the choices this browser keeps (theme, notifications,
   log panes, layout) and a read-only view of the server configuration,
   which lives in config.ini. The header buttons stay as shortcuts; the
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
  note.hidden = !blocked;
  note.textContent = blocked ? `Desktop notifications do not work: ${blocked}.` : '';
  $('#setNotifyTest').disabled = mode === 'off';
  $('#setTs').checked = localStorage.getItem('cmc-ts') !== '0';
  $('#setWrap').checked = localStorage.getItem('cmc-wrap') === '1';
  renderServer();
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
  const rows = [
    ['configuration file', `<code>${esc(cfg.path)}</code> <button class="copy" data-copy="${esc(cfg.path)}" title="copy the path">⧉</button>`
      + (cfg.exists ? '' : ` ${unset('(not created yet: every value is the default)')}`)],
    ['address', esc(location.host)],
    ['log directory', cfg.log_base ? `<code>${esc(cfg.log_base)}</code>` : `<code>log</code> ${unset('(default)')}`],
    ['old builds', keep != null && keep >= 0 ? `keep the newest ${keep} of each kind` : unset('kept forever')],
    ['editor links', cfg.editor_url ? `<code>${esc(cfg.editor_url)}</code>` : unset('off')],
    ['claude CLI', cfg.claude_bin ? `<code>${esc(cfg.claude_bin)}</code>` : unset('found on PATH')],
    ['update check', cfg.check_updates ? 'once a day' : unset('off')],
    ['extra scan folders', (cfg.extra_roots || []).length
      ? cfg.extra_roots.map(r => `<code>${esc(r)}</code>`).join(' ') : unset('none')],
  ];
  $('#setServer').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

export function initSettings() {
  const overlay = $('#settings');
  const close = () => { overlay.hidden = true; };
  $('#settingsBtn').onclick = () => {
    if (overlay.hidden) render();
    overlay.hidden = !overlay.hidden;
  };
  overlay.querySelector('.sclose').onclick = close;
  overlay.addEventListener('click', ev => {
    if (ev.target === overlay) close();
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
