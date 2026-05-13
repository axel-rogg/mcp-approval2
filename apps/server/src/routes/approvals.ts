/**
 * Approvals-HTTP-Routes — PWA-facing Approval-Sign-Off-Flow.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2 (Request-Lifecycle Step 5-9), §11 Phase 4.
 *
 * Endpunkte:
 *   GET    /v1/approvals                  — list (pending+recent, own)
 *   GET    /v1/approvals/:id              — read single (own)
 *   POST   /v1/approvals/:id/approve      — body: { signatureB64, prfSessionId? }
 *   POST   /v1/approvals/:id/reject       — body: { reason? }
 *   GET    /v1/approvals/:id/result       — poll result (after approve)
 *
 * Auth: Bearer-Session-JWT. RLS enforct owner-only.
 *
 * Post-Approve-Trigger: nach erfolgreichem `approve()` triggert die Route
 * `resumeApproval()` und persistiert das Tool-Result. Dann antwortet der
 * Approve-Endpoint mit `{ status: 'approved', result_emitted_at }`. PWA
 * kann `/result` pollen ODER direkt den Body interpretieren.
 *
 * Schedule:
 *   Long-poll auf `/result`: HTTP-keep-alive, max 25s wait, dann 304-ish
 *   Empty-Result. PWA macht erneuten GET. Phase-4 implementiert nur die
 *   Short-Poll-Variante; Long-Poll bleibt offen (TODO Phase 5).
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AppBindings, ServerContext } from '../lib/context.js';
import { HttpError } from '../lib/errors.js';
import { auth } from '../middleware/auth.js';
import type { PendingApproval, ApprovalStatus } from '../schema/types.js';
import {
  ApprovalConflictError,
  type ApprovalService,
} from '../services/approvals.js';
import { resumeApproval } from '../mcp/protocol/approval-resume.js';
import type { ToolRegistry } from '../mcp/protocol/registry.js';
import type { AuditService } from '../mcp/protocol/tool.js';

export interface ApprovalsRouteDeps {
  readonly server: ServerContext;
  readonly approvals: ApprovalService;
  readonly registry: ToolRegistry;
  readonly audit: AuditService;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const approveSchema = z.object({
  signatureB64: z.string().min(1).max(8192),
  prfSessionId: z.string().min(1).max(128).optional(),
});

const rejectSchema = z.object({
  reason: z.string().max(500).optional(),
});

const listQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'expired']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// ---------------------------------------------------------------------------
// b64 helpers
// ---------------------------------------------------------------------------

function b64ToBytes(b64: string): Uint8Array {
  const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] ?? 0);
  return btoa(s);
}

// ---------------------------------------------------------------------------
// Serialization (PendingApproval → JSON)
// ---------------------------------------------------------------------------

function approvalToJson(a: PendingApproval): Record<string, unknown> {
  return {
    id: a.id,
    userId: a.userId,
    toolName: a.toolName,
    toolInput: a.toolInput,
    displayTemplate: a.displayTemplate,
    displayRendered: a.displayRendered,
    sensitivity: a.sensitivity,
    status: a.status,
    approvalChallenge: a.approvalChallenge,
    approvalSignatureB64: a.approvalSignature ? bytesToB64(a.approvalSignature) : null,
    approvedAt: a.approvedAt,
    rejectedAt: a.rejectedAt,
    rejectionReason: a.rejectionReason,
    expiredAt: a.expiredAt,
    prfSessionBound: a.prfSessionId !== null,
    resultJson: a.resultJson,
    resultEmittedAt: a.resultEmittedAt,
    requestId: a.requestId,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function approvalsRoutes(deps: ApprovalsRouteDeps): Hono<AppBindings> {
  const { server, approvals, registry, audit } = deps;
  const app = new Hono<AppBindings>();
  const guard = auth(server);

  // GET /v1/approvals
  app.get('/v1/approvals', guard, async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const q = listQuerySchema.safeParse({
      status: c.req.query('status'),
      limit: c.req.query('limit'),
    });
    if (!q.success) {
      throw HttpError.badRequest('invalid_request', 'invalid query', {
        issues: q.error.issues,
      });
    }
    const listArgs: {
      userId: string;
      status?: ApprovalStatus;
      limit?: number;
    } = { userId: principal.userId };
    if (q.data.status) listArgs.status = q.data.status;
    if (q.data.limit !== undefined) listArgs.limit = q.data.limit;
    const list = await approvals.list(listArgs);
    return c.json({ approvals: list.map(approvalToJson) });
  });

  // GET /v1/approvals/:id
  app.get('/v1/approvals/:id', guard, async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const id = c.req.param('id');
    const row = await approvals.get({ id, userId: principal.userId });
    if (!row) throw HttpError.notFound('approval not found');
    return c.json({ approval: approvalToJson(row) });
  });

  // POST /v1/approvals/:id/approve
  app.post(
    '/v1/approvals/:id/approve',
    guard,
    zValidator('json', approveSchema),
    async (c) => {
      const principal = c.get('user');
      if (!principal) throw HttpError.unauthorized();
      const id = c.req.param('id');
      const body = c.req.valid('json');
      const signature = b64ToBytes(body.signatureB64);
      try {
        const approval = await approvals.approve({
          id,
          userId: principal.userId,
          signature,
          ...(body.prfSessionId ? { prfSessionId: body.prfSessionId } : {}),
        });

        // Resume Tool-Dispatch synchron. Bei Tool-Error: setResult(error) +
        // werfen → Caller sieht 500, PWA sieht result_json.ok=false beim Re-Read.
        let resumeError: unknown = null;
        try {
          await resumeApproval(
            {
              approval,
              principal,
              server,
              registry,
              audit,
              requestId: c.get('requestId'),
            },
            approvals,
          );
        } catch (err) {
          resumeError = err;
        }

        // Approval-Row neu laden — setResult hat result_json.emitted_at gesetzt.
        const refreshed = await approvals.get({ id, userId: principal.userId });
        return c.json({
          approval: refreshed ? approvalToJson(refreshed) : approvalToJson(approval),
          resume_error: resumeError
            ? resumeError instanceof Error
              ? resumeError.message
              : 'unknown'
            : null,
        });
      } catch (err) {
        if (err instanceof ApprovalConflictError) {
          return c.json(
            {
              error: {
                code: 'conflict',
                message: err.message,
                details: { currentStatus: err.currentStatus },
              },
            },
            409,
          );
        }
        throw err;
      }
    },
  );

  // POST /v1/approvals/:id/reject
  app.post(
    '/v1/approvals/:id/reject',
    guard,
    zValidator('json', rejectSchema),
    async (c) => {
      const principal = c.get('user');
      if (!principal) throw HttpError.unauthorized();
      const id = c.req.param('id');
      const body = c.req.valid('json');
      try {
        const rejectArgs: { id: string; userId: string; reason?: string } = {
          id,
          userId: principal.userId,
        };
        if (body.reason !== undefined) rejectArgs.reason = body.reason;
        const row = await approvals.reject(rejectArgs);
        return c.json({ approval: approvalToJson(row) });
      } catch (err) {
        if (err instanceof ApprovalConflictError) {
          return c.json(
            {
              error: {
                code: 'conflict',
                message: err.message,
                details: { currentStatus: err.currentStatus },
              },
            },
            409,
          );
        }
        throw err;
      }
    },
  );

  // GET /v1/approvals/:id/result
  app.get('/v1/approvals/:id/result', guard, async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const id = c.req.param('id');
    const row = await approvals.get({ id, userId: principal.userId });
    if (!row) throw HttpError.notFound('approval not found');
    if (row.resultEmittedAt === null || row.resultJson === null) {
      return c.json(
        {
          status: row.status,
          result_emitted_at: null,
          result: null,
        },
        202,
      );
    }
    return c.json({
      status: row.status,
      result_emitted_at: row.resultEmittedAt,
      result: row.resultJson,
    });
  });

  return app;
}
