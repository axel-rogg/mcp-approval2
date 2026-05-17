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

## Deployment-Kontext: Private Freunde vs. Corporate-VPC

Das Threat-Modell ist **kontextabhängig**. Dieselbe Architektur (mcp-approval2 + KC2) hat in verschiedenen Deployment-Szenarien grundverschiedene Risiko-Prioritäten. Diese Sektion stellt die zwei realistischen Endpunkte gegenüber, damit M1–M4 + Hardening-Stufen nicht "one-size-fits-all" priorisiert werden.

### Trust-Annahmen

| Aspekt | Private (5-15 Freunde) | Corporate (VPC, 20-500 User) |
|---|---|---|
| **Operator** | Axel persönlich. Trust ist *sozial* gewachsen. Versehen > Vorsatz. | Mehrere Admins, formelle Rollen. Operator-Trust = *vertraglich/audit-trail-belegt*, nicht persönlich. |
| **User-Pool** | Freunde, Familie. Identifizierbar persönlich. Phishing-Risiko = pro Person individuell. | Mitarbeiter / Externe. Wechsel, Kündigung, "böser Ex-MA" sind reale Vektoren. |
| **Netzwerk** | Public Internet vor Fly.io. Cloudflare/Fly DDoS-Schicht. | Im internen VPC; "hinter der Firewall = trusted" ist verlockend, aber falsch. Lateral-Movement-Risiko. |
| **Compliance** | Keine. GDPR-Grundsätze ja, aber kein formaler Auditor. | DSGVO-Auditor, ISO27001, evtl. BaFin/HIPAA, real existierende Aufsicht. |
| **Datenwert** | Persönlich (eigene Calendar, eigene Memos, eigener GMail). Schaden = persönlich-individuell, *kein* Marktwert. | Geschäftsgeheimnisse, Kundendaten, regulierte Daten. Schaden = Reputation, Strafe, Klagen. |
| **Recovery-Pfad** | Axel kennt User persönlich (Telefon, Treffen). Verlorener Passkey = Anruf. | Recovery muss formell laufen (Ticket, Helpdesk, MFA-Reset-Workflow). |

### Gegenüberstellung: was wirklich zählt

| Threat | Private (Freunde) | Corporate (VPC) |
|---|---|---|
| **Operator-Versehen (rm -rf, kaputter Restore)** | 🔴 **TOP-Risiko**. Höher als jeder Insider-Angriff. Realistisch alle 1-2 Jahre einmal. | 🟡 mitigiert durch 4-Augen, Change-Management, IaC-Reviews |
| **Verlorener Passkey** | 🔴 **TOP-Risiko**. Tech-mixed Freunde verlieren regelmäßig Geräte/Browser. Kein Recovery = User gelockt. | 🟡 Helpdesk-Workflow gelöst |
| **Cross-User-Lese-Bug (RLS-Bypass)** | 🔴 hoch — Privacy-Vertrauensbruch zwischen Freunden, sozial irreparabel | 🔴 hoch — Compliance-Verstoß, Klage |
| **Externe Phishing eines Users (Google-Account-Takeover)** | 🔴 hoch — der eine User verliert seinen GMail/GitHub, persönliche Katastrophe; aber: *isoliert auf den User* dank Per-User-KEK | 🟠 mittel — kompromittierter User = Lateral-Movement in Firmen-Daten |
| **VPC-Lateral-Movement (Nachbar-Workload → mcp-approval2)** | ⚪ N/A — kein VPC | 🔴 **TOP-Risiko**. Kein Default-Schutz; Metadata-Server-SSRF, internes DNS-Spoof, direktes Postgres |
| **Insider-Admin missbraucht DB+KMS** | 🟠 mittel — sozialer Vertrauensbruch wäre dramatisch, aber Axel-Single-Operator | 🔴 hoch — mehrere Admins, kollegialer Trust nicht ausreichend |
| **npm-Supply-Chain (RCE in Transitive-Dep)** | 🔴 hoch (identisch in beiden Szenarien) — 1.5k+ Transitive-Deps | 🔴 hoch (identisch) |
| **`JWT_RS256_PRIVATE_KEY_PEM` Theft** | 🔴 hoch (identisch) — universeller GAU | 🔴 hoch (identisch) |
| **Audit-Log fail-soft / nicht WORM** | 🟡 mittel — kein Auditor liest es; aber soziale Beweisbarkeit ("habe ich's gelöscht?") fehlt | 🔴 hoch — Compliance + Forensik unmöglich ohne |
| **DSGVO-formaler Erase-Workflow** | 🟢 niedrig — Self-Service-Delete in PWA reicht, kein "Auskunftsersuchen-Workflow" nötig | 🔴 Pflicht — Art. 17, 15, 20 GDPR |
| **DDoS / Rate-Limit** | 🟢 niedrig — Fly.io / CF in front, klein Volume | 🟠 mittel — abhängig von Außenanschluss |
| **mTLS zwischen Services** | 🟢 niedrig — fly-internal Network reicht, alles im selben Org | 🔴 hoch — Zero-Trust-Architektur erwartet |

### Top-3 Risiko-Reihenfolge je Kontext

**Private (Freunde):**

1. **Operator-Versehen + Backup/Restore-Drill** — was machst du wenn du *aus Versehen* die DB schrotest? Aktuell: Neon-PITR-Backup, aber **Restore wurde nie geübt**.
2. **Verlorener Passkey + Recovery-Pfad** — was passiert wenn Freund-X sein Telefon verliert? Aktuell: kein dokumentierter Recovery-Flow. Risiko: Axel-bypass-Pfad könnte zu *Identitätsübernahme durch Operator* werden.
3. **Per-User-Isolation (gestohlener User-Account → andere User safe)** — Hardening-Stufe 2 (Per-User-KEK) ist hier *wertvoller als Stufe 1 (Decrypt-Alerts)*, weil Blast-Radius pro Account-Compromise zählt, nicht Detection-Latenz.

