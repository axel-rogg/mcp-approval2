/**
 * Cron-Task: stuck `executing` approvals expiren.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2 (Request-Lifecycle Step 5/7),
 *           Migration-Notes (Sweep-Pattern aus mcp-approval Phase 0007 portiert).
 *
 * In mcp-approval2 ist der `executing`-Status nicht-explizit modelliert —
 * wir nutzen den Approval-Resume-Pattern, der direkt von approved → result
 * uebergeht. Der Sweep ist daher konzeptuell der ApprovalService.sweepExpired()
 * Aufruf: pending-rows deren expires_at < now werden auf expired geflippt.
 *
 * Idempotent + safe. Returns Zahl der gesweepten Rows.
 */
import type { CronDeps, TaskResult } from './index.js';
import { emitAudit } from '../services/audit.js';

export async function runSweepExecutingApprovals(deps: CronDeps): Promise<TaskResult> {
  if (!deps.approvals) {
    // Approval-Service nicht verdrahtet (Tests / Bootstrap-Mode).
    await emitAudit(deps.db, {
      action: 'cron.sweep_executing_approvals',
      actorUserId: null,
      result: 'noop',
      details: { reason: 'approval_service_unavailable' },
    });
    return { swept: 0 };
  }
  const swept = await deps.approvals.sweepExpired();
  return { swept };
}
