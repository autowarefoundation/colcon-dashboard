import { newSgr, renderLogLine, updateGroup } from './ansi.js';
import { emit, on } from './bus.js';
import { zoomToPkg } from './camera.js';
import { label } from './graph.js';
import { mode } from './modes.js';
import { App } from './state.js';
import { toast } from './toasts.js';
import { $, copyText, esc, failNote, fmtDur, icon, wsParam } from './util.js';

/* ---------------- log dock ---------------- */

export const STATE_DOT = { done: 'c-done', building: 'c-building', ready: 'c-ready',
  waiting: 'c-waiting', failed: 'c-failed', aborted: 'c-aborted',
  skipped: 'c-skipped', blocked: 'c-failed' };

export const BUILD_PANE = '\0build';  // the pinned whole-build terminal view

export const FAIL_PANE = '\0failures';  // the aggregated failure summary

// The log tabs work from the keyboard: Enter or Space opens a tab,
// Delete closes it, and the arrow keys move between tabs.
function tabKeys(tab, name, closable) {
  tab.tabIndex = 0;
  tab.setAttribute('role', 'tab');
  tab.addEventListener('keydown', ev => {
    if (ev.target !== tab) return;  // the close button handles its own keys
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      activatePane(name);
    } else if (ev.key === 'Delete' && closable) {
      const next = tab.previousElementSibling?.matches('.ltab')
        ? tab.previousElementSibling : tab.nextElementSibling;
      closePane(name);
      if (next?.matches('.ltab')) next.focus();
    } else if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      const to = ev.key === 'ArrowRight' ? tab.nextElementSibling : tab.previousElementSibling;
      if (to?.matches('.ltab')) to.focus();
    }
  });
}

export function openPane(name) {
  if (!App.panes.has(name)) createPane(name);
  activatePane(name);
}

/* ---- editor links: file:line in a log opens the editor ----
   Active only when config.ini sets [ui] editor_url. */

export const FILE_LINE_RE =
  /(\/?[\w.+~-]+(?:\/[\w.+~-]+)+\.[A-Za-z]\w{0,3}):(\d+)/;

// node: the text part of a log line (.lc)
export function linkifyLine(node) {
  const tmpl = App.cfg?.editor_url;
  if (!tmpl || !node) return;
  if (node.nodeType !== 3 && node.querySelector?.('.elink')) return;
  const m = FILE_LINE_RE.exec(node.textContent);
  if (!m) return;
  if (!m[1].startsWith('/') && !App.workspace) return;  // no anchor yet
  if (tmpl.includes('{project}') && !App.workspace) return;
  let el = node;
  if (el.nodeType === 3) {  // bare text line: wrap it to hold the link
    const s = document.createElement('span');
    el.replaceWith(s);
    s.appendChild(el);
    el = s;
  }
  const path = m[1].startsWith('/') ? m[1] : `${App.workspace}/${m[1]}`;
  const a = document.createElement('a');
  a.className = 'elink';
  a.href = tmpl.replace('{path}', path).replace('{line}', m[2])
    .replace('{line0}', m[2] - 1)  // JetBrains URLs count lines from 0
    .replace('{project}', (App.workspace || '').split('/').pop());
  a.title = `open ${m[1]}:${m[2]} in your editor`;
  // wrap the file:line text itself; a Range survives the match
  // crossing ANSI span boundaries, where plain splitText cannot
  const start = m.index, end = m.index + m[0].length;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let pos = 0, sNode = null, sOff = 0, eNode = null, eOff = 0, t;
  while ((t = walker.nextNode())) {
    const next = pos + t.data.length;
    if (!sNode && start < next) { sNode = t; sOff = start - pos; }
    if (end <= next) { eNode = t; eOff = end - pos; break; }
    pos = next;
  }
  if (!eNode) return;
  const range = document.createRange();
  range.setStart(sNode, sOff);
  range.setEnd(eNode, eOff);
  a.appendChild(range.extractContents());
  range.insertNode(a);
}

export function updateCloseAll() {
  $('#closeAll').hidden = ![...App.panes.values()].some(p => !p.fixed);
}

