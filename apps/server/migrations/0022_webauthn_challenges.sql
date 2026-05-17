-- =============================================================================
-- 0022_webauthn_challenges.sql — DB-backed Challenge-Store fuer WebAuthn
-- =============================================================================
--
-- Hintergrund: routes/auth/webauthn.ts hatte einen In-Memory-Map als
-- Challenge-Store. Auf Fly mit 2+ Maschinen (auto_stop+auto_start) trifft
-- der begin-Request u.U. eine andere Machine als der finish-Request →
-- 'webauthn_challenge_mismatch'.
--
-- Diese Tabelle persistiert Challenges zwischen begin + finish ueber alle
-- Server-Instances hinweg. Lebensdauer 5 min (cleanup im finish-Step durch
-- DELETE; abgelaufene Rows werden lazy via WHERE-Filter im take()
-- ignoriert).
--
-- KEINE RLS-Policy: Challenges sind kurzlebig + an einen challengeId-Token
-- gebunden, der nur dem Begin-Caller bekannt ist (randomBytes(16) →
-- base64url). RLS waere overkill + macht Boot-Sequenz schwerer (kein
-- gesetzter app.current_user beim login/begin der oeffentlich ist).
-- =============================================================================

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  -- ASCII-base64url, 22-24 chars (randomBytes(16)):
  challenge_id  TEXT PRIMARY KEY,
  -- WebAuthn-Challenge (base64url). Lifecycle: 5 min from creation.
  challenge     TEXT NOT NULL,
  -- 'reg' (enrollment) | 'login' (authentication). Discriminator damit
  -- ein registration-challenge nicht versehentlich als login akzeptiert wird.
  kind          TEXT NOT NULL,
  -- bei reg: gefuellt mit principal.userId. Bei login: optional (User
  -- bekannt nur wenn Email mitgegeben).
  user_id       UUID,
  -- Multi-Origin: rpId + origin werden mit dem Challenge zusammen
  -- persistiert, damit finish-Step exakt dieselben Werte verifiziert.
  rp_id         TEXT NOT NULL,
  origin        TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL,

  CONSTRAINT webauthn_challenges_kind_check CHECK (kind IN ('reg', 'login'))
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires
  ON webauthn_challenges(expires_at);

-- =============================================================================
-- END 0022_webauthn_challenges.sql
-- =============================================================================
