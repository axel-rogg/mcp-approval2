/**
 * sessions + refresh_tokens + revoked_jtis — Session-Management.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.5 (Session-Management).
 *
 * Pattern:
 * - Session-JWT mit 30 min TTL (jti = sessions.id, in-band).
 * - Refresh-Token in HTTP-Only-Cookie, 30 Tage TTL, rotation on use (RFC 9700).
 * - Replay-Detection: alter Refresh-Token erneut → komplette Familie revoken.
 *
 * Drei Tabellen:
 *   - sessions: aktive + expired Sessions (jti, user_id, device-context).
 *   - refresh_tokens: Refresh-Token-Familie pro Session (rotation-history).
 *   - revoked_jtis: Bloomfilter-Ersatz fuer schnellen Revoke-Check pro Request.
 */
import {
  bigint,
  index,
  inet,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * sessions-Tabelle. Eine Row pro Login.
 *
 * - `id`: UUID, wird als JWT `jti` verwendet — pro Request gegen revoked_jtis
 *   geprueft.
 * - `user_id`: FK auf users(id).
 * - `created_at` / `expires_at`: Session-Lifetime (30 min Default).
 * - `device_id`: stabile Device-Kennung (z.B. Hash aus User-Agent + Screen).
 *   Hilft beim Erkennen von Refresh-Token-Replays aus anderen Geraeten.
 * - `ip` / `user_agent`: Audit-Kontext, NICHT als Auth-Faktor genutzt.
 * - `last_seen_at`: rolling-Update bei jedem Request (Idle-Tracking).
 * - `revoked_at`: gesetzt bei explicit logout ODER Refresh-Replay-Detection.
 *
 * RLS-Policy (in 0001_initial.sql): owner-only — `user_id = current_setting
 * ('app.current_user')::uuid`. Admin-Read kommt aus separatem read-only User.
 */
export const sessionsTable = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    deviceId: text('device_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    lastSeenAt: bigint('last_seen_at', { mode: 'number' }),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
  },
  (t) => ({
    userIdx: index('idx_sessions_user').on(t.userId),
    expiresIdx: index('idx_sessions_expires').on(t.expiresAt),
    revokedIdx: index('idx_sessions_revoked').on(t.revokedAt),
  })
);

/**
 * refresh_tokens-Tabelle. Refresh-Familie pro Session.
 *
 * Pattern (RFC 9700 rotation):
 *   - Beim Login: neue Session + erstes Refresh-Token (parent=NULL).
 *   - Bei Refresh-Use: alte Row revoked + neue Row (parent=old.id) ausgegeben.
 *   - Replay-Erkennung: wenn revoked-Row erneut angefragt wird → ALLE Rows der
 *     Familie (chain via parent) revoken, Session terminieren, Audit-Log.
 *
 * - `token_hash`: SHA-256 vom raw-refresh-token. Raw-Token nie persistiert.
 * - `parent_id`: Vorgaenger in der Rotations-Kette. NULL fuer initial Token.
 * - `revoked_at`: NULL = aktiv. Sonst entweder normal-rotated oder replay.
 * - `replaced_by`: Zeiger auf Nachfolger (denormalisiert fuer Replay-Detection).
 */
export const refreshTokensTable = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull(),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    parentId: uuid('parent_id'),
    replacedBy: uuid('replaced_by'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex('idx_refresh_tokens_hash').on(t.tokenHash),
    sessionIdx: index('idx_refresh_tokens_session').on(t.sessionId),
    userIdx: index('idx_refresh_tokens_user').on(t.userId),
    parentIdx: index('idx_refresh_tokens_parent').on(t.parentId),
  })
);

/**
 * revoked_jtis-Tabelle. Schnell-Check fuer Session-JWT-Revoke.
 *
 * JWT-Validation-Middleware muss pro Request pruefen: ist `jti` in dieser
 * Tabelle? Wenn ja → 401. Index auf (jti) macht das O(1).
 *
 * Rows altern: nach `expires_at` (Original-JWT-Expiry) ist der Eintrag obsolet
 * — wird durch Cron-Cleanup geloescht (siehe Phase 1 Cron-Job).
 *
 * - `jti`: PRIMARY KEY — uniqueness ist enforct, und Lookup-Lookup-Performant.
 * - `reason`: 'logout' | 'admin_revoke' | 'replay_detect' | 'rotate'. Audit.
 */
export const revokedJtisTable = pgTable(
  'revoked_jtis',
  {
    jti: uuid('jti').primaryKey(),
    userId: uuid('user_id').notNull(),
    revokedAt: bigint('revoked_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    reason: text('reason').notNull(),
  },
  (t) => ({
    expiresIdx: index('idx_revoked_jtis_expires').on(t.expiresAt),
    userIdx: index('idx_revoked_jtis_user').on(t.userId),
  })
);