export function createPane(name) {
  if (name === FAIL_PANE) return createFailPane();
  const fixed = name === BUILD_PANE;
  const ai = name.startsWith('ai:');
  const pkg = ai ? name.slice(3) : name;
  $('#panes .placeholder')?.remove();
  const tab = document.createElement('div');
  tab.className = 'ltab';
  tab.innerHTML =
    `<span class="dot ${fixed ? 'c-building' : 'c-waiting'}"></span>` +
    `<span class="tlabel">${fixed ? 'Build log' : (ai ? icon('spark') : '') + esc(label(pkg))}</span>` +
    (fixed ? '' : `<button class="x" title="close" aria-label="close">${icon('close')}</button>`);
  tab.onclick = ev => {
    // the click lands on the icon inside the button
    if (ev.target.closest('.x')) closePane(name);
    else activatePane(name);
  };
  tab.ondblclick = () => {
    if (fixed) mode().fit();
    else zoomToPkg(pkg);
  };
  tab.title = fixed ? 'double-click to fit the whole graph'
                    : 'double-click to find this package in the graph';
  tabKeys(tab, name, !fixed);
  $('#logtabs').appendChild(tab);

  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.innerHTML = `
    <div class="phead">
      <span class="pname">${fixed ? 'colcon build' : (ai ? `${icon('spark')}Claude · ${esc(pkg)}` : esc(name))}</span>
      <span class="chip">…</span>
      <span class="ph"></span>
      <span class="errn"></span>
      ${fixed || ai ? '' : `<button class="askai" hidden title="explain this failure with the claude CLI">${icon('spark')}Ask Claude</button>
      <button class="cpath" hidden title="copy the package source path">${icon('copy')}Path</button>
      <button class="locate" title="find this package in the graph or the timeline">${icon('locate')}Locate</button>`}
      <span class="grow"></span>
      <span class="searchwrap"><input class="search" type="text" placeholder="Search log" spellcheck="false"><button class="sclear" hidden title="clear the search" aria-label="clear the search">${icon('close')}</button></span>
      <span class="scount"></span>
      <button class="sprev" title="previous match" aria-label="previous match" disabled>${icon('up')}</button>
      <button class="snext" title="next match" aria-label="next match" disabled>${icon('down')}</button>
      ${fixed || ai ? '' : `<label>File <select class="fsel">
        <option value="streams">Output (timestamped)</option>
        <option value="combined">stdout + stderr</option>
        <option value="stderr">stderr</option>
        <option value="stdout">stdout</option>
        <option value="command">Commands</option>
      </select></label>`}
      ${ai ? '' : `<button class="earlier" style="display:none" title="load the whole log from the start">${icon('top')}Load all</button>
      <button class="tsbtn on" title="show or hide timestamps">${icon('clock')}Time</button>`}
      <button class="wrapbtn" title="soft-wrap long lines">${icon('wrap')}Wrap</button>
      <button class="follow on" title="auto-scroll to the end">${icon('follow')}Follow</button>
    </div>
    <div class="lognote" hidden></div>
    <div class="logwrap"><pre tabindex="0" class="showts"></pre><div class="lmarks" aria-hidden="true"></div></div>`;
  $('#panes').appendChild(pane);

  const p = {
    name, el: pane, tabEl: tab, pre: pane.querySelector('pre'), fixed,
    ai, pkg, running: false,
    offset: -1, buf: '', file: fixed ? 'combined' : 'streams',
    follow: true, lines: 0, fetching: false,
    sgr: newSgr(), start: null, noTrim: false, loadingEarlier: false,
    earlierBtn: pane.querySelector('.earlier'),
  };
  if (p.earlierBtn) p.earlierBtn.onclick = () => loadEarlier(p);
  const tsBtn = pane.querySelector('.tsbtn');
  if (tsBtn && localStorage.getItem('cmc-ts') === '0') {
    p.pre.classList.remove('showts');
    tsBtn.classList.remove('on');
  }
  if (tsBtn) tsBtn.onclick = () => {
    const on = p.pre.classList.toggle('showts');
    tsBtn.classList.toggle('on', on);
    localStorage.setItem('cmc-ts', on ? '1' : '0');
    scheduleMarks(p);
    if (p.follow) p.pre.scrollTop = p.pre.scrollHeight;
  };
  const wrapBtn = pane.querySelector('.wrapbtn');
  if (ai || localStorage.getItem('cmc-wrap') === '1') {
    p.pre.classList.add('wrap');  // prose panes always start wrapped
    wrapBtn.classList.add('on');
  }
  wrapBtn.onclick = () => {
    const on = p.pre.classList.toggle('wrap');
    wrapBtn.classList.toggle('on', on);
    if (!ai) localStorage.setItem('cmc-wrap', on ? '1' : '0');
    scheduleMarks(p);
    if (p.follow) p.pre.scrollTop = p.pre.scrollHeight;
  };
  initSearch(p);
  // clicks inside the log: a package tag opens its pane, a group line
  // opens or closes its lines, an environment chip shows the variables
  p.pre.addEventListener('click', ev => {
    if (getSelection().type === 'Range') return;  // the user selects text
    const pk = ev.target.closest('.pk');
    if (pk) { emit('open-pkg', pk.textContent); return; }
    const head = ev.target.closest('.lgrp-head');
    if (head) {
      const g = head.parentElement;
      g.classList.toggle('folded');
      g.dataset.user = '1';
      scheduleMarks(p);
      return;
    }
    const env = ev.target.closest('.envfold');
    if (env) {
      const open = env.classList.toggle('open');
      env.textContent = open ? env.dataset.full : env.dataset.lbl;
    }
  });
  new ResizeObserver(() => scheduleMarks(p)).observe(p.pre);
  pane.querySelector('.askai')?.addEventListener('click',
    () => emit('analyze-pkg', name));
  pane.querySelector('.locate')?.addEventListener('click', () => zoomToPkg(pkg));
  pane.querySelector('.cpath')?.addEventListener('click', async () => {
    const abs = pkgAbsPath(name);
    if (!abs) return;
    const ok = await copyText(abs);
    toast(ok ? `Copied <span class="mono">${esc(abs)}</span>`
             : 'The browser refused the clipboard.', 'info');
  });
  if (ai) {
    const row = document.createElement('div');
    row.className = 'askrow';
    row.innerHTML =
      `<input type="text" placeholder="Ask Claude a follow-up question…" spellcheck="false">
       <button>Ask</button>`;
    const input = row.querySelector('input');
    const send = () => {
      const t = input.value.trim();
      if (!t || p.running) return;
      input.value = '';
      emit('analyze-pkg', pkg, t);
    };
    row.querySelector('button').onclick = send;
    input.onkeydown = ev => { if (ev.key === 'Enter') send(); };
    pane.appendChild(row);
  }
  pane.querySelector('.fsel')?.addEventListener('change', ev => {
    p.file = ev.target.value;
    p.fellBack = false;  // the user picked a file: say nothing about the swap
    resetPane(p);
  });
  const followBtn = pane.querySelector('.follow');
  followBtn.onclick = () => {
    p.follow = !p.follow;
    followBtn.classList.toggle('on', p.follow);
    if (p.follow) p.pre.scrollTop = p.pre.scrollHeight;
  };
  p.pre.addEventListener('scroll', () => {
    const atEnd = p.pre.scrollTop + p.pre.clientHeight >= p.pre.scrollHeight - 24;
    if (p.follow !== atEnd) {
      p.follow = atEnd;
      followBtn.classList.toggle('on', atEnd);
    }
  });
  App.panes.set(name, p);
  updateCloseAll();
  pollPane(p);
}

