/**
 * Catalog-OAuth-Server-Seeder.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4, AS-3.
 *
 * Registriert OAuth-basierte Sub-MCP-Server als Catalog-Defaults
 * (owner_user_id=NULL, is_catalog_default=TRUE). Jeder User durchläuft danach
 * einen EIGENEN OAuth-Flow:
 *   - cf       (Cloudflare-MCP)  → DCR (RFC 7591): jeder User registriert sich
 *                                   einen eigenen DCR-Client beim Authorize-Start
 *   - github   (GitHub-MCP)      → Pre-registered: jeder User muss eine eigene
 *                                   GitHub-App/OAuth-App anlegen und client_id +
 *                                   client_secret unter /v1/me/servers/github/config
 *                                   eintragen, BEVOR der OAuth-Start läuft
 *                                   (siehe project_github_oauth_needs_github_app.md)
 *
 * Die Catalog-Row tragt nur die "öffentlichen" Metadaten (base_url,
 * authorize_url, token_url, default_scopes) in `config_schema._meta.oauth`.
 * Pro-User-Geheimnisse (client_id, client_secret, refresh_token) liegen
 * AES-GCM-encrypted in `user_sub_mcp_config` mit user-gebundener AAD
 * (siehe user-server-config.ts).
 *
 * Idempotent: ON CONFLICT UPDATE — Server-Metadata bleibt operator-pflegbar
 * über Code, User-Subscriptions/Credentials werden nicht angefasst.
 *
 * Naming-Abgrenzung: seed_satellites.ts registriert die EIGENEN Worker
 * (utils/gws/gcloud), die auf Cloudflare Workers laufen aber mit
 * Service-Bearer-Auth zwischen approval2 ↔ Worker arbeiten. Hier registrieren
 * wir EXTERNE MCP-Server die wir nicht selbst betreiben (cf, github), und für
 * die OAuth-2.1 (PKCE + DCR oder pre-registered) der einzige Weg ist.
 */
import type { DbAdapter } from '@mcp-approval2/adapters';

export type OAuthKind = 'dcr' | 'pre';

export interface OAuthCatalogServerSeed {
  readonly name: string;
  readonly displayName: string;
  readonly baseUrl: string;
  /**
   * 'dcr'  → Dynamic Client Registration (RFC 7591) per User beim ersten
   *          Authorize-Start. registration_endpoint kommt aus oauth_meta
   *          (oder via RFC 9728/8414 Discovery wenn nicht gesetzt).
   * 'pre'  → Pre-registered Client. User muss eigene OAuth-App/GitHub-App
   *          anlegen und client_id/client_secret in user_sub_mcp_config
   *          eintragen, bevor /oauth/start läuft.
   */
  readonly oauthKind: OAuthKind;
  /** Snapshot der OAuth-Metadata. Wird in config_schema._meta.oauth abgelegt. */
  readonly oauthMeta: {
    readonly authorize_url: string;
    readonly token_url: string;
    readonly default_scopes: ReadonlyArray<string>;
    /** Nur bei kind='dcr' relevant. Wenn null → Discovery via RFC 9728/8414. */
    readonly registration_endpoint?: string;
    /** Provider-Hint für Token-Refresh-Handling. */
    readonly provider: 'cloudflare' | 'github' | 'generic';
  };
}

/**
 * Default-Liste der OAuth-Catalog-Server. Hardcoded weil:
 *  - URLs/Endpoints sind stabil (Cloudflare/GitHub ändern sich selten)
 *  - Dadurch braucht der User KEIN Doppler/env-Config — Anbindung läuft
 *    rein über die PWA (OAuth-Button → Browser-Roundtrip).
 *  - Snapshot in config_schema ist nach Discovery refreshbar.
 */
