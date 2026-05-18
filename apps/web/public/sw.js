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

// Bump bei jedem PWA-Asset-Update. Activate-Hook purged alle Caches mit
// anderem Key, install-Hook precached die STATIC_ASSETS-Liste neu.
const CACHE_VERSION = 'mcp-approval2-v13-2026-05-18-gcloud-config-fields';

// index.html / '/' bewusst NICHT precached — sie werden network-first geholt,
// damit Vite-Builds mit neuen Asset-Hash-Verweisen sofort sichtbar werden.
// Cache-first fuer hashed assets (Vite-Build legt assets/index-<hash>.{js,css}
// an — immutable by design, also Cache-first sicher).
const STATIC_ASSETS = [
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

// ---------------------------------------------------------------------------
// Push notifications (Burst 7).
//
// Server sends JSON-encoded `{ title, body, tag?, url? }` payloads (RFC 8291
// encrypted body). If decryption fails (event.data missing), we ignore the
// event silently. tag-based deduplication is delegated to the browser.
// ---------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data = {};
  try {
    data = event.data.json();
  } catch {
    try {
      data = { title: 'mcp-approval2', body: event.data.text() };
    } catch {
      return;
    }
  }
  const title = data.title || 'mcp-approval2';
  const opts = {
    body: data.body || '',
    icon: '/icon-192.svg',
    badge: '/icon-192.svg',
  };
  if (data.tag) opts.tag = data.tag;
  if (data.url) opts.data = { url: data.url };

  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data && event.notification.data.url;
  const url = target || '/';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientsArr) => {
        // Re-use an existing window if one matches the target origin.
        for (const c of clientsArr) {
          if (c.url.includes(self.location.origin) && 'focus' in c) {
            c.focus();
            try {
              c.navigate(url);
            } catch {
              // ignore — some browsers don't allow navigate from SW
            }
            return undefined;
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
        return undefined;
      }),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Navigation-Requests (top-level browsing) NIE abfangen. Wenn der Server
  // einen 302-Redirect returnt (OAuth-Callback: /auth/google/callback →
  // 302 zu /), wird der mit redirect=manual-mode zu einer opaque-redirect-
  // Response — die der Browser dann nicht folgt. Resultat: TypeError
  // "Failed to fetch" + Browser haengt. Fix: SW gibt navigation-requests
  // komplett an den Browser zurueck — der kann 302-Chains nativ handlen.
  if (req.mode === 'navigate') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API responses
  if (API_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    event.respondWith(fetch(req));
    return;
  }

  // Network-first fuer index.html / '/' — vermeidet Stale-Shell-Bug bei dem
  // ein gecachter index.html auf alte (404'ende) Asset-Hashes verweist.
  // Cache nur als Offline-Fallback.
  if (url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || new Response('Offline', { status: 503 }))),
    );
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
