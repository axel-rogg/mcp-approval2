# Auftragsverarbeitungsvertrag (Data Processing Agreement / DPA) — Template

**Status:** Template (Draft 2026-05-13)
**Plan-Reference:** [PLAN-architecture-v1.md §4 (Compliance)](../plans/active/PLAN-architecture-v1.md), [ADR-0003](../adr/0003-eu-only-data-residency.md)

> **WICHTIGER HAFTUNGSHINWEIS:** Dieses Dokument ist ein **technisches Template**, das die operativen + technischen Inhalte fuer einen DSGVO-Art-28-Auftragsverarbeitungsvertrag vorbereitet. Es ist KEIN Rechtsdokument. **Vor Pilot-Go-Live ist eine anwaltliche Pruefung Pflicht.** Die Standardvertragsklauseln (Art. 28 Abs. 3 DSGVO) muessen vom Customer-Rechts-Team gegen die jeweils gueltige Fassung der Aufsichtsbehoerde abgeglichen werden.

Platzhalter in `{{...}}` werden pro Pilot ersetzt.

---

## 1. Parteien

**Auftraggeber / Verantwortlicher:**
- Firma: `{{KUNDE_NAME}}`
- Anschrift: `{{KUNDE_ADRESSE}}`
- Vertretungsberechtigt: `{{VERANTWORTLICHER}}`
- Datenschutz-Kontakt: `{{KUNDE_DSB}}`

**Auftragsverarbeiter:**
- Firma: `{{ANBIETER_NAME}}` (Betreiber von mcp-approval2-Pilot-Instanzen)
- Anschrift: `{{ANBIETER_ADRESSE}}`
- Vertretungsberechtigt: `{{ANBIETER_VERTRETUNG}}`
- Datenschutz-Kontakt: `{{ANBIETER_DSB}}`

---

## 2. Gegenstand des Vertrags

Der Auftragsverarbeiter betreibt fuer den Auftraggeber die Software **mcp-approval2** als Single-Tenant-Pilot-Installation. Dabei werden personenbezogene Daten i. S. v. Art. 4 Nr. 1 DSGVO verarbeitet.

Vertragslaufzeit: `{{LAUFZEIT_START}} bis {{LAUFZEIT_ENDE}}`, danach automatische Verlaengerung um 12 Monate sofern keine Partei mit 3-Monatsfrist kuendigt.

---

## 3. Datenkategorien und Betroffenenkreise

### 3.1 Kategorien personenbezogener Daten

| Kategorie | Beispiele | Speicherort | Rechtsgrundlage |
|---|---|---|---|
| **User-Stammdaten** | Email, Display-Name, Rolle (admin/member), Erstellungs-Datum | Postgres `users`-Tabelle (encrypted at rest) | Art. 6 Abs. 1 lit. b DSGVO (Vertrag) |
| **Authentifizierungs-Daten** | Google-OAuth-Tokens (refresh + access), WebAuthn-Credentials, PRF-Outputs | OpenBao Transit + Postgres `credentials`-Tabelle (AES-256-GCM) | Art. 6 Abs. 1 lit. b, f DSGVO |
| **Session-Daten** | JWT-Tokens (kurzlebig), Session-IDs, IP, User-Agent | Postgres `sessions`-Tabelle, Server-Memory | Art. 6 Abs. 1 lit. f DSGVO |
| **Workspace-Daten** | Vom User in Tools gespeicherte Dokumente, App-States, Skills, Memos | mcp-knowledge2-Postgres + Vector-Store (CMEK-encrypted) | Art. 6 Abs. 1 lit. b DSGVO |
| **Service-Credentials** | Vom User registrierte Tokens fuer externe Tools (Google Workspace, GitHub, etc.) | OpenBao-vertraulich, ciphertext in Postgres | Art. 6 Abs. 1 lit. b DSGVO |
| **Audit-Log** | Aktion, Actor-User-ID, Result, Timestamp, IP, User-Agent | Postgres `audit_log`-Tabelle (immutable, append-only) | Art. 6 Abs. 1 lit. c, f DSGVO (Compliance) |
| **Operational-Log** | HTTP-Logs (request_id, path, status, duration) — KEINE Bodies, KEINE PII im Klartext | Cloud Logging (90d Retention) | Art. 6 Abs. 1 lit. f DSGVO |

### 3.2 Kategorien Betroffener

- Mitarbeiter:innen + Kontraktor:innen des Auftraggebers, die das System nutzen
- Eingeladene Externe (gemaess Invite-Workflow)

### 3.3 NICHT verarbeitet

Der Auftragsverarbeiter verarbeitet KEINE besonderen Kategorien i. S. v. Art. 9 DSGVO (Gesundheit, Religion, etc.) — sofern der Auftraggeber solche Daten in den Workspace-Tools speichert, geschieht dies **eigenverantwortlich**; der Auftragsverarbeiter hat keine Kenntnis vom Inhalt (siehe §10 Verschluesselung).

