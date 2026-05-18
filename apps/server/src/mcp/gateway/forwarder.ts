/**
 * Sub-MCP-HTTP-Forwarder (MCP-Streamable-HTTP, `tools/call`).
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4, §9.
 *
 * Verantwortung:
 *   - JSON-RPC-2.0-Envelope um den Tool-Call wickeln.
 *   - Headers: `Authorization: Bearer <serviceToken>` (Schicht 1),
 *     `X-User-JWT: <userJwt>` (Schicht 2). `Accept: application/json,
 *     text/event-stream` damit Streamable-HTTP-Server happy sind.
 *   - 2xx ohne `error` → result returnen.
 *   - 4xx/5xx → SubMcpForwardError.
 *   - JSON-RPC-error im Body → SubMcpError.
 *
 * Wir machen kein Initialize-Handshake pro Call — Streamable-HTTP-Server muessen
 * stateless tools/call akzeptieren. Falls ein konkreter Sub-MCP-Server das nicht
 * tut, ist das ein Konfig-Issue dort, nicht im Gateway.
 */
import { randomUUID } from 'node:crypto';
import type { SubMcpRegistry } from './registry.js';
import {
  type ForwardToolCallArgs,
  type JsonRpcResponse,
  SubMcpError,
  SubMcpForwardError,
} from './types.js';

export interface SubMcpForwarderOptions {
  readonly registry: SubMcpRegistry;
  readonly fetchImpl?: typeof fetch;
  /**
   * Timeout pro Forward (Default 30s). Sub-MCP-Tools koennen langsam sein
   * (externe APIs), aber wir wollen kein Hang fuer den Caller.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
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
    // Fallback unten
  }
  return `${baseUrl}${MCP_ENDPOINT_PATH}`;
}

export class SubMcpForwarder {
  private readonly registry: SubMcpRegistry;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: SubMcpForwarderOptions) {
    this.registry = opts.registry;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Forward `tools/call` an einen Sub-MCP. Wirft:
   *   - SubMcpNotFoundError (aus registry.getByName)
   *   - SubMcpForwardError  (network/HTTP-status problems)
   *   - SubMcpError         (JSON-RPC-error im Body)
   */
  async forwardToolCall(args: ForwardToolCallArgs): Promise<unknown> {
    const cfg = await this.registry.getByName(args.subMcpName);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-user-jwt': args.userJwt,
    };
    if (cfg.serviceToken) {
      headers['authorization'] = `Bearer ${cfg.serviceToken}`;
    }
    // Auth-Enricher kann zusaetzliche per-User-Header injizieren
    // (z.B. x-google-access-token fuer gws, x-gcp-sa-json fuer gcloud).
    // Siehe services/sub-mcp-auth-enricher.ts. Header-Namen sind lowercase.
    if (args.extraHeaders) {
      for (const [k, v] of Object.entries(args.extraHeaders)) {
        // case-insensitive replace: HTTP-Header sind case-insensitive,
        // wir overwriten nicht das Standard-Set (authorization/content-type/etc).
        const lower = k.toLowerCase();
        if (lower === 'authorization' || lower === 'content-type' || lower === 'accept' || lower === 'x-user-jwt') {
          continue;
        }
        headers[lower] = v;
      }
    }

