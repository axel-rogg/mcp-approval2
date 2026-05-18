/**
 * Approval-Resume — verbindet ApprovalService und ToolRegistry.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2 (Request-Lifecycle Step 5-9), §11 Phase 4.
 *
 * Zwei Aufgaben:
 *
 * 1. `enqueueApproval(ctx, err)` — wird vom Transport (POST /mcp) aufgerufen
 *    wenn `registry.dispatch` mit `ApprovalRequiredError` wirft. Persistiert
 *    eine pending_approval-Row und liefert dem MCP-Client eine
 *    Approval-Required-Antwort (JSON-RPC-Wire-Shape) zurueck.
 *
 * 2. `resumeApproval(args)` — wird vom HTTP-Approve-Endpoint aufgerufen
 *    nachdem User signed. Laedt die Approval-Row, baut einen ToolContext aus
 *    SessionPrincipal, ruft `registry.dispatch({ name, input, ctx,
 *    bypassApproval: true })`, persistiert das Result via
 *    `ApprovalService.setResult`.
 *
 * Anti-Pattern: Wir loesen den Resume hier synchron (await dispatch). Long-
 * running Tools koennen den HTTP-Approve-Request blockieren — Phase-4-Default
 * ist OK weil unsere Tools alle Sekunden-Range. Phase-5+: optional async-
 * resume mit Background-Worker.
 *
 * Cross-User Security: Caller MUSS sicherstellen, dass `args.userId` zum
 * approval.user_id passt. RLS in `ApprovalService.approve` enforct das.
 */
import type { ServerContext, SessionPrincipal } from '../../lib/context.js';
import { emitAudit } from '../../services/audit.js';
import type {
  ApprovalService,
  CreateApprovalArgs,
} from '../../services/approvals.js';
import type { ApprovalSensitivity, PendingApproval } from '../../schema/types.js';
import {
  ApprovalRequiredError,
  type AuditService,
  type ToolContext,
} from './tool.js';
import type { DispatchResult, ToolRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// enqueueApproval
// ---------------------------------------------------------------------------

export interface EnqueueApprovalArgs {
  readonly approvals: ApprovalService;
  readonly userId: string;
  readonly error: ApprovalRequiredError;
  readonly requestId?: string;
  readonly ip?: string;
  readonly ttlSec?: number;
}

export interface ApprovalRequiredPayload {
  readonly approval_required: true;
  readonly approval_id: string;
  readonly expires_at: number;
  readonly tool_name: string;
  readonly sensitivity: ApprovalSensitivity;
  readonly display_rendered: string | null;
  readonly approval_challenge: string | null;
}

/**
 * Konvertiert eine ApprovalRequiredError in eine persistente Approval-Row +
 * client-facing Payload.
 */
export async function enqueueApproval(
  args: EnqueueApprovalArgs,
): Promise<{ approval: PendingApproval; payload: ApprovalRequiredPayload }> {
  if (args.error.sensitivity === 'read') {
    // Sollte nicht passieren — read triggert keine ApprovalRequiredError.
    throw new Error('cannot enqueue read-sensitivity approval');
  }
  const sensitivity: ApprovalSensitivity = args.error.sensitivity;
  const toolInput = isPlainObject(args.error.input)
    ? (args.error.input as Record<string, unknown>)
    : { _value: args.error.input };

  const createArgs: CreateApprovalArgs = {
    userId: args.userId,
    toolName: args.error.toolName,
    toolInput,
    sensitivity,
    ...(args.error.displayTemplate ? { displayTemplate: args.error.displayTemplate } : {}),
    ...(args.requestId ? { requestId: args.requestId } : {}),
    ...(args.ip ? { ip: args.ip } : {}),
    ...(args.ttlSec !== undefined ? { ttlSec: args.ttlSec } : {}),
    ...(args.error.defaultsApplied.length > 0
      ? { defaultsApplied: args.error.defaultsApplied }
      : {}),
  };

  const approval = await args.approvals.create(createArgs);
  const payload: ApprovalRequiredPayload = {
    approval_required: true,
    approval_id: approval.id,
    expires_at: approval.expiresAt,
    tool_name: approval.toolName,
    sensitivity,
    display_rendered: approval.displayRendered,
    approval_challenge: approval.approvalChallenge,
  };
  return { approval, payload };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// resumeApproval
// ---------------------------------------------------------------------------

export interface ResumeApprovalArgs {
  readonly approval: PendingApproval;
  readonly principal: SessionPrincipal;
  readonly server: ServerContext;
  readonly registry: ToolRegistry;
  readonly audit: AuditService;
  readonly requestId: string;
}

export interface ResumeApprovalResult {
  readonly dispatch: DispatchResult;
}

/**
 * Re-Dispatch nach erfolgreichem Approve.
 *
 * Erwartet `approval.status === 'approved'`. Caller (HTTP-Route) hat den
 * Status-Check via `ApprovalService.approve` bereits gemacht.
 *
 * Pipeline:
 *   1. ToolContext aus Principal + Server bauen (mit fresh AbortController).
 *   2. registry.dispatch mit bypassApproval=true.
 *   3. ApprovalService.setResult (auch wenn dispatch wirft — wir persistieren
 *      Error in result_json damit PWA das zeigt).
 *
 * Fehler in Tool-Execution werden NICHT geswallowt — Caller bekommt sie. Aber
 * wir loggen + persistieren sie vorher.
 */
export async function resumeApproval(
  args: ResumeApprovalArgs,
  approvals: ApprovalService,
): Promise<ResumeApprovalResult> {
  const ctrl = new AbortController();
  const ctx: ToolContext = {
    userId: args.principal.userId,
    email: args.principal.email,
    role: args.principal.role,
    requestId: args.requestId,
    audit: args.audit,
    db: args.server.db,
    signal: ctrl.signal,
    // AS-3: approval_id wandert in den OBO-JWT wenn das wieder-aufgenommene
    // Tool einen KC2-Call macht. KC2 logged `via_proxy=true, approval_id=<…>`.
    approvalId: args.approval.id,
  };

  try {
    const dispatch = await args.registry.dispatch({
      name: args.approval.toolName,
      input: args.approval.toolInput,
      ctx,
      bypassApproval: true,
    });

    // Result persistieren (PWA pollt /approvals/:id/result).
    await approvals.setResult({
      id: args.approval.id,
      result: { ok: true, content: dispatch.result.content, durationMs: dispatch.durationMs },
    });

    await emitAudit(args.server.db, {
      action: 'tool.approval.resumed',
      actorUserId: args.principal.userId,
      result: 'success',
      requestId: args.requestId,
      details: {
        approval_id: args.approval.id,
        tool_name: args.approval.toolName,
        durationMs: dispatch.durationMs,
      },
    });

    return { dispatch };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    await approvals.setResult({
      id: args.approval.id,
      result: { ok: false, error: message },
    });
    await emitAudit(args.server.db, {
      action: 'tool.approval.resume_failed',
      actorUserId: args.principal.userId,
      result: 'failure',
      requestId: args.requestId,
      details: {
        approval_id: args.approval.id,
        tool_name: args.approval.toolName,
        error: message,
      },
    });
    throw err;
  }
}
