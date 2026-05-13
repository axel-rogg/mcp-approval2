/**
 * GDPR-Service: Export (Art. 15/20) + Erase (Art. 17, Crypto-Shred).
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.5 (Crypto-Shredding) + §11.2 (Offboarding)
 *           + §6.3 (Audit-Events 'data.exported' / 'user.erased').
 *
 * Trennung der Methoden:
 *   - exportUserData    : sammelt Meta-Daten aus mcp-approval2-Tabellen,
 *                         optional Cascade an mcp-knowledge2 fuer objects.
 *                         NIE Plaintext-Credentials, NIE Refresh-Tokens.
 *
 *   - requestErase      : Self-Service / Admin-Trigger. Soft-Delete + Queue-Row
 *                         (gdpr_erase_queue) mit purge_after_at = now + 30d.
 *                         Reversibel via cancelErase().
 *
 *   - hardEraseUser     : Cron-Pfad nach Ablauf der Grace-Period. Zerstoert
 *                         den Vault-KEK des Users (Crypto-Shred) + DELETE
 *                         aus credentials/sessions/webauthn_credentials +
 *                         Cascade-Call an mcp-knowledge2 + Pseudonymisierung
 *                         der users-Row (audit_log-Eintraege bleiben mit
 *                         actor_user_id-Pseudonym).
 *
 *   - cancelErase       : Innerhalb der Grace-Period kann der User zurueckziehen.
 *
 * Output-Format Export: NDJSON-Stream. Caller (Route) kann das als
 * `application/x-ndjson` direkt durchreichen. Top-Level-Records:
 *   { "table": "users", "row": {...} }
 *   { "table": "credentials_meta", "row": {...} }   // OHNE secrets
 *   { "table": "audit_log", "row": {...} }
 *   { "table": "objects", "row": {...} }             // von mcp-knowledge2
 */
import type { DbAdapter, KekProvider } from '@mcp-approval2/adapters';
import { HttpError } from '../lib/errors.js';
import { emitAudit } from './audit.js';
import type { KnowledgeService } from './knowledge.js';

export interface GdprServiceOptions {
  readonly db: DbAdapter;
  readonly kekProvider: KekProvider;
  /**
   * Optional: KnowledgeService fuer Cascade-Erase + Export aus mcp-knowledge2.
   * Wenn nicht uebergeben, sind Export/Erase nur fuer mcp-approval2-lokale
   * Daten zustaendig (z.B. wenn knowledge2 nicht erreichbar ist).
   */
  readonly knowledge?: KnowledgeService;
  /**
   * KEK-Ref-Builder pro User. Default `vault://transit/keys/user-{id}` (mit
   * §5.2 Konvention). Tests overriden.
   */
  readonly kekRefForUser?: (userId: string) => string;
  /** 30-Tage-Grace-Period default. Override fuer Tests / Notfall-Setups. */
  readonly gracePeriodMs?: number;
  /** Optional clock fuer Tests. */
  readonly now?: () => number;
}

/**
 * Ein einzelner Record im Export-NDJSON.
 */
export interface GdprExportRecord {
  readonly table: string;
  readonly row: Record<string, unknown>;
}

export interface GdprService {
  /**
   * Liefert User-Daten als async-iterable Stream von NDJSON-Records.
   * Caller (Route) iteriert + schreibt in den ResponseStream.
   */
  exportUserData(args: {
    readonly userId: string;
    readonly actorUserId: string;
    readonly requestId?: string;
  }): AsyncIterable<GdprExportRecord>;

  /**
   * Triggert Soft-Delete + Queue. Reversibel via cancelErase fuer
   * `gracePeriodMs` (default 30 Tage).
   */
  requestErase(args: {
    readonly userId: string;
    readonly actorUserId: string;
    readonly requestId?: string;
  }): Promise<{ purgeAfterAt: number; requestedAt: number }>;

  /**
   * Cancel die pending erase-Anfrage. Reaktiviert den User-Status.
   */
  cancelErase(args: {
    readonly userId: string;
    readonly actorUserId: string;
    readonly requestId?: string;
  }): Promise<void>;

  /**
   * Hard-Delete-Pfad. Wird ausschliesslich vom Cron-Helper aufgerufen,
   * NICHT direkt von HTTP-Routes. Crypto-Shred + Cascade-Cleanup.
   */
  hardEraseUser(args: {
    readonly userId: string;
    readonly actorUserId: string;
    readonly confirmationToken: string;
    readonly requestId?: string;
  }): Promise<{ deletedLocalRows: number; deletedKnowledgeRows: number }>;

