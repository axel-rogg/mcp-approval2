# THREAT-MODEL.md — Threat-Modell für mcp-approval2

> **Status:** ⚠️ Working-Doc 2026-05-17 (umbenannt von SECRET.md, Scope erweitert: nicht nur Secret-Storage, sondern auch Daten-System-Zugriff, Identity-Theft, Deployment-Kontext-Risiken).
> **Trigger:** User-Frage 2026-05-17: "Admin darf nicht einfach so andere User-Passwörter lesen können" — plus Folge-Frage: "Das wäre nur für Passwörter. Zugriff zu Datensystemen, ID-Diebstahl. Wie sieht ein Security-Experte das?"
> **Decision (Pilot):** wir bleiben beim Audit-Trail-Modell für Secret-Storage, dokumentieren die breiteren Risiken hier, planen Hardening (M1–M4) priorisiert. Deployment-Kontext (private vs. corporate) wird in §Deployment-Kontext gegenübergestellt.
>
> Volle Experten-Review (cross-cutting, ~2400 Wörter, 2026-05-17): siehe `docs/security/THREAT-REVIEW-2026-05-17.md`.

## TL;DR — was heute geht und was nicht

| Frage | Antwort |
|---|---|
| Kann ein externer Angreifer User-Secrets lesen? | **Nein**, mehrere Schichten (Auth + RLS + KMS-Wrap + AAD) |
| Kann ein **anderer User** meine Secrets lesen? | **Nein**, RLS + KMS-DEK mit user-bound AAD |
| Kann **DB-only-Access** Secrets lesen? | **Nein**, ciphertext only |
| Kann **KMS-only-Access** Secrets lesen? | **Nein**, ohne DB-Read keine ciphertext |
| Kann **DB+KMS-Access** (= V2-Operator) Secrets lesen? | **Ja**, aber jeder Decrypt ist in GCP Audit-Log mit Caller + Timestamp + plaintext-target nachweisbar |
| Kann der **mcp-gws/gcloud Worker** Secrets im Klartext sehen? | **Ja**, kurz im Memory zur Tool-Call-Zeit (1× per Forward). Nicht persistiert |

## Was secret-encrypted gespeichert wird (V2)

| Tabelle | Spalten | Was drin |
|---|---|---|
| `credentials` | `wrapped_dek`, `ciphertext`, `nonce`, `is_secret` | Generische Tokens (V1-Legacy: GitHub-PAT, Jira, etc.) |
| `user_sub_mcp_config` | `wrapped_dek`, `ciphertext`, `nonce`, `is_secret` | Per-User-pro-Server Config-Werte. Keys mit `_`-Prefix sind secret: `_oauth_client_id`, `_oauth_client_secret`, `_oauth_refresh_token`, `_service_account_json` |
| `webauthn_credentials` | `public_key` | WebAuthn Public-Keys (nicht secret, aber per-User) |

**Nicht in V2 gespeichert (out-of-band):**
- mcp-gws Worker D1 hat `gws_tokens` mit Google-Refresh-Tokens (V1-Legacy, single-user Axel)
- CF-Worker `MCP_BEARER_TOKEN` Secrets (write-only via wrangler)

## Crypto-Schichten (heute)

### Schicht 1: Envelope-Encryption mit GCP KMS

```
Plaintext (z.B. _oauth_refresh_token = "1//04ghI...")
   ↓
AES-256-GCM mit zufällig generierter DEK (32 Bytes)
   AAD = "generic|user_sub_mcp_config|<userId>/<server>/_oauth_refresh_token"
   ↓
ciphertext + nonce (12 Bytes)  ← geht in DB

DEK (raw, 32 Bytes)
   ↓
GCP KMS API: kms.encrypt(DEK, kek="europe-west3/mcp-approval2-privat/user-dek-master")
   ↓
wrapped_dek (variable Länge, ~120 Bytes)  ← geht in DB

DEK (raw) wird in Memory wiped (Buffer.fill(0))
```

