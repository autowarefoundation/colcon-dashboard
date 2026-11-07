import { on } from './bus.js';
import { openPane, pollPane, STATE_DOT } from './dock.js';
import { App } from './state.js';
import { failNote, wsParam } from './util.js';

/* ---- AI failure analysis: shell out to the claude CLI on the server ---- */

export async function startAnalysis(pkg, question) {
  openPane('ai:' + pkg);
  try {
    await fetch(`/api/analyze/${encodeURIComponent(pkg)}${wsParam()}` +
      (question ? `&q=${encodeURIComponent(question)}` : ''),
      { method: 'POST' });
  } catch (e) { /* transient */ }
  const p = App.panes.get('ai:' + pkg);
  if (p) {
    p.running = true;  // poll eagerly until the first response says otherwise
    pollPane(p);
  }
}

export function updatePaneHeads() {
  for (const [name, p] of App.panes) {
    // ai chips update from /api/analysis; the failure summary from 'state'
    if (p.ai || p.summary) continue;
    if (p.fixed) {
      // the same verdict as the header badge: a finished build is no alarm
      const all = Object.values(App.pkgs);
      const done = all.filter(x => x.s === 'done').length;
      const [label, cls, dot] = App.active ? ['live', 'building', 'c-building']
        : all.some(x => x.s === 'failed') ? ['failed', 'failed', 'c-failed']
        : App.total > 0 && done === App.total ? ['finished', 'done', 'c-done']
        : ['stopped', 'aborted', 'c-skipped'];
      const chip = p.el.querySelector('.chip');
      chip.textContent = label;
      chip.className = 'chip ' + cls;
      p.tabEl.querySelector('.dot').className = 'dot ' + dot;
      continue;
    }
    const st = App.pkgs[name];
    const chip = p.el.querySelector('.chip');
    const s = st ? st.s : 'waiting';
    chip.textContent = s + (s === 'failed' && (st.tf || st.rc != null) ? ` ${failNote(st)}` : '');
    chip.className = 'chip ' + s;
    const ask = p.el.querySelector('.askai');
    if (ask) ask.hidden = !(App.ai && s === 'failed');
    const cp = p.el.querySelector('.cpath');
    if (cp) cp.hidden = !App.graph?.[name]?.path;
    p.el.querySelector('.ph').textContent =
      st && st.s === 'building'
        ? (st.ph || '') + (st.pct != null ? ` ${st.pct}%` : '') : '';
    p.el.querySelector('.errn').textContent =
      st?.err ? `${st.err} stderr line${st.err === 1 ? '' : 's'}` : '';
    const dot = p.tabEl.querySelector('.dot');
    dot.className = 'dot ' + (STATE_DOT[s] || 'c-waiting');
  }
}

export function pollAllPanes() {
  for (const p of App.panes.values()) {
    const st = App.pkgs[p.name];
    const busy = p.fixed ? App.active
      : p.ai ? p.running
      : st && (st.s === 'building' || st.t1 == null);
    // active pane always; background panes only while their package still writes
    if (p.name === App.activePane || busy || p.offset === -1) pollPane(p);
  }
}

on('analyze-pkg', (pkg, question) => startAnalysis(pkg, question));

on('state', updatePaneHeads);
