export const App = {
  buildId: null,
  graph: null,          // /api/graph packages
  prev: null,           // /api/graph prev: the previous run's durations
  cmp: null,            // the run that the timeline compares with (gantt.js)
  graphJobCount: 0,
  lastGraphFetch: 0,
  pkgs: {},             // /api/state packages
  active: false,
  total: 0,
  workspace: '',        // absolute path, from /api/state
  remote: null,         // remote target metadata, or null for a local workspace
  capabilities: {},     // optional workspace operations supported by the server
  runRoot: '',          // where colcon ran, when not here: /ws in a container
  cfg: null,            // /api/config: version, editor_url
  scope: 'build',       // 'build' | 'all'
  view: 'graph',
  ganttFollow: true,
  layoutMode: localStorage.getItem('cmc-layout') || 'layered',
  prefixes: [],         // label prefixes to hide (graph.js computePrefix)
  prefixMode: 'auto',
  prefixAuto: '',
  prefixKept: '',       // the common prefix that auto mode keeps: the rest is too short
  prefixCands: [],
  prefixTotal: 0,
  lay: null,
  edgeList: [],
  adjIn: new Map(),
  adjOut: new Map(),
  vb: null,             // graph viewBox
  selected: new Set(),  // selected packages: their chains stay in focus
  selStep: false,       // a step of the find-package box made the selection
  elapsedBase: 0, elapsedAt: 0, buildStarted: 0,
  failedSeen: new Set(),
  panes: new Map(),
  activePane: null,
  pollTick: 0,
};
