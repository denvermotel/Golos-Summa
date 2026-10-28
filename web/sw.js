/* Golos-Summa service worker: app shell cached for offline use.
   Bump CACHE on every release so clients pick up the new files. */
'use strict';

const CACHE = 'golos-summa-v0.1.1';
const SHELL = [
  './',
  './index.html',
  './app.css',
  './skins.css',
  './engine.js',
  './i18n.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './fonts/archivo-variable.woff2',
  './fonts/courier-prime-400.woff2',
  './fonts/courier-prime-700.woff2',
  './fonts/dseg7-classic-regular.woff2',
  './fonts/dseg7-classic-italic.woff2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

// the page asks for it when the user presses Update
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // App shell: network first so an online user always gets the current
  // files, cache as fallback when offline.
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
