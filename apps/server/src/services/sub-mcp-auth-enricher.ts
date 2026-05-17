/**
 * SubMcpAuthEnricher — injiziert Auth-Header pro Sub-MCP-Server-Type.
 *
 * Plan-Ref: docs/plans/active/PLAN-multiuser-subMcp-auth.md (PfadB + per-User-SA)
 *
 * Konzept: jeder Sub-MCP-Server-Type braucht u.U. zusaetzliche Auth-Header
 * zwischen V2-Hub und Worker, die per-User aus user_sub_mcp_config geholt
 * werden muessen.
 *
 *   - gws  (Google Workspace) → X-Google-Access-Token Header
 *       Quelle: per-User _oauth_client_id + _oauth_client_secret +
 *               _oauth_refresh_token
 *       Flow: refresh Google access-token via token-endpoint, cache 50 min
 *
 *   - gcloud → X-Google-Access-Token + X-GCP-Project-Id Header
 *       Quelle: per-User _service_account_json (1.6 KB JSON, encrypted at-rest)
 *       Flow: lokales JWT-Bearer-Grant via services/google/sa-jwt-bearer.ts,
 *             access_token cached 50 min. Private-Key verlaesst approval2
 *             NICHT mehr im Klartext (Sprint 2026-05-18 — vorher
 *             "x-gcp-sa-json" mit dem rohen JSON-Header, jetzt nur access_token).
 *
 * Worker-Side liest die Header und nutzt sie statt eigener ALLOWED_EMAILS-
 * Lookup. Fallback (V1-Compat): wenn Header fehlt, Worker nutzt Legacy-Pfad.
 *
 * Pool-Hygiene: dieser Service nutzt nur user_sub_mcp_config.getAllValues()
 * (das selbst db.transaction nutzt). Kein direkter db.scoped().
 */
import {
  parseServiceAccountKey,
  requestSaAccessToken,
} from './google/sa-jwt-bearer.js';
import type { UserServerConfigService } from './user-server-config.js';

/** In-memory cache pro (userId, subMcpName) — Google-Access-Token-TTL. */
interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

export interface SubMcpAuthEnricherOpts {
  readonly config: UserServerConfigService;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** Map subMcpName → auth-strategy-kind. Default: hardcoded for gws + gcloud. */
  readonly strategy?: Map<string, AuthStrategy>;
}

export type AuthStrategy = 'google-oauth' | 'gcp-service-account' | 'oauth-bearer' | 'none';

/**
 * Default-Mapping subMcpName → strategy. `oauth-bearer` ist der generische
 * Pfad fuer externe MCP-Server die per OAuth2 access_token authentifizieren
 * (GitHub-MCP, Cloudflare-MCP-Pre-Registered, Notion, ...). Der token-URL
 * kommt pro Server aus sub_mcp_servers.config_schema._meta.oauth.token_url
 * (siehe enrich-Branch unten).
 */
export const DEFAULT_AUTH_STRATEGIES: ReadonlyMap<string, AuthStrategy> = new Map([
  ['gws', 'google-oauth'],
  ['gcloud', 'gcp-service-account'],
  ['github', 'oauth-bearer'],
]);

export interface SubMcpAuthEnricher {
  /**
   * Compute extra HTTP-Headers für outbound forward an einen Sub-MCP.
   * Returns {} wenn der Server kein extra-auth braucht (oder die per-user
   * config nicht gesetzt ist — Worker faellt dann auf Legacy-Pfad zurueck).
   */
  enrich(args: { userId: string; subMcpName: string }): Promise<Record<string, string>>;
  /** Cache invalidieren (z.B. bei Token-Rotation). */
  invalidate(userId: string, subMcpName: string): void;
}

/** Google-Access-Token Lifetime ist 1h. Wir cache 50 min damit Refresh-Headroom da ist. */
const GOOGLE_TOKEN_CACHE_MS = 50 * 60 * 1000;

/**
 * Map: subMcpName → token_endpoint URL fuer OAuth-Bearer-Refresh.
 * GitHub-Apps haben kein Standard-Discovery-Doc, daher hardcoded.
 * Cloudflare-MCP nutzt DCR mit Discovery — landet hier nicht.
 */
const OAUTH_BEARER_TOKEN_ENDPOINTS: ReadonlyMap<string, string> = new Map([
  ['github', 'https://github.com/login/oauth/access_token'],
]);

