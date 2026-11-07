/* ---------------- the service worker ----------------
   With it, a browser can install the dashboard as an app with its own
   window, and the app shows offline.html when the server does not answer.
   It keeps only the offline page and its logos. Every other request goes
   to the network as before, so a server update never meets a stale copy.
   This file is not an ES module: the browser runs it apart from the page. */

const CACHE = 'colcon-dashboard-offline';
const FILES = ['offline.html', 'logo.svg', 'logo-dark.svg'];

const refresh = () => caches.open(CACHE).then(c => c.addAll(FILES));

self.addEventListener('install', ev => {
  ev.waitUntil(refresh().then(() => self.skipWaiting()));
});

self.addEventListener('activate', ev => {
  ev.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const OWN = new Set(FILES.map(f => new URL(f, self.registration.scope).href));

self.addEventListener('fetch', ev => {
  if (OWN.has(ev.request.url)) {  // the offline page's logos: the cache when offline
    ev.respondWith(fetch(ev.request).catch(() => caches.match(ev.request)));
    return;
  }
  if (ev.request.mode !== 'navigate') return;  // the API and the files: untouched
  ev.respondWith(fetch(ev.request).then(
    res => {
      // the server answers: keep the offline page as new as the server
      ev.waitUntil(refresh().catch(() => {}));
      return res;
    },
    () => caches.match('offline.html')));
});
