export const App = {
  buildId: null,
  graph: null,          // /api/graph packages
  prev: null,           // /api/graph prev: the previous run's durations
  graphJobCount: 0,
  lastGraphFetch: 0,
  pkgs: {},             // /api/state packages
  active: false,
  total: 0,
  workspace: '',        // absolute path, from /api/state
  cfg: null,            // /api/config: version, editor_url
  scope: 'build',       // 'build' | 'all'
  view: 'graph',
  ganttFollow: true,
  layoutMode: localStorage.getItem('cmc-layout') || 'layered',
  prefix: '',
  lay: null,
  nodeEls: new Map(),
  edgeList: [],
  adjIn: new Map(),
  adjOut: new Map(),
  vb: null,             // graph viewBox
  elapsedBase: 0, elapsedAt: 0, buildStarted: 0,
  failedSeen: new Set(),
  panes: new Map(),
  activePane: null,
  pollTick: 0,
};
