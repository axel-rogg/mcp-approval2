/**
 * DekService — per-User-persistent-Data-Encryption-Key.
 *
 * Plan-Ref: ADR-0001 (DEK-Resolution-Strategy, Variant B) — mcp-knowledge2
 *           callt /internal/v1/dek/resolve und bekommt 32 byte raw DEK; alle
 *           encrypt/decrypt-Ops fuer objects laufen damit.
 *
 * Lifecycle:
 *   - Beim ersten Resolve-Call eines Users: random 32-byte DEK generieren,
 *     mit `vault://transit/keys/user-dek-<userId>` wrappen, in
 *     `user_dek_seeds` persisten.
 *   - Bei Folge-Resolves: row lesen, mit dem stored kek_ref unwrappen,
 *     returnen.
 *   - Rotate: neuen DEK generieren, alten unwrappen-nicht-noetig, neuen
 *     wrappen, INSERT-or-UPDATE (UPDATE in der Praxis). Re-Encrypt der
 *     existing ciphertexts ist Caller-Job (Welle 4).
 *   - Destroy (GDPR): KekProvider.destroyKey(ref) → Crypto-Shred. Row
 *     bleibt als Tombstone bzw. wird via CASCADE-on-users-delete entfernt.
 *
 * Security:
 *   - DEK NIEMALS loggen. Audit-Eintraege nur mit user_id + request_id.
 *   - Konkurrente erste-Resolve-Calls fuer denselben User: wir nutzen
 *     `INSERT ... ON CONFLICT DO NOTHING RETURNING` und re-SELECT — der
 *     Verlierer des Race nutzt den DEK des Gewinners (idempotent).
 *   - DEK-Material wird als `Uint8Array` zurueckgegeben — Caller-Pflicht,
 *     den Buffer nach Gebrauch zu zeroen (best-effort; JS ist limitiert).
 */
import type { DbAdapter, KekProvider, KekRef } from '@mcp-approval2/adapters';
import { randomBytes } from '@mcp-approval2/core';
import { HttpError } from '../lib/errors.js';
import { emitAudit } from './audit.js';

export interface DekResolveArgs {
  readonly userId: string;
  readonly requestId?: string;
}

export interface DekService {
  /** Resolve (or auto-create) the user's persistent DEK. Returns 32 bytes. */
  resolveUserDek(args: DekResolveArgs): Promise<Uint8Array>;
  /** Rotate the user's DEK. Existing wrapped row is replaced. */
  rotateUserDek(args: { userId: string }): Promise<void>;
  /** Crypto-shred via OpenBao + delete the seed row (GDPR Art. 17). */
  destroyUserDek(args: { userId: string }): Promise<void>;
}

export interface DekServiceOptions {
  readonly db: DbAdapter;
  readonly kekProvider: KekProvider;
  /**
   * Builds the KekRef for a given user. Default produces
   * `vault://transit/keys/user-dek-<userId>` — separate ref-namespace from
   * credentials (`user-<userId>`) so the two key-rings are independent.
   */
  readonly kekRefForUser?: (userId: string) => KekRef;
}

interface SeedRow {
  readonly user_id: string;
  readonly wrapped_dek: Uint8Array;
  readonly kek_ref: string;
  readonly created_at: number | string;
  readonly rotated_at: number | string | null;
}

/**
 * Optional method on the KekProvider — production OpenBao impl has it, the
 * Local dev-impl does not. We feature-detect at runtime.
 */
interface KekProviderWithCreate extends KekProvider {
  createKey(ref: KekRef): Promise<void>;
}
function hasCreateKey(p: KekProvider): p is KekProviderWithCreate {
  return typeof (p as { createKey?: unknown }).createKey === 'function';
}

