/**
 * Cron-Task: auto-archive Apps mit >=14d Inaktivitaet.
 *
 * Plan-Ref: PLAN-architecture-v1.md §7 (Apps-Subsystem, Phase 1 Default).
 *
 * Architektur-Hinweis: in mcp-approval2 lebt `app_state` als kind im
 * mcp-knowledge2-Storage-Service. mcp-approval2 hat selbst KEINE
 * `objects`-Tabelle. Dieser Task adressiert daher KC2 via
 * KnowledgeService — Implementierung ist defensive: wenn der Service-Hook
 * nicht uebergeben wurde, ist der Task no-op (returns archived=0).
 *
 * Aktueller Status: KC2 hat heute noch keine Bulk-Archive-Route. Wir lassen
 * den Task als Skeleton stehen + emitten ein audit-event mit `result='noop'`,
 * damit das Cron-Triggering bereits End-to-End validiert ist. Sobald KC2
 * eine `/v1/objects/auto_archive`-Surface bekommt, wird hier der Call
 * eingebaut.
 */
import type { CronDeps, TaskResult } from './index.js';
import { emitAudit } from '../services/audit.js';

const AUTO_ARCHIVE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export async function runAutoArchiveApps(deps: CronDeps): Promise<TaskResult> {
  const now = deps.now ?? (() => Date.now());
  const ts = now();
  const cutoff = ts - AUTO_ARCHIVE_AGE_MS;

  // Skeleton: bis KC2 eine Bulk-Archive-Surface hat, ist das ein no-op.
  // Wir emitten trotzdem ein Audit-Event, damit der Trigger sichtbar ist.
  await emitAudit(deps.db, {
    action: 'cron.auto_archive_apps',
    actorUserId: null,
    result: 'noop',
    details: {
      cutoff_age_days: 14,
      cutoff_ts: cutoff,
      note: 'awaiting KC2 bulk-archive surface',
    },
  });

  return { archived: 0, cutoff_ts: cutoff };
}
