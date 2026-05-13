/**
 * Cron-Task: hard-purge soft-deleted Apps nach 30d Recovery-Window.
 *
 * Plan-Ref: PLAN-architecture-v1.md §7 (Apps-Subsystem, Phase 2 Soft-Delete-Trash).
 *
 * Architektur-Hinweis: analog auto-archive — `app_state`-Objekte leben in
 * KC2, nicht in mcp-approval2. Aktueller Status: Skeleton + Audit-Event,
 * wartet auf KC2-Surface.
 */
import type { CronDeps, TaskResult } from './index.js';
import { emitAudit } from '../services/audit.js';

const TRASH_PURGE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export async function runPurgeTrashedApps(deps: CronDeps): Promise<TaskResult> {
  const now = deps.now ?? (() => Date.now());
  const ts = now();
  const cutoff = ts - TRASH_PURGE_AGE_MS;

  await emitAudit(deps.db, {
    action: 'cron.purge_trashed_apps',
    actorUserId: null,
    result: 'noop',
    details: {
      cutoff_age_days: 30,
      cutoff_ts: cutoff,
      note: 'awaiting KC2 bulk-purge surface',
    },
  });

  return { purged: 0, cutoff_ts: cutoff };
}
