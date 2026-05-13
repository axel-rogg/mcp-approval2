# Compliance — Index

Datenschutz- + Compliance-Templates fuer mcp-approval2 Pilot-Betrieb.

> **HAFTUNGSHINWEIS:** Alle Templates in diesem Ordner sind **technische Vorbereitungen**, kein Rechtsdokument. **Vor Pilot-Go-Live sind anwaltliche Pruefung und Anpassung an die konkrete Pilot-Konstellation Pflicht.** Die Inhalte stuetzen sich auf DSGVO-Standardstrukturen, ersetzen aber keine juristische Beratung.

## Verfuegbar

| Datei | Zweck | Pflege durch |
|---|---|---|
| [DPA-template.md](DPA-template.md) | Auftragsverarbeitungsvertrag-Template (DSGVO Art. 28) mit Parteien, Datenkategorien, Sub-Prozessoren, TOMs, Betroffenenrechten, Crypto-Shredding, Audit-Log, Meldepflichten, Auditrechten, Vertragsende-Workflows | Customer-Rechts-Team + Anbieter-DSB |
| [DPIA-template.md](DPIA-template.md) | Data Protection Impact Assessment (Art. 35 DSGVO) — Beschreibung der Verarbeitung, Erforderlichkeit, Risiko-Analyse (10 Risiken), Mitigations, Rest-Risiken, Konsultations-Pflichten | Customer-DSB (Pflicht) |
| [sub-processor-list.md](sub-processor-list.md) | Liste aller Sub-Prozessoren (GCP, OpenBao, Vertex AI, Cloudflare optional, SIEM optional) mit Drittland-Risiko-Mitigations + Aenderungsprozess (30-Tage-Notification) | Anbieter (Pflege), Customer (Akzeptanz) |

## TODO Phase 7

- `incident-notification-template.md` — Standardisierte Customer-Notification bei Vorfall
- `data-subject-notification-template.md` — Direkt-Notification an Betroffene (Art. 34 DSGVO)
- `tom-detail.md` — Vollstaendige TOM-Beschreibung (heute in DPA inline)
- `tia-template.md` — Transfer Impact Assessment (Schrems II) fuer jeden Drittland-Transfer
- `CHANGELOG.md` — Versionierungs-Log fuer alle Compliance-Docs
- `contacts.md` — Eskalations-Kontakte (NICHT in git — separater Secret-Store!)
- `audit-report-template.md` — Quartals-Audit-Report fuer Customer

## Konventionen

- Platzhalter in `{{...}}` (z. B. `{{KUNDE_NAME}}`, `{{PILOT_REGION}}`)
- Konkrete Pilot-Versionen werden im Customer-Account-Vault gepflegt (NICHT in git)
- Versions-Header mit Datum + Plan-Reference + ggf. ADR-Verweisen
- DPIA wird **mindestens jaehrlich** geprueft + bei Aenderungen aktualisiert

## Pilot-Workflow

1. Pre-Sales: Customer sieht Templates + Sub-Prozessor-Liste, gibt Feedback
2. Vor Vertragsabschluss: anwaltliche Pruefung beider Seiten, Anpassungen
3. Vertragsabschluss: konkrete DPA-Version signiert, im Customer-Vault abgelegt
4. Vor Pilot-Go-Live: DPIA durch Customer-DSB geprueft + freigegeben
5. Quartalsweise: TOM-Review, Sub-Prozessor-Liste-Pruefung
6. Jaehrlich: Pen-Test + DPIA-Update
7. Bei Vorfall: Notification gemaess [Incident-Response-Runbook](../runbooks/runbook-incident-response.md) §4

## Verweise

- [Architektur-Plan](../plans/active/PLAN-architecture-v1.md) §4 (Compliance)
- [ADR-Index](../adr/README.md) — alle Architektur-Entscheidungen mit Datenschutz-Bezug
- [Runbooks](../runbooks/README.md) — operative Playbooks
