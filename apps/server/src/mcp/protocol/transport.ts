/**
 * MCP Streamable-HTTP Transport.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2 (Architektur-Uebersicht — MCP-
 * Streamable-HTTP, OAuth 2.1 + PKCE), §11 Phase 4 (MCP-Protocol).
 *
 * Endpunkte:
 *   POST /mcp        — Single-Request/Response (JSON-RPC 2.0)
 *   GET  /mcp/sse    — Server-Sent-Events fuer server-initiated messages
 *                      (future: tools/list-changed, log streaming).
 *                      Phase 4: minimaler 200-OK-Stream, der nur Heartbeats
 *                      und nichts weiter sendet. Hook fuer Burst-3+ vorbereitet.
 *
 * Auth: jede Methode (ausser `initialize` + `ping`) erfordert einen guelti-
 * gen Bearer-Token (OAuth-2.1-Resource-Server). Token-`aud`-Claim muss zu
 * unserem JWT_AUDIENCE matchen (RFC 8707 Resource-Indicator).
 *
 * Cancellation: ein `notifications/cancelled` mit `params.requestId`
 * triggert den AbortController fuer den laufenden Tool-Call. In Phase 4
 * halten wir einen pro-Connection-Cancel-Registry — der Transport pfeift
 * ueber `AbortController.signal` an Tools durch.
 *
 * Async-Tool-Streaming: noch nicht implementiert. Long-running Tools muessen
 * unter `SESSION_TTL_SEC` bleiben oder via Approval-Polling-Pattern laufen.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type {
  AppBindings,
  ServerContext,
  SessionPrincipal,
} from '../../lib/context.js';
import { HttpError } from '../../lib/errors.js';
import { auth } from '../../middleware/auth.js';
import { emitAudit } from '../../services/audit.js';
import { ToolRegistry, type DispatchResult } from './registry.js';
import {
  McpMethods,
  error as rpcError,
  mapErrorToJsonRpc,
  parseIncoming,
  success as rpcSuccess,
} from './messages.js';
import type { AuditService, ToolContext } from './tool.js';
import {
  JsonRpcErrorCode,
  MCP_PROTOCOL_VERSION,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccess,
  type ResourcesListResult,
  type ResourcesReadParams,
  type ToolsCallParams,
  type ToolsListResult,
} from './types.js';

// ============================================================================
// Public types
// ============================================================================

export interface McpTransportOptions {
  readonly server: ServerContext;
  readonly registry: ToolRegistry;
  /** Override fuer `serverInfo.name`. Default: `mcp-approval2`. */
  readonly serverName?: string;
  /** Override fuer `serverInfo.version`. Default: `0.0.1`. */
  readonly serverVersion?: string;
}

// ============================================================================
// Param-Schemas (lokal — Tools haben eigene Schemas in ihren Defs)
// ============================================================================

