/* Tiny pub/sub: modules communicate through events instead of importing
   each other sideways. emit() runs subscribers synchronously, in
   subscription order.

   Events:
     state (s)                a /api/state poll landed, App is updated
     graph                    a /api/graph fetch landed, App.graph is updated
     build-changed (s, first) the page follows a new build id
     pkg-failed (name)        a package newly turned failed
     open-pkg (name)          request: open this package's log pane
     focus-pkg (name)         request: fly the view to this package
     analyze-pkg (pkg, q?)    request: start or continue an AI analysis
     theme-changed            the color theme was applied */

const listeners = new Map();

export function on(event, fn) {
  let subs = listeners.get(event);
  if (!subs) listeners.set(event, subs = []);
  subs.push(fn);
}

export function emit(event, ...args) {
  for (const fn of listeners.get(event) || []) fn(...args);
}
