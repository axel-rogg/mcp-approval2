/**
 * Sub-MCP-Gateway-Types.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4 (Sub-MCP-Credential-Verteilung),
 *           §9 (Sub-MCP-Server).
 *
 * Konvention:
 *   - Sub-MCP-Server werden im DB-Table `sub_mcp_servers` registriert
 *     (siehe ../../schema/postgres/sub-mcp.ts).
 *   - Discovery liefert `tools/list` ueber MCP-Streamable-HTTP.
 *   - Forwarding nutzt `tools/call`.
 *   - Auth-Schicht-1: pre-shared Service-Token (Bearer) zwischen mcp-approval2
 *     und Sub-MCP. Token-Roh-Wert lebt out-of-band; mcp-approval2 cached den
 *     Plain-Wert in-memory (config / secret-store), DB haelt nur Hash.
 *   - Auth-Schicht-2: kurzlebiger user-JWT (60s, aud=<subMcpName>) im
 *     X-User-JWT-Header. Sub-MCP nutzt den, um `/internal/v1/credentials/resolve`
 *     zu callen.
 */
import type { JsonSchema, ToolAnnotations } from '../protocol/types.js';
import type {
  SubMcpAuthConfig,
  SubMcpAuthMode,
  SubMcpToolCacheEntry,
} from '../../schema/postgres/sub-mcp.js';

export type { SubMcpAuthMode, SubMcpAuthConfig, SubMcpToolCacheEntry };

/**
 * In-Memory-Repraesentation eines Sub-MCP-Server-Records — mit dem Plain-
 * Service-Token (zur Laufzeit aufgeloest aus secret-store / env), den die
 * DB nicht haelt.
 */
export interface SubMcpServerConfig {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly authMode: SubMcpAuthMode;
  readonly authConfig: SubMcpAuthConfig;
  readonly enabled: boolean;
  /**
   * Plain-Service-Token. Wird zur Laufzeit aus dem ServiceTokenResolver
   * geholt (env-vars o.ae.). NULL wenn `authMode != 'service_bearer'`.
   */
  readonly serviceToken: string | null;
  readonly toolsCache: ReadonlyArray<SubMcpToolCacheEntry> | null;
  readonly toolsCachedAt: number | null;
  /**
   * Phase 2 PLAN-per-user-server-store: vom Worker via `tools/list._meta`
   * deklarierte Config-Felder + OAuth-Hinweise. PWA rendert das fuer den
   * Config-Drawer pro Server.
   */
  readonly configSchema: Record<string, unknown> | null;
  /**
   * Phase 4 PLAN-per-user-server-store: User-Owner-ID. NULL = catalog-default
   * (operator-managed, fuer alle User sichtbar via RLS). Non-NULL = user-added,
   * nur der Owner sieht den Server.
   */
  readonly ownerUserId: string | null;
  /** TRUE wenn der Server ein operator-managed Catalog-Default ist. */
  readonly isCatalogDefault: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Wrapper-Tool-Metadata fuer die Haupt-Registry.
 * Discovery generiert pro Sub-MCP-Tool einen ForwardedToolDef.
 */
export interface ForwardedToolDef {
  /** Name in der Haupt-Registry: `<subMcpName>.<remoteToolName>`. */
  readonly name: string;
  /** Name am Remote-Sub-MCP (ohne Prefix). */
  readonly remoteName: string;
  readonly subMcpName: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations?: ToolAnnotations;
}

export interface ForwardToolCallArgs {
  readonly subMcpName: string;
  readonly toolName: string;
  readonly input: unknown;
  /**
   * Kurzlebiger user-context-JWT, signed by mcp-approval2.
   * Wird im `X-User-JWT`-Header an den Sub-MCP geliefert.
   */
  readonly userJwt: string;
  /** Optional: Korrelations-ID, gemerged in den JSON-RPC-id-Slot. */
  readonly requestId?: string;
  /** Optional: AbortSignal — wird auf MCP `notifications/cancelled` getriggert. */
  readonly signal?: AbortSignal;
  /**
   * Optional: zusaetzliche Headers (z.B. x-google-access-token, x-gcp-sa-json)
   * vom SubMcpAuthEnricher. Werden nach dem Standard-Header-Set gemerged.
   * Reservierte Namen (authorization, content-type, accept, x-user-jwt) werden
   * NICHT ueberschrieben.
   */
  readonly extraHeaders?: Record<string, string>;
}

/**
 * Strukturierte Fehler beim Forwarding. Caller (Tool-Registry-Dispatch) wickelt
 * die in JSON-RPC-Errors.
 */
export class SubMcpForwardError extends Error {
  public readonly subMcpName: string;
  public readonly status: number | null;
  public override readonly cause: unknown;
  constructor(subMcpName: string, message: string, status: number | null, cause?: unknown) {
    super(`sub-mcp '${subMcpName}' forward failed: ${message}`);
    this.name = 'SubMcpForwardError';
    this.subMcpName = subMcpName;
    this.status = status;
    this.cause = cause;
  }
}

/**
 * Remote-Sub-MCP hat eine JSON-RPC-error-Antwort geliefert (200 + `error`-Feld).
 * Anders als ForwardError ist hier das Network OK — die Tool-Logik selbst hat
 * gemeldet, dass etwas nicht stimmt.
 */
export class SubMcpError extends Error {
  public readonly subMcpName: string;
  public readonly code: number;
  public readonly data: unknown;
  constructor(subMcpName: string, code: number, message: string, data?: unknown) {
    super(`sub-mcp '${subMcpName}' tool error (${code}): ${message}`);
    this.name = 'SubMcpError';
    this.subMcpName = subMcpName;
    this.code = code;
    this.data = data;
  }
}

export class SubMcpNotFoundError extends Error {
  public readonly subMcpName: string;
  constructor(subMcpName: string) {
    super(`sub-mcp '${subMcpName}' not registered or disabled`);
    this.name = 'SubMcpNotFoundError';
    this.subMcpName = subMcpName;
  }
}

/**
 * JSON-RPC-2.0-Response-Shape (von Sub-MCP). Wir parsen nur Top-Level-Felder.
 */
export interface JsonRpcResponse {
  readonly jsonrpc?: '2.0';
  readonly id?: string | number | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
    readonly data?: unknown;
  };
}