**Corporate (VPC):**

1. **VPC-Network-Hardening** — kein Vertrauen ins interne Netz. mTLS, Cert-Pinning, SSRF-Mitigation (Egress-Allowlist, IMDSv2/Workload-Identity statt Metadata), Postgres nur via Sidecar-Proxy.
2. **Audit-WORM + 4-Augen-Operator** — M1 wird Pflicht, plus formaler Admin-Workflow (jede Operator-Aktion 2-Personen).
3. **Compliance-Workflows** — DSGVO Art. 17/15/20, Audit-Trail mit Retention-Policy, Incident-Response-Plan.

### Was im Private-Kontext wichtig ist, das SECRET.md nicht abdeckt

| # | Punkt | Bezug |
|---|---|---|
| P1 | **Backup-Restore-Drill** mindestens 1× pro Quartal manuell durchspielen | Operator-Versehen ist häufiger als Angriff |
| P2 | **Verlorener-Passkey-Recovery-Pfad dokumentieren** — Axel-Reset *muss* User-Knowledge-Faktor oder Out-of-Band-Bestätigung verlangen, sonst ist Axel = Universal-ID-Diebstahl | Operator-bypass-Pfad wird sonst zur Hintertür |
| P3 | **Per-User-KEK (Hardening-Stufe 2)** — Phishing eines Users darf andere User nicht gefährden | Blast-Radius klein halten |
| P4 | **Self-Service-Erase pro User in PWA** — Freund kann *sehen* welche Daten er hat + *löschen* (Storage-Tab existiert teilweise) | Privacy-Transparenz, sozialer Vertrauensaufbau |
| P5 | **Operator-Transparenz-Mechanik** — User sieht im Audit-Log seines Accounts wann Axel auf seine Daten zugegriffen hat (z.B. PWA-Sektion "Operator-Activity") | Sozialer Vertrauensvertrag braucht Sichtbarkeit, sonst "spioniert er mich aus?" |
| P6 | **User-Exit-Protokoll** — Freund verlässt den Kreis: was passiert mit seinen Daten? Self-Export → Auto-Delete-after-X-Days vs. Soft-Delete-Recovery | Soziale Reversibilität |
| P7 | **Phishing-Awareness pro User** — kurze Onboarding-Note: "Ich (Axel) werde dich *nie* per Mail nach deinem Passwort/Passkey fragen" | Externer Phishing-Vektor je User isolieren |

### Was im Corporate-Kontext wichtig ist, das im Private-Kontext over-engineered wäre

| # | Punkt | Warum private über-engineered |
|---|---|---|
| C1 | WORM-Audit-Log + Pub/Sub-Streaming | Niemand liest's; Operator-Trust ist sozial |
| C2 | mTLS zwischen Workloads | Fly-Org ist single-trust-boundary |
| C3 | Egress-Allowlist | Kein Lateral-Movement-Szenario |
| C4 | 4-Augen-Operator-Workflow | Single-Operator Axel |
| C5 | DSGVO Art. 15/17/20 formell mit SLA | Self-Service in PWA reicht |
| C6 | Cloud HSM (Hardening-Stufe 4) | State-Actor-Threats irrelevant |
| C7 | SIEM-Integration | Operator liest GCP-Audit selbst stichprobenartig |

### Was in BEIDEN Szenarien identisch wichtig ist (Universal-Hardening)

- **M3 (KC2-Scope-Split-Tokens)** — ändert nichts am Aufwand, fixt sofort einen god-mode-Token
- **M4 (JWT-Key-Rotation)** — Single-Point-of-Failure für *alle* Identitäten
- **npm-Supply-Chain-Hygiene** — `npm audit` 0 Vulns + dep-pinning + regelmäßiges Update-Audit
- **Cookie-Domain + CSP + XSS-Hygiene** — eine XSS-Lücke killt beide Modelle gleich hart
- **Single-Operator-Total-Compromise-Statement** — Doppler-Leak + Fly-Token-Leak + npm-RCE darf nicht versteckt sein, sondern explizit dokumentiert
- **Recovery-Drill für KMS-Key + Doppler-Secrets** — wenn Cloud-KMS-Key oder Doppler-Account verloren geht, muss restore-from-backup-Pfad existieren

### Aktueller Pilot-Status (Freundes-Modus)

✅ vorhanden: RLS, KMS-Envelope, AAD-Binding, GCP-Audit, WebAuthn-Passkey, Per-User-Secrets
🟡 teilweise: Backup (Neon-PITR vorhanden, Restore-Drill fehlt), Self-Service-Erase (PWA Storage-Tab partiell)
🔴 fehlt: Verlorener-Passkey-Recovery, Per-User-KEK (Stufe 2), Operator-Activity-Sichtbarkeit pro User, User-Exit-Protokoll, KC2-Scope-Split-Token aktiviert (M3), JWT-Rotation (M4)

**Empfehlung Freundes-Pilot:** vor Öffnung an Tester P1 (Restore-Drill) + P2 (Recovery-Pfad) + M3 + M4 — alles ~8h Operator-Arbeit, kein Tech-Risiko. Stufe-2-KEK (P3) und Operator-Transparenz (P5) parallel als Phase-2-Hardening.