    const rpcId = args.requestId ?? randomUUID();
    const payload = {
      jsonrpc: '2.0' as const,
      id: rpcId,
      method: 'tools/call',
      params: {
        name: args.toolName,
        arguments: args.input ?? {},
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const upstreamAbort = (): void => controller.abort();
    if (args.signal) {
      if (args.signal.aborted) controller.abort();
      else args.signal.addEventListener('abort', upstreamAbort, { once: true });
    }

    const mcpUrl = buildMcpUrl(cfg.baseUrl);
    let response: Response;
    try {
      response = await this.fetchImpl(mcpUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      // Streamable-HTTP: stateful Server (z.B. CF) verlangen `Mcp-Session-Id`.
      // Bei 400 mit "session required": initialize → retry mit session-id-Header.
      if (response.status === 400) {
        const probeText = await response.text();
        const needsSession = /mcp-session-id|session.+required/i.test(probeText);
        if (needsSession) {
          const sessionId = await this.initializeSession(args.subMcpName, mcpUrl, headers, controller.signal);
          const retryHeaders = { ...headers, 'mcp-session-id': sessionId };
          response = await this.fetchImpl(mcpUrl, {
            method: 'POST',
            headers: retryHeaders,
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
        } else {
          response = new Response(probeText, { status: 400, headers: response.headers });
        }
      }
    } catch (err) {
      clearTimeout(timer);
      if (args.signal) args.signal.removeEventListener('abort', upstreamAbort);
      throw new SubMcpForwardError(
        args.subMcpName,
        err instanceof Error ? err.message : 'fetch failed',
        null,
        err,
      );
    }
    clearTimeout(timer);
    if (args.signal) args.signal.removeEventListener('abort', upstreamAbort);

    if (!response.ok) {
      let bodyText = '';
      try {
        bodyText = await response.text();
      } catch {
        bodyText = '<unreadable>';
      }
      throw new SubMcpForwardError(
        args.subMcpName,
        `HTTP ${response.status}: ${bodyText.slice(0, 256)}`,
        response.status,
      );
    }

    // Streamable-HTTP-Server koennen text/event-stream zurueckgeben — fuer den
    // Single-Response-Fall in tools/call extrahieren wir das letzte data-Event.
    // Der Einfachheit halber: wenn application/json → direkt parsen, sonst
    // SSE-Frames durchlaufen.
    const contentType = response.headers.get('content-type') ?? '';
    let parsed: JsonRpcResponse;
    if (contentType.includes('application/json')) {
      try {
        parsed = (await response.json()) as JsonRpcResponse;
      } catch (err) {
        throw new SubMcpForwardError(
          args.subMcpName,
          'response body is not valid JSON',
          response.status,
          err,
        );
      }
    } else if (contentType.includes('text/event-stream')) {
      const sseText = await response.text();
      parsed = parseSseRpc(args.subMcpName, sseText, response.status);
    } else {
      // Fallback: versuche JSON.
      try {
        const text = await response.text();
        parsed = JSON.parse(text) as JsonRpcResponse;
      } catch (err) {
        throw new SubMcpForwardError(
          args.subMcpName,
          `unsupported content-type '${contentType}'`,
          response.status,
          err,
        );
      }
    }

    if (parsed.error) {
      const code = typeof parsed.error.code === 'number' ? parsed.error.code : -32603;
      const message = parsed.error.message ?? 'unknown remote tool error';
      throw new SubMcpError(args.subMcpName, code, message, parsed.error.data);
    }
    return parsed.result;
  }

  /**
   * Streamable-HTTP `initialize`-Handshake. Liest `Mcp-Session-Id` aus den
   * Response-Headern. Identisch zu discovery.ts:initializeMcpSession — wir
   * koennen das spaeter in einen shared helper extrahieren wenn weitere
   * Stellen den Handshake brauchen.
   */
  private async initializeSession(
    subMcpName: string,
    mcpUrl: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<string> {
    const resp = await this.fetchImpl(mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'mcp-approval2', version: '1.0.0' },
        },
      }),
      signal,
    });
    if (!resp.ok) {
      const txt = (await resp.text().catch(() => '')).slice(0, 200);
      throw new SubMcpForwardError(
        subMcpName,
        `initialize HTTP ${resp.status} body=${txt}`,
        resp.status,
      );
    }
    const sessionId =
      resp.headers.get('mcp-session-id') ?? resp.headers.get('Mcp-Session-Id');
    if (!sessionId) {
      throw new SubMcpForwardError(
        subMcpName,
        'initialize ok but no Mcp-Session-Id header',
        resp.status,
      );
    }
    await resp.text().catch(() => '');
    return sessionId;
  }
}

/**
 * Parsen einer SSE-Antwort (text/event-stream) auf die einzelne JSON-RPC-
 * Response. Wir suchen das LETZTE `data:`-Frame mit gleichem rpcId, oder
 * einfach das letzte Frame, das ein JSON-RPC-2.0-Envelope ist. MCP-Spec sagt
 * fuer one-shot tools/call ist genau ein response-frame zu erwarten.
 */
function parseSseRpc(subMcpName: string, sseText: string, status: number): JsonRpcResponse {
  const frames = sseText.split(/\r?\n\r?\n/);
  let last: JsonRpcResponse | null = null;
  for (const frame of frames) {
    if (!frame.trim()) continue;
    const dataLines = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter((l) => l.length > 0);
    if (dataLines.length === 0) continue;
    const joined = dataLines.join('\n');
    try {
      const obj = JSON.parse(joined) as JsonRpcResponse;
      if (obj.jsonrpc === '2.0') {
        last = obj;
      }
    } catch {
      // ignore non-JSON frames
    }
  }
  if (!last) {
    throw new SubMcpForwardError(
      subMcpName,
      'SSE response did not contain a JSON-RPC-2.0 frame',
      status,
    );
  }
  return last;
}
