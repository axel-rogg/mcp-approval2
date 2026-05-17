/**
 * /admin/kc-proxy/* — PWA-to-KC2-Same-Origin-Proxy.
 *
 * Plan-Ref: PLAN-as3-autonomous.md §1.3 (kc-proxy-Code-Beispiel).
 *
 * Zweck:
 *   - Browser-PWA (im selben Origin wie approval2) spricht KC2 nicht direkt
 *     (anders Origin → CORS-Komplexitaet + Token-Sharing-Risk).
 *   - Statt CORS-Setup: PWA macht alle Storage-Calls gegen
 *     `/admin/kc-proxy/<KC2-path>` same-origin. approval2 verifiziert die
 *     Cookie-Session, baut OBO-JWT, forwarded an KC2 als
 *     `Authorization: Bearer <SERVICE_TOKEN>` + `X-On-Behalf-Of: <OBO-JWT>`.
 *
 * Auth-Modell:
 *   - Cookie `session_jwt` ODER Bearer-Header → User-Principal aufloesen.
 *   - Keine Approval-Wall hier: das ist same-origin PWA, kein MCP-Client.
 *     State-changing Calls aus der PWA werden serverseitig via PWA-Tool-
 *     Surface gefuehrt; PWA-Direkt-Edits an objects sind Read+Update fuer
 *     den eigenen User (RLS gilt KC2-side).
 *
 * Fail-graceful:
 *   - Ohne `MCP_KNOWLEDGE_URL` + `MCP_KNOWLEDGE_SERVICE_TOKEN` wird die
 *     Route NICHT gemountet (Hono returnt 404). createApp() liest die
 *     Felder, mountet nur bei Vollkonfig.
 *
 * Anti-Pattern (was wir NICHT machen):
 *   - Wir leiten KEINE Response-Headers an die PWA durch (insb. NICHT
 *     `set-cookie` — KC2's cookie wuerde sonst im PWA-Origin landen).
 *   - Wir leiten KEINE Query-Strings ueber das KC2-Reservoir hinaus
 *     ohne URL-Encoding-Roundtrip.
 *   - Wir streamen NICHT — Phase-1 buffered, ist fuer JSON-Objects
 *     <100 KB ausreichend.
 *
 * Anti-Open-Redirect / Anti-SSRF:
 *   - Pfad wird auf `/v1/*` und `/admin/*` (KC2-side) eingeschraenkt.
 *     Alles ausserhalb → 404. Verhindert dass jemand
 *     `/admin/kc-proxy/../../weird` ausnutzt.
 */
import { Hono } from 'hono';
import type { AppBindings, ServerContext, SessionPrincipal } from '../lib/context.js';
import { HttpError } from '../lib/errors.js';
import { verifySessionJwt } from '../auth/session/issuer.js';
import { effectiveOauthIssuer } from '../schema/env.js';
import { makeRs256Signer } from '../services/knowledge.js';
import { getSigningKey } from '../auth/jwt-signing.js';

export interface KcProxyDeps {
  /**
   * Pflicht — KC2-Base-URL ohne trailing-slash (z.B. `https://knowledge.firma.de`).
   */
  readonly knowledgeUrl: string;
  /** Pflicht — SERVICE_TOKEN fuer S2S-Bearer. */
  readonly serviceToken: string;
  /** Optional Override fuer Tests: fertig-konfigurierter Signer-Stub. */
  readonly signerOverride?: import('@mcp-approval2/adapters').JwtSigner;
  /** Optional fetch-Override fuer Tests. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Whitelist KC2-Path-Prefixes die die PWA proxyen darf. Defense-in-Depth
 * gegen Pfad-Traversal + unbeabsichtigte KC2-internal-Routes-Exposure.
 *
 * SEC-011: `/admin/` wurde entfernt. PWA darf KC2-Admin nicht via Proxy
 * ansprechen — Admin-Aktionen laufen ueber separate first-party PWA-Routen
 * die durch die approval2-Approval-Wall gehen (kein Cookie-CSRF-Pfad).
 */
const ALLOWED_PATH_PREFIXES = ['/v1/'];

/**
 * Headers die NIE an die PWA zurueckgereicht werden — KC2-side Cookies
 * sind ein No-Go (Cookie-Domain-Mismatch, Session-Leak).
 */
const FORBIDDEN_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'set-cookie2',
  'www-authenticate',
  'transfer-encoding',
  'connection',
]);

