/**
 * WritemodeService — pro-User Auto-Approve-Window persistiert in der
 * `write_mode`-Tabelle (Migration 0013).
 *
 * Plan-Ref: docs/plans/active/PLAN-writemode.md (Slice 3).
 *
 * Verantwortung:
 *   - `activate(userId, durationMin, credentialId)` — INSERT einer neuen
 *     Session-Row. Mehrere parallele Sessions sind erlaubt (Re-Activation
 *     verlaengert NICHT — die laengere gewinnt automatisch via MAX-Scan).
 *   - `deactivate(userId)` — alle aktiven Rows des Users auf jetzt expired.
 *     Idempotent (gibt 0 zurueck wenn nichts zu beenden war).
 *   - `isActive(userId, now?)` — boolean Hot-Path-Check. Wird im
 *     Registry-Dispatch (Slice 5) pro Tool-Call aufgerufen — muss schnell sein.
 *   - `listActive(userId)` — fuer den /writemode/status-Endpoint.
 *
 * Was NICHT hier liegt:
 *   - WebAuthn-Verifikation: macht die Route (`routes/writemode.ts`) vor dem
 *     `activate`-Aufruf. Diese Schicht kennt nur Datenbank.
 *   - Sweep abgelaufener Rows: der hot-path braucht keinen Sweep (Index-only-
 *     Scan auf `expires_at > now`). Ein optionaler Cron koennte die DB
 *     periodisch aufraeumen.
 *
 * RLS: alle Queries gehen ueber `db.transaction(userId, ...)` → `app.current_user`
 * ist gesetzt, owner_only_write_mode greift.
 */
import type { DbAdapter } from '@mcp-approval2/adapters';

export type WritemodeDuration = 15 | 60 | 240;
export const VALID_DURATIONS: ReadonlyArray<WritemodeDuration> = [15, 60, 240];

export type WritemodeMethod = 'webauthn' | 'smoke';

export interface WritemodeSession {
  readonly id: string;
  readonly userId: string;
  readonly activatedAt: number;
  readonly expiresAt: number;
  readonly activatedByCredential: string;
  readonly method: WritemodeMethod;
}

export interface ActivateArgs {
  readonly userId: string;
  readonly durationMin: WritemodeDuration;
  readonly credentialId: string;
  readonly method?: WritemodeMethod;
  /** Test-Helper: deterministische Uhrzeit. Default Date.now(). */
  readonly now?: number;
}

export interface DeactivateArgs {
  readonly userId: string;
  readonly now?: number;
}

export interface IsActiveArgs {
  readonly userId: string;
  readonly now?: number;
}

export interface ListActiveArgs {
  readonly userId: string;
  readonly now?: number;
}

export interface WritemodeService {
  activate(args: ActivateArgs): Promise<WritemodeSession>;
  deactivate(args: DeactivateArgs): Promise<number>;
  isActive(args: IsActiveArgs): Promise<boolean>;
  listActive(args: ListActiveArgs): Promise<WritemodeSession[]>;
}

export interface WritemodeServiceOptions {
  readonly db: DbAdapter;
}

interface SessionRow {
  id: string;
  user_id: string;
  activated_at: number | string;
  expires_at: number | string;
  activated_by_credential: string;
  method: string;
}

function rowToSession(r: SessionRow): WritemodeSession {
  const method = r.method === 'smoke' ? 'smoke' : 'webauthn';
  return {
    id: r.id,
    userId: r.user_id,
    activatedAt: Number(r.activated_at),
    expiresAt: Number(r.expires_at),
    activatedByCredential: r.activated_by_credential,
    method,
  };
}

function assertDuration(d: number): asserts d is WritemodeDuration {
  if (!VALID_DURATIONS.includes(d as WritemodeDuration)) {
    throw new Error(
      `writemode: invalid duration ${d} (allowed: ${VALID_DURATIONS.join(', ')})`,
    );
  }
}

export function createWritemodeService(
  opts: WritemodeServiceOptions,
): WritemodeService {
  const { db } = opts;

  return {
    async activate(args) {
      assertDuration(args.durationMin);
      if (!args.credentialId || args.credentialId.length === 0) {
        throw new Error('writemode: credentialId is required');
      }
      const now = args.now ?? Date.now();
      const expiresAt = now + args.durationMin * 60 * 1000;
      const method: WritemodeMethod = args.method ?? 'webauthn';

      return db.transaction(args.userId, async (scoped) => {
        const rows = await scoped.query<SessionRow>(
          `INSERT INTO write_mode
             (user_id, activated_at, expires_at, activated_by_credential, method)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, user_id, activated_at, expires_at,
                     activated_by_credential, method`,
          [args.userId, now, expiresAt, args.credentialId, method],
        );
        if (rows.length === 0) {
          throw new Error('writemode: INSERT returned no row');
        }
        return rowToSession(rows[0]!);
      });
    },

    async deactivate(args) {
      const now = args.now ?? Date.now();
      return db.transaction(args.userId, async (scoped) => {
        const rows = await scoped.query<{ id: string }>(
          `UPDATE write_mode
              SET expires_at = $2
            WHERE user_id = $1 AND expires_at > $2
            RETURNING id`,
          [args.userId, now],
        );
        return rows.length;
      });
    },

    async isActive(args) {
      const now = args.now ?? Date.now();
      return db.transaction(args.userId, async (scoped) => {
        const rows = await scoped.query<{ id: string }>(
          `SELECT id
             FROM write_mode
            WHERE user_id = $1 AND expires_at > $2
            LIMIT 1`,
          [args.userId, now],
        );
        return rows.length > 0;
      });
    },

    async listActive(args) {
      const now = args.now ?? Date.now();
      return db.transaction(args.userId, async (scoped) => {
        const rows = await scoped.query<SessionRow>(
          `SELECT id, user_id, activated_at, expires_at,
                  activated_by_credential, method
             FROM write_mode
            WHERE user_id = $1 AND expires_at > $2
            ORDER BY expires_at DESC`,
          [args.userId, now],
        );
        return rows.map(rowToSession);
      });
    },
  };
}
