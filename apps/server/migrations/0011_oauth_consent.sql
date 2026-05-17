-- SEC-005 (Phase A): explizite User-Consent fuer DCR-registrierte Clients.
--
-- Vor dieser Migration: /oauth/authorize hat fuer eingeloggte User direkt den
-- Code ausgestellt ohne Consent-Page. Damit konnte ein Angreifer einen DCR-
-- Client mit redirect_uri="https://attacker.com/cb" registrieren und einen
-- single-click-Account-Takeover via /oauth/authorize-Link bauen.
--
-- Nach dieser Migration: jedes (user_id, client_id)-Paar braucht eine
-- explizite Consent-Row bevor der Authorize-Endpoint den Code ausstellt.
-- Erst-Auth fuer einen Client → HTML-Consent-Page; nach POST /oauth/consent
-- ist die Row da und nachfolgende Authorize-Calls flutschen durch.

CREATE TABLE IF NOT EXISTS oauth_client_consents (
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id        TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scope_granted    TEXT,
  consented_at     BIGINT NOT NULL,
  consented_ip     INET,
  user_agent       TEXT,
  PRIMARY KEY (user_id, client_id)
);

-- RLS-Policy: User sieht/aendert nur eigene Consent-Rows.
ALTER TABLE oauth_client_consents ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'oauth_client_consents'
       AND policyname = 'oauth_consent_owner'
  ) THEN
    CREATE POLICY oauth_consent_owner ON oauth_client_consents
      USING (user_id = current_setting('app.current_user', true)::UUID)
      WITH CHECK (user_id = current_setting('app.current_user', true)::UUID);
  END IF;
END $$;