// Note: wir bauen die Outbound-Headers fresh (Auth + content-type + accept +
// x-request-id + x-on-behalf-of). Wir leiten KEINE inbound headers durch —
// Defense-in-Depth, kein Header-Smuggling-Risk via cookie/origin/host.

export function kcProxyRoutes(server: ServerContext, deps: KcProxyDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const baseUrl = deps.knowledgeUrl.replace(/\/+$/, '');
  const fetchImpl = deps.fetchImpl ?? fetch;

  // Signer wird lazy beim ersten Call gebaut — verschiebt den
  // PEM-import bis nach dem Boot (preflightJwtKeys hat ihn eh schon
  // einmal geladen → CryptoKey-Cache hit).
  let signerCache: Promise<import('@mcp-approval2/adapters').JwtSigner> | null = null;
  const getSigner = async (): Promise<import('@mcp-approval2/adapters').JwtSigner> => {
    if (deps.signerOverride) return deps.signerOverride;
    if (signerCache) return signerCache;
    signerCache = (async () => {
      const pem = process.env['JWT_RS256_PRIVATE_KEY_PEM'] ?? process.env['JWT_PRIVATE_KEY'];
      if (!pem) {
        throw new HttpError(500, 'internal',
          'kc-proxy: JWT_RS256_PRIVATE_KEY_PEM not configured — cannot sign OBO',
        );
      }
      const signingEnv: { JWT_RS256_PRIVATE_KEY_PEM: string; JWT_KID?: string } = {
        JWT_RS256_PRIVATE_KEY_PEM: pem,
      };
      if (process.env['JWT_KID']) signingEnv.JWT_KID = process.env['JWT_KID'];
      const privateKey = await getSigningKey(signingEnv);
      if (!privateKey) {
        throw new HttpError(500, 'internal','kc-proxy: failed to load private key');
      }
      const issuer = effectiveOauthIssuer({
        ORIGIN: server.config.ORIGIN,
        ...(server.config.SELF_OAUTH_ISSUER !== undefined
          ? { SELF_OAUTH_ISSUER: server.config.SELF_OAUTH_ISSUER }
          : {}),
      });
      const kid = process.env['JWT_KID'];
      return makeRs256Signer({
        privateKey,
        issuer,
        audience: 'mcp-knowledge2',
        ...(kid ? { kid } : {}),
      });
    })();
    return signerCache;
  };

  // Catch-all → forward.
  app.all('/admin/kc-proxy/*', async (c) => {
    // SEC-011: Origin-Header-Allowlist als CSRF-Defense. Same-site-Cookies
    // wuerden Cross-Subdomain-Calls von z.B. attacker-controlled
    // dev-preview.ai-toolhub.org durchlassen — wir lehnen jede Origin ab
    // die nicht in der Allowlist steht. Same-origin-Calls (Origin == ORIGIN
    // oder Origin-fehlend wie bei direct-API-Tool-Calls) sind erlaubt.
    const originHeader = c.req.header('origin');
    if (originHeader) {
      const allowed = new Set<string>([
        server.config.RP_ORIGIN,
        server.config.ORIGIN,
        ...server.config.ALLOWED_ORIGINS,
      ]);
      if (!allowed.has(originHeader)) {
        throw HttpError.forbidden('forbidden', `kc-proxy: origin not allowed: ${originHeader}`);
      }
    }

    const principal = await resolvePrincipal(c, server);
    if (!principal) {
      throw HttpError.unauthorized('login_required');
    }

    // Pfad nach dem Prefix extrahieren.
    const fullPath = new URL(c.req.url).pathname;
    const PREFIX = '/admin/kc-proxy';
    if (!fullPath.startsWith(`${PREFIX}/`)) {
      // Hono routing-Trick: '/admin/kc-proxy/*' matched auch '/admin/kc-proxy' selbst.
      throw HttpError.notFound('kc-proxy: empty target path');
    }
    const targetPath = fullPath.slice(PREFIX.length);

    // Whitelist-Pruefung. SEC-011: /admin/ ist nicht mehr in der Liste.
    if (!ALLOWED_PATH_PREFIXES.some((p) => targetPath.startsWith(p))) {
      throw HttpError.notFound(`kc-proxy: target path not allowed: ${targetPath}`);
    }
    // Pfad-Traversal-Schutz: keine `..`-Segmente, weder roh noch URL-
    // encoded. SEC-011: decodeURIComponent-Roundtrip damit z.B. `%2E%2E`
    // nicht durch den simplen string-includes-Check schluepft.
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(targetPath);
    } catch {
      throw HttpError.badRequest('invalid_request', 'kc-proxy: invalid url-encoding in path');
    }
    const segments = decodedPath.split('/');
    if (segments.includes('..') || segments.includes('.')) {
      throw HttpError.badRequest('invalid_request', 'kc-proxy: path traversal denied');
    }
    // Authority-Injection-Schutz: verifizieren dass `targetPath` keinen
    // anderen Host injiziert (z.B. `//attacker.com/x` waere bei naivem
    // URL-Resolve gegen base zu attacker.com aufgeloest).
    const targetCandidate = new URL(targetPath, `${baseUrl}/`);
    if (targetCandidate.origin !== new URL(baseUrl).origin) {
      throw HttpError.badRequest(
        'invalid_request',
        'kc-proxy: authority injection denied',
      );
    }

    // OBO-JWT bauen.
    const reqId =
      c.req.header('x-request-id') ?? c.get('requestId') ?? randomRequestId();
    const signer = await getSigner();
    const oboToken = await signer.signOBO({
      sub: principal.userId,
      aud: 'mcp-knowledge2',
      on_behalf_of: principal.email,
      request_id: reqId,
      ttlSec: 60,
    });

    // Request-Body durchschleifen (alle Methoden ausser GET/HEAD).
    const method = c.req.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const bodyText = hasBody ? await c.req.text() : undefined;

    // Header-Filter.
    const headers: Record<string, string> = {
      authorization: `Bearer ${deps.serviceToken}`,
      'x-on-behalf-of': oboToken,
      'x-request-id': reqId,
      accept: c.req.header('accept') ?? 'application/json',
    };
    if (hasBody) {
      headers['content-type'] = c.req.header('content-type') ?? 'application/json';
    }

    // Query-String mitnehmen.
    const url = new URL(`${baseUrl}${targetPath}`);
    const inUrl = new URL(c.req.url);
    inUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));

    // Forward.
    const init: RequestInit = {
      method,
      headers,
    };
    if (hasBody && bodyText !== undefined) {
      init.body = bodyText;
    }

    let upstream: Response;
    try {
      upstream = await fetchImpl(url.toString(), init);
    } catch (err) {
      throw new HttpError(
        502,
        'internal',
        `kc-proxy: upstream fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Response-Headers filtern + bauen.
    const respHeaders = new Headers();
    upstream.headers.forEach((v, k) => {
      if (!FORBIDDEN_RESPONSE_HEADERS.has(k.toLowerCase())) {
        respHeaders.set(k, v);
      }
    });
    // x-request-id zurueckspiegeln fuer Audit-Korrelation.
    if (!respHeaders.has('x-request-id')) {
      respHeaders.set('x-request-id', reqId);
    }

    // 204 → leerer body.
    if (upstream.status === 204) {
      return new Response(null, { status: 204, headers: respHeaders });
    }
    const upstreamBody = await upstream.arrayBuffer();
    return new Response(upstreamBody, {
      status: upstream.status,
      headers: respHeaders,
    });
  });

  return app;
}

/**
 * Loest den User-Principal aus dem Bearer-Header auf.
 *
 * SEC-011: Cookie-Fallback wurde entfernt. Damit kann eine andere
 * Subdomain unter `*.ai-toolhub.org` (zukuenftige Pilot-Instance,
 * Marketing-Page, dev-preview) NICHT mehr cross-origin POST/PATCH/DELETE
 * auf `/admin/kc-proxy/*` machen + den same-site-Cookie ausnutzen. PWA
 * muss expliziten `Authorization`-Header senden (wie `/v1/*` schon).
 */
async function resolvePrincipal(
  c: { req: { header: (n: string) => string | undefined; url: string } },
  server: ServerContext,
): Promise<SessionPrincipal | null> {
  const header = c.req.header('authorization');
  let token: string | null = null;
  if (header && header.toLowerCase().startsWith('bearer ')) {
    token = header.slice(7).trim();
  }
  if (!token) return null;
  try {
    return await verifySessionJwt(token, server.config);
  } catch {
    return null;
  }
}

function randomRequestId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  const rand = () => Math.floor(Math.random() * 0xffff_ffff).toString(16);
  return `req-${Date.now().toString(16)}-${rand()}`;
}