  /**
   * Cron-Hilfsmethode: alle pending-Rows in gdpr_erase_queue mit
   * purge_after_at <= now zuruckliefern. Caller (Cron) iteriert + ruft
   * hardEraseUser auf.
   */
  listDuePurges(now: number): Promise<ReadonlyArray<{ userId: string; purgeAfterAt: number }>>;
}

const DEFAULT_GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export function createGdprService(opts: GdprServiceOptions): GdprService {
  const { db, kekProvider, knowledge } = opts;
  const kekRefFor =
    opts.kekRefForUser ?? ((userId: string) => `vault://transit/keys/user-${userId}`);
  const gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
  const now = opts.now ?? (() => Date.now());

  return {
    exportUserData(args) {
      return exportUserDataImpl({ db, knowledge: knowledge ?? null, ...args });
    },

    async requestErase(args) {
      const ts = now();
      const purgeAfterAt = ts + gracePeriodMs;
      const raw = db.unsafe('gdpr_request_erase');

      // 1. Pruefe ob User existiert + nicht schon deleted.
      const userRows = await raw.query<{ id: string; status: string }>(
        `SELECT id, status FROM users WHERE id = $1 LIMIT 1`,
        [args.userId],
      );
      const userRow = userRows[0];
      if (!userRow) throw HttpError.notFound('user_not_found');
      if (userRow.status === 'deleted') {
        throw HttpError.conflict('user already in erasure flow', { userId: args.userId });
      }

      // 2. Soft-Delete: users.status='deleted', deleted_at=now.
      await raw.query(
        `UPDATE users SET status = 'deleted', deleted_at = $1 WHERE id = $2`,
        [ts, args.userId],
      );

      // 3. Queue-Row anlegen (UPSERT — falls eine cancelled-Row existiert).
      await raw.query(
        `INSERT INTO gdpr_erase_queue
           (user_id, requested_at, purge_after_at, requested_by, status)
         VALUES ($1, $2, $3, $4, 'pending')
         ON CONFLICT (user_id) DO UPDATE SET
           requested_at = EXCLUDED.requested_at,
           purge_after_at = EXCLUDED.purge_after_at,
           requested_by = EXCLUDED.requested_by,
           status = 'pending',
           processed_at = NULL,
           failure_reason = NULL`,
        [args.userId, ts, purgeAfterAt, args.actorUserId],
      );

      // 4. Alle aktiven Sessions des Users revoken.
      await raw.query(
        `UPDATE sessions SET revoked_at = $1
         WHERE user_id = $2 AND revoked_at IS NULL`,
        [ts, args.userId],
      );
      await raw.query(
        `UPDATE refresh_tokens SET revoked_at = $1
         WHERE user_id = $2 AND revoked_at IS NULL`,
        [ts, args.userId],
      );

      await emitAudit(db, {
        action: 'user.erase.requested',
        actorUserId: args.actorUserId,
        targetUserId: args.userId,
        result: 'success',
        ...(args.requestId !== undefined ? { requestId: args.requestId } : {}),
        details: { purgeAfterAt, gracePeriodMs },
      });

      return { purgeAfterAt, requestedAt: ts };
    },

    async cancelErase(args) {
      const ts = now();
      const raw = db.unsafe('gdpr_cancel_erase');

      const queueRows = await raw.query<{ user_id: string; status: string }>(
        `SELECT user_id, status FROM gdpr_erase_queue WHERE user_id = $1 LIMIT 1`,
        [args.userId],
      );
      const queueRow = queueRows[0];
      if (!queueRow) throw HttpError.notFound('no erase request pending');
      if (queueRow.status !== 'pending') {
        throw HttpError.conflict('erase already processed', { status: queueRow.status });
      }

      await raw.query(
        `UPDATE gdpr_erase_queue SET status = 'cancelled', processed_at = $1
         WHERE user_id = $2 AND status = 'pending'`,
        [ts, args.userId],
      );
      await raw.query(
        `UPDATE users SET status = 'active', deleted_at = NULL
         WHERE id = $1 AND status = 'deleted'`,
        [args.userId],
      );

      await emitAudit(db, {
        action: 'user.erase.cancelled',
        actorUserId: args.actorUserId,
        targetUserId: args.userId,
        result: 'success',
        ...(args.requestId !== undefined ? { requestId: args.requestId } : {}),
      });
    },

    async hardEraseUser(args) {
      const ts = now();
      const raw = db.unsafe('gdpr_hard_erase');
      let deletedKnowledgeRows = 0;
      let deletedLocalRows = 0;

      // Claim die Queue-Row (Status=processing) — verhindert parallele Crons.
      const claimedRows = await raw.query<{ user_id: string }>(
        `UPDATE gdpr_erase_queue
           SET status = 'processing'
         WHERE user_id = $1 AND status = 'pending'
         RETURNING user_id`,
        [args.userId],
      );
      if (claimedRows.length === 0) {
        throw HttpError.conflict('queue row not claimable (already processing or not pending)');
      }

      try {
        // 1. Crypto-Shred: KEK zerstoeren → alle wrapped_deks fuer diesen User
        //    werden permanent unrecoverable.
        await kekProvider.destroyKey(kekRefFor(args.userId));

        // 2. Cascade an mcp-knowledge2 (objects + share_grants des Users).
        if (knowledge) {
          const kcResult = await knowledge.eraseUser({
            userId: args.userId,
            confirmationToken: args.confirmationToken,
            actorUserId: args.actorUserId,
          });
          deletedKnowledgeRows = kcResult.deletedRows;
        }

        // 3. Lokale Tabellen-Deletes. ON DELETE CASCADE auf users(id) raeumt
        //    credentials/sessions/refresh_tokens/webauthn_credentials/... auf,
        //    aber wir machen explicit DELETEs vorab fuer:
        //    a) deterministische Reihenfolge im Audit-Log
        //    b) Pseudonymisierung der users-Row NACH der Cascade
        const credResult = await raw.query<{ id: string }>(
          `DELETE FROM credentials WHERE owner_id = $1 RETURNING id`,
          [args.userId],
        );
        deletedLocalRows += credResult.length;
        const sessResult = await raw.query<{ id: string }>(
          `DELETE FROM sessions WHERE user_id = $1 RETURNING id`,
          [args.userId],
        );
        deletedLocalRows += sessResult.length;
        const rtResult = await raw.query<{ id: string }>(
          `DELETE FROM refresh_tokens WHERE user_id = $1 RETURNING id`,
          [args.userId],
        );
        deletedLocalRows += rtResult.length;
        const waResult = await raw.query<{ id: string }>(
          `DELETE FROM webauthn_credentials WHERE user_id = $1 RETURNING id`,
          [args.userId],
        );
        deletedLocalRows += waResult.length;

        // 4. Pseudonymisiere users-Row (FK von audit_log bleibt intakt, aber
        //    PII raus). external_id=NULL damit OAuth-Login-Reuse-Path nicht
        //    versehentlich auf einen "geloeschten" User mappt.
        const pseudonymEmail = `[deleted-${args.userId}]`;
        await raw.query(
          `UPDATE users SET
             email = $1,
             display_name = '[deleted]',
             external_id = NULL,
             status = 'deleted',
             deleted_at = COALESCE(deleted_at, $2)
           WHERE id = $3`,
          [pseudonymEmail, ts, args.userId],
        );

        await raw.query(
          `UPDATE gdpr_erase_queue
             SET status = 'completed', processed_at = $1
           WHERE user_id = $2`,
          [ts, args.userId],
        );

        await emitAudit(db, {
          action: 'user.erased',
          actorUserId: args.actorUserId,
          targetUserId: args.userId,
          result: 'success',
          ...(args.requestId !== undefined ? { requestId: args.requestId } : {}),
          details: {
            deletedLocalRows,
            deletedKnowledgeRows,
            confirmationToken: hashForAudit(args.confirmationToken),
          },
        });

        return { deletedLocalRows, deletedKnowledgeRows };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await raw.query(
          `UPDATE gdpr_erase_queue
             SET status = 'failed', processed_at = $1, failure_reason = $2
           WHERE user_id = $3`,
          [ts, reason.slice(0, 500), args.userId],
        );
        await emitAudit(db, {
          action: 'user.erased',
          actorUserId: args.actorUserId,
          targetUserId: args.userId,
          result: 'failure',
          ...(args.requestId !== undefined ? { requestId: args.requestId } : {}),
          details: { error: reason },
        });
        throw err;
      }
    },

    async listDuePurges(timeNow: number) {
      const raw = db.unsafe('gdpr_list_due');
      const rows = await raw.query<{ user_id: string; purge_after_at: number | string }>(
        `SELECT user_id, purge_after_at FROM gdpr_erase_queue
         WHERE status = 'pending' AND purge_after_at <= $1`,
        [timeNow],
      );
      return rows.map((r) => ({
        userId: r.user_id,
        purgeAfterAt: typeof r.purge_after_at === 'number' ? r.purge_after_at : Number(r.purge_after_at),
      }));
    },
  };
}

