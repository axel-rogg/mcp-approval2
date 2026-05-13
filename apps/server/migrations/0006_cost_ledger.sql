-- =============================================================================
-- 0006_cost_ledger.sql — Per-User Tages-Budget-Counter fuer AI-Inference.
-- =============================================================================
-- Plan-Ref: PLAN-architecture-v1.md §10 (Cost-Controls), §8.3 (AI-Provider
--           Cost-Control).
--
-- Schema:
--   - cost_ledger: append-Tabelle. Pro AI-Call ein Row (oder mehrere Rows wenn
--     mehrere Providers/Modelle in einer Pipeline aufgerufen werden). Cron-
--     basierte Daily-Rollup ist Phase 2.
--   - cost_daily: View ueber SUM(total_usd) pro (user_id, date) — Hot-Path
--     fuer precheck()-Aggregation.
--
-- Aufruf-Pattern:
--   precheck(userId)  → SELECT SUM(total_usd) FROM cost_ledger
--                       WHERE user_id = $1 AND date = CURRENT_DATE
--   record(userId, …) → INSERT INTO cost_ledger (…)
--
-- Default-Tageslimit pro User: $5.00 (env COST_USD_DAILY_LIMIT). Soft-Limit
-- bei 80% (Warning-Header X-Cost-Soft-Limit), Hard-Limit bei 100% (429).
--
-- Append-only: KEINE UPDATE/DELETE-Operationen vom App-Layer. Hard-Delete nur
-- via GDPR-Erase-Cron (ON DELETE CASCADE auf users(id) ist ABSICHTLICH NICHT
-- gesetzt — Crypto-Shredding entkoppelt User-Loeschung, Reports brauchen die
-- aggregierten Zahlen evtl. weiter).
-- =============================================================================

CREATE TABLE IF NOT EXISTS cost_ledger (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL,
  date                DATE NOT NULL,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  prompt_tokens       INTEGER NOT NULL DEFAULT 0,
  completion_tokens   INTEGER NOT NULL DEFAULT 0,
  embedding_tokens    INTEGER NOT NULL DEFAULT 0,
  total_usd           DOUBLE PRECISION NOT NULL,
  call_count          INTEGER NOT NULL DEFAULT 1,
  request_id          UUID,
  created_at          BIGINT NOT NULL,
  CONSTRAINT cost_ledger_total_usd_check CHECK (total_usd >= 0),
  CONSTRAINT cost_ledger_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT cost_ledger_provider_check CHECK (provider IN ('vertex', 'openai', 'anthropic'))
);

CREATE INDEX IF NOT EXISTS idx_cost_ledger_user_date ON cost_ledger(user_id, date);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_created   ON cost_ledger(created_at);

-- Aggregations-View. Hilft Cost-Tracker.getDaily() ohne wiederholtes SUM().
CREATE OR REPLACE VIEW cost_daily AS
SELECT
  user_id,
  date,
  SUM(total_usd)    AS total_usd,
  SUM(call_count)   AS calls,
  SUM(prompt_tokens)     AS prompt_tokens,
  SUM(completion_tokens) AS completion_tokens,
  SUM(embedding_tokens)  AS embedding_tokens
FROM cost_ledger
GROUP BY user_id, date;

-- =============================================================================
-- END 0006_cost_ledger.sql
-- =============================================================================