### Schicht 2: Row-Level Security (RLS) in Postgres

```sql
CREATE POLICY usrconfig_owner_only ON user_sub_mcp_config
  USING (user_id = current_setting('app.current_user', true)::UUID)
  WITH CHECK (user_id = current_setting('app.current_user', true)::UUID);
```

User-scoped Queries gehen über `db.scoped(userId)` oder `db.transaction(userId, ...)` der `SET LOCAL app.current_user = '<uuid>'` setzt.

**Bypass:** Admin/Operator-Pool nutzt `BYPASSRLS` Rolle für legitime Boot-Tasks (Migrations, seed). Diese Operations sind in `audit_log` getrackt.

### Schicht 3: AAD-Binding

AES-GCM-AAD bindet die DEK an spezifische Felder:
- `recordType` = `'generic'`
- `namespace` = `'user_sub_mcp_config'`
- `id` = `'<userId>/<sub_mcp_name>/<config_key>'`

Wenn jemand die Row in ein anderes user_id kopiert (Row-Spoof), schlägt AES-GCM-Decrypt mit `BAD_TAG` fehl, weil AAD nicht mehr matched.

### Schicht 4: GCP Audit-Logs

Jeder `kms.Decrypt`-API-Call wird in **Cloud Audit-Logs** geloggt mit:
- `principalEmail` (= V2 service-account)
- `resourceName` (= KMS-key + crypto-key-version)
- `timestamp`
- `methodName` = `Decrypt`

Audit-Logs sind **immutable** (90 days default retention) und können in Pub/Sub gestreamt werden für Real-Time-Alerts.

## Threat-Modell — was schützt was

| Angriff | Schicht 1 (KMS) | Schicht 2 (RLS) | Schicht 3 (AAD) | Schicht 4 (Audit) |
|---|---|---|---|---|
| **DB-Theft / Cold-Backup-Leak** | ✅ Nur ciphertext sichtbar | — | — | — |
| **DB-Read-Permission ohne KMS** | ✅ Nur ciphertext | — | — | — |
| **User-A liest User-B's secrets via API** | — | ✅ Query-side filter | — | — |
| **Row-Spoof: Admin copies User-A row to User-B** | — | — | ✅ AAD-Mismatch → Decrypt-Fail | — |
| **External attacker mit V2-Bearer/JWT** | — | ✅ Per-User-RLS | — | — |
| **V2-Operator mit DB+KMS-Permission** | ❌ Kann decrypten | ❌ BYPASSRLS | ❌ Hat AAD-Knowledge | ✅ Wird geloggt |
| **Compromised mcp-gws Worker** | ❌ Sieht plaintext im Memory zur Call-Zeit | — | — | — |

**Bottom-Line für Pilot:** Operator (Axel) muss sich selbst vertrauen. Audit-Log macht jeden Decrypt nachweisbar.

## Hardening-Roadmap (Priorisiert)

### Stufe 1: Detection (Low-Cost, ~2h Setup)
- [ ] **Cloud KMS Decrypt-Alerts** via Pub/Sub
  - Alert wenn `kms.Decrypt` rate > 10/min für `user-dek-master`
  - Alert wenn `kms.Decrypt` von neuer/ungewohnter Caller-Identity
  - Cost: ~0 EUR (Pub/Sub free-tier reicht)
  - Wert: Operator-Missbrauch wird in Echtzeit visibler

### Stufe 2: Per-User-KEK (Medium-Cost, ~4h Migration)
- [ ] Ein KMS-CryptoKey **pro User-ID** statt shared `user-dek-master`
- [ ] Setup-Script: bei User-Create → `gcloud kms keys create user-<uuid>-dek`
- [ ] Migration existierender Daten: re-wrap mit Per-User-KEK
- [ ] Cost: ~0.06 EUR pro User pro Monat (rotation enabled)
- [ ] Wert: Compromised User-KEK leakt nur 1 User. Audit-Log zeigt direkt welcher User betroffen ist. Decrypt-Pattern-Anomalie ist pro-User.

