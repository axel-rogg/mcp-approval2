/**
 * Sub-MCP-Boot-Seeder fuer eigene Satellite-Worker.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4.
 *
 * **Naming-Hinweis (2026-05-17):** Diese Datei hiess frueher `seed.ts` mit
 * `seedSatelliteWorkers`/`DEFAULT_SATELLITE_WORKERS`. "CF" meinte dabei "laeuft auf
 * Cloudflare Workers" — NICHT den offiziellen Cloudflare-MCP-Server
 * (`bindings.mcp.cloudflare.com`). Letzterer ist `cf` als Catalog-OAuth-
 * Server und wird in `seed_oauth_servers.ts` registriert.
 *
 * Iteriert eine Liste bekannter Bearer-authenticated Satellite-Worker
 * (utils/gws/gcloud) und registriert sie idempotent in `sub_mcp_servers`.
 * Voraussetzung pro Server: das passende Plain-Service-Token muss in env-var
 * `SUB_MCP_TOKEN_<NAME>` gesetzt sein. Ohne Token → trotzdem als
 * Catalog-Default registriert (visible im Tools-Tab), aber Forward-Calls
 * fail'n bis ein Token aufgepflegt wird (fail-closed).
 *
 * Idempotent:
 *   - Wenn Row mit `name` existiert: hash + base_url werden auf den env-Wert
 *     gebracht (Token-Rotation, URL-Update beim CF-Domain-Switch).
 *   - Sonst: INSERT.
 *
 * Tokens werden NIE persistiert (nur SHA-256-Hex-Hash). Plain-Token lebt in
 * Doppler/Fly-Secrets, wird beim Forward zur Laufzeit aus env gelesen
 * (`DEFAULT_TOKEN_RESOLVER` in registry.ts).
 *
 * Diese Datei ist optional am Boot. Wenn keiner der drei env-vars gesetzt ist
 * → Catalog-Eintraege ohne Token (registeredWithoutToken). Damit ist die Datei
 * in Tests, dev-Umgebungen und Coop-Maschinen harmless.
 */
import { createHash } from 'node:crypto';
import type { DbAdapter } from '@mcp-approval2/adapters';

/**
 * Default-Konfiguration der drei Bearer-authenticated Satellite-Worker.
 *
 *   utils  → 8 Tools — now/cal/diagram
 *   gws    → 59 Google-Workspace-Tools (inner-Auth: x-google-access-token
 *            vom enricher, siehe sub-mcp-auth-enricher.ts)
 *   gcloud → 4 GCP-Tools (inner-Auth: x-google-access-token vom enricher)
 *
 * URLs zeigen aktuell auf workers.dev statt Custom-Domain
 * (utils|gws|gcloud.ai-toolhub.org) weil die Custom-Domains hinter Cloudflare
 * Access (Zero-Trust) liegen und externe Bearer-Calls mit 403 blocken.
 * V2 (Fly.io) ist nicht im CF Account → kann nicht durch Access
 * authentifizieren. workers.dev hat keinen Access davor → direkter Worker-
 * Zugriff mit MCP_BEARER_TOKEN. Sub-MCP-Worker env-var-Name heisst dort
 * MCP_BEARER_TOKEN (nicht SERVICE_TOKEN), daher das wrangler-Sync-Skript
 * pusht in diese Variable.
 */
export interface SatelliteWorkerSeedEntry {
  readonly name: string;
  readonly displayName: string;
  readonly baseUrl: string;
  /** Name der env-var, in der das Plain-Service-Token liegt. */
  readonly serviceTokenEnvVar: string;
  /**
   * Optionaler Inner-Auth-Setup. Aktuell genutzt fuer gws + gcloud um den
   * per-User Google-OAuth-Flow zu deklarieren (kind='shared-app' →
   * UserServerOAuthService nimmt clientId/Secret aus env statt aus
   * user_sub_mcp_config). Wird beim seedSatelliteWorkers in
   * sub_mcp_servers.config_schema._meta.oauth abgelegt.
   */
  readonly innerOAuth?: {
    readonly kind: 'shared-app';
    readonly provider: 'google';
    readonly authorize_url: string;
    readonly token_url: string;
    readonly scopes: ReadonlyArray<string>;
    /**
     * env-var-Namen fuer client_id/secret. Default: GOOGLE_WORKSPACE_CLIENT_ID
     * / GOOGLE_WORKSPACE_CLIENT_SECRET mit Fallback auf GOOGLE_CLIENT_ID /
     * GOOGLE_CLIENT_SECRET (Login-App, falls keine separate Workspace-App
     * angelegt ist).
     */
    readonly clientIdEnv?: string;
    readonly clientSecretEnv?: string;
  };
  /**
   * Optionale weitere User-konfigurierbare Felder (config_schema.config_fields).
   * Beispiel gcloud: _service_account_json als Alternative zum OAuth-Pfad.
   */
  readonly configFields?: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly type: 'text' | 'password' | 'textarea';
    readonly is_secret?: boolean;
    readonly description?: string;
  }>;
}