---

## 4. Zwecke der Verarbeitung

- Bereitstellung der mcp-approval2-Pilot-Software gemaess Hauptvertrag
- Authentifizierung + Autorisierung der User (Google-OAuth, WebAuthn)
- Speicherung + Wiederherstellung von Tool-Konfigurationen + Workspace-Daten
- Approval-Workflow fuer sicherheitskritische Tool-Calls
- Audit-Logging zur Erfuellung von Compliance- und Sicherheits-Anforderungen
- Forensik bei Security-Incidents (mit Notification an Auftraggeber)

Andere Zwecke (z. B. Marketing, Telemetrie zu Auftragsverarbeiter-Trainings-Daten) sind ausgeschlossen.

---

## 5. Sub-Prozessoren

Der Auftragsverarbeiter nutzt die in [sub-processor-list.md](sub-processor-list.md) aufgefuehrten Sub-Prozessoren. Der Auftraggeber erklaert sich mit dieser Liste **bei Vertragsabschluss** einverstanden.

**Aenderungen an der Sub-Prozessor-Liste:** Der Auftragsverarbeiter informiert den Auftraggeber **mindestens 30 Tage** im Voraus per Email an `{{KUNDE_DSB}}`. Der Auftraggeber hat ein **Widerspruchsrecht**; bei Widerspruch endet das Verarbeitungsverhaeltnis nach Ablauf einer 30-Tage-Frist.

**Sub-Prozessor-Pflichten:** Der Auftragsverarbeiter verpflichtet jeden Sub-Prozessor vertraglich auf min. die gleichen Datenschutz-Standards wie in diesem DPA. Die Sub-Prozessor-Vertraege sind dem Auftraggeber auf Anfrage einsehbar.

---

## 6. Datenresidenz

**EU-only:** Alle Daten werden ausschliesslich in EU-Rechenzentren verarbeitet (siehe [ADR-0003](../adr/0003-eu-only-data-residency.md)).

Konkret:
- **Postgres Cloud SQL:** Region `europe-west1` (Belgien) oder `europe-west3` (Frankfurt) — pro Pilot festgelegt in {{PILOT_REGION}}
- **OpenBao:** {{OPENBAO_LOCATION}} (typischerweise on-prem im EU-Rechenzentrum des Auftragsverarbeiters)
- **Cloud Run:** Region gleich wie Postgres
- **Vertex AI Embeddings:** Region `europe-west4` (Niederlande) gemaess [ADR-0018](../adr/0018-google-vertex-ai-eu-region.md)
- **Object-Storage (GCS):** Bucket-Location `EU` (multi-region innerhalb EU)
- **Logs (Cloud Logging):** Bucket-Location `eu` (90d Retention)

**Drittland-Transfers:** Ausgeschlossen, ausser fuer:
- Sub-Prozessoren, deren Stamm-Sitz ausserhalb der EU liegt, deren Verarbeitung aber nachweislich in EU-Regionen stattfindet (z. B. Google LLC mit Vertex AI EU-Region)
- Diese sind in der Sub-Prozessor-Liste explizit markiert + mit EU-SCC + Transfer-Risk-Assessment (TIA) abgesichert

---

## 7. Technisch-Organisatorische Massnahmen (TOMs)

Der Auftragsverarbeiter ergreift folgende Massnahmen gemaess Art. 32 DSGVO:

### 7.1 Vertraulichkeit

- **Zugangskontrolle:** Single-Tenant-Pro-Pilot, separate Cloud-Projekte, separate Vault-Cluster
- **Zugriffskontrolle:** Role-based + Per-User-Row-Level-Security (Postgres RLS); Admin hat keinen Klartext-Zugriff auf User-Daten (siehe [ADR-0017](../adr/0017-admin-no-user-data-access.md))
- **Trennungskontrolle:** Pilot-Instanzen voneinander isoliert (separate DB-Instances, separate Vaults)
- **Pseudonymisierung:** User-IDs (UUID) statt direkter Email-Verwendung in internen Referenzen
- **Verschluesselung:** Siehe §10

### 7.2 Integritaet

- **Weitergabekontrolle:** TLS 1.3 fuer alle Verbindungen, mutual-Auth zwischen Services via RS256-JWT
- **Eingabekontrolle:** Vollstaendiges Audit-Log fuer alle Schreibzugriffe (siehe §11)
- **Auftragskontrolle:** Server folgt strikt dem Hauptvertrag — keine eigenstaendige Verarbeitung; Audit-Log dokumentiert jeden Admin-Zugriff

### 7.3 Verfuegbarkeit + Belastbarkeit