export function resetPane(p) {
  p.trimmed = false;
  p.offset = -1;
  p.buf = '';
  p.lines = 0;
  p.sgr = newSgr();
  p.lint = null;
  p.lintBy = null;
  p.grps = null;
  p.start = null;
  p.noTrim = false;
  p.pre.textContent = '';
  updateMarks(p);
}

export function updateEarlierBtn(p) {
  if (p.earlierBtn) p.earlierBtn.style.display = p.start > 0 || p.trimmed ? '' : 'none';
}

/* ---- per-pane log search ---- */

export function initSearch(p) {
  const input = p.el.querySelector('.search');
  const clear = p.el.querySelector('.sclear');
  const sync = () => { clear.hidden = !input.value; };
  let timer = null;
  input.oninput = () => {
    sync();
    clearTimeout(timer);
    timer = setTimeout(() => runSearch(p, null), 250);
  };
  input.onkeydown = ev => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      stepHit(p, ev.shiftKey ? -1 : 1);
    } else if (ev.key === 'Escape') {
      input.value = '';
      sync();
      runSearch(p, null);
      input.blur();
    }
  };
  clear.onclick = () => {
    input.value = '';
    sync();
    runSearch(p, null);
  };
  p.el.querySelector('.sprev').onclick = () => stepHit(p, -1);
  p.el.querySelector('.snext').onclick = () => stepHit(p, 1);
}

export function markHit(p, ln) {
  ln.classList.add('hit');
  p.hits.push(ln);
  return ln;
}

// the text of a log line, without its timestamp
const lineText = ln => ln.lastElementChild?.textContent || '';

