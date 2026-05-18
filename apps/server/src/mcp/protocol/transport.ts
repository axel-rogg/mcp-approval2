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
import { ApprovalRequiredError, type AuditService, type ToolContext } from './tool.js';
import { enqueueApproval } from './approval-resume.js';
import type { ApprovalService } from '../../services/approvals.js';
import type { ToolDefaultsService } from '../../services/tool-defaults.js';
import { PrfRequiredError } from '../../services/credentials.js';
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
  /**
   * Optional: ApprovalService. Wenn gesetzt, fangen wir `ApprovalRequiredError`
   * aus dem Dispatcher ab → enqueueApproval → JSON-RPC success-Response mit
   * `approval_required: true`. Sonst (Tests ohne ApprovalService) wird der
   * Error wie bisher in einen JSON-RPC-Error gemapped.
   */
  readonly approvals?: ApprovalService;
  /**
   * Optional: Per-User-Subscription-Filter fuer tools/list. Wenn gesetzt,
   * werden Sub-MCP-Wrapper-Tools nur dann fuer einen User in tools/list
   * gezeigt, wenn er den jeweiligen Server subscribed hat. Native Tools +
   * KC-Wrapper-Tools sind nie gefiltert (immer sichtbar fuer authorisierte
   * User).
   *
   * Implementation: liefert pro userId die Server-Namen-Whitelist. Wenn
   * undefined zurueckgegeben wird → Filter ausgeschaltet (zeige alles).
   */
  readonly subscriptionFilter?: (
    userId: string,
  ) => Promise<ReadonlySet<string> | null>;
  /**
   * Optional: Set bekannter Sub-MCP-Server-Namen (z.B. ['cf', 'github',
   * 'gws', 'gcloud', 'utils']). Wird beim subscriptionFilter genutzt um zu
   * entscheiden ob ein Tool-Name wie 'cf.kv_list' zu einem Sub-MCP gehoert
   * oder ein nativer Tool ist. Wenn nicht gesetzt → Filter ausgeschaltet.
   */
  readonly subMcpServerNames?: () => Promise<ReadonlySet<string>>;
  /**
   * Optional: Tool-Defaults-Resolver (Plan-Ref: PLAN-tool-defaults-v2.md
   * Phase A). Wenn gesetzt, mergt der Transport vor jedem tools/call die
   * gespeicherten Per-User-Defaults in `params.arguments` (Args-WIN) und
   * persistiert eine Attribution-Liste in `pending_approvals.defaults_applied`.
   *
   * Resume-Pfad nutzt den Resolver NICHT — der `toolInput`-Snapshot in der
   * Approval-Row haelt bereits die resolved Args; Re-Resolve waere Drift-Risiko.
   *
   * Wenn `undefined` → Transport laeuft wie Pre-Phase-A (kein Merge).
   */
  readonly toolDefaults?: ToolDefaultsService;
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
  /**
   * Resume-Pfad: wenn die PWA approved hat, schickt der Client die
   * `approval_id` mit. Wir laden die Approval, pruefen ownership + status, und
   * dispatchen mit `bypassApproval: true`.
   */
  approval_id: z.string().min(1).optional(),
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
  const { server, registry, approvals, subscriptionFilter, subMcpServerNames, toolDefaults } = opts;
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
      ...(approvals ? { approvals } : {}),
      ...(subscriptionFilter ? { subscriptionFilter } : {}),
      ...(subMcpServerNames ? { subMcpServerNames } : {}),
      ...(toolDefaults ? { toolDefaults } : {}),
      ...(c.req.header('x-forwarded-for')
        ? { ip: (c.req.header('x-forwarded-for') ?? '').split(',')[0]?.trim() }
        : {}),
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
  readonly approvals?: ApprovalService;
  readonly ip?: string | undefined;
  /** Per-User Filter fuer tools/list — siehe McpTransportOptions. */
  readonly subscriptionFilter?: (userId: string) => Promise<ReadonlySet<string> | null>;
  readonly subMcpServerNames?: () => Promise<ReadonlySet<string>>;
  /**
   * Tool-Defaults-Resolver. Wenn gesetzt, wird vor `registry.dispatch` ein
   * Merge in die Args durchgefuehrt (Phase A). Bei approval_id-Resume bewusst
   * uebersprungen — toolInput aus der Approval-Row haelt die signed Args.
   */
  readonly toolDefaults?: ToolDefaultsService;
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
      const allTools = env.registry.list();
      // Per-User-Subscription-Filter fuer Sub-MCP-Wrapper-Tools.
      // - native tools (kein '.'-Praefix): immer durchlassen
      // - kc.* (knowledge-core wrapper, single-tenant): immer durchlassen
      // - <server>.* wo <server> in subMcpServerNames: nur wenn subscribed
      let tools: typeof allTools = allTools;
      if (env.subscriptionFilter && env.subMcpServerNames) {
        try {
          const [subSet, serverNames] = await Promise.all([
            env.subscriptionFilter(env.principal.userId),
            env.subMcpServerNames(),
          ]);
          // Wenn der Filter explizit null returnt → keine Filterung
          // (Solo-Mode / Tests). Sonst pruefen wir pro Tool-Name.
          if (subSet) {
            tools = allTools.filter((meta) => {
              const dotIdx = meta.name.indexOf('.');
              if (dotIdx <= 0) return true; // nativer Tool
              const serverPart = meta.name.slice(0, dotIdx);
              if (!serverNames.has(serverPart)) return true; // kein Sub-MCP-Server
              return subSet.has(serverPart);
            });
          }
        } catch {
          // Filter-Fehler → fail-open (zeige alles). Audit-Eintrag kommt
          // ueber das Standard-Logging der Subscription-Service.
        }
      }

      // Phase D (PLAN-tool-defaults-v2.md): _meta.defaults_summary pro Tool.
      // EINE Aggregat-Query gegen user_server_tool_defaults — kein N+1.
      // Wenn toolDefaults nicht verkabelt ist (Tests), liefern wir tools
      // ohne defaults_summary aus (BC).
      let toolsWithMeta: typeof tools = tools;
      if (env.toolDefaults) {
        try {
          const summary = await env.toolDefaults.summarizeForUser(env.principal.userId);
          toolsWithMeta = tools.map((meta) => {
            const s = summary.get(meta.name);
            if (!s) return meta;
            return {
              ...meta,
              annotations: {
                ...(meta.annotations ?? {}),
                defaults_summary: {
                  active_profile: s.activeProfile,
                  fields_with_defaults: s.fieldsWithDefaults,
                },
              },
            };
          });
        } catch {
          // Aggregat-Query-Fehler → fail-open ohne summary. Resolver-Pfad
          // ist davon nicht betroffen.
        }
      }

      const result: ToolsListResult = { tools: toolsWithMeta };
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

  // SEC-019: Body-Cap fuer tools/call params. kc_wrappers nutzen z.unknown()
  // ohne tiefe JSON-Schema-Validierung — ohne Cap kann ein Caller hier
  // multi-MB-Payloads schicken, die als pending_approval-Row persistiert
  // werden + danach an KC2 forwarded. 32 KB ist hoch genug fuer realistische
  // Tool-Calls (doc-bodies sind separat als R2-blob in KC2, hier kommt nur
  // JSON-meta + summary). Sanitization: __proto__/constructor/prototype
  // Top-Level-Keys werden gestripped (Prototype-Pollution-Defense in der
  // Wire-Schicht, zusaetzlich zu resolvePath-Schutz im Display-Renderer).
  if (parsed.data.arguments !== undefined) {
    const argBytes = byteSizeOfJson(parsed.data.arguments);
    if (argBytes > 32 * 1024) {
      return rpcError(
        req.id,
        JsonRpcErrorCode.InvalidParams,
        `tools/call arguments too large (${argBytes} bytes, max 32768)`,
      );
    }
    const cleaned = stripDangerousKeys(parsed.data.arguments);
    if (cleaned !== parsed.data.arguments) {
      parsed.data.arguments = cleaned as Record<string, unknown>;
    }
  }

  const params: ToolsCallParams = {
    name: parsed.data.name,
    ...(parsed.data.arguments ? { arguments: parsed.data.arguments } : {}),
  };
  const approvalId = parsed.data.approval_id;

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

  // Approval-Resume-Pfad: wenn Client `approval_id` mitschickt + valid + own +
  // approved, dispatchen wir mit bypassApproval=true. Wenn anything off → 403.
  //
  // SEC-004: bei bypassApproval MUSS der Dispatch `row.toolInput` nutzen, nicht
  // die client-supplied `params.arguments`. Sonst kann ein Angreifer eine
  // Approval fuer "save notes.md (Einkaufsliste)" einholen, danach mit
  // selbem approval_id einen tools/call mit args={filename:'~/.ssh/authorized_keys'}
  // schicken — die displayed-and-signed Args wuerden ignoriert.
  // Plus defense-in-depth: wenn params.arguments NICHT-leer ist und von
  // row.toolInput abweicht, rejecten wir den Call statt still die signed Args
  // zu nehmen.
  let bypassApproval = false;
  let approvalRowToolInput: Record<string, unknown> | undefined;
  if (approvalId) {
    if (!env.approvals) {
      env.cancels.finish(cancelKey);
      return rpcError(
        req.id,
        JsonRpcErrorCode.Forbidden,
        'approval resume requested but ApprovalService not configured',
      );
    }
    const row = await env.approvals.get({ id: approvalId, userId: env.principal.userId });
    if (!row) {
      env.cancels.finish(cancelKey);
      return rpcError(req.id, JsonRpcErrorCode.Forbidden, 'approval not found or not owned');
    }
    if (row.status !== 'approved') {
      env.cancels.finish(cancelKey);
      return rpcError(
        req.id,
        JsonRpcErrorCode.ApprovalDenied,
        `approval ${approvalId} is ${row.status}, not approved`,
      );
    }
    if (row.toolName !== params.name) {
      env.cancels.finish(cancelKey);
      return rpcError(
        req.id,
        JsonRpcErrorCode.Forbidden,
        'approval tool_name mismatch',
      );
    }
    // SEC-018: blockieren wenn die Approval schon einmal dispatched wurde —
    // damit derselbe approval_id nicht beliebig oft mit potentiell anderen
    // Argumenten re-dispatched werden kann.
    if (row.resultEmittedAt !== null) {
      env.cancels.finish(cancelKey);
      return rpcError(
        req.id,
        JsonRpcErrorCode.Forbidden,
        'approval already consumed (result emitted)',
      );
    }
    // SEC-004 defense-in-depth: client-supplied args MUESSEN entweder leer
    // sein (= reines Resume-Signal) oder exakt mit der signed payload
    // uebereinstimmen.
    const clientArgs = params.arguments ?? {};
    const clientArgsEmpty =
      typeof clientArgs === 'object' && clientArgs !== null && Object.keys(clientArgs).length === 0;
    if (!clientArgsEmpty && !approvalArgsMatch(clientArgs, row.toolInput)) {
      env.cancels.finish(cancelKey);
      return rpcError(
        req.id,
        JsonRpcErrorCode.Forbidden,
        'arguments diverge from approval payload',
      );
    }
    approvalRowToolInput = row.toolInput;
    bypassApproval = true;
  }

  // Phase A: Tool-Defaults mergen (vor dispatch, NUR im Nicht-Resume-Pfad).
  // Resume-Pfad nutzt den toolInput-Snapshot aus der Approval-Row (SEC-004).
  // Resolver-Fehler sind fail-OPEN: Tool-Call laeuft mit raw args weiter,
  // damit ein Tool-Defaults-DB-Hiccup den ganzen MCP-Pfad nicht blockiert.
  let resolvedInput: Record<string, unknown> = params.arguments ?? {};
  let defaultsApplied: ReadonlyArray<import('./tool.js').AppliedDefaultMeta> = [];
  if (!bypassApproval && env.toolDefaults) {
    try {
      const subMcpSet = env.subMcpServerNames ? await env.subMcpServerNames() : undefined;
      const res = await env.toolDefaults.resolveForTool({
        userId: env.principal.userId,
        toolName: params.name,
        args: params.arguments ?? {},
        ...(subMcpSet ? { subMcpServerNames: subMcpSet } : {}),
      });
      resolvedInput = res.resolvedInput;
      defaultsApplied = res.defaultsApplied;
    } catch {
      // fail-open — siehe Kommentar oben. Audit-Trail wuerde ueber service-side
      // Logging laufen.
    }
  }

  let dispatchResult: DispatchResult;
  try {
    dispatchResult = await env.registry.dispatch({
      name: params.name,
      // SEC-004: bei bypassApproval dispatchen wir IMMER mit den signed Args
      // aus der Approval-Row, niemals mit client-supplied arguments.
      input: bypassApproval && approvalRowToolInput !== undefined
        ? approvalRowToolInput
        : resolvedInput,
      ctx: toolCtx,
      bypassApproval,
      defaultsApplied,
    });
  } catch (err) {
    env.cancels.finish(cancelKey);

    // Approval-Hook: persistiere pending_approval-Row, antworte mit Success-
    // Body der `approval_required: true` traegt. PWA pollt + approve.
    if (err instanceof ApprovalRequiredError && env.approvals) {
      try {
        const { payload } = await enqueueApproval({
          approvals: env.approvals,
          userId: env.principal.userId,
          error: err,
          requestId: env.requestId,
          ...(env.ip ? { ip: env.ip } : {}),
        });
        return rpcSuccess(req.id, payload);
      } catch (enqueueErr) {
        return mapErrorToJsonRpc(req.id, enqueueErr);
      }
    }

    // PRF-Hook: Credential verlangt PRF-Output, kein Approval-Path → wir liefern
    // dem Client ein structured payload `{ prf_required: true }` damit die PWA
    // die WebAuthn-PRF-Eval triggern kann.
    if (err instanceof PrfRequiredError) {
      return rpcSuccess(req.id, {
        prf_required: true,
        tool_name: params.name,
        prf_credential_id: err.prfCredentialId
          ? bytesToB64Url(err.prfCredentialId)
          : null,
      });
    }

    return mapErrorToJsonRpc(req.id, err);
  } finally {
    env.cancels.finish(cancelKey);
  }

  const ok: JsonRpcSuccess = rpcSuccess(req.id, dispatchResult.result);
  return ok;
}

