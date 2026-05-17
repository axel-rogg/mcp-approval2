-- Multi-User Tier 1 (2026-05-17): persistente Email-Outbox.
--
-- Hintergrund: bei EMAIL_PROVIDER=console (default solange DNS-Verify
-- pending ist) gehen Invite/Recovery-Emails nirgendwo hin. Der Admin muss
-- die Magic-Links manuell zustellen.
--
-- Damit der Admin nicht im Server-Log nach den Links graben muss, schreiben
-- wir jede ausgehende Email zusätzlich in diese Tabelle. Die Admin-PWA
-- zeigt "Outbox" als Liste — Admin sieht subject + to + sent_at + body,
-- kann Link copy-pasten + per Signal/iMessage an Tester schicken.
--
-- WICHTIG: Body enthält Recovery/Invite-Tokens (= bearer-equivalent). Tabelle
-- ist NICHT user-scoped — admin-only Read via RLS-Policy unten. Server-Code
-- (services/email-outbox.ts) prueft Admin-Role vor jedem Read.
--
-- Retention: 30 Tage TTL via Cron-Sweep (separate Cron-Job). Auch wenn ein
-- Admin den Link nie liest: Token expired nach INVITE_TTL_SEC / RECOVERY_TTL_SEC
-- sowieso (~24h), die persistente Row in der Outbox waere nur noch
-- audit-relevant.

CREATE TABLE IF NOT EXISTS email_outbox (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Wenn ein User-Bezug existiert (target user). Optional — bei
  -- Recovery-Request-fuer-unknown-email speichern wir kein user_id.
  to_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  to_email      TEXT NOT NULL,
  subject       TEXT NOT NULL,
  -- HTML + Plain-Text Body. Bei console-Provider sind das die "echten"
  -- Inhalte (mit Tokens). Bei resend-Provider speichern wir sie zusaetzlich
  -- fuer Audit/Re-Send.
  body_html     TEXT NOT NULL,
  body_text     TEXT NOT NULL,
  -- "invite" | "recovery" | "notification". Klassifizierung fuer die UI.
  kind          TEXT NOT NULL,
  -- Provider-Antwort. console-fallback: 'console'. resend-success:
  -- 'resend' + provider_message_id. resend-fail: 'failed' + error_detail.
  provider      TEXT NOT NULL,
  provider_message_id TEXT,
  status        TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'logged')),
  error_detail  TEXT,
  created_at    BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  -- Wann der Admin die Mail ueber die PWA-UI als "manually dispatched"
  -- markiert (nur fuer console-Mode relevant). Default NULL.
  manually_dispatched_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_email_outbox_created_at
  ON email_outbox(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_outbox_kind_status
  ON email_outbox(kind, status);

-- KEINE RLS-Policy auf email_outbox — die Tabelle ist append-only-write
-- (vom EmailAdapter-Caller) + admin-only-read (vom Admin-PWA-Tab).
-- Beide Pfade gehen ueber app-layer principal.role-checks in
-- services/email-outbox.ts. Analog zu audit_log, das auch nur app-layer
-- gated ist.
--
-- Wenn jemand spaeter Multi-Tenant macht (per-Org admin-Rolle), kann hier
-- RLS via `app.current_role` Setting nachgezogen werden — bedingt aber
-- eine Anpassung von db.scoped() um das Setting zu setzen.
