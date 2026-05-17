/**
 * KC2-Manifest-Client — talk to mcp-knowledge2's /mcp endpoint (tools/list).
 *
 * Plan-Ref: PLAN-as3-autonomous.md §1.4 + A8 (Auto-Generator).
 *
 * Wire-Shape: JSON-RPC 2.0 ueber Streamable-HTTP-Transport.
 *
 *   Request:
 *     POST /mcp
 *     Authorization: Bearer <SERVICE_TOKEN>
 *     Accept: application/json, text/event-stream
 *     Content-Type: application/json
 *
 *     {"jsonrpc":"2.0","id":1,"method":"tools/list"}
 *
 *   Response (JSON body):
 *     {"jsonrpc":"2.0","id":1,"result":{"tools":[...], "nextCursor":...}}
 *
 * Auth: SERVICE_TOKEN-only fuer Manifest-Read (KC2 trusts the bearer for
 * tools/list — kein OBO noetig, ist Admin/System-Call).
 *
 * Cache + Refresh:
 *   - Caller (kc_wrappers/index.ts) cached die Liste.
 *   - 5-min Refresh-Cron rebuilt + ersetzt die Wrappers (cron/kc-manifest-refresh.ts).
 *   - Bei `MCP_KNOWLEDGE_URL` unreach beim Boot: graceful, log warning, leeres
 *     Manifest.
 */
import type { ToolAnnotations, JsonSchema } from '../../mcp/protocol/types.js';

export interface KcToolManifestEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations?: ToolAnnotations & {
    readonly write?: boolean;
    readonly user_content?: boolean;
  };
}

export interface KcManifest {
  readonly tools: ReadonlyArray<KcToolManifestEntry>;
  readonly fetchedAt: number;
}

export interface FetchManifestArgs {
  readonly knowledgeUrl: string;
  readonly serviceToken: string;
  readonly fetchImpl?: typeof fetch;
  /** Default 5000ms — KC2-Boot-Race-Margin. */
  readonly timeoutMs?: number;
}

/**
 * Holt das aktuelle Tool-Manifest von KC2. Wirft bei jeder Art von Fehler
 * (network, non-2xx, parse) — der Caller (`buildKcWrappers`) muss das
 * graceful fangen.
 */
export async function fetchKcManifest(args: FetchManifestArgs): Promise<KcManifest> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? 5000;
  const url = `${args.knowledgeUrl.replace(/\/+$/, '')}/mcp`;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.serviceToken}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    throw new Error(`KC2 tools/list HTTP ${resp.status}`);
  }
  const text = await resp.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`KC2 tools/list invalid JSON: ${(err as Error).message}`);
  }
  if (!isJsonRpcSuccess(parsed)) {
    throw new Error(
      `KC2 tools/list malformed jsonrpc: ${JSON.stringify(parsed).slice(0, 200)}`,
    );
  }
  const result = parsed.result as { tools?: unknown };
  if (!result || !Array.isArray(result.tools)) {
    throw new Error(`KC2 tools/list missing tools[]`);
  }
  const tools: KcToolManifestEntry[] = [];
  for (const raw of result.tools) {
    if (!isToolEntry(raw)) continue;
    tools.push(raw);
  }
  return { tools, fetchedAt: Date.now() };
}

function isJsonRpcSuccess(
  v: unknown,
): v is { jsonrpc: string; id: unknown; result: unknown } {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    'result' in v
  );
}

function isToolEntry(v: unknown): v is KcToolManifestEntry {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t['name'] === 'string' &&
    typeof t['description'] === 'string' &&
    typeof t['inputSchema'] === 'object' &&
    t['inputSchema'] !== null
  );
}
