import './g3d.js';  // registers the 3d layout mode
import { pollAllPanes } from './ai.js';
import { emit } from './bus.js';
import { initPanZoom } from './camera.js';
import { activatePane, BUILD_PANE, closePane, openPane } from './dock.js';
import { drawGantt, initGanttPan } from './gantt.js';
import { initGraphSearch } from './gsearch.js';
import { initHeaderMeta } from './header.js';
import { initHelp } from './help.js';
import { mode } from './modes.js';
import { initNotify } from './notify.js';
import { initBuildPicker, initStop, initWsPicker } from './pickers.js';
import { pollState, tickElapsed } from './poller.js';
import { App } from './state.js';
import { initTheme } from './theme.js';
import { $ } from './util.js';
import { initViews } from './views.js';

initTheme();
const deepPkg = initViews();  // a #pkg=... deep link, or null
initPanZoom();
initStop();
initWsPicker();
initBuildPicker();
initGraphSearch();
initGanttPan();
initNotify();
initHelp();
$('#closeAll').onclick = () => {
  for (const name of [...App.panes.keys()]) closePane(name);
  activatePane(BUILD_PANE);
};
$('#sysBtn').onclick = () => document.body.classList.toggle('showsys');
await initHeaderMeta();  // App.cfg must land before the first log render
openPane(BUILD_PANE);  // the pinned whole-build terminal view
if (deepPkg) emit('open-pkg', deepPkg);
pollState();
setInterval(pollState, 1000);
setInterval(pollAllPanes, 1200);
setInterval(tickElapsed, 1000);
addEventListener('resize', () => {
  if (App.view === 'gantt') drawGantt();
  mode().resize?.();
});