const InitializeParamsSchema = z.object({
  protocolVersion: z.string(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  clientInfo: z
    .object({
      name: z.string(),
      version: z.string(),
    })
    .optional(),
});

const ToolsCallParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const ResourcesReadParamsSchema = z.object({
  uri: z.string().min(1),
});

// ============================================================================
// Cancel-Registry — pro Server-Instance
// ============================================================================

/**
 * Map: jsonrpc-request-id (als String) → AbortController. Wird bei
 * `notifications/cancelled` getriggert.
 *
 * Tradeoff: in-memory, kein Multi-Worker-State-Sharing. Bei horizontaler
 * Skalierung (mehrere Hono-Worker hinter LB) wird cancel best-effort
 * (Worker der den Call hat, faengt es; andere Worker ignorieren).
 * Phase 4 ist Single-Worker; Multi-Worker-Cancellation-State ist Phase 6+.
 */
class CancelRegistry {
  private readonly map = new Map<string, AbortController>();

  start(id: string): AbortController {
    const ctrl = new AbortController();
    this.map.set(id, ctrl);
    return ctrl;
  }

  cancel(id: string, reason?: string): boolean {
    const ctrl = this.map.get(id);
    if (!ctrl) return false;
    ctrl.abort(reason ?? 'cancelled');
    this.map.delete(id);
    return true;
  }

  finish(id: string): void {
    this.map.delete(id);
  }
}

// ============================================================================
// Router
// ============================================================================

export function mcpTransport(opts: McpTransportOptions): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const { server, registry } = opts;
  const serverName = opts.serverName ?? 'mcp-approval2';
  const serverVersion = opts.serverVersion ?? '0.0.1';
  const cancels = new CancelRegistry();

  // -------------------------------------------------------------------------
  // POST /mcp — JSON-RPC 2.0 single request/response
  // -------------------------------------------------------------------------
  app.post('/mcp', auth(server, { required: true }), async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      const resp = rpcError(null, JsonRpcErrorCode.ParseError, 'invalid JSON body');
      return c.json(resp, 200);
    }

    const parsed = parseIncoming(raw);

    if (parsed.kind === 'parse_error' || parsed.kind === 'invalid_request') {
      return c.json(parsed.response, 200);
    }

    if (parsed.kind === 'notification') {
      const note = parsed.notification;
      handleNotification(note.method, note.params, cancels);
      // JSON-RPC notifications: keine Response — wir liefern 204.
      return c.body(null, 204);
    }

    const req = parsed.request;
    const response = await dispatchRequest(req, {
      registry,
      cancels,
      principal: c.get('user') as SessionPrincipal,
      requestId: c.get('requestId'),
      server,
      serverName,
      serverVersion,
    });
    return c.json(response, 200);
  });

  // -------------------------------------------------------------------------
  // GET /mcp/sse — Server-Sent-Events for server-initiated messages
  // -------------------------------------------------------------------------
  app.get('/mcp/sse', auth(server, { required: true }), async (c) => {
    // Minimaler SSE-Stream: alle 30s ein heartbeat-comment. Burst-3+ wird
    // hier echte tools/list_changed, log-events, progress-events pushen.
    const stream = makeSseStream(c);
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  return app;
}

// ============================================================================
// Request-Dispatch (testbar standalone)
// ============================================================================

interface DispatchEnv {
  readonly registry: ToolRegistry;
  readonly cancels: CancelRegistry;
  readonly principal: SessionPrincipal;
  readonly requestId: string;
  readonly server: ServerContext;
  readonly serverName: string;
  readonly serverVersion: string;
}

async function dispatchRequest(
  req: JsonRpcRequest,
  env: DispatchEnv,
): Promise<JsonRpcResponse> {
  // initialize ist Auth-pflichtig (Bearer-Token war schon validated via Middleware),
  // aber wir lassen kein "first-time"-Trust zu.
  switch (req.method) {
    case McpMethods.Initialize: {
      return handleInitialize(req, env);
    }
    case McpMethods.Ping: {
      return rpcSuccess(req.id, {});
    }
    case McpMethods.ToolsList: {
      const result: ToolsListResult = { tools: env.registry.list() };
      return rpcSuccess(req.id, result);
    }
    case McpMethods.ToolsCall: {
      return handleToolsCall(req, env);
    }
    case McpMethods.ResourcesList: {
      // Stub — Phase 4 returnt leere Liste. Phase 5 wird Resources via
      // mcp-knowledge2 anbinden.
      const result: ResourcesListResult = { resources: [] };
      return rpcSuccess(req.id, result);
    }
    case McpMethods.ResourcesRead: {
      const parsed = ResourcesReadParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        return rpcError(req.id, JsonRpcErrorCode.InvalidParams, 'invalid params');
      }
      // Stub: no resources configured.
      const params: ResourcesReadParams = parsed.data;
      return rpcError(
        req.id,
        JsonRpcErrorCode.ResourceNotFound,
        `resource not found: ${params.uri}`,
      );
    }
    default: {
      return rpcError(req.id, JsonRpcErrorCode.MethodNotFound, `method not found: ${req.method}`);
    }
  }
}

function handleInitialize(req: JsonRpcRequest, env: DispatchEnv): JsonRpcResponse {
  const parsed = InitializeParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return rpcError(req.id, JsonRpcErrorCode.InvalidParams, 'invalid initialize params');
  }
  const _params: InitializeParams = {
    protocolVersion: parsed.data.protocolVersion,
    capabilities: (parsed.data.capabilities ?? {}) as InitializeParams['capabilities'],
    clientInfo: parsed.data.clientInfo ?? { name: 'unknown', version: '0' },
  };
  // Wir akzeptieren jeden Protocol-Version-String des Clients und liefern
  // unsere eigene zurueck. Strikte Negotiation kommt in Burst 3.
  const result: InitializeResult = {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
    },
    serverInfo: {
      name: env.serverName,
      version: env.serverVersion,
    },
  };
  void _params; // intentionally unused — fuer Logging/Capability-Negotiation Burst-3
  return rpcSuccess(req.id, result);
}

