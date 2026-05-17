# Runbook: Pilot öffnen (mcp-approval2)

> **Stand 2026-05-17.** Setzt voraus: Phase A+B Security-Fixes + Multi-User
> Tier 1 sind deployed (siehe [docs/STATUS.md](../STATUS.md)). Doppler-Secrets
> sind via Terraform gemanaged (siehe
> [terraform/environments/privat/approval2-app-secrets.tf](../../terraform/environments/privat/approval2-app-secrets.tf)).

Diese Operator-Sequenz öffnet den Pilot für 2-3 Tester. Annahme: Email-Versand
läuft im `console`-Mode (Mails landen in `email_outbox`-DB, Operator stellt
Links manuell zu — sinnvoll solange Resend-DNS-Verify pending ist).

## T+0: Operator-Bootstrap (1× pro Deployment)

1. **Doppler-Secrets verifizieren** (sollten bereits via TF gesetzt sein):
   ```
   doppler secrets get BOOTSTRAP_ADMIN_EMAIL DCR_OPEN EMAIL_PROVIDER EMAIL_FROM \
     --project mcp-approval2 --config fly --plain
   ```
   Erwartet:
   - `BOOTSTRAP_ADMIN_EMAIL` = deine Operator-Email (z.B. `axelrogg@gmail.com`)
   - `DCR_OPEN` = `false`
   - `EMAIL_PROVIDER` = `console`
   - `EMAIL_FROM` = `mcp-approval2 <noreply@ai-toolhub.org>`

2. **Bootstrap-Login**: https://app2.ai-toolhub.org öffnen →
   "Sign in with Google" → mit `BOOTSTRAP_ADMIN_EMAIL`-Account einloggen.

   - SEC-007 `emailVerified`-Gate aktiv: dein Google-Account MUSS
     verifiziert sein.
   - SEC-008 `BOOTSTRAP_ADMIN_EMAIL`-Gate aktiv: bei Mismatch → 403.
   - Nach erfolgreichem Callback wirst du als `role='admin'` angelegt.

3. **Passkey enrollen**: Im Onboarding-Flow wirst du zu
   `#/enroll-passkey` geleitet. SEC-009 `userVerification:'required'`
   aktiv — Authenticator MUSS PIN/Biometrie können (FIDO2 + UV).
   - Falls dein Authenticator UV nicht kann (z.B. alter U2F-Key ohne PIN):
     im Browser die `Manage devices`-UI nutzen, Passkey mit PIN-fähigem
     Provider (Touch-ID, Windows-Hello, YubiKey 5 mit PIN) anlegen.

4. **Verifizieren** dass das Shield-Icon im Header erscheint
   (zwischen ⚙ Settings und 🚪 Logout). Klick → `#/admin`.

## T+1: Ersten Tester einladen

1. **Admin-Tab → Invites-Subtab** → Email des Testers eingeben → `Invite`.

2. Response zeigt:
   - **AcceptUrl** (`https://app2.ai-toolhub.org/accept-invite/<token>`)
   - **Email-Status** (`logged` weil console-Mode aktiv)
   - **In Zwischenablage**-Button zum Copy

3. **Out-of-band zustellen**: Link per Signal/iMessage/Mail an Tester
   schicken. Achtung: Token ist bearer-equivalent — keine unsicheren
   Kanäle (z.B. nicht-E2E-verschlüsselten SMS).

4. **Outbox-Tab** → die identische Mail liegt da auch (Status `logged`).
   Mit `✓ Mark dispatched`-Button markieren wenn zugestellt.

5. **Tester-Flow** (out-of-band):
   - Tester klickt Link → Google-Login Pop-up.
   - SEC-007: Tester-Google-Account muss `emailVerified=true` sein.
   - Nach OAuth-Callback: `invite/accept.ts` macht den User zu `member`.
   - Tester wird zu `#/enroll-passkey` weitergeleitet — muss seinen
     eigenen Passkey (PIN/Biometrie) anlegen.

6. **Verify im Users-Subtab**: Tester sollte als `member` / `active`
   erscheinen mit aktuellem `last_login_at`.

## Daily Operations

### User suspenden / unsuspenden / löschen