// re, when given, picks the lines in place of the typed text: a search
// opened for the user (the warnings) matches what the server counted
export function runSearch(p, re = p.queryRe) {
  const q = p.el.querySelector('.search').value.toLowerCase();
  p.seekFirst = false;
  p.queryRe = re;
  for (const el of p.hits || []) el.classList.remove('hit', 'hit-cur');
  p.query = q || null;
  p.hits = [];
  p.hitIdx = -1;
  if (q) {
    for (const ln of p.pre.querySelectorAll('.ln'))
      if (matchesQuery(p, lineText(ln))) markHit(p, ln);
    if (p.hits.length) {
      p.hitIdx = p.hits.length - 1;  // start at the most recent match
      focusHit(p);
    }
  }
  updateSearchCount(p);
}

function matchesQuery(p, text) {
  return p.queryRe ? p.queryRe.test(text) : text.toLowerCase().includes(p.query);
}

export function focusHit(p) {
  p.hits.forEach((h, i) => h.classList.toggle('hit-cur', i === p.hitIdx));
  const cur = p.hits[p.hitIdx];
  if (cur) {
    openGroupOf(cur);
    if (p.follow) {
      p.follow = false;
      p.el.querySelector('.follow').classList.remove('on');
    }
    cur.scrollIntoView({ block: 'center' });
  }
}

export function stepHit(p, dir) {
  if (p.hits?.length) {
    p.hits = p.hits.filter(h => h.isConnected);  // drop trimmed lines
    if (p.hitIdx >= p.hits.length) p.hitIdx = p.hits.length - 1;
  }
  if (!p.hits?.length) {
    updateSearchCount(p);  // the last matches scrolled out of the log
    return;
  }
  p.hitIdx = (p.hitIdx + dir + p.hits.length) % p.hits.length;
  focusHit(p);
  updateSearchCount(p);
}

export function updateSearchCount(p) {
  p.el.querySelector('.scount').textContent =
    p.query ? `${p.hits.length ? p.hitIdx + 1 : 0}/${p.hits.length}` : '';
  // the arrows step through matches, so without one they do nothing
  const none = !p.hits?.length;
  p.el.querySelector('.sprev').disabled = none;
  p.el.querySelector('.snext').disabled = none;
}

export async function loadEarlier(p) {
  // prepend the whole history before p.start, keeping the view in place
  if (p.loadingEarlier || !(p.start || p.trimmed)) return;
  if (p.trimmed) {
    // the line cap dropped lines from the top: load the whole log again,
    // up to the partial last line that waits in p.buf
    p.pre.textContent = '';
    p.lines = 0;
    p.hits = [];
    p.grps = null;
    p.start = p.offset - new TextEncoder().encode(p.buf).length;
    p.trimmed = false;
  }
  p.loadingEarlier = true;
  p.earlierBtn.innerHTML = `${icon('top')}Loading…`;
  const base = p.fixed
    ? `/api/buildlog?`
    : `/api/log/${encodeURIComponent(p.name)}?file=${p.file}&`;
  try {
    const parts = [];
    let start = p.start;
    while (start > 0) {
      const from = Math.max(0, start - 512 * 1024);
      const r = await (await fetch(
        `${base}offset=${from}&limit=${start - from}` +
        `&align=${from > 0 ? 1 : 0}${wsParam('&')}`)).json();
      parts.unshift(r.data);
      if (!(r.start < start)) break;  // no progress: stop
      start = r.start;
    }
    const all = parts.join('');
    if (all) {
      const frag = document.createDocumentFragment();
      // the ANSI and lint states start fresh at line zero
      const ctx = { sgr: newSgr(), fixed: p.fixed, ai: p.ai };
      const lines = all.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      for (const line of lines) renderLogLine(ctx, line, frag);
      if (App.cfg?.editor_url)
        for (const ln of frag.querySelectorAll('.ln')) linkifyLine(ln.lastElementChild);
      const before = p.pre.scrollHeight;
      p.pre.insertBefore(frag, p.pre.firstChild);
      p.pre.scrollTop += p.pre.scrollHeight - before;
      p.lines += lines.length;
      p.noTrim = true;  // keep the history the user asked for
    }
    p.start = start;
    updateEarlierBtn(p);
    if (p.query) runSearch(p);
    updateMarks(p);
  } catch (e) { /* transient */ }
  p.earlierBtn.innerHTML = `${icon('top')}Load all`;
  p.loadingEarlier = false;
}

