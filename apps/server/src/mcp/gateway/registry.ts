/**
 * Sub-MCP-Server-Registry.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4, §9.
 *
 * Daten-Layer-Abstraktion ueber `sub_mcp_servers`. Persistiert in Postgres,
 * cached in-memory (1-Minute-TTL) damit `forwardToolCall` nicht pro Request
 * eine DB-Round-Trip macht.
 *
 * Service-Token-Plain-Wert wird NICHT in der DB gespeichert (nur SHA-256-Hash
 * fuer Inbound-Validation). Plain-Token kommt aus `serviceTokenResolver`
 * (typisch: ENV-Var per Sub-MCP-Name) und wird beim Hydrieren der Config
 * eingemerged.
 */
import { createHash } from 'node:crypto';
import type { DbAdapter } from '@mcp-approval2/adapters';
import type {
  SubMcpAuthConfig,
  SubMcpAuthMode,
  SubMcpServerConfig,
  SubMcpToolCacheEntry,
} from './types.js';
import { SubMcpNotFoundError } from './types.js';

/**
 * Resolver-Funktion fuer Plain-Service-Tokens. Default: nimmt aus
 * `process.env.SUB_MCP_TOKEN_<NAME_UPPER>`. Tests override-bar.
 */
export type ServiceTokenResolver = (subMcpName: string) => string | null;

