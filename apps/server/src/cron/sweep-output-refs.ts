/**
 * Cron-Task: TTL-cached Tool-Output-Refs sweepen.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2 (Tool-Output-Caching).
 *
 * Architektur-Hinweis: `output_refs` ist eine optionale Tabelle. Falls die
 * Migration noch nicht eingespielt wurde (Phase-Skeleton), wirft der DELETE
 * — wir fangen den Error ab und melden 'noop'.
 */
import type { CronDeps, TaskResult } from './index.js';
import { emitAudit } from '../services/audit.js';

const TTL_MS = 24 * 60 * 60 * 1000;

export async function runSweepOutputRefs(deps: CronDeps): Promise<TaskResult> {
  const now = deps.now ?? (() => Date.now());
  const ts = now();
  const cutoff = ts - TTL_MS;
  const raw = deps.db.unsafe('cron_sweep_output_refs');
  try {
    const rows = await raw.query<{ id: string }>(
      `DELETE FROM output_refs WHERE created_at < $1 RETURNING id`,
      [cutoff],
    );
    if (rows.length > 0) {
      await emitAudit(deps.db, {
        action: 'cron.sweep_output_refs',
        actorUserId: null,
        result: 'success',
        details: { swept: rows.length, cutoff_ts: cutoff },
      });
    }
    return { swept: rows.length, cutoff_ts: cutoff };
  } catch (err) {
    // Tabelle existiert vermutlich noch nicht.
    await emitAudit(deps.db, {
      action: 'cron.sweep_output_refs',
      actorUserId: null,
      result: 'noop',
      details: {
        reason: 'output_refs_unavailable',
        error: err instanceof Error ? err.message : 'unknown',
      },
    });
    return { swept: 0, skipped: true };
  }
}