export const DEFAULT_OAUTH_CATALOG_SERVERS: ReadonlyArray<OAuthCatalogServerSeed> = [
  {
    name: 'cf',
    displayName: 'Cloudflare MCP',
    baseUrl: 'https://bindings.mcp.cloudflare.com/sse',
    oauthKind: 'dcr',
    oauthMeta: {
      // Cloudflare-MCP folgt RFC 9728 (Protected Resource Metadata).
      // authorize_url + token_url werden hier als Snapshot eingetragen; bei
      // Drift wird der Wert beim nächsten Discovery (RFC 8414) refreshed.
      authorize_url: 'https://bindings.mcp.cloudflare.com/oauth/authorize',
      token_url: 'https://bindings.mcp.cloudflare.com/oauth/token',
      registration_endpoint: 'https://bindings.mcp.cloudflare.com/oauth/register',
      default_scopes: ['mcp:tools'],
      provider: 'cloudflare',
    },
  },
  {
    name: 'github',
    displayName: 'GitHub MCP',
    // GitHub-MCP via Copilot-Endpoint (offizieller MCP-Server).
    // 2026-05: GitHub OAuth-Apps liefern keine Refresh-Tokens mehr für
    // axelrogg-Accounts → User muss GitHub *App* (nicht OAuth-App) anlegen.
    // Siehe memory project_github_oauth_needs_github_app.md
    baseUrl: 'https://api.githubcopilot.com/mcp/',
    oauthKind: 'pre',
    oauthMeta: {
      authorize_url: 'https://github.com/login/oauth/authorize',
      token_url: 'https://github.com/login/oauth/access_token',
      default_scopes: ['read:user', 'repo'],
      provider: 'github',
    },
  },
] as const;

export interface SeedOAuthCatalogArgs {
  readonly db: DbAdapter;
  readonly servers?: ReadonlyArray<OAuthCatalogServerSeed>;
  readonly now?: () => number;
}

export interface SeedOAuthCatalogResult {
  readonly registered: ReadonlyArray<string>;
  readonly updated: ReadonlyArray<string>;
}

/**
 * Boot-time-Helper. Idempotent. Wird nach Migrationen aufgerufen,
 * gemeinsam mit seedSatelliteWorkers().
 */
export async function seedOAuthCatalogServers(
  args: SeedOAuthCatalogArgs,
): Promise<SeedOAuthCatalogResult> {
  const servers = args.servers ?? DEFAULT_OAUTH_CATALOG_SERVERS;
  const now = args.now ?? (() => Date.now());
  const registered: string[] = [];
  const updated: string[] = [];
  const raw = args.db.unsafe('sub_mcp_seed_oauth_catalog');

  for (const srv of servers) {
    // auth_config bleibt leer für OAuth-Server (Token sind per-User in
    // user_sub_mcp_config). config_schema trägt die OAuth-Metadata als
    // _meta.oauth-Block — analog zum Format das Discovery aus
    // tools/list._meta liest.
    const authConfig = JSON.stringify({});
    const configSchema = JSON.stringify({
      _meta: {
        oauth: {
          kind: srv.oauthKind,
          provider: srv.oauthMeta.provider,
          authorize_url: srv.oauthMeta.authorize_url,
          token_url: srv.oauthMeta.token_url,
          default_scopes: [...srv.oauthMeta.default_scopes],
          ...(srv.oauthMeta.registration_endpoint
            ? { registration_endpoint: srv.oauthMeta.registration_endpoint }
            : {}),
        },
      },
    });
    const ts = now();
    const result = await raw.query<{ name: string; was_new: boolean }>(
      `INSERT INTO sub_mcp_servers
         (name, display_name, base_url, auth_mode, auth_config, config_schema,
          enabled, is_catalog_default, created_at, updated_at)
       VALUES ($1, $2, $3, 'oauth', $4::jsonb, $5::jsonb, TRUE, TRUE, $6, $6)
       ON CONFLICT (name) DO UPDATE
         SET display_name  = EXCLUDED.display_name,
             base_url      = EXCLUDED.base_url,
             auth_mode     = EXCLUDED.auth_mode,
             config_schema = EXCLUDED.config_schema,
             is_catalog_default = TRUE,
             updated_at    = EXCLUDED.updated_at
         WHERE sub_mcp_servers.auth_mode    IS DISTINCT FROM 'oauth'
            OR sub_mcp_servers.base_url     IS DISTINCT FROM EXCLUDED.base_url
            OR sub_mcp_servers.display_name IS DISTINCT FROM EXCLUDED.display_name
            OR sub_mcp_servers.config_schema IS DISTINCT FROM EXCLUDED.config_schema
            OR sub_mcp_servers.is_catalog_default IS DISTINCT FROM TRUE
       RETURNING name, (xmax = 0) AS was_new`,
      [srv.name, srv.displayName, srv.baseUrl, authConfig, configSchema, ts],
    );
    const row = result[0];
    if (!row) continue;
    if (row.was_new === true) registered.push(row.name);
    else updated.push(row.name);
  }

  return { registered, updated };
}