### Stufe 3: PRF-Wrap auf Client-Secret (Medium-Cost, ~6h Build)
- [ ] User-Toggle pro Server: "Sensitive: PRF-protect client_secret"
- [ ] Bei Toggle: ciphertext = AES-GCM(plaintext, DEK XOR PRF-output)
- [ ] PRF-Output = WebAuthn PRF-Extension Result (Passkey-Touch)
- [ ] Konsequenz: Re-Auth (OAuth-Flow) braucht User-Touch. Tool-Calls (= Refresh-Token nutzen) gehen weiter
- [ ] Wert: Admin kann existing Tokens nutzen, aber kann nicht **neue** Authorize-Flows starten oder Client-Secret extrahieren ohne User-Touch

### Stufe 4: Cloud HSM (High-Cost, ~1h Setup)
- [ ] KMS-Key auf Cloud HSM hosten (FIPS 140-2 Level 3)
- [ ] TF: `protection_level = "HSM"`
- [ ] Cost: +1.50 EUR/key/month + 20% Decrypt-API-Cost
- [ ] Wert: State-Actor-Threats. Macht für Solo-Pilot keinen Sinn, für regulierten Multi-Tenant absehbar relevant.

### Stufe 5: Zero-Knowledge (Hoher Aufwand, breaking change, ~3 Tage Build)
- [ ] Client-Side-Encryption: PWA encrypted secrets vor Upload mit User-Master-Key (z.B. PRF-derived)
- [ ] V2 sieht NIE plaintext
- [ ] Konsequenz: V2 kann KEINE Background-Tool-Calls mit OAuth machen (kein Cron, kein MCP-async-API ohne User-Anwesenheit)
- [ ] Wert: Operator kann technisch nichts entschlüsseln (auch mit Audit). Bei Compromise des V2-Hosts: User-Secrets bleiben safe.
- [ ] Verlust: Background-Tool-Capability komplett. Realistisch nur für interactive-only Use-Cases.

## Was wir NICHT in dieser Iteration machen

- Stufe 1-4 sind dokumentiert, aber nicht implementiert
- Mit Pfad-B-Implementierung **bleibt Stufe-1-Hardening offen**: Operator-Compromise = Cross-User-Token-Leak möglich (mit Audit-Trail)
- **Aktuell verbleibendes Risiko**: V2-Operator (= Axel selbst) ist **trusted**

## Entscheidungs-Trail

| Datum | Decision | Reasoning |
|---|---|---|
| 2026-05-17 | Pfad B (V2-as-OAuth-Authority) für gws | Sicherer als Pfad A (RLS + KMS-Wrap + AAD vs CF-Worker-MASTER_KEY); nutzt bestehende Phase-C-Infrastruktur |
| 2026-05-17 | Per-User SA-JSON für gcloud (gleicher Storage-Pattern wie gws-Refresh) | Konsistent, SA-JSON ist kritischer als Refresh-Token (= Private-Key direkt), KMS-Wrap ist state-of-the-art |
| 2026-05-17 | Hardening-Stufen 1-4 nicht jetzt | Pilot ist Solo-Operator, Operator-Trust akzeptabel. Multi-User-Pilot startet bei <= 15 User, Operator-Compromise wäre dramatic incident, Audit-Trail reicht für post-incident-Forensik |

## Re-Visit-Trigger

Hardening Stufe 1 wird Pflicht wenn eine dieser Bedingungen eintritt:
- [ ] > 15 echte User auf der Instance (jenseits Pilot)
- [ ] DSGVO-Audit / Compliance-Anforderung
- [ ] Erster User-Compromise-Incident (Lessons-Learned)
- [ ] Migration auf Business-Mode (regulierte Industrie / GCP Cloud Run)