/**
 * SEC-019: byte-size eines JSON-serialisierbaren Werts. Schnell + ohne
 * extra Encoder — TextEncoder gibt UTF-8-Length, was die exakte Wire-Size
 * approximiert.
 */
function byteSizeOfJson(v: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(v)).length;
  } catch {
    // JSON.stringify wirft bei BigInt/Cycles. Wir wollen das aber gar
    // nicht zur Approval-Persist lassen → behandeln als infinity um den
    // Cap zu triggern.
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * SEC-019: stripped Prototype-Pollution-Keys aus dem Object-Tree.
 * Top-level + nested. Akzeptiert non-objects unveraendert. Returnt das
 * urspruengliche Object wenn nichts entfernt wurde — sonst eine fresh
 * geclonte version ohne die dangerous keys.
 */
function stripDangerousKeys(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const cleaned = stripDangerousKeys(x);
      if (cleaned !== x) changed = true;
      return cleaned;
    });
    return changed ? out : v;
  }
  if (typeof v !== 'object') return v;
  const obj = v as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
      changed = true;
      continue;
    }
    const cleaned = stripDangerousKeys(obj[k]);
    if (cleaned !== obj[k]) changed = true;
    out[k] = cleaned;
  }
  return changed ? out : v;
}

/**
 * Deep-equal-Vergleich fuer Approval-Args (SEC-004). Order-stable JSON-Serialisation
 * — bewusst klein gehalten, weil tool_input nur JSON-safe-Values enthaelt
 * (kommt durch zValidator) — keine Dates, keine Functions, keine Symbols.
 *
 * Wir serialisieren beide Seiten mit sortierten Object-Keys, dann string-eq.
 * Bei Mismatch returnt false → Caller wirft Forbidden.
 */
function approvalArgsMatch(client: unknown, signed: Record<string, unknown>): boolean {
  return stableStringify(client) === stableStringify(signed);
}

function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) {
    return `[${v.map((x) => stableStringify(x)).join(',')}]`;
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

function bytesToB64Url(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] ?? 0);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