export function pkgAbsPath(name) {
  const rel = App.graph?.[name]?.path;
  if (!rel) return null;
  return rel.startsWith('/') ? rel : `${App.workspace}/${rel}`;
}

export function activatePane(name) {
  App.activePane = name;
  for (const [n, p] of App.panes) {
    p.el.classList.toggle('on', n === name);
    p.tabEl.classList.toggle('on', n === name);
    p.tabEl.setAttribute('aria-selected', n === name ? 'true' : 'false');
  }
  emit('pane-changed', name);
}

export function closePane(name) {
  const p = App.panes.get(name);
  if (!p || p.fixed) return;
  // every close path counts as a dismissal, "close all" included
  if (name === FAIL_PANE) failDismissed = true;
  p.el.remove();
  p.tabEl.remove();
  App.panes.delete(name);
  updateCloseAll();
  if (App.activePane === name) {
    const last = [...App.panes.keys()].pop();
    if (last) activatePane(last);
    else {
      App.activePane = null;
      const ph = document.createElement('div');
      ph.className = 'placeholder';
      ph.textContent = 'Click a package in the graph or timeline to open its build log.';
      $('#panes').appendChild(ph);
      emit('pane-changed', null);
    }
  }
}

// a package pane never stays blank: say why, or swap to a file that exists
function updateLogNote(p, r) {
  const st = App.pkgs[p.name];
  const ended = !App.active || st?.t1 != null;  // nothing more will be written
  if (r.missing && ended && p.file === 'streams' && p.fellBack == null) {
    p.fellBack = true;  // older colcon versions write no streams.log
    p.file = 'combined';
    p.el.querySelector('.fsel').value = 'combined';
    resetPane(p);
    setTimeout(() => pollPane(p), 0);
    return;
  }
  if (p.fellBack == null) p.fellBack = false;
  const name = p.el.querySelector(`.fsel option[value="${p.file}"]`)?.textContent;
  let msg = '';
  if (!p.lines && !p.buf) {
    msg = !ended ? 'Waiting for output…'
        : r.missing ? `This build wrote no ${name} log for this package.`
        : `The ${name} log of this package is empty.`;
  } else if (p.fellBack) {
    msg = 'This build wrote no timestamped output for this package. It shows stdout+stderr instead.';
  }
  const note = p.el.querySelector('.lognote');
  note.textContent = msg;
  note.hidden = !msg;
}

export async function pollPane(p) {
  if (p.summary || p.fetching) return;  // the summary refreshes on 'state'
  p.fetching = true;
  let r = null;
  try {
    const url = p.fixed
      ? `/api/buildlog?offset=${p.offset}${wsParam('&')}`
      : p.ai
        ? `/api/analysis/${encodeURIComponent(p.pkg)}?offset=${p.offset}` +
          wsParam('&')
        : `/api/log/${encodeURIComponent(p.name)}?offset=${p.offset}` +
          `&file=${p.file}${wsParam('&')}`;
    r = await (await fetch(url)).json();
    if (p.ai) {
      p.running = !!r.running;
      const chip = p.el.querySelector('.chip');
      chip.textContent = p.running ? 'thinking…' : (r.size ? 'answered' : 'ready');
      chip.className = 'chip ' + (p.running ? 'building' : 'done');
      p.tabEl.querySelector('.dot').className =
        'dot ' + (p.running ? 'c-building' : 'c-done');
    }
    if (r.reset) {
      p.trimmed = false;
      p.pre.textContent = '';
      p.buf = '';
      p.lines = 0;
      p.sgr = newSgr();
      p.lint = null;
      p.lintBy = null;
      p.grps = null;
      p.noTrim = false;
      p.start = r.start ?? 0;
      updateEarlierBtn(p);
    } else if (p.start == null) {
      p.start = r.start ?? 0;
      updateEarlierBtn(p);
    }
    p.offset = r.offset;
    if (r.data) appendLog(p, r.data);
  } catch (e) { /* transient */ }
  p.fetching = false;
  if (r && !p.fixed && !p.ai) updateLogNote(p, r);
}

