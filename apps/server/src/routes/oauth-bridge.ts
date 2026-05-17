/**
 * /oauth/sub-mcp-callback — RFC-konformer Server-side Bridge fuer
 * Sub-MCP-Gateway OAuth-Flows (z.B. GitHub-App, andere externe MCPs).
 *
 * Hintergrund:
 *   Die PWA generiert in `apps/web/src/server-config.ts` ihre eigene
 *   Callback-URL als Hash-Route:
 *     `https://app2.ai-toolhub.org/#/tools/servers/<name>/oauth/callback`
 *
 *   Das ist client-side-clever (Hash bleibt im Browser, PWA-Routing klappt),
 *   aber RFC 6749 §3.1.2 verbietet Fragments in der redirect_uri. GitHub-
 *   Apps + diverse Enterprise-Provider rejecten beim strict-match. Selbst
 *   wenn sie es akzeptieren ist es brittle.
 *
 * Diese Route:
 *   1. Wird in der GitHub-App als Callback registriert:
 *        `https://<origin>/oauth/sub-mcp-callback`
 *      (eine pro Origin — die PWA waehlt zur Laufzeit die aktuelle).
 *   2. GitHub redirected hierher mit `?code=...&state=...` (+ ggf.
 *      `installation_id` etc fuer GitHub-Apps).
 *   3. Wir 302-redirecten weiter zur PWA-Hash-Route, mit allen Query-
 *      Params durchgereicht. Die PWA macht dann ihren existing-flow
 *      (POST /v1/me/servers/:name/oauth/callback).
 *
 * Anti-Open-Redirect:
 *   - `?name`-Parameter wird strikt validiert (alphanumeric + `-` + `_`,
 *     max 64 chars).
 *   - Die Ziel-Origin ist die aktuelle Request-Origin (kein User-Input).
 *
 * Auth-Mode:
 *   - Diese Route ist OEFFENTLICH erreichbar — GitHub muss ohne Cookie
 *     callback'en koennen. Der eigentliche State-Check + Code-Exchange
 *     passiert spaeter in /v1/me/servers/:name/oauth/callback (auth-
 *     middleware + state-validation in DB).
 *   - Wir leiten lediglich um. Kein Side-Effect, keine DB-Mutation.
 */
import { Hono } from 'hono';
import type { AppBindings, ServerContext } from '../lib/context.js';

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export function oauthBridgeRoutes(_server: ServerContext): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get('/oauth/sub-mcp-callback', (c) => {
    const url = new URL(c.req.url);
    const name = url.searchParams.get('name') ?? '';
    // Defense: Name validieren bevor wir ihn in die PWA-URL hineinpacken
    // (sonst beliebige Hash-Route exploitable als Open-Redirect-Vehicle —
    // zwar im selben Origin, aber XSS-vermeidung).
    if (!NAME_RE.test(name)) {
      return c.text('invalid name', 400);
    }
    // Alle anderen Query-Params (code, state, error, error_description,
    // installation_id, setup_action, ...) 1:1 weiterreichen.
    const fwd = new URLSearchParams();
    for (const [k, v] of url.searchParams.entries()) {
      if (k === 'name') continue;
      fwd.append(k, v);
    }
    // Origin re-konstruieren: hinter Fly-Proxy ist `c.req.url` interner
    // http://-Hostname. X-Forwarded-Proto / Host vom Edge bevorzugen,
    // sonst Fallback auf c.req.url-Origin.
    const fwdProto = c.req.header('x-forwarded-proto') ?? '';
    const fwdHost = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? '';
    const scheme = fwdProto === 'https' || fwdProto === 'http' ? fwdProto : 'https';
    const host = fwdHost || url.host;
    const targetOrigin = `${scheme}://${host}`;
    const target = `${targetOrigin}/#/tools/servers/${encodeURIComponent(name)}/oauth/callback?${fwd.toString()}`;
    return c.redirect(target, 302);
  });

  return app;
}