---

## Erweiterter Scope (Experten-Review 2026-05-17)

Das oben dokumentierte Modell deckt **Secret-Storage at-rest** ab. Eine cross-cutting Security-Review (siehe `docs/security/THREAT-REVIEW-2026-05-17.md`) hat fünf zusätzliche Risikoklassen identifiziert, die das ursprüngliche SECRET.md nicht modelliert:

1. **Token-Lifecycle nach Decrypt** — Refresh-Tokens, OBO-JWTs, Access-Tokens leben im Worker-Memory; kompromittierter Worker (npm-Supply-Chain, RCE) sieht plaintext.
2. **Daten-System-Zugriff** — wer auf KC2 (Storage), Google Workspace, GCP-Projekt, GitHub zugreift, nicht nur wer das Passwort liest.
3. **Identity-Theft** — Session-Cookie-Diebstahl, OAuth-Replay, JWKS-Compromise, WebAuthn-Recovery-Bypass, Approval-Replay, Admin-Account-Takeover.
4. **God-Mode-Tokens** — `MCP_KNOWLEDGE_SERVICE_TOKEN` (KC2-wide), `JWT_SECRET` (HS256, alle MCP-Tokens), `JWT_RS256_PRIVATE_KEY_PEM` (alle OBO-JWTs) — Compromise jeder dieser drei = systemweiter GAU.
5. **Audit-Log Integrität** — `audit.ts:71-74` ist fail-soft (schluckt Errors stumm), kein WORM-Mirror, Operator mit DB-Write kann nachträglich editieren.

### M1–M4 Hardening-Pflichtprogramm vor breiterer Pilot-Öffnung

| ID | Maßnahme | Aufwand | Trigger |
|---|---|---|---|
| **M1** | Audit-Log WORM-Mirror (GCS append-only-Bucket oder Pub/Sub-Stream) | ~3h | vor zweitem User |
| **M2** | MCP-Access-Tokens HS256 → RS256 (gleicher Key-Pool wie OBO) | ~4h | vor Multi-User-Öffnung |
| **M3** | KC2-Scope-Split-Tokens (`_ERASE` / `_SYNC` / `_OPS`) in Doppler aktivieren — Code ist da, Werte fehlen | ~30min Operator-Task | sofort |
| **M4** | `JWT_RS256_PRIVATE_KEY_PEM` Key-Rotation-Mechanik (kid-rotation, JWKS-multi-key) | ~6h | vor zweitem User |

---

## Deployment-Kontext: drei realistische Szenarien

Das Threat-Modell ist **kontextabhängig**. Statt einer abstrakten "Privat 5-15 User"-Annahme arbeitet dieses Repo mit drei distinkten Szenarien — jedes mit eigenen Trust-Grenzen, eigener Compliance-Schwelle und eigener Hardening-Liste. Strategie-Entscheidung 2026-05-17: **Privat = Familie im Haushalt; Freunde hosten selbst; Firma in GCP-VPC.**

### Trust-Annahmen (drei Spalten)

| Aspekt | Familie im Haushalt (2-5) | Freunde Self-Host (jeder eigene Instance) | Corporate GCP-VPC (20-500) |
|---|---|---|---|
| **Wer ist Verantwortlicher?** | Axel als Familien-Operator | Jeder Freund für seine Instance | Firma (mit DPO) |
| **DSGVO-Anwendbarkeit** | ⚪ Art. 2(2)c greift (Haushalts-Ausnahme) | ⚪ Axel raus aus DSGVO; jeder Freund selbst-zuständig | 🔴 Voll anwendbar |
| **Sub-Verarbeiter-Kette** | informell | jeder eigener Stack — Axel liefert nur Code | konsolidiert auf 1 Cloud (GCP) |
| **Schrems-II / CLOUD-Act** | ⚪ irrelevant | ⚪ irrelevant für Axel | 🟡 bleibt (Google ist US-Mutter), aber DPF + EU-SCCs decken |
| **Operator-Trust** | familiär gegeben | N/A (jeder selbst) | vertraglich + Audit-Trail |
| **Bus-Faktor** | 🟠 1 (Axel) — Mitigation: Recovery-Brief im Safe | ⚪ verteilt | 🟢 Multi-Operator + IAM-Rollen |
| **Recovery wenn Passkey weg** | trivial (gleicher Haushalt) | jeder selbst | formaler Helpdesk |
| **Netzwerk** | Public-Internet vor Fly | Public-Internet vor Fly (je User) | im VPC — neue Lateral-Movement-Risiken |
| **Compliance-Programm** | keines | Code-Hygiene-Pflicht für Axel | DPIA + AVV + TIA + VVT + DPO |

