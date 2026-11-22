import { requestDraw } from './draw.js';
import { endStep, pickPkg } from './selection.js';
import { App } from './state.js';
import { $ } from './util.js';

/* ---- graph search: find packages by name or state in any view ---- */

export const GS = { q: '', matches: [], set: null, idx: -1,
                    states: new Set() };

// chip -> package states it matches: the failed chip includes the
// blocked blast radius, the post-mortem gesture the chips exist for
export const CHIP_STATES = {
  failed: ['failed', 'blocked'],
  building: ['building'],
  waiting: ['waiting', 'ready'],
  done: ['done'],
};

export function runGraphSearch(refresh = false) {
  const q = $('#gsearch').value.trim().toLowerCase();
  GS.q = q;
  const filtering = !!q || GS.states.size > 0;
  const matches = [];
  if (filtering && App.lay) {
    for (const name of App.lay.nodes.keys()) {
      if (q && !name.toLowerCase().includes(q)) continue;
      if (GS.states.size && !GS.states.has(App.pkgs[name]?.s)) continue;
      matches.push(name);
    }
    matches.sort();
  }
  // a poll-tick refresh with an unchanged match set must not reset the
  // Enter-stepping position or overwrite the i/N counter
  if (refresh && GS.set && matches.length === GS.matches.length
      && matches.every((m, i) => m === GS.matches[i])) {
    return;
  }
  // a refresh with a changed set (a live build moves the states under a
  // chip) keeps the step position on its package while it still matches
  const cur = refresh ? GS.matches[GS.idx] : undefined;
  GS.matches = matches;
  GS.idx = cur === undefined ? -1 : matches.indexOf(cur);
  GS.set = filtering ? new Set(GS.matches) : null;
  requestDraw();  // the graph reads GS.set
  $('#gantt').classList.toggle('searching', filtering);
  for (const bar of $('#gantt').querySelectorAll('.gbar'))
    bar.classList.toggle('smatch', !!GS.set?.has(bar.dataset.name));
  $('#gscount').textContent = !filtering ? ''
    : GS.idx >= 0 ? `${GS.idx + 1}/${GS.matches.length}` : `${GS.matches.length} found`;
  // the arrows step through matches, so without one they do nothing
  $('#gsprev').disabled = $('#gsnext').disabled = !GS.matches.length;
  if (!filtering) endStep();  // no search: a selection of a step shows its chain
}

export function stepGraphSearch(dir) {
  const n = GS.matches.length;
  if (!n) return;
  // before the first step: forward starts at the first match, back at the last
  GS.idx = GS.idx < 0 ? (dir > 0 ? 0 : n - 1) : (GS.idx + dir + n) % n;
  $('#gscount').textContent = `${GS.idx + 1}/${n}`;
  // a step selects its match, and every visible view moves to it
  pickPkg(GS.matches[GS.idx], { open: false, step: true });
}

export function initGraphSearch() {
  const input = $('#gsearch');
  const clear = $('#gsclear');
  const sync = () => { clear.hidden = !input.value; };
  let timer = null;
  input.oninput = () => {
    sync();
    clearTimeout(timer);
    timer = setTimeout(runGraphSearch, 200);
  };
  input.onkeydown = ev => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      // Ctrl+Enter opens the log of the current match, so the keyboard
      // alone reaches a package log. Before any step, the first match
      // becomes the current one.
      ev.preventDefault();
      const n = GS.matches.length;
      if (!n) return;
      if (GS.idx < 0) {
        GS.idx = 0;
        $('#gscount').textContent = `1/${n}`;
      }
      pickPkg(GS.matches[GS.idx], { step: true });
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      stepGraphSearch(ev.shiftKey ? -1 : 1);
    } else if (ev.key === 'Escape') {
      input.value = '';
      sync();
      runGraphSearch();
      input.blur();
    }
  };
  clear.onclick = () => {
    input.value = '';
    sync();
    runGraphSearch();
  };
  // the arrows do what Shift+Enter and Enter do in the box. They also step
  // through the packages of a state chip while the box is empty.
  // A mouse click on an arrow puts the keyboard focus in the box, so that
  // the keys of the box (Enter, Shift+Enter, Ctrl+Enter, Esc) work after
  // it. Left on the arrow, or on the chip that was clicked before, Enter
  // would press that button again. A touch leaves the focus alone: in the
  // box, it would open the screen keyboard. A click from the keyboard
  // (ev.detail is 0) keeps the focus on its arrow.
  let byMouse = false;
  $('#gsnav').addEventListener('pointerdown', ev => { byMouse = ev.pointerType === 'mouse'; });
  const arrow = dir => ev => {
    stepGraphSearch(dir);
    if (ev.detail && byMouse) input.focus({ preventScroll: true });
  };
  $('#gsprev').onclick = arrow(-1);
  $('#gsnext').onclick = arrow(1);
  for (const chip of document.querySelectorAll('#stateChips button')) {
    chip.onclick = () => {
      const states = CHIP_STATES[chip.dataset.filter] || [];
      const on = chip.classList.toggle('on');
      for (const s of states) on ? GS.states.add(s) : GS.states.delete(s);
      runGraphSearch();
    };
  }
  // a reload can bring back the text of the box, and Firefox also brings
  // back the enabled state of the arrows: start from what the box holds
  sync();
  runGraphSearch();
}
