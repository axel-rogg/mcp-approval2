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
  /**
   * Optional: Auth-Enricher fuer OAuth-basierte Sub-MCPs (GitHub etc.).
   * Wenn gesetzt + operatorUserId vorhanden, fragt Discovery den Enricher
   * nach Authorization-Headern pro Server. Ohne Enricher faellt sie auf
   * statisches `cfg.serviceToken` zurueck (Default fuer utils/gws/gcloud).
   */
  readonly authEnricher?: import('../../services/sub-mcp-auth-enricher.js').SubMcpAuthEnricher;
  /**
   * User-ID dessen Refresh-Token fuer OAuth-Discovery genommen wird.
   * Solo-Pilot: erster authorisierter User. Multi-User-Cron: kann pro
   * Tick rotieren oder einen designated operator nehmen.
   */
  readonly operatorUserId?: string;
}

export interface DiscoveryResult {
  readonly subMcpName: string;
  readonly count: number;
  readonly error?: string;
}

export interface UserDiscoveryArgs {
  readonly userId: string;
  readonly registry: SubMcpRegistry;
  readonly authEnricher: import('../../services/sub-mcp-auth-enricher.js').SubMcpAuthEnricher;
  readonly toolCache: import('../../services/user-sub-mcp-tool-cache.js').UserSubMcpToolCacheService;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Nur diese Sub-MCPs (Default: alle enabled mit auth_mode='oauth' ODER mit innerOAuth). */
  readonly only?: ReadonlyArray<string>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MCP_ENDPOINT_PATH = '/mcp';

/**
 * Wenn baseUrl bereits einen Pfad enthaelt (z.B. github-MCP:
 * `https://api.githubcopilot.com/mcp/`), ist baseUrl die volle Endpoint-URL —
 * KEIN `/mcp`-Append. Sonst (Origin-only wie utils/gws/gcloud) `/mcp` anhaengen.
 */
function buildMcpUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    if (u.pathname && u.pathname !== '/') return baseUrl;
  } catch {
    // ignore — Fallback unten
  }
  return `${baseUrl}${MCP_ENDPOINT_PATH}`;
}

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
      // OAuth-aware Discovery: wenn ein Enricher uebergeben wurde + ein
      // operatorUserId, schiesse den Enricher per-Server und uebergib die
      // Headers an fetchToolsList. Bei utils/gcloud/gws bleibt es beim
      // statischen cfg.serviceToken-Pfad (Enricher returnt {} fuer 'none').
      let extraHeaders: Record<string, string> | undefined;
      if (args.authEnricher && args.operatorUserId) {
        try {
          extraHeaders = await args.authEnricher.enrich({
            userId: args.operatorUserId,
            subMcpName: cfg.name,
          });
        } catch {
          // Enricher-Fail (z.B. refresh-token revoked) ist non-fatal —
          // wir versuchen es ohne und lassen tools/list 401-en damit der
          // Error-Status korrekt im Audit landet.
        }
      }
      const { tools, meta } = await fetchToolsListWithMeta(cfg, fetchImpl, timeoutMs, extraHeaders);
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

/**
 * Per-User Discovery fuer OAuth-basierte Sub-MCPs.
 *
 * Plan-Ref: Sprint 2026-05-18 — Per-User-OAuth-Pipeline.
 *
 * Iteriert alle enabled Sub-MCPs, holt fuer den uebergebenen User pro Server
 * einen access_token via enricher, ruft tools/list, schreibt das Resultat in
 * user_sub_mcp_tool_cache. Wenn der enricher fuer einen Server `{}` zurueck-
 * liefert (kein User-Token gesetzt) → Server wird uebersprungen (kein
 * Discovery-Versuch, Result hat error='no_user_credentials').
 *
 * Im Gegensatz zu refreshSubMcpToolCache (global cache, fuer service_bearer-
 * Server) ist DIESE Function User-bezogen — jeder User bekommt eigenen Cache.
 *
 * Aufrufer:
 *   - user-server-oauth.ts:callback() nach erfolgreichem Token-Exchange
 *   - PWA-Trigger ("Refresh Tools" pro User)
 *   - Cron (optional, alle User mit recent activity)
 */