async function handleToolsCall(
  req: JsonRpcRequest,
  env: DispatchEnv,
): Promise<JsonRpcResponse> {
  const parsed = ToolsCallParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return rpcError(req.id, JsonRpcErrorCode.InvalidParams, 'invalid tools/call params', {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.map((p) => String(p)),
        message: i.message,
      })),
    });
  }
  const params: ToolsCallParams = {
    name: parsed.data.name,
    ...(parsed.data.arguments ? { arguments: parsed.data.arguments } : {}),
  };

  // Cancel-Registry: id muss vorhanden sein (Notifications haben keine id —
  // tools/call ist Request → id Pflicht).
  const cancelKey = req.id !== null && req.id !== undefined ? String(req.id) : `auto-${env.requestId}`;
  const ctrl = env.cancels.start(cancelKey);

  const toolCtx: ToolContext = {
    userId: env.principal.userId,
    email: env.principal.email,
    role: env.principal.role,
    requestId: env.requestId,
    audit: makeAuditService(env),
    db: env.server.db,
    signal: ctrl.signal,
  };

  let dispatchResult: DispatchResult;
  try {
    dispatchResult = await env.registry.dispatch({
      name: params.name,
      input: params.arguments ?? {},
      ctx: toolCtx,
    });
  } catch (err) {
    env.cancels.finish(cancelKey);
    return mapErrorToJsonRpc(req.id, err);
  } finally {
    env.cancels.finish(cancelKey);
  }

  const ok: JsonRpcSuccess = rpcSuccess(req.id, dispatchResult.result);
  return ok;
}

function handleNotification(
  method: string,
  params: unknown,
  cancels: CancelRegistry,
): void {
  if (method === McpMethods.Cancelled) {
    if (params && typeof params === 'object') {
      const id = (params as { requestId?: unknown }).requestId;
      if (typeof id === 'string' || typeof id === 'number') {
        cancels.cancel(String(id), 'client cancelled');
      }
    }
    return;
  }
  if (method === McpMethods.Initialized) {
    // No-op — Client signalt ready. Wir tun nichts (keine pending state).
    return;
  }
  // Unbekannte Notifications werden absichtlich verworfen — JSON-RPC-Spec.
}

// ============================================================================
// AuditService-Adapter
// ============================================================================

function makeAuditService(env: DispatchEnv): AuditService {
  return {
    async emit(event) {
      await emitAudit(env.server.db, {
        action: event.action,
        actorUserId: event.actorUserId,
        result: event.result,
        ...(event.requestId ? { requestId: event.requestId } : {}),
        details: {
          ...(event.resourceKind ? { resource_kind: event.resourceKind } : {}),
          ...(event.resourceId ? { resource_id: event.resourceId } : {}),
          ...(event.details ?? {}),
        },
      });
    },
  };
}

// ============================================================================
// SSE-Helper
// ============================================================================

function makeSseStream(_c: Context<AppBindings>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Initial comment, dann Heartbeat-Loop. Cleanup via cancel().
      controller.enqueue(encoder.encode(': mcp-sse-stream-open\n\n'));
      const interval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
        } catch {
          clearInterval(interval);
        }
      }, 30_000);
      // Cleanup via close-Event ist environment-spezifisch — wir verlassen uns auf
      // controller.error/close vom Konsumenten.
      (controller as unknown as { _interval?: NodeJS.Timeout })._interval = interval;
    },
    cancel(reason) {
      // Bei Client-Disconnect: ReadableStream.cancel ruft hier auf. Cleanup
      // des Heartbeat-Timers waere ideal, aber wir haben keinen sauberen Handle.
      void reason;
    },
  });
}

// ============================================================================
// Convenience: HTTP-Error-Mapping fuer Auth-Failures auf Transport-Ebene
// ============================================================================

/**
 * Wenn die Auth-Middleware wirft (z.B. fehlender Bearer-Token), bekommt der
 * Client einen 401-JSON aus dem Global-Error-Handler. Wir konvertieren das
 * NICHT zu JSON-RPC, weil OAuth-2.1-Resource-Server-Spec klassische
 * `WWW-Authenticate`-Header verlangt.
 *
 * Falls wir doch in den JSON-RPC-Wire-Shape zwingen wollen: dieser Helper
 * existiert; wird Phase-4-default nicht aufgerufen.
 */
export function httpErrorToJsonRpc(err: HttpError, id: unknown = null): JsonRpcError {
  const code =
    err.status === 401 ? JsonRpcErrorCode.Unauthorized : JsonRpcErrorCode.Forbidden;
  return rpcError(id as null, code, err.message, err.details);
}
