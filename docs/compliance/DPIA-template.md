# Datenschutz-Folgenabschaetzung (Data Protection Impact Assessment / DPIA) — Template

**Status:** Template (Draft 2026-05-13)
**Plan-Reference:** [PLAN-architecture-v1.md §4](../plans/active/PLAN-architecture-v1.md)

> **WICHTIGER HAFTUNGSHINWEIS:** Diese DPIA ist ein **technisches Template** als Vorbereitung fuer die nach Art. 35 DSGVO ggf. erforderliche Folgenabschaetzung. Es ist KEIN Rechtsgutachten. **Vor Pilot-Go-Live MUSS** der/die Datenschutzbeauftragte(r) des Auftraggebers (oder ein qualifizierter Berater) das Template fuellen, juristisch pruefen + dokumentieren, ob die Verarbeitung tatsaechlich eine DPIA-Pflicht ausloest.

Platzhalter in `{{...}}` werden pro Pilot ausgefuellt.

---

## 1. Allgemeine Angaben

| Feld | Wert |
|---|---|
| Bezeichnung der Verarbeitung | mcp-approval2 — KI-Tool-Hub mit Approval-Workflow (Pilot bei `{{KUNDE_NAME}}`) |
| Verantwortlicher | `{{KUNDE_NAME}}` |
| Auftragsverarbeiter | `{{ANBIETER_NAME}}` |
| Datenschutzbeauftragte(r) | `{{KUNDE_DSB}}` |
| Erstelldatum | `{{ERSTELLDATUM}}` |
| Letzte Aktualisierung | `{{UPDATE_DATUM}}` |
| Pilot-Region (Cloud SQL + OpenBao) | `{{PILOT_REGION}}` |

---

## 2. Beschreibung des Verarbeitungsvorgangs

### 2.1 Zweck

mcp-approval2 stellt Benutzer:innen des Auftraggebers eine **MCP-Server-Plattform** zur Verfuegung, die:
1. **Authentifizierte Tool-Calls** an KI-Modelle (Anthropic Claude, OpenAI etc.) durchroutet
2. Bei **sicherheitskritischen Tool-Calls** (Schreib-Aktionen, Credentials, Datei-Exporte) einen **Approval-Workflow** mit WebAuthn-Passkey + PRF-Verifikation erzwingt
3. User-Workspace-Daten (Dokumente, App-States, Skills, Memos) in einer separaten Storage-Service-Instanz (mcp-knowledge2) verwaltet
4. Service-Credentials des Users (z. B. Google Workspace OAuth-Token) verschluesselt vorhaelt

### 2.2 Datenfluss (vereinfacht)

```
User (Browser)
   │
   ▼ HTTPS / WebAuthn
mcp-approval2 (Authority + Approval + Gateway)
   │                                    │
   │ verifies JWT, RLS-scoped DB        │ tool.call
   ▼                                    ▼
Postgres (audit_log, users, sessions,   External MCP Server (z. B. Anthropic)
credentials-ciphertext) — CMEK encrypted
   │
   │ via /v1/knowledge/* proxy + RS256-JWT
   ▼
mcp-knowledge2 (Storage-Service)
   │
   ▼
Postgres (objects, refs, FTS, pgvector) — CMEK encrypted
+ Vertex AI Embeddings (EU-region, no data retention)
```

### 2.3 Rollen

- **Verantwortlicher:** Auftraggeber (entscheidet, dass + zu welchem Zweck verarbeitet wird)
- **Auftragsverarbeiter:** Anbieter (betreibt mcp-approval2 als Pilot-Instanz)
- **Unter-Auftragsverarbeiter:** Google Cloud (Cloud SQL, Cloud Run, Vertex AI), siehe [sub-processor-list.md](sub-processor-list.md)
- **Betroffene:** User des Auftraggebers (Mitarbeiter, Kontraktoren)

### 2.4 Daten-Kategorien

Siehe [DPA-Template §3](DPA-template.md). Wichtigste Kategorien:
- User-Stammdaten (Email, Display-Name, Rolle)
- Authentifizierungs-Daten (OAuth-Tokens, WebAuthn-Credentials, PRF-Outputs)
- Workspace-Inhalte (Dokumente, App-States — VOM USER EINGEGEBEN, koennten besondere Kategorien enthalten)
- Service-Credentials (vom User registrierte Tokens fuer externe Tools)
- Audit-Log + Operational-Log

### 2.5 Rechtsgrundlage

- Art. 6 Abs. 1 lit. b DSGVO (Vertrag mit User i. R. d. Arbeitsverhaeltnisses)
- Art. 6 Abs. 1 lit. c DSGVO (Audit-Pflichten)
- Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an Sicherheitsmassnahmen + Forensik)

---

## 3. Erforderlichkeit + Verhaeltnismaessigkeit

### 3.1 Erforderlichkeit der Datenverarbeitung