export function appendLog(p, data) {
  p.buf += data;
  const lines = p.buf.split('\n');
  p.buf = lines.pop();
  if (!lines.length) return;
  const frag = document.createDocumentFragment();
  const added = lines.map(line => renderLogLine(p, line, frag));
  p.lines += lines.length;
  p.pre.appendChild(frag);
  const doLink = !!App.cfg?.editor_url;
  if (p.query || doLink) {  // keep the search live as the log streams
    for (const ln of added) {
      if (doLink) linkifyLine(ln.lastElementChild);
      if (p.query && matchesQuery(p, lineText(ln))) markHit(p, ln);
    }
    if (p.query) updateSearchCount(p);
    seekFirstHit(p);
  }
  let trimmed = false;
  while (!p.noTrim && p.lines > 6000) {
    const first = p.pre.querySelector('.ln');
    if (!first) break;
    const body = first.parentElement.classList.contains('lgrp-body') ? first.parentElement : null;
    first.remove();
    if (body) {
      if (!body.firstChild) body.parentElement.remove();
      else updateGroup(body.parentElement, body.childElementCount);
    }
    p.lines--;
    trimmed = true;
  }
  if (trimmed && !p.trimmed) {
    p.trimmed = true;  // the start of the log is gone: offer to load it again
    updateEarlierBtn(p);
  }
  if (p.follow) p.pre.scrollTop = p.pre.scrollHeight;
  scheduleMarks(p);
}

/* ---- the error and warning marks beside the scrollbar: where the
   problems sit in a long log, and a click jumps to one ---- */

const MAX_MARKS = 400;

export function scheduleMarks(p) {
  if (p.marksTimer) return;
  p.marksTimer = setTimeout(() => { p.marksTimer = null; updateMarks(p); }, 400);
}

export function updateMarks(p) {
  const box = p.el?.querySelector('.lmarks');
  if (!box || !p.pre) return;
  box.textContent = '';
  const h = p.pre.scrollHeight;
  if (!h || h <= p.pre.clientHeight) return;  // no scrollbar: nothing to find
  const lines = p.pre.querySelectorAll('.ln.l-err, .ln.l-warn');
  const step = Math.max(1, Math.ceil(lines.length / MAX_MARKS));
  const frag = document.createDocumentFragment();
  for (let i = 0; i < lines.length; i += step) {
    const ln = lines[i];
    if (!ln.offsetParent) continue;  // inside a closed group
    const m = document.createElement('span');
    m.className = ln.classList.contains('l-err') ? 'mk err' : 'mk warn';
    m.style.top = `${(100 * ln.offsetTop / h).toFixed(2)}%`;
    m.title = lineText(ln).trim().slice(0, 160);
    m.onclick = () => {
      ln.scrollIntoView({ block: 'center' });
      if (p.follow) {
        p.follow = false;
        p.el.querySelector('.follow').classList.remove('on');
      }
      ln.classList.remove('flash');
      void ln.offsetWidth;  // restart the animation
      ln.classList.add('flash');
    };
    frag.appendChild(m);
  }
  box.appendChild(frag);
}

function openGroupOf(ln) {
  const g = ln.closest('.lgrp');
  if (g?.classList.contains('folded')) {
    g.classList.remove('folded');
    g.dataset.user = '1';
  }
}

/* ---- failure summary: every failed package's stderr tail, in one
   pane, in failure order, with jump links. Refreshes on 'state'. ---- */

export function createFailPane() {
  $('#panes .placeholder')?.remove();
  const tab = document.createElement('div');
  tab.className = 'ltab';
  tab.innerHTML = `<span class="dot c-failed"></span><span class="tlabel">Failures</span>` +
    `<button class="x" title="close" aria-label="close">${icon('close')}</button>`;
  tab.title = 'every failed package, in failure order';
  tab.onclick = ev => {
    if (ev.target.closest('.x')) closePane(FAIL_PANE);
    else activatePane(FAIL_PANE);
  };
  tabKeys(tab, FAIL_PANE, true);
  $('#logtabs').appendChild(tab);
  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.innerHTML = `
    <div class="phead">
      <span class="pname heading">Failed packages</span>
      <span class="count"><span class="dot c-failed"></span><b class="fcount">…</b> failed</span>
      <span class="grow"></span>
      <button class="fcopyall" title="copy every failure as text, for an issue or a chat">${icon('copy')}Copy all</button>
    </div>
    <div class="fsummary"></div>`;
  $('#panes').appendChild(pane);
  pane.querySelector('.fcopyall').onclick = () => copyFailures(
    [...pane.querySelectorAll('.fsummary .fitem')], 'every failure');
  const p = { name: FAIL_PANE, el: pane, tabEl: tab, pre: null, fixed: false,
              ai: false, summary: true, pkg: null, offset: -1,
              fetching: false, items: new Map() };
  App.panes.set(FAIL_PANE, p);
  updateCloseAll();
}

