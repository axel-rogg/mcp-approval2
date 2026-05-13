-- =============================================================================
-- 0002_oauth.sql — OAuth 2.1 Authorization-Server Schema (MCP-Spec Nov 2025)
-- =============================================================================
-- Plan-Ref: PLAN-architecture-v1.md §11 Phase 4 (OAuth 2.1 + PKCE Endpoints).
--
-- Drei Tabellen fuer den /oauth/*-Flow:
--   - oauth_clients         (pre-registered + DCR-Clients, RFC 7591)
--   - oauth_authz_codes     (Auth-Code-Flow + PKCE, 60s TTL, one-shot)
--   - oauth_refresh_tokens  (RFC 9700 Rotation mit Family-Replay-Detection)
--
-- Hinweis: keine RLS-Policies — der OAuth-Service operiert mit Service-
-- Rolle (unsafe()-Path) und filtert app-seitig. User-bezogene Reads in
-- /oauth/me oder Admin-Surfaces nutzen explizite user_id-WHERE-Klauseln.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- oauth_clients
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id                       TEXT PRIMARY KEY,
  client_secret_hash              TEXT,
  redirect_uris                   JSONB NOT NULL,
  grant_types                     JSONB NOT NULL DEFAULT '["authorization_code", "refresh_token"]'::jsonb,
  scope                           TEXT,
  token_endpoint_auth_method      TEXT DEFAULT 'client_secret_post',
  client_name                     TEXT,
  client_uri                      TEXT,
  logo_uri                        TEXT,
  contacts                        JSONB,
  software_id                     TEXT,
  registration_access_token_hash  TEXT,
  created_at                      BIGINT NOT NULL,
  expires_at                      BIGINT,
  registration_source             TEXT NOT NULL,
  CONSTRAINT oauth_clients_source_check CHECK (
    registration_source IN ('dcr', 'cimd', 'pre-registered')
  ),
  CONSTRAINT oauth_clients_auth_method_check CHECK (
    token_endpoint_auth_method IN ('client_secret_post', 'client_secret_basic', 'none')
  )
);

CREATE INDEX IF NOT EXISTS idx_oauth_clients_source  ON oauth_clients(registration_source);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_expires ON oauth_clients(expires_at);

-- -----------------------------------------------------------------------------
-- oauth_authz_codes
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS oauth_authz_codes (
  code_hash             TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri          TEXT NOT NULL,
  scope                 TEXT,
  resource              TEXT,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  created_at            BIGINT NOT NULL,
  expires_at            BIGINT NOT NULL,
  used_at               BIGINT,
  CONSTRAINT oauth_codes_method_check CHECK (code_challenge_method IN ('S256'))
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_authz_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_client  ON oauth_authz_codes(client_id);

-- -----------------------------------------------------------------------------
-- oauth_refresh_tokens
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash    TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope         TEXT,
  resource      TEXT,
  created_at    BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL,
  rotated_at    BIGINT,
  family_id     UUID NOT NULL,
  revoked_at    BIGINT,
  revoke_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_family  ON oauth_refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_client  ON oauth_refresh_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user    ON oauth_refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_expires ON oauth_refresh_tokens(expires_at);

-- =============================================================================
-- END 0002_oauth.sql
-- =============================================================================
