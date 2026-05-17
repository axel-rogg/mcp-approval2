#!/usr/bin/env node
/**
 * Test-Injection-Skript: erzeugt eine synthetische pending-Approval mit
 * langem SQL-Body, um die PWA-Anzeige (Popup-Modal, scrollable sec-body,
 * Section-Layout) zu testen ohne tatsaechlich einen Tool-Call zu machen.
 *
 * Usage:
 *   DATABASE_URL=...   node inject-test-approval.mjs <email>
 *   # ODER auf Fly:
 *   flyctl ssh console -a mcp-approval2 -C \
 *     "node /app/apps/server/scripts/inject-test-approval.mjs <email>"
 *
 * Bypasst Tool-Dispatch. Insert geht via Transaction mit SET LOCAL
 * app.current_user = <user_id> damit RLS-WITH-CHECK greift.
 *
 * Vorsicht: das ist Debug-Tool. Approval ist regulaer durch User
 * approve/reject-bar; nur "tool wird wirklich ausgefuehrt" funktioniert nicht
 * (toolName 'test.long-sql' ist nicht registriert → resume-dispatch wuerde
 * scheitern). Reject ist sicher.
 */
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';

function randomB64Url(n) {
  return randomBytes(n)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const email = process.argv[2];
if (!email) {
  console.error('Usage: node inject-test-approval.mjs <user-email>');
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL ?? process.env.DATABASE_ADMIN_URL;
if (!dbUrl) {
  console.error('Set DATABASE_URL or DATABASE_ADMIN_URL in env');
  process.exit(1);
}

const LONG_SQL = `-- Migration 0042_user_activity_aggregates.sql
-- Erzeugt aggregierte Activity-Views fuer die Admin-Dashboard-Surface.
-- Performance-Goal: < 200ms full table scan auf 10M-row audit_log.
--
-- Vorgehen:
--   1. Materialized View user_activity_daily mit 24h-Buckets
--   2. CONCURRENT REFRESH-Pfad damit Live-Reads nicht blocken
--   3. Indexes auf (user_id, bucket_start) + GiST auf JSON-details
--   4. Trigger der die MV bei Audit-Inserts inkrementell updated

BEGIN;

-- =============================================================================
-- 1. Materialized View
-- =============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS user_activity_daily AS
WITH
  -- Audit-Events der letzten 90 Tage in Tages-Buckets gruppieren.
  daily_buckets AS (
    SELECT
      actor_user_id        AS user_id,
      date_trunc('day', to_timestamp(created_at / 1000.0)) AS bucket_start,
      action,
      result,
      COUNT(*)             AS event_count,
      MIN(created_at)      AS first_event_ms,
      MAX(created_at)      AS last_event_ms
    FROM audit_log
    WHERE created_at >= (EXTRACT(EPOCH FROM (NOW() - INTERVAL '90 days')) * 1000)::BIGINT
      AND actor_user_id IS NOT NULL
    GROUP BY actor_user_id, date_trunc('day', to_timestamp(created_at / 1000.0)), action, result
  ),
  -- Approval-Specific Aggregates (separat damit JOIN nicht das Hauptfenster aufblaeht).
  approval_summary AS (
    SELECT
      user_id,
      date_trunc('day', to_timestamp(approved_at / 1000.0))   AS bucket_start,
      COUNT(*) FILTER (WHERE status = 'approved')             AS approvals_approved,
      COUNT(*) FILTER (WHERE status = 'rejected')             AS approvals_rejected,
      COUNT(*) FILTER (WHERE status = 'expired')              AS approvals_expired,
      AVG(CASE WHEN approved_at IS NOT NULL
                THEN approved_at - created_at
                ELSE NULL END)                                AS avg_decision_ms
    FROM pending_approvals
    WHERE COALESCE(approved_at, rejected_at, expired_at, created_at) >= (
      EXTRACT(EPOCH FROM (NOW() - INTERVAL '90 days')) * 1000
    )::BIGINT
    GROUP BY user_id, date_trunc('day', to_timestamp(approved_at / 1000.0))
  )
SELECT
  d.user_id,
  d.bucket_start,
  jsonb_object_agg(d.action || ':' || d.result, d.event_count)
    FILTER (WHERE d.event_count IS NOT NULL)                  AS action_counts,
  COALESCE(a.approvals_approved, 0)                           AS approvals_approved,
  COALESCE(a.approvals_rejected, 0)                           AS approvals_rejected,
  COALESCE(a.approvals_expired,  0)                           AS approvals_expired,
  a.avg_decision_ms,
  SUM(d.event_count)                                          AS total_events,
  MIN(d.first_event_ms)                                       AS first_event_ms,
  MAX(d.last_event_ms)                                        AS last_event_ms
FROM daily_buckets d
LEFT JOIN approval_summary a
       ON d.user_id      = a.user_id
      AND d.bucket_start = a.bucket_start
GROUP BY
  d.user_id, d.bucket_start, a.approvals_approved,
  a.approvals_rejected, a.approvals_expired, a.avg_decision_ms;

-- =============================================================================
-- 2. Indexes — required fuer CONCURRENT REFRESH
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_uad_pk
  ON user_activity_daily(user_id, bucket_start);
CREATE INDEX IF NOT EXISTS idx_uad_bucket
  ON user_activity_daily(bucket_start);
CREATE INDEX IF NOT EXISTS idx_uad_actions
  ON user_activity_daily USING GIN (action_counts);

-- =============================================================================
-- 3. Incremental-Update-Trigger (audit_log → MV)
-- =============================================================================

CREATE OR REPLACE FUNCTION refresh_user_activity_daily() RETURNS trigger AS $$
BEGIN
  -- Concurrent refresh ist non-blocking auf Reader-Seite.
  -- Bei hohem Insert-Volume eventuell auf NOTIFY + async worker umstellen.
  PERFORM pg_notify('refresh_user_activity_daily', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_uad_refresh ON audit_log;
CREATE TRIGGER trg_uad_refresh
  AFTER INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION refresh_user_activity_daily();

COMMIT;

-- Erst-Befuellung
REFRESH MATERIALIZED VIEW user_activity_daily;
`;

const displayRendered = `=== Tool ===
test.long-sql · injected for popup/section testing

=== SQL ===
${LONG_SQL}

=== Notes ===
Synthetische Approval (Script: scripts/inject-test-approval.mjs).
Klick "🔍 Im Popup oeffnen" auf der SQL-Section um die Modal-Anzeige zu
testen. Approve wuerde fehlschlagen (Tool 'test.long-sql' ist nicht
registriert), Reject ist sicher.`;

const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });

