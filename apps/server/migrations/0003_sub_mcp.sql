-- =============================================================================
-- 0003_sub_mcp.sql — Sub-MCP-Server-Registry (Gateway-Pattern)
-- =============================================================================
-- Plan-Ref: PLAN-architecture-v1.md §5.4 (Sub-MCP-Credential-Verteilung),
--           §9 (Sub-MCP-Server).
--
-- Eine Tabelle:
--   - sub_mcp_servers — registrierte externe Sub-MCP-Server (cf/gh/gws/...).
--
-- Keine RLS-Policy — Registry ist global (admin-managed), nicht user-scoped.
-- Discovery wird periodisch ueber `POST /internal/v1/sub-mcp/discover` getriggert
-- (z.B. von externem Cron) und cached die `tools/list`-Antwort in `tools_cache`.
--
-- Service-Token-Hashing: wir persistieren NUR SHA-256-Hex des Service-Tokens.
-- Plain-Token lebt in den Sub-MCP-Worker-ENVs out-of-band.
-- =============================================================================

CREATE TABLE IF NOT EXISTS sub_mcp_servers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  base_url        TEXT NOT NULL,
  auth_mode       TEXT NOT NULL,
  auth_config     JSONB NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  tools_cache     JSONB,
  tools_cached_at BIGINT,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  CONSTRAINT sub_mcp_auth_mode_check CHECK (
    auth_mode IN ('service_bearer', 'oauth', 'pat')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_mcp_name
  ON sub_mcp_servers(name);

CREATE INDEX IF NOT EXISTS idx_sub_mcp_enabled
  ON sub_mcp_servers(enabled) WHERE enabled = TRUE;

-- =============================================================================
-- END 0003_sub_mcp.sql
-- =============================================================================