const DEFAULT_TOKEN_RESOLVER: ServiceTokenResolver = (name) => {
  const envKey = `SUB_MCP_TOKEN_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  if (typeof process !== 'undefined' && process.env) {
    return process.env[envKey] ?? null;
  }
  return null;
};

/**
 * SHA-256-Hex eines Service-Tokens — exportiert fuer den Inbound-Auth-Check
 * im /internal/v1/credentials/resolve-Endpoint.
 */
export function hashServiceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface SubMcpRowRaw {
  readonly id: string;
  readonly name: string;
  readonly display_name: string;
  readonly base_url: string;
  readonly auth_mode: string;
  readonly auth_config: SubMcpAuthConfig | string;
  readonly enabled: boolean;
  readonly tools_cache: SubMcpToolCacheEntry[] | string | null;
  readonly tools_cached_at: number | string | null;
  readonly created_at: number | string;
  readonly updated_at: number | string;
}

const SELECT_COLS = `
  id, name, display_name, base_url, auth_mode, auth_config,
  enabled, tools_cache, tools_cached_at,
  created_at, updated_at
`;

const CACHE_TTL_MS = 60_000;

function toNumber(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'number' ? v : Number(v);
}

function parseJson<T>(v: T | string | null | undefined): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v;
}

export interface RegisterSubMcpArgs {
  readonly name: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly authMode: SubMcpAuthMode;
  readonly authConfig: SubMcpAuthConfig;
  readonly enabled?: boolean;
  /**
   * Falls authMode === 'service_bearer': der Plain-Token wird hier vergeben.
   * Wir hashen + speichern den Hash in auth_config.service_token_hash; der
   * Plain-Token muss vom Caller out-of-band an den Sub-MCP-Worker delivered
   * werden.
   */
  readonly serviceTokenPlain?: string;
}

export interface SubMcpRegistry {
  /** Liefert eine aktive Sub-MCP-Config (enabled=true). Throws wenn nicht gefunden. */
  getByName(name: string): Promise<SubMcpServerConfig>;
  /** Liefert alle aktiven Sub-MCPs. */
  listEnabled(): Promise<ReadonlyArray<SubMcpServerConfig>>;
  /** Liefert alle (auch disabled). */
  listAll(): Promise<ReadonlyArray<SubMcpServerConfig>>;
  /** Tool-Cache nach Discovery aktualisieren. */
  updateToolsCache(id: string, tools: ReadonlyArray<SubMcpToolCacheEntry>): Promise<void>;
  /** Service-Token-Hash gegen DB-Wert pruefen — Konstant-Zeit-Vergleich. */
  verifyServiceToken(name: string, presentedToken: string): Promise<SubMcpServerConfig | null>;
  /** Sub-MCP eintragen (admin-Operation, hier ohne Auth — Caller schuetzt). */
  register(args: RegisterSubMcpArgs): Promise<SubMcpServerConfig>;
  /** Cache invalidieren — Tests, Hot-Reload. */
  invalidate(): void;
}

export interface SubMcpRegistryOptions {
  readonly db: DbAdapter;
  readonly serviceTokenResolver?: ServiceTokenResolver;
  /** Optional: Cache-TTL override fuer Tests. */
  readonly cacheTtlMs?: number;
  /** Optional: explizite Zeit-Quelle fuer Tests. */
  readonly now?: () => number;
}

interface CacheSlot {
  readonly entries: ReadonlyMap<string, SubMcpServerConfig>;
  readonly expiresAt: number;
}

export function createSubMcpRegistry(opts: SubMcpRegistryOptions): SubMcpRegistry {
  const { db } = opts;
  const tokenResolver = opts.serviceTokenResolver ?? DEFAULT_TOKEN_RESOLVER;
  const ttlMs = opts.cacheTtlMs ?? CACHE_TTL_MS;
  const now = opts.now ?? (() => Date.now());

  let cache: CacheSlot | null = null;

  function rowToConfig(row: SubMcpRowRaw): SubMcpServerConfig {
    const authConfig = (parseJson<SubMcpAuthConfig>(row.auth_config) ?? {}) as SubMcpAuthConfig;
    const toolsCache = parseJson<SubMcpToolCacheEntry[]>(row.tools_cache);
    const serviceToken = row.auth_mode === 'service_bearer' ? tokenResolver(row.name) : null;
    return {
      id: row.id,
      name: row.name,
      displayName: row.display_name,
      baseUrl: row.base_url.replace(/\/+$/, ''),
      authMode: row.auth_mode as SubMcpAuthMode,
      authConfig,
      enabled: row.enabled,
      serviceToken,
      toolsCache,
      toolsCachedAt: toNumber(row.tools_cached_at),
      createdAt: toNumber(row.created_at) ?? 0,
      updatedAt: toNumber(row.updated_at) ?? 0,
    };
  }

  async function loadAll(): Promise<ReadonlyMap<string, SubMcpServerConfig>> {
    const raw = db.unsafe('sub_mcp_load_all');
    const rows = await raw.query<SubMcpRowRaw>(
      `SELECT ${SELECT_COLS} FROM sub_mcp_servers ORDER BY name ASC`,
    );
    const map = new Map<string, SubMcpServerConfig>();
    for (const r of rows) {
      const cfg = rowToConfig(r);
      map.set(cfg.name, cfg);
    }
    return map;
  }

  async function getCache(): Promise<ReadonlyMap<string, SubMcpServerConfig>> {
    const ts = now();
    if (cache && cache.expiresAt > ts) {
      return cache.entries;
    }
    const entries = await loadAll();
    cache = { entries, expiresAt: ts + ttlMs };
    return entries;
  }

  return {
    async getByName(name) {
      const entries = await getCache();
      const cfg = entries.get(name);
      if (!cfg || !cfg.enabled) throw new SubMcpNotFoundError(name);
      return cfg;
    },

    async listEnabled() {
      const entries = await getCache();
      return [...entries.values()].filter((c) => c.enabled);
    },

    async listAll() {
      const entries = await getCache();
      return [...entries.values()];
    },

    async updateToolsCache(id, tools) {
      const raw = db.unsafe('sub_mcp_update_tools_cache');
      const ts = now();
      await raw.query(
        `UPDATE sub_mcp_servers
            SET tools_cache = $1, tools_cached_at = $2, updated_at = $3
          WHERE id = $4`,
        [JSON.stringify(tools), ts, ts, id],
      );
      cache = null;
    },

    async verifyServiceToken(name, presentedToken) {
      const entries = await getCache();
      const cfg = entries.get(name);
      if (!cfg || !cfg.enabled || cfg.authMode !== 'service_bearer') return null;
      const expectedHash = cfg.authConfig['service_token_hash'];
      if (typeof expectedHash !== 'string' || expectedHash.length === 0) return null;
      const presentedHash = hashServiceToken(presentedToken);
      // Konstant-Zeit-Vergleich (hex-strings haben gleiche Laenge bei SHA-256).
      if (presentedHash.length !== expectedHash.length) return null;
      let diff = 0;
      for (let i = 0; i < presentedHash.length; i++) {
        diff |= presentedHash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
      }
      return diff === 0 ? cfg : null;
    },

    async register(args) {
      const authConfig: SubMcpAuthConfig = { ...args.authConfig };
      if (args.authMode === 'service_bearer' && args.serviceTokenPlain) {
        (authConfig as Record<string, unknown>)['service_token_hash'] =
          hashServiceToken(args.serviceTokenPlain);
      }
      const raw = db.unsafe('sub_mcp_register');
      const ts = now();
      const rows = await raw.query<SubMcpRowRaw>(
        `INSERT INTO sub_mcp_servers
           (name, display_name, base_url, auth_mode, auth_config,
            enabled, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
         RETURNING ${SELECT_COLS}`,
        [
          args.name,
          args.displayName,
          args.baseUrl.replace(/\/+$/, ''),
          args.authMode,
          JSON.stringify(authConfig),
          args.enabled ?? true,
          ts,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error('sub_mcp_servers insert returned no row');
      cache = null;
      return rowToConfig(row);
    },

    invalidate() {
      cache = null;
    },
  };
}
