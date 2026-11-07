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
import { startStatePolling, tickElapsed } from './poller.js';
import { initSettings } from './settings.js';
import { App } from './state.js';
import { initTheme } from './theme.js';
import { $, mirrorPressed } from './util.js';
import { initViews } from './views.js';

initTheme();
mirrorPressed();
const deepPkg = initViews();  // a #pkg=... deep link, or null
initPanZoom();
initStop();
initWsPicker();
initBuildPicker();
initGraphSearch();
initGanttPan();
initNotify();
initHelp();
initSettings();
$('#closeAll').onclick = () => {
  for (const name of [...App.panes.keys()]) closePane(name);
  activatePane(BUILD_PANE);
};
$('#sysBtn').onclick = () => document.body.classList.toggle('showsys');
await initHeaderMeta();  // App.cfg must land before the first log render
openPane(BUILD_PANE);  // the pinned whole-build terminal view
if (deepPkg) emit('open-pkg', deepPkg);
startStatePolling();
setInterval(pollAllPanes, 1200);
setInterval(tickElapsed, 1000);
addEventListener('resize', () => {
  if (App.view === 'gantt') drawGantt();
  mode().resize?.();
});
// the service worker makes the page installable as an app (sw.js); browsers
// offer it only on localhost or https, where navigator.serviceWorker exists
navigator.serviceWorker?.register('sw.js').catch(() => { /* not installable */ });
// an installed app focuses its open window, not a new one (the manifest's
// launch_handler): a workspace link that launched it arrives here
window.launchQueue?.setConsumer(params => {
  const target = params.targetURL && new URL(params.targetURL);
  if (target && target.search && target.search !== location.search) location.href = target.href;
});
