/**
 * Vite-Config fuer die mcp-approval2 PWA.
 *
 * Dev-Server: proxyt `/auth/*`, `/v1/*`, `/oauth/*`, `/mcp*`, `/health` und
 * `/.well-known/*` an den lokalen Hono-Server auf :8787 — damit Cookies &
 * Bearer-Tokens same-origin bleiben.
 */
import { defineConfig } from 'vite';

const SERVER_URL = process.env['SERVER_URL'] ?? 'http://localhost:8787';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/auth': SERVER_URL,
      '/v1': SERVER_URL,
      '/oauth': SERVER_URL,
      '/mcp': SERVER_URL,
      '/health': SERVER_URL,
      '/.well-known': SERVER_URL,
      '/accept-invite': SERVER_URL,
    },
  },
});
