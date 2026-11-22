import { emit } from './bus.js';
import { App } from './state.js';

/* ---- the selection: the packages that every view keeps in focus ----
   App.selected holds the names. Each view draws the selection in its own
   way when 'selection-changed' arrives: the graph and the 3D view keep the
   dependency chains in focus (graph.js, g3d.js), and the timeline marks
   the bars of the chains (gantt.js).

   A pick is one action of the user on one package, from any input: a
   click in a view, a step of the find-package box, a log tab. Every pick
   goes through this module and selects the package: pickPkg() for a plain
   pick, which can also open the log pane ('open-pkg') and move the views
   to the package ('focus-pkg'), and selectPkg() alone for a pick that
   does neither. An action of the page itself, such as the pane that opens
   for a new failure, is not a pick and leaves the selection alone. */

// select only this package; additive (Ctrl/Cmd/Shift+click): add it to
// the selection, or take it out again.
// step: a step of the find-package box made this selection (App.selStep).
//   While that search is on, the views keep its other matches clear and do
//   not fade them as packages outside the chain of the selection.
export function selectPkg(name, additive = false, step = false) {
  if (!additive) App.selected = new Set([name]);
  else if (App.selected.has(name)) App.selected.delete(name);
  else App.selected.add(name);
  App.selStep = step;
  emit('selection-changed');
}

export function clearSelection() {
  if (!App.selected.size) return;
  App.selected = new Set();
  App.selStep = false;
  emit('selection-changed');
}

// the search that made the selection ended (gsearch.js): the selection
// stays, and from now on it is like one that a click made
export function endStep() {
  if (!App.selStep) return;
  App.selStep = false;
  emit('selection-changed');
}

// source: where the pick came from. For 'graph' or 'timeline', that view
//   stays where it is, so that nothing moves under the pointer. For
//   'failures' (the failure summary), the graph comes into view first.
// open: false leaves the log dock as it is
// reveal: false moves no view
// step: true for a step of the find-package box (see selectPkg)
export function pickPkg(name, { source = null, open = true, reveal = true, step = false } = {}) {
  selectPkg(name, false, step);
  if (open) emit('open-pkg', name);
  if (reveal) emit('focus-pkg', name, source);
}
