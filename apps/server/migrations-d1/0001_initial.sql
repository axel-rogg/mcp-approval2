-- =============================================================================
-- 0001_initial.sql (D1 / SQLite dialect)
-- =============================================================================
-- D1-flavoured port of apps/server/migrations/0001_initial.sql.
--
-- DELTAS FROM POSTGRES SOURCE:
--   * No CREATE EXTENSION (no pgcrypto on SQLite).
--   * UUID → TEXT  with `lower(hex(randomblob(16)))` default (note: NOT a real
--     RFC-4122 v4 UUID; format is `<32 hex chars>` without dashes. App code
--     generates dashed UUIDs in user-id paths — this default is only the
--     last-resort fallback when application code forgets to supply one).
--   * JSONB → TEXT (JSON parsed at the app layer; SQLite has JSON1 functions
--     if we ever need server-side queries).
--   * BYTEA → BLOB.
--   * TIMESTAMPS stay INTEGER (epoch-ms), same as the Postgres BIGINT pattern.
--   * NO RLS, NO POLICIES — repository pattern enforces owner_id in WHERE.
--   * `pg_roles` REVOKE/GRANT block dropped — SQLite has no roles.
--   * `CONSTRAINT … CHECK (… IN ('a','b'))` is identical syntax — kept.
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  external_id     TEXT,
  email           TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member',
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      INTEGER NOT NULL,
  last_login_at   INTEGER,
  invited_by      TEXT,
  deleted_at      INTEGER,
  CONSTRAINT users_role_check CHECK (role IN ('admin', 'member')),
  CONSTRAINT users_status_check CHECK (status IN ('active', 'invited', 'suspended', 'deleted')),
  CONSTRAINT users_invited_by_fk FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_external ON users(external_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

CREATE TABLE IF NOT EXISTS invites (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email           TEXT NOT NULL,
  invited_by      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  accepted_at     INTEGER,
  status          TEXT NOT NULL DEFAULT 'pending',
  CONSTRAINT invites_status_check CHECK (status IN ('pending', 'accepted', 'expired', 'revoked'))
);

CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_invites_status ON invites(status);

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  device_id       TEXT,
  ip              TEXT,            -- PG INET → TEXT
  user_agent      TEXT,
  last_seen_at    INTEGER,
  revoked_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_revoked ON sessions(revoked_at);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL,
  parent_id       TEXT REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  replaced_by     TEXT REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  revoked_at      INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_session ON refresh_tokens(session_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_parent ON refresh_tokens(parent_id);

CREATE TABLE IF NOT EXISTS revoked_jtis (
  jti             TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revoked_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  reason          TEXT NOT NULL,
  CONSTRAINT revoked_jtis_reason_check CHECK (reason IN ('logout', 'admin_revoke', 'replay_detect', 'rotate'))
);

CREATE INDEX IF NOT EXISTS idx_revoked_jtis_expires ON revoked_jtis(expires_at);
CREATE INDEX IF NOT EXISTS idx_revoked_jtis_user ON revoked_jtis(user_id);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id     BLOB NOT NULL,
  public_key        BLOB NOT NULL,
  sign_count        INTEGER NOT NULL DEFAULT 0,
  transports        TEXT DEFAULT '[]',     -- JSON-text
  prf_supported     INTEGER NOT NULL DEFAULT 0,  -- 0|1
  prf_credential_id BLOB,
  friendly_name     TEXT,
  created_at        INTEGER NOT NULL,
  last_used_at      INTEGER,
  invalidated_at    INTEGER
);

-- D1 / SQLite UNIQUE on BLOB works (compared byte-for-byte).
CREATE UNIQUE INDEX IF NOT EXISTS idx_webauthn_credential_id ON webauthn_credentials(credential_id);
CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);

CREATE TABLE IF NOT EXISTS credentials (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  owner_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  kind              TEXT NOT NULL,
  label             TEXT NOT NULL,

  ciphertext        BLOB NOT NULL,
  nonce             BLOB NOT NULL,
  wrapped_dek       BLOB NOT NULL,
  aad               TEXT NOT NULL,
  kek_ref           TEXT NOT NULL,
  alg               TEXT NOT NULL DEFAULT 'A256GCM',

  prf_enabled       INTEGER NOT NULL DEFAULT 1,
  prf_credential_id BLOB,

  meta_json         TEXT,  -- JSON-text

  created_at        INTEGER NOT NULL,
  rotated_at        INTEGER,
  last_used_at      INTEGER,
  expires_at        INTEGER,

  CONSTRAINT credentials_kind_check CHECK (kind IN ('oauth_refresh', 'api_token', 'password', 'service_account'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_owner_provider_label
  ON credentials(owner_id, provider, label);
CREATE INDEX IF NOT EXISTS idx_credentials_owner ON credentials(owner_id);
CREATE INDEX IF NOT EXISTS idx_credentials_provider ON credentials(provider);
CREATE INDEX IF NOT EXISTS idx_credentials_expires ON credentials(expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  ts              INTEGER NOT NULL,
  actor_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_type      TEXT NOT NULL,
  action          TEXT NOT NULL,
  resource_kind   TEXT,
  resource_id     TEXT,
  before_hash     TEXT,
  after_hash      TEXT,
  ip              TEXT,
  user_agent      TEXT,
  request_id      TEXT,
  result          TEXT NOT NULL,
  details         TEXT,            -- JSON-text
  CONSTRAINT audit_log_actor_type_check CHECK (actor_type IN ('user', 'system', 'admin')),
  CONSTRAINT audit_log_result_check CHECK (result IN ('success', 'denied', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_audit_actor_ts ON audit_log(actor_user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action_ts ON audit_log(action, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource_kind, resource_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_log(request_id);

-- =============================================================================
-- TODO: migrations 0002–0007 are not yet ported. The CF deploy is functional
-- with this initial set (auth + credentials + audit only); features that
-- depend on 0002+ (sub-MCP gateway, rate-limit-audit-view, approvals tables,
-- cost ledger, per-user-DEK seeds) need explicit dialect-ports before they
-- light up. See deploy/cloudflare/migrations.toml header.
-- =============================================================================