/** Standard OAuth-Access-Token cache duration. 50 min entspricht GitHub
 *  User-to-Server-Token-TTL (8h) minus Buffer. Andere Provider haben
 *  ggf. kuerzere TTL — der refresh-response-`expires_in` cappt das. */
const OAUTH_BEARER_CACHE_MS = 50 * 60 * 1000;

/**
 * Hilfsfunktion: `_gcp_scopes` aus user-config (space- oder comma-separated)
 * in Array konvertieren. Leer/undefined → undefined (Provider nutzt Defaults).
 */
function parseScopes(raw: string | undefined): ReadonlyArray<string> | undefined {
  if (!raw) return undefined;
  const items = raw.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

export function createSubMcpAuthEnricher(opts: SubMcpAuthEnricherOpts): SubMcpAuthEnricher {
  const { config } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const strategy = opts.strategy ?? DEFAULT_AUTH_STRATEGIES;
  const tokenCache = new Map<string, CachedToken>();

  function cacheKey(userId: string, subMcpName: string): string {
    return `${userId}::${subMcpName}`;
  }

  async function refreshGoogleAccessToken(args: {
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  }): Promise<{ accessToken: string; expiresInSec: number }> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: args.refreshToken,
      client_id: args.clientId,
      client_secret: args.clientSecret,
    });
    const resp = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`google-token-refresh failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
    }
    const json = (await resp.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (json.error || !json.access_token) {
      throw new Error(`google-token-refresh error: ${json.error ?? 'no_access_token'} ${json.error_description ?? ''}`);
    }
    return {
      accessToken: json.access_token,
      expiresInSec: typeof json.expires_in === 'number' ? json.expires_in : 3600,
    };
  }

  return {
    async enrich({ userId, subMcpName }) {
      const strat = strategy.get(subMcpName) ?? 'none';
      if (strat === 'none') return {};

      // Per-User-Config lesen
      let cfgMap: Map<string, string>;
      try {
        cfgMap = await config.getAllValues(userId, subMcpName);
      } catch {
        return {}; // keine config → Worker faellt auf Legacy-Pfad zurueck
      }

      if (strat === 'google-oauth') {
        const refreshToken = cfgMap.get('_oauth_refresh_token');
        const clientId = cfgMap.get('_oauth_client_id');
        const clientSecret = cfgMap.get('_oauth_client_secret');
        if (!refreshToken || !clientId || !clientSecret) {
          return {}; // unvollstaendig — Worker-Legacy-Fallback
        }

        // Cache-Check
        const key = cacheKey(userId, subMcpName);
        const cached = tokenCache.get(key);
        const ts = now();
        if (cached && cached.expiresAt > ts + 60_000) {
          // 1 min safety margin
          return { 'x-google-access-token': cached.token };
        }

        // Refresh
        const refreshed = await refreshGoogleAccessToken({ refreshToken, clientId, clientSecret });
        const expiresAt = ts + Math.min(refreshed.expiresInSec * 1000, GOOGLE_TOKEN_CACHE_MS);
        tokenCache.set(key, { token: refreshed.accessToken, expiresAt });
        return { 'x-google-access-token': refreshed.accessToken };
      }

      if (strat === 'gcp-service-account') {
        const saJson = cfgMap.get('_service_account_json');
        if (!saJson) return {}; // Worker-Legacy-Fallback (eigene SA aus env)

        // Cache-Check (gleiche key-Struktur wie google-oauth, anderer Lebens-
        // zyklus — JWT-Bearer-Grant gibt 3600s zurueck, wir cachen 50 min).
        const key = cacheKey(userId, subMcpName);
        const cached = tokenCache.get(key);
        const ts = now();
        if (cached && cached.expiresAt > ts + 60_000) {
          const projectId = cfgMap.get('_gcp_project_id');
          const headers: Record<string, string> = {
            'x-google-access-token': cached.token,
          };
          if (projectId) headers['x-gcp-project-id'] = projectId;
          return headers;
        }

        // Parse + lokales JWT-Bearer-Grant. Wirft mit klarer Operator-Anleitung
        // wenn SA-JSON kaputt ist.
        let sa: ReturnType<typeof parseServiceAccountKey>;
        try {
          sa = parseServiceAccountKey(saJson);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[enricher] gcp-sa parse failed', {
            subMcpName,
            userId,
            err: err instanceof Error ? err.message : String(err),
          });
          return {}; // Worker faellt auf Legacy-Pfad zurueck.
        }
        // Default-Scope cloud-platform ist breit genug fuer alle gcloud-
        // Worker-Tools (LLM, Storage, Compute). User kann pro-Server
        // _gcp_scopes setzen wenn er enger limitieren will.
        const userScopes = parseScopes(cfgMap.get('_gcp_scopes'));
        let exchanged;
        try {
          exchanged = await requestSaAccessToken({
            sa,
            fetchImpl,
            now,
            ...(userScopes ? { scopes: userScopes } : {}),
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[enricher] gcp-sa token-exchange failed', {
            subMcpName,
            userId,
            err: err instanceof Error ? err.message : String(err),
          });
          return {};
        }
        const expiresAt = ts + Math.min(exchanged.expiresInSec * 1000, GOOGLE_TOKEN_CACHE_MS);
        tokenCache.set(key, { token: exchanged.accessToken, expiresAt });

        // project_id Resolution: User kann _gcp_project_id pro-Server
        // ueberschreiben (z.B. wenn die SA Zugriff auf mehrere Projekte hat).
        // Sonst project_id aus dem SA-JSON.
        const projectId = cfgMap.get('_gcp_project_id') ?? exchanged.projectId;
        const headers: Record<string, string> = {
          'x-google-access-token': exchanged.accessToken,
        };
        if (projectId) headers['x-gcp-project-id'] = projectId;
        return headers;
      }

      if (strat === 'oauth-bearer') {
        const refreshToken = cfgMap.get('_oauth_refresh_token');
        const clientId = cfgMap.get('_oauth_client_id');
        const clientSecret = cfgMap.get('_oauth_client_secret');
        const tokenUrl = OAUTH_BEARER_TOKEN_ENDPOINTS.get(subMcpName);
        // eslint-disable-next-line no-console
        console.info('[enricher] oauth-bearer enrich', {
          subMcpName,
          userId,
          hasRefreshToken: !!refreshToken,
          hasClientId: !!clientId,
          hasClientSecret: !!clientSecret,
          tokenUrl: tokenUrl ?? null,
          configKeys: Array.from(cfgMap.keys()),
        });
        if (!refreshToken || !clientId || !clientSecret || !tokenUrl) {
          // eslint-disable-next-line no-console
          console.warn('[enricher] oauth-bearer skipped: missing pieces', {
            subMcpName,
            userId,
            missing: {
              refreshToken: !refreshToken,
              clientId: !clientId,
              clientSecret: !clientSecret,
              tokenUrl: !tokenUrl,
            },
          });
          return {};
        }
        // Cache-Check
        const key = cacheKey(userId, subMcpName);
        const cached = tokenCache.get(key);
        const ts = now();
        if (cached && cached.expiresAt > ts + 60_000) {
          return { authorization: `Bearer ${cached.token}` };
        }
        // Refresh via Standard-OAuth2-refresh_token-grant.
        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        });
        const resp = await fetchImpl(tokenUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: body.toString(),
        });
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          // eslint-disable-next-line no-console
          console.warn('[enricher] oauth-bearer refresh HTTP error', {
            subMcpName,
            status: resp.status,
            body: errText.slice(0, 300),
          });
          return {};
        }
        const responseText = await resp.text();
        let json: { access_token?: string; expires_in?: number; error?: string };
        try {
          json = JSON.parse(responseText);
        } catch {
          // eslint-disable-next-line no-console
          console.warn('[enricher] oauth-bearer refresh non-JSON response', {
            subMcpName,
            body: responseText.slice(0, 300),
          });
          return {};
        }
        if (!json.access_token || json.error) {
          // eslint-disable-next-line no-console
          console.warn('[enricher] oauth-bearer refresh error in body', {
            subMcpName,
            error: json.error ?? 'no_access_token',
            body: responseText.slice(0, 300),
          });
          return {};
        }
        // eslint-disable-next-line no-console
        console.info('[enricher] oauth-bearer refresh ok', {
          subMcpName,
          expiresIn: json.expires_in,
        });
        const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
        const expiresAt = ts + Math.min(expiresIn * 1000, OAUTH_BEARER_CACHE_MS);
        tokenCache.set(key, { token: json.access_token, expiresAt });
        return { authorization: `Bearer ${json.access_token}` };
      }

      return {};
    },

    invalidate(userId, subMcpName) {
      tokenCache.delete(cacheKey(userId, subMcpName));
    },
  };
}
