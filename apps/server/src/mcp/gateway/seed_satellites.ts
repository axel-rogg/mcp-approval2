/**
 * Sub-MCP-Boot-Seeder.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4.
 *
 * Iteriert eine Liste bekannter CF-Sub-MCP-Gateways (utils/gws/gcloud) und
 * registriert sie idempotent in `sub_mcp_servers`. Voraussetzung pro Server:
 * das passende Plain-Service-Token muss in env-var `SUB_MCP_TOKEN_<NAME>`
 * gesetzt sein. Ohne Token → skip (nicht-registriert, kein Forwarding moeglich,
 * gut so: fail-closed).
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
 * → no-op. Damit ist die Datei in Tests, dev-Umgebungen und Coop-Maschinen
 * harmless.
 */
import { createHash } from 'node:crypto';
import type { DbAdapter } from '@mcp-approval2/adapters';

/**
 * Default-Konfiguration der drei CF-Sub-MCP-Gateways. URLs entsprechen den
 * Custom-Domains aus den jeweiligen wrangler.jsonc:
 *   utils  → utils.ai-toolhub.org    (8 Tools — now/cal/diagram)
 *   gws    → gws.ai-toolhub.org      (59 Google-Workspace-Tools)
 *   gcloud → gcloud.ai-toolhub.org   (4 GCP-Tools)
 */
export interface CfGatewaySeedEntry {
  readonly name: string;
  readonly displayName: string;
  readonly baseUrl: string;
  /** Name der env-var, in der das Plain-Service-Token liegt. */
  readonly serviceTokenEnvVar: string;
}

// 2026-05-17: URLs auf workers.dev statt Custom-Domain.
// Custom-Domains (utils|gws|gcloud.ai-toolhub.org) liegen hinter Cloudflare
// Access (Zero-Trust) → blocken externe Bearer-Calls mit 403 egal welcher
// Token. V2 (Fly.io) ist nicht im CF Account → kann nicht durch Access
// authentifizieren. workers.dev hat KEINEN Access davor → direkter Worker-
// Zugriff mit MCP_BEARER_TOKEN.
//
// Sub-MCP-Worker env-var-Name heisst MCP_BEARER_TOKEN (nicht SERVICE_TOKEN),
// daher das wrangler-Sync-Skript pusht in diese Variable.
export const DEFAULT_CF_GATEWAYS: ReadonlyArray<CfGatewaySeedEntry> = [
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
  },
  {
    name: 'gcloud',
    displayName: 'Google Cloud Gateway',
    baseUrl: 'https://mcp-gcloud.axelrogg.workers.dev',
    serviceTokenEnvVar: 'SUB_MCP_TOKEN_GCLOUD',
  },
] as const;

export interface SeedCfGatewaysArgs {
  readonly db: DbAdapter;
  /** Override fuer Tests — sonst werden DEFAULT_CF_GATEWAYS verwendet. */
  readonly gateways?: ReadonlyArray<CfGatewaySeedEntry>;
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
export async function seedCfGateways(args: SeedCfGatewaysArgs): Promise<SeedResult> {
  const gateways = args.gateways ?? DEFAULT_CF_GATEWAYS;
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
    const ts = now();
    // INSERT ON CONFLICT UPDATE — idempotent. Bringt Hash + URL auf env-Stand.
    // `enabled` wird beim UPDATE NICHT geflippt, damit ein manueller toggle via
    // gateway_server_toggle nicht von einem Boot ueberschrieben wird.
    // is_catalog_default=TRUE damit der per-user-Subscription-Layer den
    // Server in die "Verfuegbar"-Liste streut (siehe PLAN-per-user-server-
    // store.md). owner_user_id bleibt NULL = Catalog-Default fuer alle User.
    //
    // ON CONFLICT (name): Migration 0020 (renumbered von 0017) behaelt den
    // global-uniq-index idx_sub_mcp_name aus 0003. Multi-User-different-
    // name-pro-Owner waere ein eigener Refactor (siehe Migration-Kommentar).
    const result = await raw.query<{ name: string; was_new: boolean }>(
      `INSERT INTO sub_mcp_servers
         (name, display_name, base_url, auth_mode, auth_config, enabled,
          is_catalog_default, created_at, updated_at)
       VALUES ($1, $2, $3, 'service_bearer', $4::jsonb, TRUE, TRUE, $5, $5)
       ON CONFLICT (name) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             base_url     = EXCLUDED.base_url,
             auth_config  = EXCLUDED.auth_config,
             is_catalog_default = TRUE,
             updated_at   = EXCLUDED.updated_at
         WHERE sub_mcp_servers.auth_config IS DISTINCT FROM EXCLUDED.auth_config
            OR sub_mcp_servers.base_url    IS DISTINCT FROM EXCLUDED.base_url
            OR sub_mcp_servers.display_name IS DISTINCT FROM EXCLUDED.display_name
            OR sub_mcp_servers.is_catalog_default IS DISTINCT FROM TRUE
       RETURNING name, (xmax = 0) AS was_new`,
      [gw.name, gw.displayName, gw.baseUrl, authConfig, ts],
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