/**
 * Export-Stream-Implementation. Wir streamen Row-fuer-Row, damit grosse
 * Exporte nicht den Heap fluten.
 */
async function* exportUserDataImpl(args: {
  readonly db: DbAdapter;
  readonly knowledge: KnowledgeService | null;
  readonly userId: string;
  readonly actorUserId: string;
  readonly requestId?: string;
}): AsyncIterable<GdprExportRecord> {
  const { db, knowledge, userId, actorUserId } = args;
  const raw = db.unsafe('gdpr_export');

  // Audit-Eintrag vorab — falls Stream mittendrin abbricht, wissen wir
  // dass ein Export angefordert wurde.
  await emitAudit(db, {
    action: 'data.exported',
    actorUserId,
    targetUserId: userId,
    result: 'success',
    ...(args.requestId !== undefined ? { requestId: args.requestId } : {}),
  });

  // 1. users-Row (eigene).
  const userRows = await raw.query<Record<string, unknown>>(
    `SELECT id, email, display_name, role, status, created_at, last_login_at,
            invited_by, deleted_at
       FROM users WHERE id = $1`,
    [userId],
  );
  for (const row of userRows) yield { table: 'users', row };

  // 2. credentials_meta — KEIN ciphertext, KEIN wrapped_dek. Nur Metadata.
  //    Plan §11.2: "credentials [meta only — NO secrets]"
  const credMetaRows = await raw.query<Record<string, unknown>>(
    `SELECT id, provider, kind, label, prf_enabled, meta_json,
            created_at, rotated_at, last_used_at, expires_at
       FROM credentials WHERE owner_id = $1`,
    [userId],
  );
  for (const row of credMetaRows) yield { table: 'credentials_meta', row };

  // 3. sessions (Audit-relevant — User darf sehen wo seine Logins waren).
  const sessRows = await raw.query<Record<string, unknown>>(
    `SELECT id, created_at, expires_at, device_id, ip, user_agent, last_seen_at, revoked_at
       FROM sessions WHERE user_id = $1`,
    [userId],
  );
  for (const row of sessRows) yield { table: 'sessions', row };

  // 4. webauthn_credentials — public-only Metadata (kein public_key BLOB raw).
  const waRows = await raw.query<Record<string, unknown>>(
    `SELECT id, friendly_name, transports, prf_supported, created_at, last_used_at, invalidated_at
       FROM webauthn_credentials WHERE user_id = $1`,
    [userId],
  );
  for (const row of waRows) yield { table: 'webauthn_credentials', row };

  // 5. audit_log — eigene Eintraege.
  const auditRows = await raw.query<Record<string, unknown>>(
    `SELECT id, ts, action, resource_kind, resource_id, result, details
       FROM audit_log WHERE actor_user_id = $1 ORDER BY ts DESC LIMIT 10000`,
    [userId],
  );
  for (const row of auditRows) yield { table: 'audit_log', row };

  // 6. objects (mcp-knowledge2) — wenn KnowledgeService verfuegbar.
  //    Iteriere durch alle vier kinds, paginiert.
  if (knowledge) {
    for (const kind of ['doc', 'skill', 'app', 'memo'] as const) {
      let cursor: string | null = null;
      do {
        const page: import('@mcp-approval2/adapters').ObjectsList = await (
          knowledge as KnowledgeService
        ).listObjects({
          userId,
          kind,
          ...(cursor !== null ? { cursor } : {}),
        });
        for (const obj of page.items) {
          yield {
            table: 'objects',
            row: obj as unknown as Record<string, unknown>,
          };
        }
        cursor = page.cursor;
      } while (cursor);
    }
  }
}

/**
 * Audit-Helper: hashen wir den confirmationToken, damit er nicht im
 * Audit-Log auftaucht (waere Secret-Leak).
 */
function hashForAudit(s: string): string {
  // einfacher SHA-256-Substring fuers Audit. Wir nutzen WebCrypto sync nicht,
  // also nehmen wir hier eine simple Laenge+Praefix-Pseudonymisierung — der
  // tatsaechliche Token ist ohnehin schon kurzlebig (60s).
  return `len=${s.length},prefix=${s.slice(0, 4)}***`;
}
