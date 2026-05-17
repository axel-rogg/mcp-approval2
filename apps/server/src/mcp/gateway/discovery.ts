/**
 * Sub-MCP-Tool-Discovery.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4, §9.
 *
 * Lifecycle:
 *   - Externer Cron triggert `POST /internal/v1/sub-mcp/discover` periodisch.
 *   - Pro enabled Sub-MCP: `tools/list`-Call → JSON-Parse → in `tools_cache`
 *     schreiben (registry.updateToolsCache).
 *   - Resultierende Tools werden ueber `buildForwardedToolDefs` in
 *     `ForwardedToolDef[]` umgewandelt; die Haupt-Registry konsumiert das und
 *     legt wrapper-tools an, die `SubMcpForwarder.forwardToolCall` callen.
 *
 * Auth fuer Discovery: das gleiche Service-Token wie fuer tools/call (Schicht 1).
 * Kein User-JWT noetig — discovery ist user-unabhaengig.
 */
import { randomUUID } from 'node:crypto';
import type { JsonSchema, ToolAnnotations } from '../protocol/types.js';
import type { SubMcpRegistry } from './registry.js';
import type {
  ForwardedToolDef,
  JsonRpcResponse,
  SubMcpServerConfig,
  SubMcpToolCacheEntry,
} from './types.js';
import { SubMcpForwardError } from './types.js';

export interface RefreshToolCacheArgs {
  readonly registry: SubMcpRegistry;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /**
   * Optional: nur diese Sub-MCPs refreshen (Default: alle enabled).
   * Useful fuer admin-getriggerte single-server refreshes.
   */
  readonly only?: ReadonlyArray<string>;
}

export interface DiscoveryResult {
  readonly subMcpName: string;
  readonly count: number;
  readonly error?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MCP_ENDPOINT_PATH = '/mcp';

/**
 * Refresh-Hook. Iteriert alle aktiven Sub-MCPs, ruft `tools/list` ab,
 * schreibt in `tools_cache`. Errors pro Server werden gesammelt, nicht
 * thrown — wir wollen, dass ein einzelner kaputter Sub-MCP nicht den
 * ganzen Refresh stoppt.
 */
export async function refreshSubMcpToolCache(args: RefreshToolCacheArgs): Promise<ReadonlyArray<DiscoveryResult>> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const onlySet = args.only ? new Set(args.only) : null;

  const subMcps = await args.registry.listEnabled();
  const filtered = onlySet ? subMcps.filter((s) => onlySet.has(s.name)) : subMcps;