export function createDekService(opts: DekServiceOptions): DekService {
  const { db, kekProvider } = opts;
  const kekRefFor =
    opts.kekRefForUser ?? ((u: string) => `vault://transit/keys/user-dek-${u}`);

  async function readSeed(userId: string): Promise<SeedRow | null> {
    const raw = db.unsafe('dek_resolve_read');
    const rows = await raw.query<SeedRow>(
      `SELECT user_id, wrapped_dek, kek_ref, created_at, rotated_at
         FROM user_dek_seeds
        WHERE user_id = $1
        LIMIT 1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  async function insertSeed(
    userId: string,
    wrappedDek: Uint8Array,
    kekRef: string,
  ): Promise<SeedRow | null> {
    const raw = db.unsafe('dek_resolve_insert');
    // ON CONFLICT DO NOTHING + RETURNING: winner gets a row, loser gets [].
    // Loser re-selects.
    const rows = await raw.query<SeedRow>(
      `INSERT INTO user_dek_seeds (user_id, wrapped_dek, kek_ref, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING user_id, wrapped_dek, kek_ref, created_at, rotated_at`,
      [userId, wrappedDek, kekRef, Date.now()],
    );
    return rows[0] ?? null;
  }

  async function ensureTransitKey(ref: KekRef): Promise<void> {
    if (hasCreateKey(kekProvider)) {
      // Idempotent on OpenBao side (204 if exists).
      await kekProvider.createKey(ref);
    }
    // LocalKekProvider derives the per-ref KEK via HKDF on demand — no
    // create needed.
  }

  return {
    async resolveUserDek(args) {
      if (!args.userId || args.userId.length === 0) {
        throw new HttpError(400, 'invalid_request', 'userId required');
      }
      const kekRef = kekRefFor(args.userId);
      const requestId = args.requestId;

      try {
        // Step 1: existing row?
        let row = await readSeed(args.userId);

        if (!row) {
          // Step 2: first-time create — generate DEK, ensure transit key, wrap,
          // INSERT-with-conflict-tolerance, re-read on race-loss.
          const rawDek = randomBytes(32);
          await ensureTransitKey(kekRef);
          const wrapped = await kekProvider.wrap(rawDek, kekRef);
          const inserted = await insertSeed(args.userId, wrapped, kekRef);
          if (inserted) {
            row = inserted;
          } else {
            // Race: someone else inserted between our SELECT and INSERT.
            // Discard our DEK + read theirs.
            row = await readSeed(args.userId);
            if (!row) {
              // Cannot happen if INSERT...ON CONFLICT honored the constraint,
              // but defense-in-depth.
              throw new HttpError(500, 'internal', 'dek seed race recovery failed');
            }
          }

          await emitAudit(db, {
            action: 'dek.created',
            actorUserId: args.userId,
            result: 'success',
            ...(requestId ? { requestId } : {}),
            details: { kekRef },
          });
        }

        // Step 3: unwrap to raw DEK.
        const dek = await kekProvider.unwrap(row.wrapped_dek, row.kek_ref);
        if (dek.byteLength !== 32) {
          throw new HttpError(500, 'internal', 'unwrapped dek has unexpected length');
        }

        await emitAudit(db, {
          action: 'dek.resolved',
          actorUserId: args.userId,
          result: 'success',
          ...(requestId ? { requestId } : {}),
          // NEVER include the DEK bytes here, only metadata.
          details: { kekRef: row.kek_ref },
        });
        return dek;
      } catch (err) {
        await emitAudit(db, {
          action: 'dek.resolved',
          actorUserId: args.userId,
          result: 'failure',
          ...(requestId ? { requestId } : {}),
          details: { error: errorMessage(err) },
        });
        throw err;
      }
    },

    async rotateUserDek(args) {
      const kekRef = kekRefFor(args.userId);
      const rawDek = randomBytes(32);
      await ensureTransitKey(kekRef);
      const wrapped = await kekProvider.wrap(rawDek, kekRef);
      const raw = db.unsafe('dek_rotate');
      const rows = await raw.query<{ user_id: string }>(
        `UPDATE user_dek_seeds
            SET wrapped_dek = $1, kek_ref = $2, rotated_at = $3
          WHERE user_id = $4
          RETURNING user_id`,
        [wrapped, kekRef, Date.now(), args.userId],
      );
      if (rows.length === 0) {
        // No row to rotate — caller is expected to resolve() at least once
        // first. Throw rather than silently insert.
        throw HttpError.notFound('user dek not initialized');
      }
      await emitAudit(db, {
        action: 'dek.rotated',
        actorUserId: args.userId,
        result: 'success',
        details: { kekRef },
      });
    },

    async destroyUserDek(args) {
      const kekRef = kekRefFor(args.userId);
      // 1. Crypto-shred — destroy the transit key. After this, the wrapped
      // bytes are unrecoverable.
      try {
        await kekProvider.destroyKey(kekRef);
      } catch (err) {
        // If the key doesn't exist (404), continue to clean up the row;
        // other errors bubble.
        const code = (err as { status?: number }).status;
        if (code !== 404) throw err;
      }
      // 2. Drop the seed row.
      const raw = db.unsafe('dek_destroy');
      await raw.query(
        `DELETE FROM user_dek_seeds WHERE user_id = $1`,
        [args.userId],
      );
      await emitAudit(db, {
        action: 'dek.destroyed',
        actorUserId: args.userId,
        result: 'success',
        details: { kekRef },
      });
    },
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