### Was im jeweiligen Szenario wirklich zählt (Top-Risiken)

| Szenario | Top-3-Risiken (sortiert nach Wahrscheinlichkeit × Schaden) |
|---|---|
| **Familie** | (1) Phishing eines Familienmitglieds → Yubikey/Passkey + Recovery-Codes. (2) Operator-Versehen + Bus-Faktor 1 → Restore-Drill + Recovery-Brief im Safe. (3) Ransomware auf R2-Backup → Object-Lock + Versioning. |
| **Self-Host Freunde** | (1) Code-Defaults im Repo (Per-User-KEK an, Audit-Trigger an, JWT-Rotation an). (2) Setup-Runbook + sichere Defaults für Nicht-Techies. (3) Threat-Model im Repo damit jeder Self-Hoster Tradeoffs kennt. — Axel-Verantwortung endet bei "sicherer Code + Doku". |
| **Corporate VPC** | (1) VPC-Network-Hardening (mTLS, Cert-Pinning, SSRF-Mitigation, Egress-Allowlist). (2) Audit-WORM + 4-Augen + Compliance-Workflows. (3) DPIA + AVV + Joint-Controller-Vereinbarungen für Sharing. |

### Was im Familie-Modus implementiert ist (Stand 2026-05-17)

Konkretes ~4h Hardening-Programm: [runbook-family-hardening.md](docs/runbooks/runbook-family-hardening.md).

✅ vorhanden + aktiv (Code-Side): Defense-in-Depth-Stack (TLS, OAuth-2.1-PKCE-DCR, Google-OIDC, WebAuthn-UV-Passkey, Postgres-RLS, AES-256-GCM + AAD, KMS-Wrap, CORS-Allowlist, Rate-Limit).

✅ neu via Family-Hardening-Sprint:
- `BOOTSTRAP_ADMIN_EMAIL` fail-CLOSED in production ([apps/server/src/auth/bootstrap.ts](apps/server/src/auth/bootstrap.ts))
- `securityHeaders()` Middleware: HSTS + X-Frame-Options:DENY + nosniff + Referrer-Policy + COIP/COOP ([apps/server/src/middleware/security-headers.ts](apps/server/src/middleware/security-headers.ts))
- `originCheck()` Middleware: CSRF-Lite auf `/auth/*` + `/oauth/*` ([apps/server/src/middleware/origin-check.ts](apps/server/src/middleware/origin-check.ts))
- GCP-Billing-Budget + Alert-TF ([terraform/environments/privat/gcp-billing-budget.tf](terraform/environments/privat/gcp-billing-budget.tf))
- Operator-Recovery-Brief-Template ([docs/runbooks/operator-recovery-brief.md](docs/runbooks/operator-recovery-brief.md))

