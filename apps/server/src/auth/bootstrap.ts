/**
 * First-Login-First-Admin Bootstrap.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.3.
 *
 * Aufgerufen vom Google-OAuth-Callback OHNE Invite-Token. Wenn `users`-Tabelle
 * leer ist (kein aktiver User), wird der einlogende Google-User als Admin
 * angelegt. Sonst → 403 `bootstrap_only`.
 *
 * SEC-008: zusaetzliche Email-Gating-Schicht.
 *   - Wenn `config.BOOTSTRAP_ADMIN_EMAIL` gesetzt ist, muss die einlogende
 *     Email exact-match (case-insensitive). Sonst → 403 `bootstrap_email_mismatch`.
 *   - Wenn `BOOTSTRAP_ADMIN_EMAIL` NICHT gesetzt ist, wirft die Funktion ein
 *     warn, akzeptiert aber den ersten User (Backward-Compat fuer existing
 *     deployments). In Production STRONGLY RECOMMENDED zu setzen.
 *   - Race-Schutz: `SELECT COUNT + INSERT` ist nicht atomar; die Migration
 *     0012 fuegt einen partial unique index `WHERE role='admin' AND
 *     status='active'` hinzu, der bei einem 2nd-Bootstrap-Versuch im selben
 *     Race-Fenster mit `unique_violation` (PG-error code 23505) abbricht.
 *   - Failed attempts werden via `admin.bootstrap.rejected` audit-logged.
 */
import type { DbAdapter } from '@mcp-approval2/adapters';
import { HttpError } from '../lib/errors.js';
import { emitAudit } from '../services/audit.js';

export interface BootstrapInput {
  readonly externalId: string;
  readonly email: string;
  readonly displayName: string;
}

export interface BootstrapResult {
  readonly userId: string;
  readonly role: 'admin';
  readonly bootstrapped: boolean;
}

export interface BootstrapConfig {
  readonly BOOTSTRAP_ADMIN_EMAIL?: string;
}

export async function bootstrapIfNeeded(
  db: DbAdapter,
  input: BootstrapInput,
  config?: BootstrapConfig,
): Promise<BootstrapResult> {
  const raw = db.unsafe('bootstrap_check_and_insert');

  // SEC-008: Email-Gate. Wenn Operator BOOTSTRAP_ADMIN_EMAIL gesetzt hat,
  // MUSS die einlogende Email matchen. Damit kann ein Angreifer der Fast-
  // Login-Race vor dem Operator gewinnt trotzdem keine Admin-Rolle claimen.
  const expectedEmail = config?.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const incomingEmail = input.email.trim().toLowerCase();
  if (expectedEmail && expectedEmail !== incomingEmail) {
    await emitAudit(db, {
      action: 'admin.bootstrap.rejected',
      actorUserId: null,
      result: 'failure',
      details: {
        reason: 'email_mismatch',
        incoming_email: incomingEmail,
        expected_email_set: true,
      },
    }).catch(() => {
      /* audit failure non-fatal */
    });
    throw HttpError.forbidden(
      'bootstrap_only',
      'bootstrap reserved for BOOTSTRAP_ADMIN_EMAIL operator',
    );
  }
  if (!expectedEmail) {
    // Backward-compat: existing deployments don't have this env-var set.
    // Loud warn so operator sees the drift.
    console.warn(
      `[bootstrap] BOOTSTRAP_ADMIN_EMAIL is not set. The first Google login (${incomingEmail}) will become admin. ` +
        `In production, set BOOTSTRAP_ADMIN_EMAIL to gate this against race-condition attackers (SEC-008).`,
    );
  }

  const rows = await raw.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM users WHERE status = 'active'`,
  );
  const count = rows[0]?.count ?? 0;
  if (count > 0) {
    throw HttpError.forbidden('bootstrap_only', 'invite required: bootstrap already completed');
  }
  const now = Date.now();
  // INSERT kann mit unique_violation failen, falls eine zweite Race-Instance
  // parallel INSERT'd hat — wir mappen das auf 403 bootstrap_only damit der
  // 2. Caller keinen 500 sieht. Postgres-error code 23505 = unique_violation,
  // signalisiert vom partial-unique-index aus Migration 0012.
  let inserted: { id: string }[];
  try {
    inserted = await raw.query<{ id: string }>(
      `INSERT INTO users (external_id, email, display_name, role, status, created_at, last_login_at, invited_by)
       VALUES ($1, $2, $3, 'admin', 'active', $4, $4, NULL)
       RETURNING id`,
      [input.externalId, incomingEmail, input.displayName, now],
    );
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === '23505') {
      await emitAudit(db, {
        action: 'admin.bootstrap.rejected',
        actorUserId: null,
        result: 'failure',
        details: { reason: 'race_lost_unique_violation', incoming_email: incomingEmail },
      }).catch(() => {
        /* non-fatal */
      });
      throw HttpError.forbidden('bootstrap_only', 'bootstrap already completed (race)');
    }
    throw err;
  }
  const userId = inserted[0]?.id;
  if (!userId) throw new Error('failed to insert bootstrap admin user');

  await emitAudit(db, {
    action: 'admin.bootstrap',
    actorUserId: userId,
    result: 'success',
    details: { email: incomingEmail },
  });

  return { userId, role: 'admin', bootstrapped: true };
}
