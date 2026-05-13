/**
 * mcp-approval2 Service-Worker.
 *
 * Strategy:
 *   - Static assets (HTML/CSS/JS/SVG/manifest) → cache-first (offline-friendly
 *     for the app shell)
 *   - API calls (/auth/*, /v1/*, /oauth/*, /mcp*, /health, /.well-known/*)
 *     → network-only (we never want stale credentials/approvals)
 *
 * Bump CACHE_VERSION whenever the asset list changes; the activate-step
 * purges old caches.
 */

const CACHE_VERSION = 'mcp-approval2-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.svg',
];

const API_PREFIXES = ['/auth/', '/v1/', '/oauth/', '/mcp', '/health', '/.well-known/', '/internal/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .catch(() => {
        // best-effort — install must not fail on offline
      }),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API responses
  if (API_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    event.respondWith(fetch(req));
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // Refresh-in-background
        event.waitUntil(
          fetch(req)
            .then((res) => {
              if (res && res.ok) {
                const clone = res.clone();
                caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
              }
            })
            .catch(() => {}),
        );
        return cached;
      }
      return fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(
          () =>
            new Response('Offline', {
              status: 503,
              statusText: 'Offline',
              headers: { 'content-type': 'text/plain' },
            }),
        );
    }),
  );
});