  const results: DiscoveryResult[] = [];
  for (const cfg of filtered) {
    try {
      const { tools, meta } = await fetchToolsListWithMeta(cfg, fetchImpl, timeoutMs);
      await args.registry.updateToolsCache(cfg.id, tools);
      // Phase 2 (PLAN-per-user-server-store): _meta.config_fields + oauth
      // wird in sub_mcp_servers.config_schema gespeichert. updateConfigSchema
      // ist optional auf der Registry — Bestand bleibt funktional.
      if (meta && args.registry.updateConfigSchema) {
        await args.registry.updateConfigSchema(cfg.id, meta);
      }
      results.push({ subMcpName: cfg.name, count: tools.length });
    } catch (err) {
      results.push({
        subMcpName: cfg.name,
        count: 0,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }
  return results;
}

interface FetchToolsResult {
  readonly tools: ReadonlyArray<SubMcpToolCacheEntry>;
  /**
   * `_meta`-Block aus dem tools/list-Result. Enthaelt typischerweise:
   *   - config_fields: Felder die der User pro-Server konfigurieren kann
   *   - oauth: OAuth-Mode + Provider + Scopes
   * Worker die das nicht setzen liefern undefined → kein Drawer-Schema.
   */
  readonly meta?: Record<string, unknown>;
}

async function fetchToolsListWithMeta(
  cfg: SubMcpServerConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<FetchToolsResult> {
  return fetchToolsList(cfg, fetchImpl, timeoutMs);
}

async function fetchToolsList(
  cfg: SubMcpServerConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<FetchToolsResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (cfg.serviceToken) {
    headers['authorization'] = `Bearer ${cfg.serviceToken}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${cfg.baseUrl}${MCP_ENDPOINT_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tools/list',
        params: {},
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new SubMcpForwardError(
      cfg.name,
      err instanceof Error ? err.message : 'fetch failed',
      null,
      err,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new SubMcpForwardError(cfg.name, `tools/list HTTP ${response.status}`, response.status);
  }
  let parsed: JsonRpcResponse;
  try {
    parsed = (await response.json()) as JsonRpcResponse;
  } catch (err) {
    // Try SSE fallback.
    try {
      const text = await response.text();
      const frames = text.split(/\r?\n\r?\n/);
      let last: JsonRpcResponse | null = null;
      for (const f of frames) {
        const dataLines = f
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim());
        if (dataLines.length === 0) continue;
        try {
          const obj = JSON.parse(dataLines.join('\n')) as JsonRpcResponse;
          if (obj.jsonrpc === '2.0') last = obj;
        } catch {
          // ignore
        }
      }
      if (!last) throw new Error('no JSON-RPC frame');
      parsed = last;
    } catch {
      throw new SubMcpForwardError(cfg.name, 'tools/list body not parseable', response.status, err);
    }
  }
  if (parsed.error) {
    throw new SubMcpForwardError(
      cfg.name,
      `tools/list rpc-error: ${parsed.error.message ?? 'unknown'}`,
      response.status,
    );
  }
  const result = parsed.result as
    | { tools?: unknown; _meta?: unknown }
    | null
    | undefined;
  if (!result || !Array.isArray(result.tools)) {
    return { tools: [] };
  }
  const out: SubMcpToolCacheEntry[] = [];
  for (const t of result.tools) {
    if (!t || typeof t !== 'object') continue;
    const rec = t as Record<string, unknown>;
    const recName = rec['name'];
    const name = typeof recName === 'string' ? recName : null;
    if (!name) continue;
    const desc = rec['description'];
    const schema = rec['inputSchema'];
    const ann = rec['annotations'];
    const entry: SubMcpToolCacheEntry = {
      name,
      ...(typeof desc === 'string' ? { description: desc } : {}),
      ...(schema && typeof schema === 'object'
        ? { inputSchema: schema as Record<string, unknown> }
        : {}),
      ...(ann && typeof ann === 'object'
        ? { annotations: ann as Record<string, unknown> }
        : {}),
    };
    out.push(entry);
  }
  const meta =
    result._meta && typeof result._meta === 'object'
      ? (result._meta as Record<string, unknown>)
      : undefined;
  return meta ? { tools: out, meta } : { tools: out };
}

/**
 * Wandelt die in der Registry gecachten Sub-MCP-Tools in `ForwardedToolDef[]`
 * um — die Haupt-Tool-Registry konsumiert das und registriert pro Eintrag
 * ein wrapper-tool, das `forwardToolCall` aufruft.
 *
 * Naming: `<subMcpName>.<remoteToolName>`. Wir validieren NUR, dass das
 * resultierende Name-Pattern dem `validateToolDefinition`-Regex genuegt
 * (lowercase + dot/underscore/colon). Falls ein Remote-Tool ein invalides
 * Zeichen enthaelt, wird es uebersprungen (geloggt in `skipped`).
 */
export function buildForwardedToolDefs(
  cfg: SubMcpServerConfig,
): {
  readonly defs: ReadonlyArray<ForwardedToolDef>;
  readonly skipped: ReadonlyArray<string>;
} {
  const NAME_RE = /^[a-z][a-z0-9_.:-]{0,79}$/;
  const defs: ForwardedToolDef[] = [];
  const skipped: string[] = [];
  for (const tool of cfg.toolsCache ?? []) {
    const fullName = `${cfg.name}.${tool.name}`;
    if (!NAME_RE.test(fullName)) {
      skipped.push(fullName);
      continue;
    }
    const inputSchema: JsonSchema =
      tool.inputSchema && typeof tool.inputSchema === 'object'
        ? (tool.inputSchema as JsonSchema)
        : ({ type: 'object', properties: {}, additionalProperties: true } as JsonSchema);
    const ann = (tool.annotations as ToolAnnotations | undefined) ?? undefined;
    const def: ForwardedToolDef = {
      name: fullName,
      remoteName: tool.name,
      subMcpName: cfg.name,
      description: tool.description ?? `Forwarded ${cfg.name} tool: ${tool.name}`,
      inputSchema,
      ...(ann ? { annotations: ann } : {}),
    };
    defs.push(def);
  }
  return { defs, skipped };
}