try {
  const users = await sql`SELECT id, email FROM users WHERE email = ${email} LIMIT 1`;
  if (users.length === 0) {
    console.error(`user not found: ${email}`);
    process.exit(1);
  }
  const userId = users[0].id;
  console.log(`Target user: ${users[0].email} (${userId})`);

  const now = Date.now();
  const expiresAt = now + 5 * 60 * 1000;

  const result = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_user', ${userId}, true)`;
    const rows = await tx`
      INSERT INTO pending_approvals (
        user_id, tool_name, tool_input,
        display_template, display_rendered,
        sensitivity, status,
        approval_challenge,
        created_at, expires_at
      ) VALUES (
        ${userId},
        'test.long-sql',
        ${sql.json({ sql: LONG_SQL })},
        '=== Tool ===\n{{toolName}}',
        ${displayRendered},
        'write',
        'pending',
        ${randomB64Url(32)},
        ${now},
        ${expiresAt}
      )
      RETURNING id
    `;
    return rows[0];
  });

  console.log(`✓ injected pending approval ${result.id}`);
  console.log(`  expires_at: ${new Date(expiresAt).toISOString()}`);
  console.log(`  PWA: https://mcp-approval2.fly.dev/#/approvals/${result.id}`);
} finally {
  await sql.end({ timeout: 5 });
}
