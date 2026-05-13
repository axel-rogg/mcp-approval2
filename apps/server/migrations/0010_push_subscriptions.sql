-- =============================================================================
-- 0010_push_subscriptions.sql — WebPush-Subscriptions pro User
-- =============================================================================
-- Plan-Ref: PLAN-architecture-v1.md §7 (Notification-Surface). Portiert von
--           mcp-approval/migrations/.../push_subscriptions (Workers/D1-Variante).
--
-- Schema:
--   - id          UUID PK
--   - user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
--   - endpoint    TEXT NOT NULL UNIQUE  (Push-Service-spezifische URL)
--   - p256dh      TEXT NOT NULL         (base64url uncompressed P-256 pub)
--   - auth        TEXT NOT NULL         (base64url 16-byte auth secret)
--   - user_agent  TEXT NULL             (browser-Info aus Settings-Push)
--   - created_at  BIGINT NOT NULL       (epoch-ms)
--   - last_used_at BIGINT NULL          (epoch-ms, gesetzt nach send())
--
-- RLS: owner-only (current_setting('app.current_user')::uuid).
-- Idempotent: alle CREATE haben IF NOT EXISTS / DO $$-blocks.
-- =============================================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint      TEXT NOT NULL,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  user_agent    TEXT,
  created_at    BIGINT NOT NULL,
  last_used_at  BIGINT,

  CONSTRAINT push_subscriptions_endpoint_check
    CHECK (length(endpoint) > 0 AND length(endpoint) <= 2048),
  CONSTRAINT push_subscriptions_p256dh_check
    CHECK (length(p256dh) > 0 AND length(p256dh) <= 256),
  CONSTRAINT push_subscriptions_auth_check
    CHECK (length(auth) > 0 AND length(auth) <= 64)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint
  ON push_subscriptions(endpoint);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions(user_id);

-- =============================================================================
-- Row-Level-Security: owner-only
-- =============================================================================

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'push_owner_only' AND tablename = 'push_subscriptions'
  ) THEN
    CREATE POLICY push_owner_only ON push_subscriptions
      USING (user_id = current_setting('app.current_user', TRUE)::uuid)
      WITH CHECK (user_id = current_setting('app.current_user', TRUE)::uuid);
  END IF;
END$$;

-- =============================================================================
-- END 0010_push_subscriptions.sql
-- =============================================================================
