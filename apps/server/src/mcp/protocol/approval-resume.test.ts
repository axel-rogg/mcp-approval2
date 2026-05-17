/**
 * Tests fuer approval-resume — AS-3-Erweiterung A10.
 *
 * Plan-Ref: PLAN-as3-autonomous.md §1.5 + §1.6.
 *
 * Wir verifizieren:
 *   - `resumeApproval` baut einen ToolContext, in dem `approvalId` gesetzt ist.
 *     Damit kann ein nachgelagerter KC-Wrapper-Tool den `approval_id` in
 *     den OBO-JWT-Claim packen → KC2-Audit `via_proxy=true, approval_id=<…>`.
 *   - Die `email`-Felder von SessionPrincipal wandern korrekt in ctx.email.
 *   - bypassApproval=true wird gesetzt (sonst Endlosschleife).
 */
import { describe, it, expect, vi } from 'vitest';
import { resumeApproval } from './approval-resume.js';
import type { ApprovalService } from '../../services/approvals.js';
import type { AuditService, ToolContext } from './tool.js';
import type { DispatchResult, ToolRegistry } from './registry.js';
import type { PendingApproval } from '../../schema/types.js';
import type { ServerContext, SessionPrincipal } from '../../lib/context.js';

function makeApproval(): PendingApproval {
  return {
    id: 'appr-uuid-42',
    userId: 'user-1',
    toolName: 'docs.put',
    toolInput: { title: 'hi' },
    displayTemplate: null,
    displayRendered: null,
    sensitivity: 'write',
    status: 'approved',
    approvalChallenge: null,
    approvalSignature: null,
    approvedAt: 1,
    rejectedAt: null,
    rejectionReason: null,
    expiredAt: null,
    prfSessionId: null,
    resultJson: null,
    resultEmittedAt: null,
    requestId: null,
    originIp: null,
    createdAt: 1,
    expiresAt: 1000,
  };
}

function makePrincipal(): SessionPrincipal {
  return {
    userId: 'user-1',
    email: 'axel@example.org',
    role: 'member',
    sessionId: 'sess-1',
    issuedAt: 1,
    expiresAt: 1000,
  };
}

describe('resumeApproval — AS-3 approval_id propagation (A10)', () => {
  it('passes approval.id as ctx.approvalId to the dispatched tool', async () => {
    let capturedCtx: ToolContext | null = null;
    const dispatchResult: DispatchResult = {
      result: { content: [{ type: 'text', text: 'ok' }] },
      durationMs: 0,
      structuredContent: undefined,
    } as unknown as DispatchResult;
    const registry: ToolRegistry = {
      dispatch: vi.fn(async (args: { ctx: ToolContext }) => {
        capturedCtx = args.ctx;
        return dispatchResult;
      }),
    } as unknown as ToolRegistry;

    const approvals: ApprovalService = {
      setResult: vi.fn(async () => undefined),
    } as unknown as ApprovalService;

    const audit: AuditService = { emit: vi.fn(async () => undefined) };

    // Minimal stub-DbAdapter — emitAudit ruft `db.unsafe('...').query(...)`.
    const queryMock = vi.fn().mockResolvedValue([]);
    const db = {
      unsafe: () => ({ query: queryMock }),
    } as unknown as ServerContext['db'];

    const server: ServerContext = {
      config: { ORIGIN: 'https://approval2.example' } as ServerContext['config'],
      db,
    };

    await resumeApproval(
      {
        approval: makeApproval(),
        principal: makePrincipal(),
        server,
        registry,
        audit,
        requestId: 'req-test',
      },
      approvals,
    );

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.approvalId).toBe('appr-uuid-42');
    expect(capturedCtx!.userId).toBe('user-1');
    expect(capturedCtx!.email).toBe('axel@example.org');
    expect(capturedCtx!.requestId).toBe('req-test');
    expect(registry.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        bypassApproval: true,
        name: 'docs.put',
      }),
    );
  });
});