- **Verfuegbarkeitskontrolle:** Cloud SQL HA mit Read-Replica, taegliches Backup, PITR enabled; Vault-Auto-Unseal
- **Wiederherstellbarkeit:** Restore-Drill quartalsweise (siehe [runbook-incident-response.md](../runbooks/runbook-incident-response.md))
- **Belastbarkeit:** Rate-Limiting, Cost-Gates, Per-User-Resource-Quotas

### 7.4 Verfahren zur Ueberpruefung

- **Audit-Log:** Pflicht-Sink Postgres (immutable, append-only) + optionaler SIEM-Forward (OpenTelemetry / Loki / Splunk)
- **Penetration-Testing:** Mindestens 1x / Jahr durch unabhaengigen Anbieter; Report dem Auftraggeber auf Anfrage einsehbar
- **Internes Audit:** Quartalsweise Audit-Review durch Datenschutzbeauftragten

---

## 8. Weisungen + Mitwirkungspflichten

- Der Auftragsverarbeiter verarbeitet personenbezogene Daten **ausschliesslich auf dokumentierte Weisung** des Auftraggebers. Schriftlicher Hauptvertrag + diesem DPA gelten als Weisung.
- Zusaetzliche Weisungen erfolgen per Email an `{{ANBIETER_DSB}}` oder schriftlich.
- Der Auftragsverarbeiter informiert den Auftraggeber unverzueglich, wenn eine Weisung gegen geltendes Datenschutzrecht verstoesst.
- Der Auftragsverarbeiter unterstuetzt den Auftraggeber bei der Erfuellung der Betroffenenrechte (Art. 15-22 DSGVO) — siehe §13.

---

## 9. Betroffenenrechte (Self-Service + Operator-Pfad)

mcp-approval2 implementiert folgende Self-Service-Endpunkte (im PWA verfuegbar):

- **Auskunft (Art. 15):** `/v1/gdpr/export` — User exportiert alle eigenen Daten als NDJSON. Audit-Event `gdpr.export.success`.
- **Berichtigung (Art. 16):** PWA-User-Settings + Tool-spezifische Edit-Workflows
- **Loeschung (Art. 17):** `/v1/gdpr/erase` — User stoesst Loeschanfrage an; 30-Tage-Recovery-Window, danach Hard-Erase (Crypto-Shredding via KEK-Destroy fuer die User-DEK; ueber-mcp-knowledge2-Cascade)
- **Einschraenkung (Art. 18):** Admin-Pfad — User-Account auf "suspended" setzen; Audit-Event `admin.user.suspend`
- **Datenuebertragbarkeit (Art. 20):** identisch zu Auskunft (Art. 15)
- **Widerspruch (Art. 21):** beendet das Vertragsverhaeltnis; nach Erase-Workflow

**Operator-Unterstuetzung:** Wenn der Auftragsverarbeiter eine Betroffenenanfrage **direkt** erhaelt, leitet er sie ohne Bearbeitung an den Auftraggeber weiter (Art. 28 Abs. 3 lit. e DSGVO).

---

## 10. Verschluesselung + Crypto-Shredding

### 10.1 At-Rest

- **Postgres:** CMEK-Verschluesselung mit kunde-owned Cloud-KMS-Key (Region wie Postgres)
- **User-Credentials + sensitive Workspace-Bodies:** AES-256-GCM mit per-User-DEK; DEKs in OpenBao Transit wrapped, AAD bindet ciphertext an User-ID + Kind
- **Vault-Storage:** OpenBao Raft mit Auto-Unseal via Cloud KMS

### 10.2 In-Transit

- TLS 1.3 mit forward-secrecy, HSTS preload, OCSP-Stapling
- Service-zu-Service: zusaetzlich JWT-Auth (RS256, kurz-lived)

### 10.3 Crypto-Shredding (User-Erase)

Wenn ein User eine Loeschanfrage stellt + die 30-Tage-Recovery-Frist abgelaufen ist:
1. mcp-approval2 ruft `KekProvider.destroyKey(user_id)` auf — die per-User-DEK in OpenBao wird zerstoert
2. Cascade an mcp-knowledge2 (gleicher Destroy-Call mit denselben Audit-Events)
3. Die User-Daten in den DB-Rows verbleiben als ciphertext, sind aber **kryptografisch unleserlich** + werden im naechsten Backup-Cycle nicht mehr lesbar restored
4. Hard-DELETE der User-Stammdaten (Email, Display-Name) in einer 7-Tage-Frist-Cascade
5. Audit-Events: `gdpr.erase.requested`, `gdpr.erase.executed`, `gdpr.kek.destroyed`

---

## 11. Audit-Log + Aufbewahrung

