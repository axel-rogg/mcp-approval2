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
 *       Quelle: per-User _oauth_client_id + _oauth_client_secret + _oauth_refresh_token
 *       Flow: refresh Google access-token via token-endpoint, cache 50 min
 *
 *   - gcloud → X-GCP-SA-JSON Header
 *       Quelle: per-User _service_account_json (1.6 KB JSON)
 *       Flow: dekrypten, direkt als Header senden (kein Refresh noetig — SA-JSON ist long-lived)
 *
 * Worker-Side liest die Header und nutzt sie statt eigener ALLOWED_EMAILS-
 * Lookup. Fallback (V1-Compat): wenn Header fehlt, Worker nutzt Legacy-Pfad.
 *
 * Pool-Hygiene: dieser Service nutzt nur user_sub_mcp_config.getAllValues()
 * (das selbst db.transaction nutzt). Kein direkter db.scoped().
 */
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

export type AuthStrategy = 'google-oauth' | 'gcp-service-account' | 'none';

export const DEFAULT_AUTH_STRATEGIES: ReadonlyMap<string, AuthStrategy> = new Map([
  ['gws', 'google-oauth'],
  ['gcloud', 'gcp-service-account'],
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
        return { 'x-gcp-sa-json': saJson };
      }

      return {};
    },

    invalidate(userId, subMcpName) {
      tokenCache.delete(cacheKey(userId, subMcpName));
    },
  };
}
