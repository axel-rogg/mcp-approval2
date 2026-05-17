/**
 * /oauth/sub-mcp-callback — RFC-konformer Server-side Bridge fuer
 * Sub-MCP-Gateway OAuth-Flows (z.B. GitHub-App, andere externe MCPs).
 *
 * Hintergrund:
 *   Die PWA generierte fruher ihre eigene Callback-URL als Hash-Route:
 *     `https://app2.ai-toolhub.org/#/tools/servers/<name>/oauth/callback`
 *   RFC 6749 §3.1.2 verbietet Fragments — GitHub-Apps rejected mit
 *   "Url must be a valid URL". Ausserdem verlangen einige Provider strikt-
 *   string-Match der redirect_uri inklusive Query, also kein `?name=X`.
 *
 * Diese Bridge:
 *   1. Registriert in GitHub-App als simpler Callback (eine pro Origin):
 *        https://mcp-approval2.fly.dev/oauth/sub-mcp-callback
 *        https://mcp2.ai-toolhub.org/oauth/sub-mcp-callback
 *        https://app2.ai-toolhub.org/oauth/sub-mcp-callback
 *      KEIN Query-Param, KEIN `#`, KEIN server-name im Pfad.
 *   2. GitHub redirected hierher mit `?code=...&state=...`.
 *   3. Wir lesen `state` (CSRF-token, generiert vom OAuth-Start-Endpoint),
 *      schlagen in user_sub_mcp_oauth_state den sub_mcp_name nach.
 *   4. 302-redirected zur PWA-Hash-Route mit code+state als query.
 *   5. PWA macht POST /v1/me/servers/:name/oauth/callback {state, code}.
 *
 * Anti-Open-Redirect:
 *   - `state` muss in DB existieren (sonst 400). Damit ist `name`
 *     server-vouched, nicht User-Input.
 *   - Ziel-Origin ist die aktuelle Request-Origin (kein User-Input).
 *
 * Auth-Mode:
 *   - Diese Route ist OEFFENTLICH erreichbar — GitHub muss ohne Cookie
 *     callback'en koennen. Der eigentliche Code-Exchange passiert spaeter
 *     in /v1/me/servers/:name/oauth/callback (auth-middleware).
 *   - Wir leiten lediglich um. Kein Side-Effect ausser dem DB-Read.
 */
import { Hono } from 'hono';
import type { AppBindings, ServerContext } from '../lib/context.js';
import { baseLogger as logger } from '../lib/logger.js';

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const STATE_RE = /^[A-Za-z0-9_-]{8,256}$/;

export function oauthBridgeRoutes(server: ServerContext): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get('/oauth/sub-mcp-callback', async (c) => {
    const url = new URL(c.req.url);
    const code = url.searchParams.get('code') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const error = url.searchParams.get('error') ?? '';
    logger.info(
      {
        event: 'oauth.bridge.hit',
        hasCode: code.length > 0,
        hasState: state.length > 0,
        error: error || null,
        host: c.req.header('x-forwarded-host') ?? c.req.header('host') ?? null,
        proto: c.req.header('x-forwarded-proto') ?? null,
      },
      'oauth-bridge incoming callback',
    );

    // Origin re-konstruieren fuer den 302-Target.
    const fwdProto = c.req.header('x-forwarded-proto') ?? '';
    const fwdHost = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? '';
    const scheme = fwdProto === 'https' || fwdProto === 'http' ? fwdProto : 'https';
    const host = fwdHost || url.host;
    const targetOrigin = `${scheme}://${host}`;

    // GitHub kann auch mit `error=...` zurueckkommen (User-cancelled,
    // app-installation-failed). Wir leiten den Error transparent weiter
    // zur PWA — kein DB-Lookup noetig falls error.
    if (error && !state) {
      const fwd = new URLSearchParams();
      for (const [k, v] of url.searchParams.entries()) fwd.append(k, v);
      const target = `${targetOrigin}/#/tools/servers/unknown/oauth/callback?${fwd.toString()}`;
      return c.redirect(target, 302);
    }

    // State muss vorhanden + shape-valid sein (string aus randomBytes-base64url).
    if (!STATE_RE.test(state)) {
      logger.warn({ event: 'oauth.bridge.invalid_state', stateLen: state.length }, 'rejected');
      return c.text('invalid or missing state', 400);
    }

    // sub_mcp_name aus DB via state-Lookup. Pflicht: PG hat state als PK
    // in user_sub_mcp_oauth_state mit sub_mcp_name. Wir lesen nur READ —
    // der eigentliche Consume (DELETE) passiert spaeter in
    // /v1/me/servers/:name/oauth/callback.
    let name: string;
    try {
      // unsafe() weil dieser Endpoint OEFFENTLICH ist (GitHub-Callback ohne
      // Cookie/Session) — kein User-Kontext fuer RLS-scoped() vorhanden.
      // Wir lesen nur die TTL-state-Row die der User selbst angelegt hat
      // (per oauthSvc.start). Side-Effect-frei.
      const rows = await server.db
        .unsafe('oauth-bridge: lookup sub_mcp_name by state for callback redirect')
        .query<{ sub_mcp_name: string }>(
          `SELECT sub_mcp_name FROM user_sub_mcp_oauth_state
           WHERE state = $1 AND expires_at > $2 LIMIT 1`,
          [state, Date.now()],
        );
      const row = rows[0];
      if (!row) {
        logger.warn(
          { event: 'oauth.bridge.state_not_found', stateLen: state.length },
          'no matching oauth_state row',
        );
        return c.text('state not found or expired', 400);
      }
      name = row.sub_mcp_name;
    } catch (err) {
      logger.error(
        { event: 'oauth.bridge.db_error', err: (err as Error).message },
        'state lookup failed',
      );
      return c.text('internal error', 500);
    }

    if (!NAME_RE.test(name)) {
      // Server-Side eigenes Daten kaputt — schliesslich war es DB-vouched.
      logger.error({ event: 'oauth.bridge.bad_db_name', name }, 'malformed name in DB');
      return c.text('internal error', 500);
    }

    // Forward: alle Query-Params 1:1 (code, state, error, error_description,
    // installation_id, setup_action, ...).
    const fwd = new URLSearchParams();
    for (const [k, v] of url.searchParams.entries()) fwd.append(k, v);
    const target = `${targetOrigin}/#/tools/servers/${encodeURIComponent(name)}/oauth/callback?${fwd.toString()}`;
    logger.info(
      { event: 'oauth.bridge.redirect', name, targetLen: target.length },
      'redirecting to PWA',
    );
    return c.redirect(target, 302);
  });

  return app;
}
