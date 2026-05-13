/**
 * Cron-Task: reminder-block notifications dispatchen.
 *
 * Plan-Ref: PLAN-architecture-v1.md §7 (Apps-Subsystem, PLAN-apps-future Q3).
 *
 * Architektur-Hinweis: reminder-blocks leben in `app_state.layout.reminders[]`,
 * also bei KC2. Die concrete Implementierung scant alle Apps mit active
 * reminders, vergleicht `next_fire_at <= now`, ruft `pushService.send(...)`
 * fuer den App-Owner, stempelt `last_fired_at`.
 *
 * Heute Skeleton: solange KC2 keine `/v1/apps/with_reminders`-Surface hat,
 * laeuft der Task als no-op. Audit-Event macht das Triggering trotzdem
 * sichtbar.
 */
import type { CronDeps, TaskResult } from './index.js';
import { emitAudit } from '../services/audit.js';

export async function runReminders(deps: CronDeps): Promise<TaskResult> {
  if (!deps.push) {
    await emitAudit(deps.db, {
      action: 'cron.reminders',
      actorUserId: null,
      result: 'noop',
      details: { reason: 'push_service_unavailable' },
    });
    return { fired: 0, scanned: 0 };
  }
  await emitAudit(deps.db, {
    action: 'cron.reminders',
    actorUserId: null,
    result: 'noop',
    details: { note: 'awaiting KC2 apps-with-reminders surface' },
  });
  return { fired: 0, scanned: 0 };
}
