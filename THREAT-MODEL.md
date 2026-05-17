# SECRET.md — Threat-Modell für User-Secrets in mcp-approval2

> **Status:** ⚠️ Working-Doc 2026-05-17. Aktuelle Implementierung läuft mit **Status quo + Audit-Trail**.
> **Trigger:** User-Frage 2026-05-17: "Admin darf nicht einfach so andere User-Passwörter lesen können"
> **Decision (Pilot):** wir bleiben beim Audit-Trail-Modell, dokumentieren das Risiko hier, planen Hardening später.

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