- **Pflicht-Events:** alle Auth-, Permission-, Credential-, Tool-Call-, Admin-, Approval-Events (siehe [ADR-0019](../adr/0019-audit-schema-day-zero-sink-later.md))
- **Retention:** mindestens 365 Tage; auf Anfrage des Auftraggebers verlaengerbar bis 7 Jahre (Compliance-Pflichten z. B. GoBD)
- **Immutability:** Postgres-Tabelle `audit_log` mit Trigger-Schutz gegen UPDATE/DELETE (Pflicht-Default); Sink kann zusaetzlich auf WORM-Storage (GCS Object Lock) repliziert werden
- **Operator-Zugriff:** Read-only via Admin-Dashboard; jeder Read wird selbst auditet (`admin.audit.read`)
- **Customer-Access:** Auf Anfrage Audit-Export im NDJSON-Format, mit GPG-Verschluesselung; mind. 1x / Quartal kostenlos

---

## 12. Meldepflichten + Incident-Response

- **Compromise-Notification:** Der Auftragsverarbeiter informiert den Auftraggeber **ohne unangemessene Verzoegerung** (max. 24h ab Kenntnisnahme) ueber jeden Vorfall, der personenbezogene Daten betrifft
- **Notification-Inhalt:** Art des Vorfalls, Kategorien + ungefaehre Anzahl Betroffener, Folgen, getroffene Massnahmen
- **Behoerden-Notification (Art. 33):** Pflicht des Auftraggebers (als Verantwortlicher); der Auftragsverarbeiter unterstuetzt mit allen relevanten Informationen
- **Betroffenen-Notification (Art. 34):** Pflicht des Auftraggebers; Auftragsverarbeiter unterstuetzt
- **Playbook:** siehe [runbook-incident-response.md](../runbooks/runbook-incident-response.md)

---

## 13. Auditrechte des Auftraggebers

Der Auftraggeber kann:
- Auf Anfrage Audit-Log-Auszuege erhalten (siehe §11)
- 1x / Jahr eine On-Site-Pruefung (oder per Remote-Tool) der TOMs anstossen — Termin mit 30-Tage-Vorlauf; Kosten traegt der Auftraggeber wenn keine Beanstandungen
- Penetration-Test-Reports (siehe §7.4) einsehen
- ISO 27001 / SOC 2 / BSI C5 Zertifikate des Auftragsverarbeiters einsehen, sofern vorhanden (Aktueller Status: `{{ZERTIFIKAT_STATUS}}`)

---

## 14. Vertragsende + Datenrueckgabe / -loeschung

Nach Beendigung des Hauptvertrags:
- **Wahlmoeglichkeit Auftraggeber** (innerhalb 30 Tagen nach Vertragsende):
  - (A) **Vollexport** aller User-Daten im NDJSON-Format (mit GPG-Verschluesselung an `{{KUNDE_GPG_KEY}}`)
  - (B) **Loeschung** durch Crypto-Shredding (siehe §10.3) + Hard-DELETE
- **Standard ohne Wahl:** Crypto-Shredding nach 30 Tagen Karenz; Hard-DELETE binnen weiteren 7 Tagen
- **Audit-Log:** Audit-Log bleibt fuer 365 Tage nach Vertragsende erhalten (Compliance-Pflicht), danach Loeschung mit Audit-Event `gdpr.audit.purged`

---

## 15. Verguetung + Haftung

- Die Verarbeitung erfolgt im Rahmen der Verguetung des Hauptvertrags. Zusaetzliche Aufwaende (z. B. Sonder-Audits, Recovery-Drills auf Customer-Wunsch) werden gesondert in Rechnung gestellt.
- Haftung des Auftragsverarbeiters gegenueber dem Auftraggeber richtet sich nach Art. 82 DSGVO + Hauptvertrag.

---

## 16. Geltungsvorrang

Im Konflikt zwischen DPA und Hauptvertrag gilt der DPA **fuer alle Datenschutz-Aspekte vorrangig**. Aenderungen des DPA bedurfen der **schriftlichen** Form.

---

## 17. Anlagen

- **Anlage A:** [Sub-Prozessor-Liste](sub-processor-list.md)
- **Anlage B:** [Technisch-Organisatorische Massnahmen — Detail-Beschreibung](DPIA-template.md) (DPIA-Template, dient gleichzeitig als TOM-Belegdokumentation)
- **Anlage C:** Penetration-Test-Report `{{PENTEST_REPORT_REF}}`
- **Anlage D:** Datenfluss-Diagramm (separates PDF)

---

**Datum, Ort:**

Auftraggeber: ____________________________________

Auftragsverarbeiter: ______________________________

---

> Bei jeder Aenderung dieses Templates wird die Versions-Nummer im Header erhoeht + Changes im Changelog (`docs/compliance/CHANGELOG.md`) protokolliert. Eine angepasste Version eines DPA fuer einen konkreten Pilot wird im Customer-Account-Vault (NICHT in git) abgelegt.
