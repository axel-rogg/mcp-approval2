/**
 * sub_mcp_servers — Registry der externen Sub-MCP-Server (cf/github/gws/gcloud/utils).
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4 (Sub-MCP-Credential-Verteilung), §9
 * (Sub-MCP-Server).
 *
 * Pattern:
 *   - mcp-approval2 ist der zentrale Punkt fuer User-Credentials. Sub-MCP-Server
 *     holen Tokens JIT via `POST /internal/v1/credentials/resolve` mit einem
 *     pre-shared Service-Token (Schicht 1) plus einem user-JWT (Schicht 2,
 *     signed by mcp-approval2).
 *   - Discovery: mcp-approval2 ruft periodisch `tools/list` auf jedem Sub-MCP,
 *     cached in `tools_cache` JSONB. Die discovered Tools werden in der Haupt-
 *     Registry als `<subMcpName>.<toolName>` wrapper-tools registriert.
 *   - `auth_config` ist mode-spezifisch:
 *       service_bearer: { service_token: '<sha256-hash>', token_header?: 'authorization' }
 *       oauth:          { authorize_url, token_url, scopes[], client_id }
 *       pat:            { token_field?: 'X-API-Token' }
 *
 * Service-Token-Storage: wir persistieren NUR den SHA-256-Hash des Service-Tokens
 * (analog zu oauth_clients.client_secret_hash). Plain-Token lebt out-of-band
 * im Sub-MCP-Worker als ENV-Var.
 */
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Auth-Mode-Discriminator. Bestimmt, wie mcp-approval2 ankommende Calls auf
 * `/internal/v1/credentials/resolve` authentifiziert UND wie die User-Credentials
 * an den Sub-MCP delivered werden.
 *
 *   service_bearer — pre-shared Service-Token im X-Service-Token-Header.
 *                    Sub-MCP holt user-credentials per JWT. Default.
 *   oauth          — Sub-MCP nutzt OAuth-Flow direkt (Cloudflare-MCP-Pattern,
 *                    DCR). User-Credentials werden NICHT durchgereicht.
 *   pat            — Sub-MCP nutzt User-PAT aus Credentials-Vault.
 */
export const SUB_MCP_AUTH_MODES = ['service_bearer', 'oauth', 'pat'] as const;
export type SubMcpAuthMode = (typeof SUB_MCP_AUTH_MODES)[number];

/**
 * Tools-Cache-Entry. Pro discovered tool ein Eintrag. Wird in der Haupt-Registry
 * als wrapper-tool angelegt: `<subMcpName>.<toolName>`.
 */
export interface SubMcpToolCacheEntry {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
}

export interface SubMcpAuthConfig {
  /** SHA-256-Hex des pre-shared Service-Tokens (service_bearer-Mode). */
  readonly service_token_hash?: string;
  /** Optional: header-name, falls Sub-MCP ein custom-header nutzt. Default: 'authorization'. */
  readonly token_header?: string;
  /** OAuth-Mode-Felder. */
  readonly authorize_url?: string;
  readonly token_url?: string;
  readonly scopes?: ReadonlyArray<string>;
  readonly client_id?: string;
  /** Beliebige Extras (z.B. Discovery-URL-Override). */
  readonly [key: string]: unknown;
}

/**
 * sub_mcp_servers-Tabelle.
 *
 * Spalten-Gruppen:
 *
 * Identity:
 * - `id`: UUID.
 * - `name`: 'cf' | 'github' | 'gws' | 'gcloud' | 'utils' | ... — UNIQUE,
 *   wird als Tool-Prefix benutzt (`<name>.<toolName>`).
 * - `display_name`: human-readable.
 * - `base_url`: 'https://cf.firma.de' — kein trailing-slash.
 *
 * Auth:
 * - `auth_mode`: 'service_bearer' | 'oauth' | 'pat'.
 * - `auth_config`: JSONB, mode-spezifisch.
 *
 * Lifecycle:
 * - `enabled`: Soft-Disable ohne Row-Delete.
 * - `tools_cache`: JSONB-Array discovered tools (SubMcpToolCacheEntry[]).
 * - `tools_cached_at`: Last-refresh-timestamp (epoch-ms).
 * - `created_at` / `updated_at`.
 *
 * Keine RLS — registry ist global (admin-managed), nicht user-scoped.
 */
export const subMcpServersTable = pgTable(
  'sub_mcp_servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    displayName: text('display_name').notNull(),
    baseUrl: text('base_url').notNull(),
    authMode: text('auth_mode').notNull(),
    authConfig: jsonb('auth_config').$type<SubMcpAuthConfig>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    toolsCache: jsonb('tools_cache').$type<SubMcpToolCacheEntry[]>(),
    toolsCachedAt: bigint('tools_cached_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    nameUnique: uniqueIndex('idx_sub_mcp_name').on(t.name),
    enabledIdx: index('idx_sub_mcp_enabled').on(t.enabled),
  }),
);