🟡 Operator-Task (manuell, im Hardening-Runbook):
- Google-Passkey + Recovery-Codes für Operator + Familie
- Fallback-Login-Pfade (TOTP) bei GitHub/Fly/Doppler/Cloudflare/Resend
- R2 Object-Lock + Versioning (CF-Dashboard out-of-band, Provider unterstützt's nicht via TF)
- Restore-Drill scharf fahren (Neon-Branch-from-time)
- Recovery-Brief ausfüllen + versiegeln + Safe + Treuhänder-Kopie

🟢 bewusst weggelassen im Familie-Modus (Begründung: siehe Runbook §7):
- Per-User-KEK, HS256→RS256-Migration, WORM-Audit-Sink, Related-Origin-File, Multi-Recipient-Sharing-Crypto, Datenschutzerklärung, mTLS, Cross-Region-DR, Hardware-Yubikey

### Was im Self-Host-für-Freunde-Modus zu liefern ist (Code-Side)

Wenn Self-Host die Strategie für Freunde wird, ist Axels Verantwortung der **Default**: ein Self-Hoster soll das Repo clonen, `terraform apply` + `fly deploy` machen, und out-of-the-box sicher sein. Konkret:

- Per-User-KEK als Default an (gegen Phishing-Blast-Radius)
- `JWT_RS256` mit Rotation-Mechanik (kid-rotation, JWKS-multi-key)
- HS256-MCP-Access-Tokens → RS256 (gleicher Key-Pool wie OBO)
- Audit-Log Append-Only-Trigger + Pub/Sub-Sink-Option
- Setup-Runbook für Nicht-Techies (Step-by-Step, ~1-2h Setup)
- Threat-Model + akzeptierte Restrisiken im Repo
- Security-Disclosure-Pfad für Bugs

### Was im Corporate-GCP-VPC-Modus dazu kommt (4-6 Wochen Programm)

- DPIA + Sub-Prozessor-AVVs + TIAs + VVT + DPO benannt
- WORM-Audit-Sink → BigQuery Object-Lock-Bucket
- Workload-Identity-Federation statt SA-JSON
- mTLS + Cert-Pinning + Egress-Allowlist via VPC SC
- Cloud-SQL statt Neon (7d-PITR Default), Cloud-Run statt Fly
- Cloud-HSM (FIPS-140-2 L3) statt Software-protected CryptoKey
- Step-Up-Auth pro Tool-Sensitivity (per-Call WebAuthn-UV für `danger`)
- 4-Augen-Operator-Workflow + formelle Incident-Response 72h-Pipeline
- Joint-Controller-Vereinbarung für Sharing (Art. 26)
- Sharing-Konsens-Modal in PWA + Multi-Recipient-Body-Crypto

### Was in ALLEN drei Szenarien identisch wichtig ist (Universal-Hardening)

- **M3 (KC2-Scope-Split-Tokens):** Code ist da, Doppler-Werte fehlen — Operator-Task, fixt sofort einen god-mode-Token (`MCP_KNOWLEDGE_SERVICE_TOKEN`)
- **M4 (JWT-Key-Rotation):** Single-Point-of-Failure-Mitigation für *alle* Identitäten
- **npm-Supply-Chain-Hygiene:** `npm audit` 0 Vulns + Dependabot-Auto-Merge für Security + SHA-Pinning für Container + Actions
- **XSS-/Cookie-Hygiene + CSP-Hardening** (perspektivisch)
- **Recovery-Drill** für KMS-Key + Doppler-Secrets (jährlich)
- **akzeptierte Restrisiken explizit kommunizieren** (Fly-Compromise, GCP-Account-Suspension, KMS-Key-Destroy) statt verschweigen

### Drei akzeptierte Restrisiken in jedem Szenario

Diese überlebt der Stack realistisch nicht — Mitigation = Treuhänder-Backup-Pfad + ehrliche Kommunikation:

1. **Fly-Platform-Compromise** — Single-Vendor, kein Image-Signing-Mitigation-Pfad
2. **GCP-Account-Suspension** — KMS blocked = Boot fail = effektiver Data-Loss bis Reaktivierung
3. **KMS-Key-Destroy ohne Offline-Master-Copy** — selbst mit 90d-Schutz nicht recoverable
