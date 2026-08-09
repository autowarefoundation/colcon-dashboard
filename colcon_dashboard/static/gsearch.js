import { zoomToPkg } from './camera.js';
import { App } from './state.js';
import { $ } from './util.js';

/* ---- graph search: find packages by name in any view ---- */

export const GS = { q: '', matches: [], set: null, idx: -1 };

export function runGraphSearch() {
  const q = $('#gsearch').value.trim().toLowerCase();
  GS.q = q;
  GS.matches = [];
  GS.idx = -1;
  if (q && App.lay) {
    for (const name of App.lay.nodes.keys())
      if (name.toLowerCase().includes(q)) GS.matches.push(name);
    GS.matches.sort();
  }
  GS.set = q ? new Set(GS.matches) : null;
  $('#graph').classList.toggle('searching', !!q);
  $('#gantt').classList.toggle('searching', !!q);
  for (const [name, g] of App.nodeEls)
    g.classList.toggle('smatch', !!GS.set?.has(name));
  for (const bar of $('#gantt').querySelectorAll('.gbar'))
    bar.classList.toggle('smatch', !!GS.set?.has(bar.dataset.name));
  $('#gscount').textContent = q ? `${GS.matches.length} found` : '';
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
}