export function buildFailItem(name, st) {
  const el = document.createElement('div');
  el.className = 'fitem';
  const dur = st.t1 && st.t0 ? fmtDur(st.t1 - st.t0) : null;
  el.innerHTML = `
    <div class="fhead">
      <button class="fjump mono" title="find this package in the graph">${esc(label(name))}</button>
      <span class="chip failed">${esc(failNote(st))}</span>
      ${dur ? `<span class="fmeta">failed after ${dur}</span>` : ''}
      ${st.warn ? `<span class="fmeta">${st.warn} warning${st.warn === 1 ? '' : 's'}</span>` : ''}
      ${App.prev?.failed && !App.prev.failed.includes(name)
        ? '<span class="chip newfail" title="it did not fail in the last run">new</span>' : ''}
      <span class="grow"></span>
      <button class="fcopy" title="copy the name, the reason, and the log tail as text">${icon('copy')}Copy</button>
      <button class="askai" ${App.ai ? '' : 'hidden'} title="explain this failure with the claude CLI">${icon('spark')}Ask Claude</button>
      <button class="fopen" title="open the full log pane">${icon('log')}Open log</button>
    </div>
    ${st.cmd ? `<div class="fcmd mono" title="the command that failed">$ ${esc(st.cmd)}</div>` : ''}
    ${(st.tr?.fail || []).length ? `<ul class="ftests">${st.tr.fail.map(f =>
      `<li><span class="mono">${esc(f.n)}</span>${f.m ? ` - ${esc(f.m)}` : ''}</li>`).join('')}</ul>` : ''}
    <pre class="ftail">Loading…</pre>`;
  el.dataset.head = `${name}: ${failNote(st)}` + (dur ? `, failed after ${dur}` : '')
    + (st.cmd ? `\n$ ${st.cmd}` : '')
    + (st.tr?.fail || []).map(f => `\nFAILED ${f.n}${f.m ? `: ${f.m}` : ''}`).join('');
  el.querySelector('.fcopy').onclick = () => copyFailures([el], name);
  el.querySelector('.fjump').onclick = () => {
    emit('open-pkg', name);
    emit('focus-pkg', name);
  };
  el.querySelector('.fopen').onclick = () => openPane(name);
  el.querySelector('.askai').onclick = () => emit('analyze-pkg', name);
  return el;
}

// Failures as plain text, for an issue or a chat: one block per package,
// the name and the reason, then the log tail.
async function copyFailures(items, what) {
  const text = items.map(el =>
    `${el.dataset.head}\n${el.querySelector('.ftail').textContent.trimEnd()}`).join('\n\n');
  const ok = await copyText(text);
  toast(ok ? `Copied ${esc(what)}` : 'The browser refused the clipboard.', 'info');
}

export async function fillFailTail(item, name) {
  const pre = item.el.querySelector('.ftail');
  const url = file => `/api/log/${encodeURIComponent(name)}?offset=-1` +
    `&file=${file}${wsParam('&')}`;
  try {
    let r = await (await fetch(url('stderr'))).json();
    if (!r.data.trim()) r = await (await fetch(url('combined'))).json();
    const lines = r.data.split('\n').filter(l => l.trim()).slice(-20);
    pre.textContent = '';
    if (!lines.length) {
      pre.textContent = '(no output captured)';
      return;
    }
    const ctx = { sgr: newSgr() };
    const frag = document.createDocumentFragment();
    for (const line of lines) renderLogLine(ctx, line, frag);
    if (App.cfg?.editor_url)
      for (const ln of frag.querySelectorAll('.ln')) linkifyLine(ln.lastElementChild);
    pre.appendChild(frag);
  } catch (e) {
    pre.textContent = '(log unavailable)';
  }
}

export function refreshFailSummary(p, failed) {
  p.el.querySelector('.fcount').textContent = failed.length;
  const box = p.el.querySelector('.fsummary');
  // move a node only when it is new or misplaced: re-appending an
  // unchanged node every tick would destroy the user's text selection
  let prev = null;
  for (const [name, st] of failed) {
    const key = `${name}@${st.t1 ?? ''}`;
    let item = p.items.get(name);
    if (!item || item.key !== key) {
      if (item) item.el.remove();
      item = { key, el: buildFailItem(name, st) };
      p.items.set(name, item);
      fillFailTail(item, name);
    }
    if (item.el.parentNode !== box || item.el.previousElementSibling !== prev)
      box.insertBefore(item.el,
        prev ? prev.nextElementSibling : box.firstElementChild);
    prev = item.el;
  }
  for (const [name, item] of p.items) {
    if (!failed.some(([n]) => n === name)) {
      item.el.remove();
      p.items.delete(name);
    }
  }
}

