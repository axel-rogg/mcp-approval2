/**
 * Audit-Log-Emit (immutable, append-only).
 *
 * Plan-Ref: PLAN-architecture-v1.md §6 (Audit-Logging).
 *
 * Phase 1: Sink = Postgres `audit_log` Tabelle. Spaeter: Worker-Queue +
 * BigQuery / Loki / S3-Glacier.
 *
 * Datenfeld-Layout: action / actor / target / result + JSON-details. Wir
 * persistieren NIE PII im Klartext jenseits dessen was schon im users-table
 * steht (email/displayName) — details werden vom Caller "sicherheits-
 * bewusst" gefuellt.
 */
import type { DbAdapter } from '@mcp-approval2/adapters';

export interface AuditEvent {
  readonly action: string;
  readonly actorUserId: string | null;
  readonly targetUserId?: string;
  readonly result: 'success' | 'failure' | 'noop';
  readonly requestId?: string;
  readonly ip?: string;
  readonly userAgent?: string;
  readonly details?: Record<string, unknown>;
}

/**
 * Mapping zwischen Code-Result-Enum und Schema-CHECK-Constraint.
 * Schema (migration 0001_initial.sql) erlaubt nur 'success'|'denied'|'error'.
 * Code spricht semantisch in 'success'|'failure'|'noop' — wir mappen 'failure'
 * → 'error' (Operation fehlgeschlagen) und 'noop' → 'denied' (Operation wurde
 * intentional nicht durchgefuehrt, z.B. weil schon idempotent).
 */
function mapResult(result: 'success' | 'failure' | 'noop'): 'success' | 'denied' | 'error' {
  if (result === 'failure') return 'error';
  if (result === 'noop') return 'denied';
  return 'success';
}

export async function emitAudit(db: DbAdapter, event: AuditEvent): Promise<void> {
  try {
    const raw = db.unsafe('audit_emit');
    // Schema-Match (audit_log aus migration 0001_initial.sql):
    //   - `ts` (nicht created_at)
    //   - `actor_type` NOT NULL (derived: 'system' wenn actorUserId leer, sonst 'user')
    //   - `target_user_id` existiert NICHT in Schema — wandert in details.targetUserId
    //   - `result` CHECK: 'success'|'denied'|'error' → via mapResult()
    const actorType = event.actorUserId ? 'user' : 'system';
    const details = (() => {
      if (!event.details && !event.targetUserId) return null;
      const merged: Record<string, unknown> = { ...(event.details ?? {}) };
      if (event.targetUserId) merged['targetUserId'] = event.targetUserId;
      return JSON.stringify(merged);
    })();
    await raw.query(
      `INSERT INTO audit_log
         (ts, actor_user_id, actor_type, action, request_id, ip, user_agent, result, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        Date.now(),
        event.actorUserId,
        actorType,
        event.action,
        event.requestId ?? null,
        event.ip ?? null,
        event.userAgent ?? null,
        mapResult(event.result),
        details,
      ],
    );
  } catch (err) {
    // Audit-Log darf den Request nicht killen — wir loggen auf stderr.
    // eslint-disable-next-line no-console
    console.error('[audit] failed to emit', event.action, err);
  }
}