| Daten | Warum erforderlich | Alternative geprueft? |
|---|---|---|
| Email | User-Identifikation, OAuth-Match, Invite-Workflow | Ja: Pseudonyme verworfen (User-Recognition + Recovery erfordern Email) |
| OAuth-Tokens | Single-Sign-On gegen Google Workspace | Ja: lokales Password verworfen (geringerer Schutz, Phishing-Risk) |
| WebAuthn + PRF | Phishing-resistente MFA + Per-User-DEK-Ableitung | Ja: TOTP/SMS verworfen (Phishing-anfaellig, kein PRF-Aequivalent) |
| Audit-Log mit IP + User-Agent | Forensik bei Compromise | Ja: ohne IP unmoeglich, Angreifer-Pivot zu erkennen |

### 3.2 Verhaeltnismaessigkeit

- **Data Minimization:** keine Felder werden "vorsorglich" gespeichert — jeder Feld ist im Datenfluss begruendet
- **Zweckbindung:** Audit-Log wird NICHT fuer Telemetrie oder Mitarbeiter-Ueberwachung ausgewertet (Vertragspflicht im DPA)
- **Speicherbegrenzung:** Sessions/JWTs kurz-lived (30 min / 30 Tage); User-Daten Crypto-Shredding nach Erase; Audit 365d Default
- **Transparenz:** PWA zeigt User alle seine Daten (`/v1/gdpr/export`) jederzeit auf Knopfdruck

---

## 4. Risiken fuer die Rechte + Freiheiten der Betroffenen

### 4.1 Risiko-Liste (vor Mitigation)

| ID | Risiko | Eintrittswahrscheinlichkeit | Schadensschwere | Brutto-Risk |
|---|---|---|---|---|
| R-1 | Compromise OpenBao-AppRole → KEK-Decrypt → User-Credentials im Klartext | niedrig | sehr hoch | hoch |
| R-2 | Compromise RS256-Signing-Key → Service-Boundary umgangen → Storage-Service lesbar | niedrig | hoch | mittel |
| R-3 | SQL-Injection / RLS-Bypass → Cross-User-Read | mittel | hoch | hoch |
| R-4 | Audit-Log-Manipulation (Privilege-Escalation) | niedrig | hoch | mittel |
| R-5 | OAuth-Refresh-Token-Compromise (z. B. Phishing) → Long-lived Drittsystem-Access | mittel | hoch | hoch |
| R-6 | User exfiltriert PII via Tool-Call an externen MCP-Server | mittel | mittel | mittel |
| R-7 | Drittland-Transfer ueber Sub-Prozessor (z. B. US-Cloud) | niedrig | hoch | mittel |
| R-8 | Loeschanfrage nicht vollstaendig durchgefuehrt (z. B. in Backup) | mittel | mittel | mittel |
| R-9 | Mitarbeiter-Ueberwachung durch Audit-Log-Auswertung | niedrig | hoch | mittel |
| R-10 | Vault-Cluster-Verlust → KEK-Verlust → User-Daten unwiederherstellbar | niedrig | sehr hoch | hoch |

### 4.2 Bewertung

Brutto-Risiken **hoch** = R-1, R-3, R-5, R-10. Diese MUESSEN durch Mitigations auf "mittel" oder besser gesenkt werden, sonst ist die Verarbeitung **unzulaessig**.

---

## 5. Mitigations (Technisch + Organisatorisch)

### 5.1 Encryption-at-Rest

- Postgres CMEK (kunde-owned Cloud-KMS-Key, EU-Region) — entzieht dem Cloud-Provider die Decrypt-Faehigkeit
- User-Credentials: AES-256-GCM mit per-User-DEK, AAD-bound (`credentials|<id>|<provider>:<kind>`)
- DEKs in OpenBao Transit gewrappt — KEK verlaesst OpenBao nie
- Verifikation: `R-1` von "hoch" auf "mittel" gesenkt; Compromise muss **simultan** Vault + AppRole haben

### 5.2 Row-Level-Security (RLS)

- Postgres-RLS-Policies pro Tabelle: `USING (user_id = current_setting('app.current_user')::uuid)`
- `scoped(userId)` setzt `SET LOCAL app.current_user` in jeder Transaction
- Admin-Routen schreiben Audit-Eintrag VOR jedem Read (siehe [ADR-0017](../adr/0017-admin-no-user-data-access.md))
- Verifikation: `R-3` von "hoch" auf "niedrig" gesenkt; nur via Postgres-RCE umgehbar

### 5.3 Audit-Log Immutability

- Postgres-Trigger blockt UPDATE/DELETE auf `audit_log`
- Optionaler WORM-Forward auf GCS Object Lock (TODO Phase 7)
- Verifikation: `R-4` von "mittel" auf "niedrig" gesenkt

### 5.4 OAuth-Token-Handling

- Refresh-Token nur in Postgres + encrypted (siehe 5.1)
- Token-Rotation alle 30 Tage erzwungen (siehe [runbook-token-rotation.md](../runbooks/runbook-token-rotation.md))
- Rate-Limit auf Token-Exchange-Endpunkt
- Verifikation: `R-5` von "hoch" auf "mittel" gesenkt