let dockWasActive = false;
let failDismissed = false;

on('state', () => {
  const failed = Object.entries(App.pkgs)
    .filter(([, p]) => p.s === 'failed')
    .sort((a, b) => (a[1].t1 ?? 0) - (b[1].t1 ?? 0));
  if (failed.length && !failDismissed) {
    if (!App.panes.has(FAIL_PANE)) createPane(FAIL_PANE);
    refreshFailSummary(App.panes.get(FAIL_PANE), failed);
    if (dockWasActive && !App.active) activatePane(FAIL_PANE);
  }
  dockWasActive = App.active;
});

let relinked = false;

on('state', () => {
  // panes opened at boot render before the first state names the
  // workspace, and linkify skips lines it cannot anchor: one pass
  // over the early content once the workspace is known
  if (relinked || !App.workspace || !App.cfg?.editor_url) return;
  relinked = true;
  for (const p of App.panes.values()) {
    const pres = p.pre ? [p.pre] : [...p.el.querySelectorAll('.ftail')];
    for (const pre of pres)
      for (const ln of pre.querySelectorAll('.ln')) linkifyLine(ln.lastElementChild);
  }
});

on('open-pkg', openPane);

// Open a package log searched for q (or the lines that match re), at its
// first match. The log can still be loading: then the first match that
// streams in takes the focus.
on('find-in-log', (name, q, re = null) => {
  openPane(name);
  const p = App.panes.get(name);
  p.el.querySelector('.search').value = q;
  p.el.querySelector('.sclear').hidden = false;
  runSearch(p, re);
  p.seekFirst = true;
  seekFirstHit(p);
});

function seekFirstHit(p) {
  if (!p.seekFirst || !p.hits?.length) return;
  p.seekFirst = false;
  p.hitIdx = 0;
  focusHit(p);
  updateSearchCount(p);
}

on('labels-changed', () => {
  for (const p of App.panes.values()) {
    if (p.fixed || p.summary) continue;  // the build log and the failures have fixed names
    p.tabEl.querySelector('.tlabel').innerHTML = (p.ai ? icon('spark') : '') + esc(label(p.pkg));
  }
});

on('build-changed', (s, first) => {
  if (first && App.failedSeen.size) {
    // a page opened on a failed build lands on the failures,
    // earliest first: later failures are usually its cascade
    const keep = App.panes.get(App.activePane);  // a #pkg deep link wins
    const failed = Object.entries(s.packages)
      .filter(([, p]) => p.s === 'failed')
      .sort((a, b) => (a[1].t1 ?? 0) - (b[1].t1 ?? 0))
      .slice(0, 6).map(([n]) => n);
    for (const name of failed) openPane(name);
    activatePane(keep && !keep.fixed ? keep.name : failed[0]);
  }
  if (!first) {
    for (const pane of App.panes.values())
      if (!pane.summary) resetPane(pane);
    closePane(FAIL_PANE);  // the new build has no failures yet
    failDismissed = false;
    liveFails = 0;
    moreToast?.remove();
    moreToast = null;
  }
});

// A failure cascade can fail dozens of packages within seconds. Each of
// the first few gets a toast and a pane. The rest go into one counting
// toast and the failure summary, so the dock and the screen stay usable.
const AUTO_OPEN = 6;   // panes that open by themselves in one build
const TOAST_EACH = 3;  // failures that get a toast of their own
let liveFails = 0;
let moreToast = null;

on('pkg-failed', name => {
  liveFails++;
  if (liveFails <= TOAST_EACH) {
    toast(`<b>${name}</b> failed (${failNote(App.pkgs[name])}) - click to open its log`, '',
          () => openPane(name));
  } else {
    moreToast?.remove();
    const more = liveFails - TOAST_EACH;
    moreToast = toast(`<b>${more}</b> more package${more === 1 ? '' : 's'} failed`
                      + ' - click to open the failure summary', '',
                      () => { failDismissed = false; openPane(FAIL_PANE); });
  }
  if (liveFails > AUTO_OPEN) return;  // the failure summary lists the rest
  const cur = App.panes.get(App.activePane);
  // never take the dock away from a package log that the user reads
  if (!cur || cur.fixed || cur.name === FAIL_PANE) openPane(name);
  else if (!App.panes.has(name)) createPane(name);
});