/**
 * Bundle der Google-Workspace-Scopes (analog v1 `src/auth/google_workspace.ts`).
 * Wenn der User gws verbindet, holt approval2 alle Scopes auf einmal —
 * Worker-Side entscheidet pro Tool welche es braucht.
 */
const GWS_SCOPES: ReadonlyArray<string> = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/contacts',
];

export const DEFAULT_SATELLITE_WORKERS: ReadonlyArray<SatelliteWorkerSeedEntry> = [
  {
    name: 'utils',
    displayName: 'Utils Gateway (date/calendar/diagram)',
    baseUrl: 'https://mcp-utils.axelrogg.workers.dev',
    serviceTokenEnvVar: 'SUB_MCP_TOKEN_UTILS',
  },
  {
    name: 'gws',
    displayName: 'Google Workspace Gateway',
    baseUrl: 'https://mcp-gws.axelrogg.workers.dev',
    serviceTokenEnvVar: 'SUB_MCP_TOKEN_GWS',
    innerOAuth: {
      kind: 'shared-app',
      provider: 'google',
      authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_url: 'https://oauth2.googleapis.com/token',
      scopes: GWS_SCOPES,
    },
  },
  {
    name: 'gcloud',
    displayName: 'Google Cloud Gateway',
    baseUrl: 'https://mcp-gcloud.axelrogg.workers.dev',
    serviceTokenEnvVar: 'SUB_MCP_TOKEN_GCLOUD',
    innerOAuth: {
      kind: 'shared-app',
      provider: 'google',
      authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_url: 'https://oauth2.googleapis.com/token',
      scopes: ['openid', 'email', 'https://www.googleapis.com/auth/cloud-platform'],
    },
    configFields: [
      {
        key: '_gcp_project_id',
        label: 'GCP Project-Id',
        type: 'text',
        is_secret: false,
        description:
          'Pflicht (bei OAuth-Pfad). Beispiel: my-project-12345. Bei SA-Pfad kann das project_id auch im SA-JSON stehen.',
      },
      {
        key: '_service_account_json',
        label: 'Service-Account JSON (optional Alternative)',
        type: 'textarea',
        is_secret: true,
        description:
          'Optional Alternative zu OAuth: pasten Sie das volle SA-JSON aus GCP-Console (IAM → Service Accounts → Keys). approval2 macht JWT-Bearer-Grant lokal, der Private-Key verlaesst approval2 nie. Wenn gesetzt: hat Prioritaet ueber OAuth (Headless-CI-Setup, fester SA-Account statt User-Account).',
      },
      {
        key: '_gcp_scopes',
        label: 'Custom Scopes (space/comma-separated)',
        type: 'text',
        is_secret: false,
        description:
          'Optional. Default ist cloud-platform. Engerer Scope wie devstorage.read_only / compute.readonly bei Bedarf.',
      },
    ],
  },
] as const;

export interface SeedSatelliteWorkersArgs {
  readonly db: DbAdapter;
  /** Override fuer Tests — sonst werden DEFAULT_SATELLITE_WORKERS verwendet. */
  readonly gateways?: ReadonlyArray<SatelliteWorkerSeedEntry>;
  /** Override fuer Tests — sonst process.env. */
  readonly env?: Record<string, string | undefined>;
  /** Override fuer Tests — sonst Date.now(). */
  readonly now?: () => number;
}

