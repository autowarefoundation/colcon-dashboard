import { pollAllPanes } from './ai.js';
import { initPanZoom } from './camera.js';
import { activatePane, BUILD_PANE, closePane, openPane } from './dock.js';
import { resize3d } from './g3d.js';
import { drawGantt, initGanttPan } from './gantt.js';
import { initGraphSearch } from './gsearch.js';
import { initBuildPicker, initStop, initWsPicker } from './pickers.js';
import { pollState, tickElapsed } from './poller.js';
import { App } from './state.js';
import { initTheme } from './theme.js';
import { $ } from './util.js';
import { initViews } from './views.js';

initTheme();
initViews();
initPanZoom();
initStop();
initWsPicker();
initBuildPicker();
initGraphSearch();
initGanttPan();
$('#closeAll').onclick = () => {
  for (const name of [...App.panes.keys()]) closePane(name);
  activatePane(BUILD_PANE);
};
$('#sysBtn').onclick = () => document.body.classList.toggle('showsys');
openPane(BUILD_PANE);  // the pinned whole-build terminal view
pollState();
setInterval(pollState, 1000);
setInterval(pollAllPanes, 1200);
setInterval(tickElapsed, 1000);
addEventListener('resize', () => {
  if (App.view === 'gantt') drawGantt();
  if (App.layoutMode === '3d') resize3d();
});
