/**
 * Cron-Task: expired PRF-Sessions sweepen.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.3 (PRF-Session-Lifecycle).
 *
 * Bei InMemoryPrfSessionService laufen sweep()s im Process selbst — wirkt
 * also nur, wenn der Cron im gleichen Process getriggert wird. Fuer eine
 * verteilte Variante muesste der Store DB-backed sein; das ist heute nicht
 * der Fall.
 */
import type { CronDeps, TaskResult } from './index.js';
import { emitAudit } from '../services/audit.js';

export async function runSweepPrfSessions(deps: CronDeps): Promise<TaskResult> {
  if (!deps.prfSessions) {
    await emitAudit(deps.db, {
      action: 'cron.sweep_prf_sessions',
      actorUserId: null,
      result: 'noop',
      details: { reason: 'prf_service_unavailable' },
    });
    return { swept: 0 };
  }
  const swept = await deps.prfSessions.sweep();
  return { swept, active: deps.prfSessions.size() };
}