export interface SeedResult {
  readonly registered: ReadonlyArray<string>;
  readonly updated: ReadonlyArray<string>;
  /**
   * Server die ohne env-Token registriert wurden (auth_config leer).
   * Forward-Calls fail'n bis ein Token via env oder user_sub_mcp_config
   * verfuegbar ist. Catalog-Default-Sichtbarkeit ist trotzdem da.
   */
  readonly registeredWithoutToken: ReadonlyArray<string>;
  /** @deprecated kept fuer Backwards-Compat — leer wenn 'no_token'-Pfad neu */
  readonly skipped: ReadonlyArray<{ name: string; reason: 'no_token' }>;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Boot-time-Helper. Idempotent. Wird nach Migrationen aufgerufen, vor dem
 * Build der Wrapper-Tools (damit der Tool-Cache via Discovery danach
 * gepflegt werden kann).
 */
export async function seedSatelliteWorkers(args: SeedSatelliteWorkersArgs): Promise<SeedResult> {
  const gateways = args.gateways ?? DEFAULT_SATELLITE_WORKERS;
  const env = args.env ?? (typeof process !== 'undefined' ? process.env : {});
  const now = args.now ?? (() => Date.now());
  const registered: string[] = [];
  const updated: string[] = [];
  const registeredWithoutToken: string[] = [];
  const skipped: Array<{ name: string; reason: 'no_token' }> = [];
  const raw = args.db.unsafe('sub_mcp_seed_cf_gateways');

  for (const gw of gateways) {
    const plainToken = env[gw.serviceTokenEnvVar];
    // Catalog-Defaults werden IMMER registriert (auch ohne Token) damit
    // die "Verfuegbar"-Liste im Tools-Tab sichtbar ist. Forward-Calls fail'n
    // bis ein Token via env ODER user_sub_mcp_config verfuegbar wird —
    // Token-Lookup laeuft zur Laufzeit ueber DEFAULT_TOKEN_RESOLVER.
    const tokenHash = plainToken && plainToken.length > 0 ? sha256Hex(plainToken) : null;
    const authConfig = JSON.stringify(
      tokenHash ? { service_token_hash: tokenHash } : { service_token_hash: null },
    );
    if (!tokenHash) {
      registeredWithoutToken.push(gw.name);
    }

    // config_schema-Top-Level-Layout — wird von UserServerOAuthService
    // (registry.getByName().configSchema.oauth) und der PWA gelesen.
    // ACHTUNG: NICHT in `_meta`-Subkey ablegen — sowohl getOAuthSchema()
    // in user-server-oauth.ts als auch die PWA erwarten top-level `oauth`
    // + top-level `config_fields`. Aligned mit seed_oauth_catalog.ts.
    const cfg: Record<string, unknown> = {};
    if (gw.innerOAuth) {
      cfg['oauth'] = {
        kind: gw.innerOAuth.kind,
        provider: gw.innerOAuth.provider,
        authorize_url: gw.innerOAuth.authorize_url,
        token_url: gw.innerOAuth.token_url,
        scopes: [...gw.innerOAuth.scopes],
        ...(gw.innerOAuth.clientIdEnv ? { client_id_env: gw.innerOAuth.clientIdEnv } : {}),
        ...(gw.innerOAuth.clientSecretEnv
          ? { client_secret_env: gw.innerOAuth.clientSecretEnv }
          : {}),
      };
    }
    if (gw.configFields && gw.configFields.length > 0) {
      cfg['config_fields'] = gw.configFields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        is_secret: f.is_secret === true,
        ...(f.description ? { description: f.description } : {}),
      }));
    }
    const configSchemaJson =
      Object.keys(cfg).length > 0 ? JSON.stringify(cfg) : null;

    const ts = now();
    // INSERT ON CONFLICT UPDATE — idempotent. Bringt Hash + URL + config_schema
    // auf env-Stand. `enabled` wird beim UPDATE NICHT geflippt, damit ein manueller
    // toggle via gateway_server_toggle nicht von einem Boot ueberschrieben wird.
    // is_catalog_default=TRUE damit der per-user-Subscription-Layer den
    // Server in die "Verfuegbar"-Liste streut (siehe PLAN-per-user-server-
    // store.md). owner_user_id bleibt NULL = Catalog-Default fuer alle User.
    //
    // ON CONFLICT (name): Migration 0020 (renumbered von 0017) behaelt den
    // global-uniq-index idx_sub_mcp_name aus 0003. Multi-User-different-
    // name-pro-Owner waere ein eigener Refactor (siehe Migration-Kommentar).
    const result = await raw.query<{ name: string; was_new: boolean }>(
      `INSERT INTO sub_mcp_servers
         (name, display_name, base_url, auth_mode, auth_config, config_schema,
          enabled, is_catalog_default, created_at, updated_at)
       VALUES ($1, $2, $3, 'service_bearer', $4::jsonb, $6::jsonb, TRUE, TRUE, $5, $5)
       ON CONFLICT (name) DO UPDATE
         SET display_name  = EXCLUDED.display_name,
             base_url      = EXCLUDED.base_url,
             auth_config   = EXCLUDED.auth_config,
             config_schema = EXCLUDED.config_schema,
             is_catalog_default = TRUE,
             updated_at    = EXCLUDED.updated_at
         WHERE sub_mcp_servers.auth_config IS DISTINCT FROM EXCLUDED.auth_config
            OR sub_mcp_servers.base_url    IS DISTINCT FROM EXCLUDED.base_url
            OR sub_mcp_servers.config_schema IS DISTINCT FROM EXCLUDED.config_schema
            OR sub_mcp_servers.display_name IS DISTINCT FROM EXCLUDED.display_name
            OR sub_mcp_servers.is_catalog_default IS DISTINCT FROM TRUE
       RETURNING name, (xmax = 0) AS was_new`,
      [gw.name, gw.displayName, gw.baseUrl, authConfig, ts, configSchemaJson],
    );
    const row = result[0];
    if (!row) {
      // Conflict mit identischen Werten → keine Zeile zurueck. Idempotent-OK.
      continue;
    }
    if (row.was_new === true) {
      registered.push(row.name);
    } else {
      updated.push(row.name);
    }
  }

  return { registered, updated, registeredWithoutToken, skipped };
}
