/**
 * Debug-Routen — read-only diagnostics ohne Auth.
 *
 * `/debug/whoami` returnt was der Server vom Request sieht: Header (whitelisted),
 * Cookie-Namen (nicht-Werte), Origin-Resolution, COOKIE_DOMAIN-Anwendbarkeit.
 * Zweck: wenn der Browser-Login hängt, kann der User `curl --cookie-jar`-Style
 * Tests fahren und sehen was der Server sieht — ohne DevTools.
 *
 * Sicherheits-Note: keine Secrets/Cookie-Werte. Header-Whitelist statisch.
 * Aktivierung per env `DEBUG_ROUTES=on` damit das in unwichtiger prod nicht
 * default-an ist.
 */
import { Hono } from 'hono';
import type { AppBindings, ServerContext } from '../lib/context.js';
import { resolveOrigin, resolveRpId } from '../lib/config.js';

const SAFE_HEADERS = [
  'host',
  'origin',
  'referer',
  'user-agent',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'fly-client-ip',
  'fly-region',
  'accept',
];

export function debugRoutes(server: ServerContext) {
  const app = new Hono<AppBindings>();

  app.get('/debug/whoami', (c) => {
    const cookieHeader = c.req.header('cookie') ?? '';
    const cookieNames = cookieHeader
      .split(';')
      .map((p) => p.trim().split('=')[0])
      .filter(Boolean);
    const headers: Record<string, string> = {};
    for (const h of SAFE_HEADERS) {
      const v = c.req.header(h);
      if (v) headers[h] = v;
    }
    const requestOrigin = resolveOrigin(c.req.raw, server.config);
    const cookieDomain = server.config.COOKIE_DOMAIN || '';
    let originHost = '';
    try {
      originHost = new URL(requestOrigin).hostname;
    } catch {
      /* */
    }
    const cd = cookieDomain.replace(/^\./, '');
    const cookieDomainApplies =
      !!cookieDomain && (originHost === cd || originHost.endsWith(`.${cd}`));

    return c.json({
      requestId: c.get('requestId'),
      url: c.req.url,
      method: c.req.method,
      headers,
      cookieNames,
      cookieCount: cookieNames.length,
      resolved: {
        requestOrigin,
        configOrigin: server.config.ORIGIN,
        rpOrigin: server.config.RP_ORIGIN,
        configRpId: server.config.RP_ID,
        resolvedRpId: resolveRpId(requestOrigin, server.config),
        cookieDomain,
        cookieDomainApplies,
        allowedOrigins: server.config.ALLOWED_ORIGINS,
      },
    });
  });

  return app;
}