export async function refreshUserSubMcpToolCache(
  args: UserDiscoveryArgs,
): Promise<ReadonlyArray<DiscoveryResult>> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const onlySet = args.only ? new Set(args.only) : null;

  const subMcps = await args.registry.listEnabled();
  const filtered = subMcps.filter((s) => {
    if (onlySet) return onlySet.has(s.name);
    // Default: nur OAuth-Server oder Server mit inner-OAuth (gws/gcloud).
    // service_bearer ohne inner-OAuth (utils) wird global discovered, hier
    // ueberspringen.
    if (s.authMode === 'oauth') return true;
    const schema = s.configSchema as { oauth?: unknown } | null;
    return !!schema?.oauth;
  });

  const results: DiscoveryResult[] = [];
  for (const cfg of filtered) {
    let extraHeaders: Record<string, string> = {};
    try {
      extraHeaders = await args.authEnricher.enrich({
        userId: args.userId,
        subMcpName: cfg.name,
      });
    } catch (err) {
      results.push({
        subMcpName: cfg.name,
        count: 0,
        error: `enricher: ${err instanceof Error ? err.message : 'unknown'}`,
      });
      continue;
    }
    if (Object.keys(extraHeaders).length === 0) {
      // Kein User-Token → User hat noch keinen OAuth-Flow durchlaufen.
      // Kein Fehler, nur skip (PWA zeigt "Verbinden" Button).
      results.push({
        subMcpName: cfg.name,
        count: 0,
        error: 'no_user_credentials',
      });
      continue;
    }
    try {
      const { tools } = await fetchToolsList(cfg, fetchImpl, timeoutMs, extraHeaders);
      await args.toolCache.write({
        userId: args.userId,
        subMcpId: cfg.id,
        subMcpName: cfg.name,
        tools: tools.map((t) => {
          const entry: {
            name: string;
            description?: string;
            inputSchema?: Record<string, unknown>;
            annotations?: Record<string, unknown>;
          } = { name: t.name };
          if (t.description !== undefined) entry.description = t.description;
          if (t.inputSchema !== undefined) entry.inputSchema = t.inputSchema;
          if (t.annotations !== undefined) entry.annotations = t.annotations;
          return entry;
        }),
      });
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
  extraHeaders?: Record<string, string>,
): Promise<FetchToolsResult> {
  return fetchToolsList(cfg, fetchImpl, timeoutMs, extraHeaders);
}

async function fetchToolsList(
  cfg: SubMcpServerConfig,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  extraHeaders?: Record<string, string>,
): Promise<FetchToolsResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (cfg.serviceToken) {
    headers['authorization'] = `Bearer ${cfg.serviceToken}`;
  }
  // Enricher-Headers ueberschreiben die statischen — OAuth-Bearer-
  // Authorization gewinnt gegen leeren cfg.serviceToken.
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers[k.toLowerCase()] = v;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(buildMcpUrl(cfg.baseUrl), {
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
  // Body EINMAL als Text lesen — response.json() konsumiert den Body, danach
  // schlaegt response.text() im SSE-Fallback mit "body already read" fehl.
  const bodyText = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  let parsed: JsonRpcResponse | null = null;
  try {
    parsed = JSON.parse(bodyText) as JsonRpcResponse;
  } catch {
    // Try SSE fallback.
    const frames = bodyText.split(/\r?\n\r?\n/);
    for (const f of frames) {
      const dataLines = f
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
      if (dataLines.length === 0) continue;
      try {
        const obj = JSON.parse(dataLines.join('\n')) as JsonRpcResponse;
        if (obj.jsonrpc === '2.0') parsed = obj;
      } catch {
        // ignore
      }
    }
    if (!parsed) {
      // eslint-disable-next-line no-console
      console.error('[discovery] body not parseable', {
        subMcp: cfg.name,
        status: response.status,
        contentType,
        bodySnippet: bodyText.slice(0, 500),
      });
      throw new SubMcpForwardError(
        cfg.name,
        `tools/list body not parseable (ct=${contentType}, snippet=${bodyText.slice(0, 200)})`,
        response.status,
      );
    }
  }
  // TS-Narrow: an dieser Stelle hat der try/catch entweder parsed gesetzt
  // ODER mit SubMcpForwardError gethrown — parsed kann hier nicht null sein.
  if (!parsed) {
    throw new SubMcpForwardError(cfg.name, 'tools/list body not parseable (null)', response.status);
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
