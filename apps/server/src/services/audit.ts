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

export async function emitAudit(db: DbAdapter, event: AuditEvent): Promise<void> {
  try {
    const raw = db.unsafe('audit_emit');
    await raw.query(
      `INSERT INTO audit_log
         (action, actor_user_id, target_user_id, result, request_id, ip, user_agent, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        event.action,
        event.actorUserId,
        event.targetUserId ?? null,
        event.result,
        event.requestId ?? null,
        event.ip ?? null,
        event.userAgent ?? null,
        event.details ? JSON.stringify(event.details) : null,
        Date.now(),
      ],
    );
  } catch (err) {
    // Audit-Log darf den Request nicht killen — wir loggen auf stderr.
    // eslint-disable-next-line no-console
    console.error('[audit] failed to emit', event.action, err);
  }
}
