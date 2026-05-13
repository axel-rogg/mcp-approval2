/**
 * users + invites — Identity-Layer.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3 (Identity & Authentication).
 *
 * Single-Tenant: KEIN `tenant_id`-Column. Multi-User-Isolation lebt via
 * `owner_id`/`user_id`-FK in den anderen Tabellen.
 *
 * Bootstrap-Mode: First-Login-First-Admin (§3.3). Wenn users-Tabelle leer ist,
 * darf erster Google-OAuth-Login durch ohne Invite. Steady-Mode: alle weiteren
 * Logins brauchen invites-Row mit matching email.
 */
import { bigint, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * users-Tabelle.
 *
 * - `id`: interne UUID, Single-Source-of-Truth fuer alle FK-Verweise.
 * - `external_id`: Google-OAuth `sub`-Claim. Wird beim Accept-Invite gesetzt,
 *   ist NULL solange `status='invited'`.
 * - `email`: UNIQUE — sowohl Invite-Match-Key als auch Login-Identity.
 * - `role`: 'admin' | 'member'. Erster aktiver User wird Admin (Bootstrap).
 * - `status`: 'active' | 'invited' | 'suspended' | 'deleted'. Soft-Delete via
 *   `deleted_at` mit 30-Tage-Grace-Window vor Crypto-Shredding (§5.5).
 * - `invited_by`: self-referenzierende FK auf einladenden User. NULL bei
 *   Bootstrap-Admin.
 * - `deleted_at`: Timestamp wenn User soft-deleted wurde. Hard-Delete via Cron.
 *
 * Timestamps: `bigint` (epoch-millis) statt PG-`timestamptz` — Plan §3.1 nutzt
 * INTEGER, was epoch-seconds nahelegt. Wir waehlen ms-precision (bigint) um
 * mit JS Date.now() direkt zu interop'en und cross-dialect (SQLite) zu bleiben.
 */
export const usersTable = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    externalId: text('external_id'), // NULL solange status='invited'
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    role: text('role').notNull().default('member'), // 'admin' | 'member'
    status: text('status').notNull().default('active'), // 'active' | 'invited' | 'suspended' | 'deleted'
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastLoginAt: bigint('last_login_at', { mode: 'number' }),
    invitedBy: uuid('invited_by'),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
  },
  (t) => ({
    emailUnique: uniqueIndex('users_email_unique').on(t.email),
    externalIdIdx: index('idx_users_external').on(t.externalId),
    statusIdx: index('idx_users_status').on(t.status),
  })
);

/**
 * invites-Tabelle.
 *
 * Admin erstellt Invite per `POST /admin/invites { email }`. Signed Magic-Link
 * wird per Email versendet (24h TTL). User klickt Link → Google-OAuth-Login
 * (email MUSS match invite.email).
 *
 * - `token_hash`: SHA-256 vom raw-token. Raw-token nie persistiert.
 * - `status`: 'pending' | 'accepted' | 'expired' | 'revoked'.
 * - `expires_at`: epoch-ms, default 24h nach `created_at`.
 * - `accepted_at`: gesetzt wenn User Invite akzeptiert hat.
 *
 * FK-Constraint auf `invited_by → users(id)` wird in der SQL-Migration gesetzt
 * (siehe migrations/0001_initial.sql) — Drizzle-DSL fuer cross-table FKs ist
 * hier bewusst minimal gehalten, SQL ist Source-of-Truth fuer DDL.
 */
export const invitesTable = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    invitedBy: uuid('invited_by').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    acceptedAt: bigint('accepted_at', { mode: 'number' }),
    status: text('status').notNull().default('pending'), // 'pending' | 'accepted' | 'expired' | 'revoked'
  },
  (t) => ({
    emailIdx: index('idx_invites_email').on(t.email),
    tokenHashIdx: uniqueIndex('idx_invites_token_hash').on(t.tokenHash),
    statusIdx: index('idx_invites_status').on(t.status),
  })
);
