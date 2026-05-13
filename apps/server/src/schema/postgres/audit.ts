/**
 * audit_log — Append-only Compliance-Log.
 *
 * Plan-Ref: PLAN-architecture-v1.md §6 (Audit-Logging).
 *
 * Append-only Enforcement (in 0001_initial.sql):
 *   REVOKE UPDATE, DELETE ON audit_log FROM app_user;
 *
 * App-Connection-User (`app_user`) hat NUR INSERT-Recht. Separate Read-Only-
 * User fuer Admin-View. Selbst Operator-Admin kann NICHT modifizieren.
 *
 * Pflicht-Events (§6.3):
 * - Auth: login.success/failed, logout, session.refresh, passkey.enrolled,
 *   passkey.recovered
 * - Permission: role.changed, share_grant.created/revoked, admin.bootstrap
 * - Credential: created, read (jeder Decrypt!), rotated, deleted
 * - Data: export, delete (GDPR)
 * - Admin: user.invited, user.suspended, user.deleted, settings.changed
 * - Tool: invoked (args-hash), approved, denied, completed (output-hash)
 */
import {
  bigint,
  index,
  inet,
  jsonb,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * audit_log-Tabelle.
 *
 * - `id`: UUID.
 * - `ts`: epoch-ms. Indexed DESC fuer Time-Range-Queries.
 * - `actor_user_id`: FK auf users(id). NULL fuer System-Events (Crons, etc.).
 * - `actor_type`: 'user' | 'system' | 'admin'.
 * - `action`: dotted-namespace ('auth.login.success', 'credential.read', ...).
 * - `resource_kind` / `resource_id`: was angesprochen wurde. NULL bei system-events.
 * - `before_hash` / `after_hash`: SHA-256 von before/after-state (fuer
 *   change-detection ohne PII zu loggen).
 * - `ip` / `user_agent`: Request-Kontext.
 * - `request_id`: korreliert Audit-Eintrage mit Worker-Logs.
 * - `result`: 'success' | 'denied' | 'error'.
 * - `details`: JSONB-Payload fuer event-spezifische Daten (z.B. tool-args-hash,
 *   OAuth-scope, share-grant-target). PII pseudonymisiert.
 *
 * Indexe:
 * - (actor_user_id, ts DESC): "alle Events von User X" — User-Audit-View.
 * - (action, ts DESC): "alle login.failed der letzten 24h" — Security-View.
 * - (resource_kind, resource_id, ts DESC): "alle Touches auf Credential Y".
 */
export const auditLogTable = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ts: bigint('ts', { mode: 'number' }).notNull(),
    actorUserId: uuid('actor_user_id'),
    actorType: text('actor_type').notNull(), // 'user' | 'system' | 'admin'
    action: text('action').notNull(),
    resourceKind: text('resource_kind'),
    resourceId: uuid('resource_id'),
    beforeHash: text('before_hash'),
    afterHash: text('after_hash'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    requestId: uuid('request_id'),
    result: text('result').notNull(), // 'success' | 'denied' | 'error'
    details: jsonb('details').$type<Record<string, unknown>>(),
  },
  (t) => ({
    actorTsIdx: index('idx_audit_actor_ts').on(t.actorUserId, t.ts),
    actionTsIdx: index('idx_audit_action_ts').on(t.action, t.ts),
    resourceIdx: index('idx_audit_resource').on(t.resourceKind, t.resourceId, t.ts),
    requestIdx: index('idx_audit_request').on(t.requestId),
  })
);
