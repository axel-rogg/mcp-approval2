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

export const DEFAULT_CF_GATEWAYS: ReadonlyArray<CfGatewaySeedEntry> = [
  {
    name: 'utils',
    displayName: 'Utils Gateway (date/calendar/diagram)',
    baseUrl: 'https://utils.ai-toolhub.org',
    serviceTokenEnvVar: 'SUB_MCP_TOKEN_UTILS',
  },
  {
    name: 'gws',
    displayName: 'Google Workspace Gateway',
    baseUrl: 'https://gws.ai-toolhub.org',
    serviceTokenEnvVar: 'SUB_MCP_TOKEN_GWS',
  },
  {
    name: 'gcloud',
    displayName: 'Google Cloud Gateway',
    baseUrl: 'https://gcloud.ai-toolhub.org',
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
  const skipped: Array<{ name: string; reason: 'no_token' }> = [];
  const raw = args.db.unsafe('sub_mcp_seed_cf_gateways');

  for (const gw of gateways) {
    const plainToken = env[gw.serviceTokenEnvVar];
    if (!plainToken || plainToken.length === 0) {
      skipped.push({ name: gw.name, reason: 'no_token' });
      continue;
    }
    const tokenHash = sha256Hex(plainToken);
    const authConfig = JSON.stringify({ service_token_hash: tokenHash });
    const ts = now();
    // INSERT ON CONFLICT UPDATE — idempotent. Bringt Hash + URL auf env-Stand.
    // `enabled` wird beim UPDATE NICHT geflippt, damit ein manueller toggle via
    // gateway_server_toggle nicht von einem Boot ueberschrieben wird.
    // is_catalog_default=TRUE damit der per-user-Subscription-Layer den
    // Server in die "Verfuegbar"-Liste streut (siehe PLAN-per-user-server-
    // store.md). owner_user_id bleibt NULL = Catalog-Default fuer alle User.
    const result = await raw.query<{ name: string; was_new: boolean }>(
      `INSERT INTO sub_mcp_servers
         (name, display_name, base_url, auth_mode, auth_config, enabled,
          is_catalog_default, created_at, updated_at)
       VALUES ($1, $2, $3, 'service_bearer', $4::jsonb, TRUE, TRUE, $5, $5)
       ON CONFLICT (name, COALESCE(owner_user_id, '00000000-0000-0000-0000-000000000000'::UUID)) DO UPDATE
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

  return { registered, updated, skipped };
}
