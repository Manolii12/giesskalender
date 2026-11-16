/* Service Worker: Offline-Cache, Hintergrund-Prüfung, Klick auf Benachrichtigung */
importScripts('core.js');

const VERSION = 'v2';
const SHELL = `giess-shell-${VERSION}`;
const RUNTIME = `giess-runtime-${VERSION}`;
const SHELL_FILES = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'core.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/badge-96.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Eigene Dateien: erst Netz (damit Updates ankommen), sonst Cache.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
    );
    return;
  }

  // Schriften von Google: Cache zuerst.
  if (url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    event.respondWith(
      caches.open(RUNTIME).then((c) =>
        c.match(req).then((hit) => hit || fetch(req).then((res) => { c.put(req, res.clone()); return res; }))
      )
    );
  }
});

// Android/Chrome (installiert): regelmäßige Hintergrund-Prüfung
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'giess-check') {
    event.waitUntil(Core.checkAndNotify(self.registration));
  }
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'check') {
    event.waitUntil(Core.checkAndNotify(self.registration, { force: !!event.data.force }));
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './', self.location.href).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
