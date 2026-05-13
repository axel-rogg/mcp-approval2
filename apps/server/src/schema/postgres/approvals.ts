/**
 * pending_approvals — WYSIWYS-Approval-Queue fuer State-modifying Tool-Calls.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2 (Request-Lifecycle Step 5), §11 Phase 4
 * (Approval-Flow with PRF-Integration).
 *
 * Flow:
 *   1. MCP-Client ruft `tools/call` → Tool-Registry wirft `ApprovalRequiredError`
 *      (sensitivity != 'read').
 *   2. Transport faengt das ab, ruft `ApprovalService.create({...})` → DB-Row
 *      mit status='pending', expires_at = now + ttl. Antwort an Client:
 *      `result.approval_required: true, approval_id: <id>, expires_at: <ts>`.
 *   3. PWA pollt `GET /v1/approvals` und zeigt die rendered display-string an.
 *   4. User signt mit WebAuthn (optional PRF-Eval fuer Credential-Tools).
 *   5. PWA postet `POST /v1/approvals/:id/approve` mit `signature` + optional
 *      `prf_session_id`.
 *   6. ApprovalService.approve verifyt WebAuthn-Assertion, setzt status='approved'
 *      und triggert Re-Dispatch des Tool-Calls (registry.dispatch mit
 *      bypassApproval=true). Result wird in `result_json` persistiert.
 *   7. PWA pollt `GET /v1/approvals/:id/result` und zeigt das Ergebnis.
 *
 * RLS: owner-only (`user_id = current_setting('app.current_user')::uuid`).
 *
 * TTL: default 5 min. Cron-Job (sweepExpired) flippt pending → expired wenn
 * `expires_at < now`.
 *
 * Idempotency: einmal approved/rejected/expired ist die Row final. Wiederholte
 * Approves auf eine schon-approved Row liefern 409 Conflict.
 */
import {
  bigint,
  customType,
  index,
  inet,
  jsonb,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return 'bytea';
  },
  fromDriver(value: Uint8Array) {
    return value;
  },
  toDriver(value: Uint8Array) {
    return value;
  },
});

/**
 * pending_approvals-Tabelle.
 *
 * Spalten-Gruppen:
 *
 * Identity:
 * - `id`: UUID (PK).
 * - `user_id`: FK auf users(id). RLS filtert hier.
 * - `tool_name`: registry-Name des aufgerufenen Tools.
 * - `tool_input`: JSONB-Snapshot der validated Args.
 *
 * Display (WYSIWYS):
 * - `display_template`: das raw-Template (mit `{{path}}`-Placeholders) wie aus
 *   tool.displayTemplate uebernommen.
 * - `display_rendered`: gerenderter Text (max 500 chars, HTML-stripped).
 *
 * Approval-Klassifikation:
 * - `sensitivity`: 'write' | 'danger'.
 * - `status`: 'pending' | 'approved' | 'rejected' | 'expired'.
 *
 * WebAuthn-Sign-Off:
 * - `approval_challenge`: random base64url, mit Approval-Create gesetzt. Wird
 *   der PWA als Teil der `assertion`-Options ausgehaendigt.
 * - `approval_signature`: WebAuthn-assertion-signature (BYTEA, proof-of-approval).
 * - `approved_at` / `rejected_at` / `expired_at`: lifecycle-Timestamps.
 * - `rejection_reason`: optional User-Text.
 *
 * PRF:
 * - `prf_session_id`: Verweis auf PrfSessionService-Eintrag (in-memory). Wird
 *   beim Resume an die credentials.read durchgereicht.
 *
 * Result:
 * - `result_json`: tool.execute-Output nach Re-Dispatch. PWA pollt das.
 * - `result_emitted_at`: Zeitstempel — PWA kann long-pollen "bis emitted".
 *
 * Origin:
 * - `request_id`: Audit-Korrelation zum originalen tools/call-Request.
 * - `origin_ip`: Request-Source (Audit only).
 *
 * Lifecycle:
 * - `created_at` / `expires_at`.
 */
export const pendingApprovalsTable = pgTable(
  'pending_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    toolName: text('tool_name').notNull(),
    toolInput: jsonb('tool_input').$type<Record<string, unknown>>().notNull(),

    displayTemplate: text('display_template'),
    displayRendered: text('display_rendered'),

    sensitivity: text('sensitivity').notNull(), // 'write' | 'danger'
    status: text('status').notNull().default('pending'), // 'pending' | 'approved' | 'rejected' | 'expired'

    approvalChallenge: text('approval_challenge'),
    approvalSignature: bytea('approval_signature'),
    approvedAt: bigint('approved_at', { mode: 'number' }),
    rejectedAt: bigint('rejected_at', { mode: 'number' }),
    rejectionReason: text('rejection_reason'),
    expiredAt: bigint('expired_at', { mode: 'number' }),

    prfSessionId: text('prf_session_id'),

    resultJson: jsonb('result_json').$type<Record<string, unknown>>(),
    resultEmittedAt: bigint('result_emitted_at', { mode: 'number' }),

    requestId: uuid('request_id'),
    originIp: inet('origin_ip'),

    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  },
  (t) => ({
    userPendingIdx: index('idx_approvals_user_pending').on(t.userId, t.status),
    expiresIdx: index('idx_approvals_expires').on(t.expiresAt),
    createdIdx: index('idx_approvals_created').on(t.createdAt),
  }),
);
