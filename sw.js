/**
 * Offline support. Network first, so a new deploy shows up on the next visit;
 * the cache is only used when the network is unavailable.
 */

const CACHE = "frequencier-v3";
const FILES = [
  "./",
  "index.html",
  "css/app.css",
  "js/app.js",
  "js/audio.js",
  "js/library.js",
  "js/visualizer.js",
  "database/frequencies.json",
  "icons/icon.svg",
  "manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});
