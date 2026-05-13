-- =============================================================================
-- 0001_initial.sql — Initial Schema fuer mcp-approval2 (Postgres 16+)
-- =============================================================================
-- Plan-Ref: PLAN-architecture-v1.md §3 (Identity), §5 (Credentials & Crypto),
--           §6 (Audit-Log).
--
-- Annahme: DB-Connection-User der Application heisst `app_user`. Audit-Append-
-- Only-Constraint wird gegen diesen User geREVOKEd. Read-Only-Admin-View nutzt
-- separaten `app_admin_ro`-User (out-of-band provisioned).
--
-- Idempotent: alle CREATE-Statements nutzen IF NOT EXISTS. CREATE POLICY hat
-- erst seit PG 17 IF NOT EXISTS — wir wrappen in DO $$ blocks fuer
-- Backwards-Compat mit PG 16.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- fuer gen_random_uuid()

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id     TEXT,                                       -- Google-OAuth sub, NULL solange invited
  email           TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member',             -- 'admin' | 'member'
  status          TEXT NOT NULL DEFAULT 'active',             -- 'active' | 'invited' | 'suspended' | 'deleted'
  created_at      BIGINT NOT NULL,
  last_login_at   BIGINT,
  invited_by      UUID,
  deleted_at      BIGINT,
  CONSTRAINT users_role_check CHECK (role IN ('admin', 'member')),
  CONSTRAINT users_status_check CHECK (status IN ('active', 'invited', 'suspended', 'deleted')),
  CONSTRAINT users_invited_by_fk FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_external ON users(external_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- -----------------------------------------------------------------------------
-- invites
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS invites (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL,
  invited_by      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL,
  created_at      BIGINT NOT NULL,
  expires_at      BIGINT NOT NULL,
  accepted_at     BIGINT,
  status          TEXT NOT NULL DEFAULT 'pending',            -- 'pending' | 'accepted' | 'expired' | 'revoked'
  CONSTRAINT invites_status_check CHECK (status IN ('pending', 'accepted', 'expired', 'revoked'))
);

CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_invites_status ON invites(status);

-- -----------------------------------------------------------------------------
-- sessions
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      BIGINT NOT NULL,
  expires_at      BIGINT NOT NULL,
  device_id       TEXT,
  ip              INET,
  user_agent      TEXT,
  last_seen_at    BIGINT,
  revoked_at      BIGINT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_revoked ON sessions(revoked_at);

-- -----------------------------------------------------------------------------
-- refresh_tokens
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL,
  parent_id       UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  replaced_by     UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  created_at      BIGINT NOT NULL,
  expires_at      BIGINT NOT NULL,
  revoked_at      BIGINT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_session ON refresh_tokens(session_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_parent ON refresh_tokens(parent_id);

-- -----------------------------------------------------------------------------
-- revoked_jtis
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS revoked_jtis (
  jti             UUID PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revoked_at      BIGINT NOT NULL,
  expires_at      BIGINT NOT NULL,
  reason          TEXT NOT NULL,
  CONSTRAINT revoked_jtis_reason_check CHECK (reason IN ('logout', 'admin_revoke', 'replay_detect', 'rotate'))
);

CREATE INDEX IF NOT EXISTS idx_revoked_jtis_expires ON revoked_jtis(expires_at);
CREATE INDEX IF NOT EXISTS idx_revoked_jtis_user ON revoked_jtis(user_id);

-- -----------------------------------------------------------------------------
-- webauthn_credentials
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id     BYTEA NOT NULL,
  public_key        BYTEA NOT NULL,
  sign_count        INTEGER NOT NULL DEFAULT 0,
  transports        JSONB DEFAULT '[]'::jsonb,
  prf_supported     BOOLEAN NOT NULL DEFAULT FALSE,
  prf_credential_id BYTEA,
  friendly_name     TEXT,
  created_at        BIGINT NOT NULL,
  last_used_at      BIGINT,
  invalidated_at    BIGINT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webauthn_credential_id ON webauthn_credentials(credential_id);
CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);

-- -----------------------------------------------------------------------------
-- credentials (envelope-encrypted user-service-tokens)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS credentials (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  kind              TEXT NOT NULL,                              -- 'oauth_refresh' | 'api_token' | 'password' | 'service_account'
  label             TEXT NOT NULL,

  -- Crypto-Material
  ciphertext        BYTEA NOT NULL,
  nonce             BYTEA NOT NULL,
  wrapped_dek       BYTEA NOT NULL,
  aad               TEXT NOT NULL,
  kek_ref           TEXT NOT NULL,
  alg               TEXT NOT NULL DEFAULT 'A256GCM',

  -- PRF-Layer
  prf_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  prf_credential_id BYTEA,

  -- Metadata (plaintext)
  meta_json         JSONB,

  -- Lifecycle
  created_at        BIGINT NOT NULL,
  rotated_at        BIGINT,
  last_used_at      BIGINT,
  expires_at        BIGINT,

  CONSTRAINT credentials_kind_check CHECK (kind IN ('oauth_refresh', 'api_token', 'password', 'service_account'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_owner_provider_label
  ON credentials(owner_id, provider, label);
CREATE INDEX IF NOT EXISTS idx_credentials_owner ON credentials(owner_id);
CREATE INDEX IF NOT EXISTS idx_credentials_provider ON credentials(provider);
CREATE INDEX IF NOT EXISTS idx_credentials_expires ON credentials(expires_at);

-- -----------------------------------------------------------------------------
-- audit_log (append-only)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts              BIGINT NOT NULL,
  actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_type      TEXT NOT NULL,                                -- 'user' | 'system' | 'admin'
  action          TEXT NOT NULL,
  resource_kind   TEXT,
  resource_id     UUID,
  before_hash     TEXT,
  after_hash      TEXT,
  ip              INET,
  user_agent      TEXT,
  request_id      UUID,
  result          TEXT NOT NULL,                                -- 'success' | 'denied' | 'error'
  details         JSONB,
  CONSTRAINT audit_log_actor_type_check CHECK (actor_type IN ('user', 'system', 'admin')),
  CONSTRAINT audit_log_result_check CHECK (result IN ('success', 'denied', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_audit_actor_ts ON audit_log(actor_user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action_ts ON audit_log(action, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource_kind, resource_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_log(request_id);

-- =============================================================================
-- Row-Level-Security (RLS)
-- =============================================================================
-- Plan-Ref: §4.4 Defense-in-Depth.
--
-- App-Layer-Check + DB-Layer-RLS als Fallback. Connection muss vor jeder Query
-- `SET LOCAL app.current_user = '<user-uuid>'` setzen (Middleware-Responsibility).
--
-- Tabellen mit RLS:
--   - credentials (owner-only, KEINE Sharing-Grants)
--   - sessions    (owner-only)
--   - refresh_tokens (owner-only)
--   - webauthn_credentials (owner-only)
--
-- audit_log: KEINE RLS. App-Layer-Restriction (Admin sieht alle, User sieht
-- nur eigene). Append-only via REVOKE statt RLS.
--
-- users + invites: KEINE RLS. App-Layer-Restriction.
-- =============================================================================

ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE webauthn_credentials ENABLE ROW LEVEL SECURITY;

-- DO $$ wrapper fuer CREATE POLICY (kein IF NOT EXISTS in PG <17):

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'owner_only_credentials' AND tablename = 'credentials'
  ) THEN
    CREATE POLICY owner_only_credentials ON credentials
      USING (owner_id = current_setting('app.current_user', TRUE)::uuid)
      WITH CHECK (owner_id = current_setting('app.current_user', TRUE)::uuid);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'owner_only_sessions' AND tablename = 'sessions'
  ) THEN
    CREATE POLICY owner_only_sessions ON sessions
      USING (user_id = current_setting('app.current_user', TRUE)::uuid)
      WITH CHECK (user_id = current_setting('app.current_user', TRUE)::uuid);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'owner_only_refresh_tokens' AND tablename = 'refresh_tokens'
  ) THEN
    CREATE POLICY owner_only_refresh_tokens ON refresh_tokens
      USING (user_id = current_setting('app.current_user', TRUE)::uuid)
      WITH CHECK (user_id = current_setting('app.current_user', TRUE)::uuid);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'owner_only_webauthn' AND tablename = 'webauthn_credentials'
  ) THEN
    CREATE POLICY owner_only_webauthn ON webauthn_credentials
      USING (user_id = current_setting('app.current_user', TRUE)::uuid)
      WITH CHECK (user_id = current_setting('app.current_user', TRUE)::uuid);
  END IF;
END$$;

-- =============================================================================
-- audit_log Append-only Enforcement
-- =============================================================================
-- Plan-Ref: §6.1 "Append-only: DB-User der App hat NUR INSERT-Recht."
--
-- Annahme: Connection-User der Application heisst `app_user`. Wenn die Rolle
-- nicht existiert, ueberspringen wir die REVOKE-Statements (Dev/Test ohne
-- separate Roles laufen dann eben mit superuser-Rights, das ist OK).
--
-- TODO (Phase 1): separater `app_admin_ro`-User fuer Audit-Read-Views einrichten.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    -- App darf nur INSERT
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM app_user;
    GRANT INSERT, SELECT ON audit_log TO app_user;
  END IF;
END$$;

-- =============================================================================
-- END 0001_initial.sql
-- =============================================================================
