/**
 * Refresh-Token-Rotation (RFC 9700) mit Replay-Detection.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.5.
 *
 * Pattern:
 *  - Login: erstes Refresh-Token (parent=NULL) wird ausgegeben.
 *  - Bei `/auth/refresh`: alter Token revoked + neuer ausgegeben (parent=old).
 *  - Replay: revoked-Token nochmal benutzt → komplette Familie revoken,
 *    Session terminieren, Audit-Log Event `session.refresh_replay`.
 *
 * Raw-Token wird NIE persistiert — nur SHA-256(Token) als `token_hash`.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AppConfig } from '../../lib/config.js';
import type { DbAdapter } from '@mcp-approval2/adapters';
import { HttpError } from '../../lib/errors.js';
import { emitAudit } from '../../services/audit.js';

export interface RefreshTokenRow {
  readonly id: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly parentId: string | null;
  readonly replacedBy: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
}

export interface IssuedRefresh {
  readonly rawToken: string;
  readonly id: string;
  readonly tokenHash: string;
  readonly expiresAt: number;
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function newRawToken(): string {
  // 32 random bytes → base64url
  return randomBytes(32).toString('base64url');
}

export async function issueInitialRefresh(
  db: DbAdapter,
  config: AppConfig,
  args: { sessionId: string; userId: string },
): Promise<IssuedRefresh> {
  const raw = newRawToken();
  const tokenHash = hashToken(raw);
  const createdAt = Date.now();
  const expiresAt = createdAt + config.REFRESH_TTL_SEC * 1000;
  // WICHTIG: db.transaction() statt db.scoped() — letzteres oeffnet BEGIN
  // aber niemand ruft release() → COMMIT fehlt → INSERT verloren →
  // anschliessender Lookup wirft refresh_token_unknown. transaction()
  // committed automatisch wenn die callback resolved.
  const id = await db.transaction<string>(args.userId, async (scoped) => {
    const rows = await scoped.query<{ id: string }>(
      `INSERT INTO refresh_tokens (session_id, user_id, token_hash, parent_id, created_at, expires_at)
       VALUES ($1, $2, $3, NULL, $4, $5) RETURNING id`,
      [args.sessionId, args.userId, tokenHash, createdAt, expiresAt],
    );
    const insertedId = rows[0]?.id;
    if (!insertedId) throw new Error('failed to insert refresh_tokens row');
    return insertedId;
  });
  return { rawToken: raw, id, tokenHash, expiresAt };
}

export interface RotateResult {
  readonly newToken: IssuedRefresh;
  readonly sessionId: string;
  readonly userId: string;
}

/**
 * Tauscht einen bestehenden Refresh-Token gegen einen neuen.
 *
 * Wenn der gefundene Token bereits `revoked_at` gesetzt hat → replay
 * detection: komplette Familie revoken + Audit-Event + 401.
 */
export async function rotateRefresh(
  db: DbAdapter,
  config: AppConfig,
  rawToken: string,
): Promise<RotateResult> {
  const tokenHash = hashToken(rawToken);
  // Lookup ohne user-scope, da wir den User noch nicht kennen.
  const raw = db.unsafe('refresh_token_lookup');
  const found = await raw.query<RefreshTokenRow>(
    `SELECT id, session_id AS "sessionId", user_id AS "userId", token_hash AS "tokenHash",
            parent_id AS "parentId", replaced_by AS "replacedBy",
            created_at AS "createdAt", expires_at AS "expiresAt", revoked_at AS "revokedAt"
       FROM refresh_tokens WHERE token_hash = $1 LIMIT 1`,
    [tokenHash],
  );
  const row = found[0];
  if (!row) throw HttpError.unauthorized('refresh_token_unknown');

  if (row.revokedAt !== null) {
    // REPLAY!
    await raw.query(
      `UPDATE refresh_tokens SET revoked_at = $2 WHERE session_id = $1 AND revoked_at IS NULL`,
      [row.sessionId, Date.now()],
    );
    await raw.query(
      `UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`,
      [row.sessionId, Date.now()],
    );
    await emitAudit(db, {
      action: 'session.refresh_replay',
      actorUserId: row.userId,
      result: 'failure',
      details: { sessionId: row.sessionId, refreshId: row.id },
    });
    throw HttpError.unauthorized('refresh_replay_detected', { sessionId: row.sessionId });
  }

  if (row.expiresAt < Date.now()) {
    throw HttpError.unauthorized('refresh_token_expired');
  }

  const newRaw = newRawToken();
  const newHash = hashToken(newRaw);
  const now = Date.now();
  const newExpires = now + config.REFRESH_TTL_SEC * 1000;

  // db.transaction() statt db.scoped() — siehe issueInitialRefresh.
  // scoped() ohne release() committed nicht, INSERT geht verloren.
  const newId = await db.transaction<string>(row.userId, async (scoped) => {
    const inserted = await scoped.query<{ id: string }>(
      `INSERT INTO refresh_tokens (session_id, user_id, token_hash, parent_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [row.sessionId, row.userId, newHash, row.id, now, newExpires],
    );
    const insertedId = inserted[0]?.id;
    if (!insertedId) throw new Error('failed to insert rotated refresh_tokens row');
    await scoped.query(
      `UPDATE refresh_tokens SET revoked_at = $1, replaced_by = $2 WHERE id = $3`,
      [now, insertedId, row.id],
    );
    return insertedId;
  });

  await emitAudit(db, {
    action: 'session.refresh',
    actorUserId: row.userId,
    result: 'success',
    details: { sessionId: row.sessionId, oldId: row.id, newId },
  });

  return {
    newToken: { rawToken: newRaw, id: newId, tokenHash: newHash, expiresAt: newExpires },
    sessionId: row.sessionId,
    userId: row.userId,
  };
}

export async function revokeSession(
  db: DbAdapter,
  args: { sessionId: string; userId: string; reason: 'logout' | 'admin_revoke' | 'rotate' },
): Promise<void> {
  const now = Date.now();
  const scoped = await db.scoped(args.userId);
  await scoped.query(
    `UPDATE refresh_tokens SET revoked_at = $1 WHERE session_id = $2 AND revoked_at IS NULL`,
    [now, args.sessionId],
  );
  await scoped.query(
    `UPDATE sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL`,
    [now, args.sessionId],
  );
  await emitAudit(db, {
    action: 'session.revoke',
    actorUserId: args.userId,
    result: 'success',
    details: { sessionId: args.sessionId, reason: args.reason },
  });
}