### 5.5 EU-Datenresidenz

- Sub-Prozessor-Liste explizit EU-only (Cloud SQL + Cloud Run + Vertex AI EU-Region)
- TIA (Transfer Impact Assessment) fuer jeden Sub-Prozessor mit US-Mutterkonzern (Google LLC) dokumentiert
- Vertex AI mit `disable_data_retention=true` konfiguriert (siehe [ADR-0018](../adr/0018-google-vertex-ai-eu-region.md))
- Verifikation: `R-7` von "mittel" auf "niedrig" gesenkt

### 5.6 Vault-Auto-Unseal + Backup

- OpenBao Raft-Snapshots alle 4h zu GCS (encrypted)
- Auto-Unseal via Cloud KMS — kein manueller Unseal-Schluessel verloren
- Quartalsweiser Restore-Drill (siehe [runbook-incident-response.md](../runbooks/runbook-incident-response.md) §6)
- Verifikation: `R-10` von "hoch" auf "niedrig" gesenkt

### 5.7 Tool-Call-Approval

- Sensitive Tools (write, delete, export) erzwingen Approval-Prompt mit Passkey + PRF
- WYSIWYS-Prinzip: PWA zeigt **exakt** den Tool-Call der ausgefuehrt wird, kein Prompt-Injection moeglich
- Verifikation: `R-6` von "mittel" auf "niedrig" gesenkt

### 5.8 Audit-Log-Auswertung-Beschraenkung

- DPA verbietet vertraglich die Auswertung von Audit-Logs zur Mitarbeiter-Ueberwachung
- Audit-Access selbst auditet (`admin.audit.read`)
- Verifikation: `R-9` von "mittel" auf "niedrig" gesenkt (technisch + vertraglich)

### 5.9 Backup-Erase

- 30-Tage-Backup-Retention; Backups sind CMEK-encrypted, KEK-Destroy schreddert den User auch in Backups
- Hard-DELETE in Backup-Daten beim naechsten Backup-Cycle automatisch (Crypto-Shredding-Effekt)
- Verifikation: `R-8` von "mittel" auf "niedrig" gesenkt

---

## 6. Rest-Risiken (nach Mitigation)

| ID | Restrisiko | Restwahrscheinlichkeit | Restschwere | Akzeptanz |
|---|---|---|---|---|
| R-1 | KEK-Compromise (nach Mitigation) | sehr niedrig | sehr hoch | akzeptabel mit Drill + Incident-Plan |
| R-2 | Signing-Key-Compromise | niedrig | mittel | akzeptabel mit Rotation 6-monatlich |
| R-3 | RLS-Bypass | niedrig | hoch | akzeptabel mit Pentests |
| R-5 | OAuth-Compromise | niedrig | mittel | akzeptabel |
| R-7 | Drittland | niedrig | mittel | akzeptabel mit TIA |
| R-10 | Vault-Verlust | sehr niedrig | hoch | akzeptabel mit Snapshot-Frequenz |

Alle Rest-Risiken liegen im akzeptablen Bereich (niedrig / sehr niedrig).

---

## 7. Konsultation Datenschutzbeauftragter

`{{KUNDE_DSB}}` hat die DPIA am `{{DSB_REVIEW_DATUM}}` gepruft mit folgendem Ergebnis:

- [ ] Verarbeitung als zulaessig bewertet, keine weiteren Mitigations erforderlich
- [ ] Mit Auflagen zulaessig (Auflagen unten dokumentiert)
- [ ] Unzulaessig — Verarbeitung darf nicht starten

**Auflagen (falls anwendbar):**
`{{DSB_AUFLAGEN}}`

**Datum, Unterschrift DSB:** ____________________________________

---

## 8. Konsultation Aufsichtsbehoerde (Art. 36 DSGVO)

Eine Konsultation ist erforderlich, wenn die DPIA ergibt, dass die Verarbeitung **trotz Mitigations** ein hohes Risiko fuer die Rechte + Freiheiten der Betroffenen birgt.

Nach §6 dieser DPIA: Restrisiken sind alle ≤ "niedrig" → **keine Konsultationspflicht** in der aktuellen Bewertung.

Wenn Aufsichtsbehoerde konsultiert: `{{AUFSICHTSBEHOERDE_AKTENZEICHEN}}`

---

## 9. Ueberwachung + Aktualisierung

- DPIA wird **mindestens jaehrlich** ueberprueft + bei wesentlichen Aenderungen (neue Sub-Prozessoren, neue Tool-Kategorien, Compromise-Vorfall) aktualisiert
- Verantwortlich: `{{KUNDE_DSB}}`
- Naechste Pruefung: `{{NEXT_REVIEW_DATE}}`

---

## 10. Aenderungs-Historie

| Version | Datum | Aenderung | Autor |
|---|---|---|---|
| 0.1 | 2026-05-13 | Initial-Draft (Template) | {{TEMPLATE_AUTHOR}} |
| | | | |