Admin-Tab → Users-Subtab:
- **Suspend**: Reason-Prompt (optional) → status='suspended' + alle aktiven
  Sessions revoked. UserSyncService pushed state an KC2.
- **Unsuspend**: status='active' wiederhergestellt. KC2-Push analog.
- **Delete**: Soft-Delete (status='deleted'). GDPR-Hard-Erase + Crypto-Shred
  läuft separat via Cron (services/gdpr.ts). Self-Delete blocked.

### Role-Change (member ↔ admin)

Users-Subtab → Role-Select bei Tester → confirm-Dialog.

⚠️ **SEC-008 one_active_admin**: maximal EIN aktiver Admin. Promote eines
zweiten Users → 409 conflict. Wenn du eine 2-Admin-Konfig willst, musst
du erst dich selbst demoten (`admin → member`) — dann den anderen
promoten.

### Recovery-Flow (Tester verliert Passkey)

1. Tester ruft `POST /auth/recovery/request { email }` (aktuell nur API,
   PWA-UI dafür ist Backlog Phase 2).
2. Server generiert Recovery-Link, persistiert in `email_outbox`.
3. Admin sieht im Outbox-Tab den Recovery-Link, leitet ihn out-of-band an
   den Tester weiter (Signal/iMessage).
4. Tester klickt → Re-Auth via Google → alte Passkeys werden
   `invalidated` → Tester legt neuen Passkey an.

### Audit-Trail prüfen

Admin-Tab → Audit-Subtab: letzte 100 Events. Filter via API:
`GET /v1/admin/audit?action=invite.create`.

## Wenn etwas schief geht

### Tester bekommt "Forbidden: Google account email must be verified"

SEC-007 ist aktiv. Tester muss bei Google → Account → Personal info → seine
Email als verifiziert markieren (Standard für Gmail; Workspace-Federation-
Setups können das anders machen).

### Tester bekommt "webauthn_verification_failed"

SEC-009 `requireUserVerification: true` aktiv. Authenticator hat UV nicht
performed.
- Iframe? In iframes funktioniert WebAuthn-PRF nicht zuverlässig — Tester
  muss app2.ai-toolhub.org als Top-Level-Window öffnen.
- Browser ohne Passkey-Support? Edge/Chrome/Safari aktuelle Versionen, kein
  Firefox-on-Android.
- Alter Security-Key ohne PIN-Setup? Im Authenticator-Hersteller-Tool PIN
  setzen.

### POST /admin/invites → 409 conflict

`invite already pending for this email` — älterer Invite ist noch nicht
abgelaufen. Optionen:
- Warte 24h (TTL via `INVITE_TTL_SEC`).
- Oder via SQL den Invite manuell `expired` setzen (admin-via-DB).

### Resend-Switch (von console zu echtem Versand)

1. resend.com signup, Domain `ai-toolhub.org` hinzufügen.
2. Resend zeigt 3 DNS-Records (DKIM `resend._domainkey`, SPF, optional
   DMARC) — in [terraform/environments/privat/cloudflare-*.tf](../../terraform/environments/privat/)
   einpflegen als `cloudflare_record`-Resourcen.
3. `doppler secrets set RESEND_API_KEY=rs_<echter> EMAIL_PROVIDER=resend \
   --project mcp-approval2 --config fly`
4. `fly secrets set` (gleich Werte) — triggert rolling restart.
5. Test: `POST /admin/invites { email: <deine-email> }` → schau in deinen
   Email-Eingang.

## Pilot-Backlog (Phase 2+)

- Logout-All-Devices Endpoint (kein PWA-Surface heute)
- Recovery-Codes (2-Faktor-Fallback wenn Passkey + Email gleichzeitig weg)
- R2-Storage-Quota pro User
- `/admin/users/:id/relink` für SEC-010-Pattern (zweiter Admin gegen-signiert
  external_id-Re-Link)
- PWA-Recovery-Form (heute nur API)

Siehe [docs/security/SECURITY_ISSUES.md](../security/SECURITY_ISSUES.md) für
verbleibende Findings (Phase C: SEC-012/013/014/015/016/017/022..026, MEDIUM:
SEC-027+).
