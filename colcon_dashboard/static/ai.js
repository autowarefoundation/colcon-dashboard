import { on } from './bus.js';
import { openPane, pollPane, STATE_DOT } from './dock.js';
import { App } from './state.js';
import { wsParam } from './util.js';

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
    if (p.ai) continue;  // its chip updates from /api/analysis responses
    if (p.fixed) {
      const chip = p.el.querySelector('.chip');
      chip.textContent = App.active ? 'live' : 'stopped';
      chip.className = 'chip ' + (App.active ? 'building' : 'aborted');
      p.tabEl.querySelector('.dot').className =
        'dot ' + (App.active ? 'c-building' : 'c-skipped');
      continue;
    }
    const st = App.pkgs[name];
    const chip = p.el.querySelector('.chip');
    const s = st ? st.s : 'waiting';
    chip.textContent = s + (st?.rc != null && s === 'failed' ? ` rc ${st.rc}` : '');
    chip.className = 'chip ' + s;
    const ask = p.el.querySelector('.askai');
    if (ask) ask.hidden = !(App.ai && s === 'failed');
    p.el.querySelector('.ph').textContent =
      st && st.s === 'building'
        ? (st.ph || '') + (st.pct != null ? ` ${st.pct}%` : '') : '';
    p.el.querySelector('.errn').textContent = st?.err ? `${st.err} stderr lines` : '';
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
