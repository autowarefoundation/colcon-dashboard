import { zoomToPkg } from './camera.js';
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
  GS.matches = matches;
  GS.idx = -1;
  GS.set = filtering ? new Set(GS.matches) : null;
  $('#graph').classList.toggle('searching', filtering);
  $('#gantt').classList.toggle('searching', filtering);
  for (const [name, g] of App.nodeEls)
    g.classList.toggle('smatch', !!GS.set?.has(name));
  for (const bar of $('#gantt').querySelectorAll('.gbar'))
    bar.classList.toggle('smatch', !!GS.set?.has(bar.dataset.name));
  $('#gscount').textContent = filtering ? `${GS.matches.length} found` : '';
}

export function stepGraphSearch(dir) {
  if (!GS.matches.length) return;
  GS.idx = (GS.idx + dir + GS.matches.length) % GS.matches.length;
  $('#gscount').textContent = `${GS.idx + 1}/${GS.matches.length}`;
  zoomToPkg(GS.matches[GS.idx]);
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
    if (ev.key === 'Enter') {
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
  for (const chip of document.querySelectorAll('#stateChips button')) {
    chip.onclick = () => {
      const states = CHIP_STATES[chip.dataset.filter] || [];
      const on = chip.classList.toggle('on');
      for (const s of states) on ? GS.states.add(s) : GS.states.delete(s);
      runGraphSearch();
    };
  }
}
