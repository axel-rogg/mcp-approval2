-- =============================================================================
-- 0004_rate_limit_and_audit_view.sql
-- =============================================================================
-- Plan-Ref: PLAN-architecture-v1.md §10 (Rate-Limiting), §5.5 (Crypto-Shredding),
--           §11.2 (Offboarding), §6.3 (Audit-Events).
--
-- Inhalt:
--   1. rate_limit_buckets — Token-Bucket Counter (persistent fallback fuer
--      Single-Instance, Phase 1). In-Memory-Bucket ist Primary. DB-Counter
--      ist optional und dient nur Cost-Counter + Multi-Instance-Plan (Phase 2,
--      dann Redis statt DB).
--
--   2. v_audit_by_user — Read-Only-View die Admin-Routes nutzen koennen,
--      ohne Plaintext-Details zu sehen. PII-Felder (email, ip, user_agent)
--      werden gepseudonymisiert.
--
--   3. gdpr_erase_queue — Hilfs-Tabelle die User-Self-Service-Erase und den
--      30-Tage-Grace-Period-Cron koppelt. Cron pruft `purge_after_at <= now`
--      und triggert Hard-Delete (Crypto-Shred + Cascade).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- rate_limit_buckets
-- -----------------------------------------------------------------------------
-- bucket_id-Konvention:
--   user:<uuid>      — pro-User-Bucket (Request-Counter)
--   tenant:global    — instance-weiter Bucket (Anti-Burst-Schutz)
--   cost:<uuid>      — Tages-USD-Budget pro User fuer AI-Inference (Phase 6,
--                      hier nur Schema-ready)
--
-- tokens DOUBLE: erlaubt fractional refill (z.B. 1.6666 tokens/sec).
-- last_refill BIGINT: epoch-ms — siehe Date.now()-Konvention.
-- capacity / refill_per_sec: config-snapshot. Ueberschriebene Config beim Boot
-- updated die Row via UPSERT (Service-Layer-Verantwortung).

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_id       TEXT PRIMARY KEY,
  tokens          DOUBLE PRECISION NOT NULL,
  last_refill     BIGINT NOT NULL,
  capacity        DOUBLE PRECISION NOT NULL,
  refill_per_sec  DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_last_refill
  ON rate_limit_buckets(last_refill);

-- -----------------------------------------------------------------------------
-- gdpr_erase_queue
-- -----------------------------------------------------------------------------
-- Plan-Ref: §5.5 GDPR-Crypto-Shredding (30-Tage-Grace-Period).
--
-- User triggert `DELETE /v1/gdpr/erase` → users.status='deleted' (soft) +
-- gdpr_erase_queue-Row mit purge_after_at = now + 30d. Cron pruft die Queue
-- + triggert Hard-Delete (vault.destroyKey + DELETE FROM <tabs> + knowledge2-
-- cascade). Status-Spalte erlaubt:
--   pending      — wartet auf Grace-Period-Ablauf
--   processing   — Cron hat die Row geclaimt, Hard-Delete laeuft
--   completed    — alle Steps erfolgreich, Row bleibt fuer Audit
--   failed       — ein Step gescheitert, Operator-Eskalation
--   cancelled    — User hat innerhalb der Grace-Period reaktiviert

CREATE TABLE IF NOT EXISTS gdpr_erase_queue (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  requested_at     BIGINT NOT NULL,
  purge_after_at   BIGINT NOT NULL,
  requested_by     UUID,                                       -- user_id (self-service) ODER admin-user-id
  status           TEXT NOT NULL DEFAULT 'pending',
  processed_at     BIGINT,
  failure_reason   TEXT,
  CONSTRAINT gdpr_erase_queue_status_check
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_gdpr_erase_purge_after
  ON gdpr_erase_queue(purge_after_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_gdpr_erase_status
  ON gdpr_erase_queue(status);

-- -----------------------------------------------------------------------------
-- v_audit_by_user — Admin-Read-Only-View
-- -----------------------------------------------------------------------------
-- Plan-Ref: §4.1 "Admin sieht nur User-Liste + Audit-Log + Quotas — keine
-- User-Inhalte." View liefert Audit-Eintrage MIT pseudonymisierten Detail-
-- Feldern (kein details-JSONB exposed — nur dotted action / actor / target /
-- result / ts).
--
-- Admin-Routes nutzen die DIREKTE audit_log-Tabelle (sehen full details), aber
-- diese View ist fuer Cross-User-Reports (z.B. "alle login.failed der letzten
-- 24h") gedacht ohne PII-Leak in BI-Tools.

CREATE OR REPLACE VIEW v_audit_by_user AS
SELECT
  a.id,
  a.ts,
  a.actor_user_id,
  a.actor_type,
  a.action,
  a.resource_kind,
  a.resource_id,
  a.result,
  a.request_id
  -- Bewusst KEINE: details, ip, user_agent, before_hash, after_hash.
FROM audit_log a;

-- =============================================================================
-- END 0004_rate_limit_and_audit_view.sql
-- =============================================================================
