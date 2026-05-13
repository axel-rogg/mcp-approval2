# Runbooks — Index

Operative Playbooks fuer mcp-approval2 Pilot-Betrieb. Diese Files sind fuer Operator (DevOps + On-Call-Engineers) gedacht — nicht fuer Endkunden.

## Verfuegbar

| Runbook | Zweck | Ziel-Audience |
|---|---|---|
| [runbook-pilot-onboarding.md](runbook-pilot-onboarding.md) | Schritt-fuer-Schritt vom leeren GCP-Project bis zum lauffaehigen Pilot — Voraussetzungen, Initial-Setup, First-Admin, User-Invites, Sub-MCP-Registration, Pilot-Smoke, Backup-Verification | Operator (T-7 bis T+0) |
| [runbook-incident-response.md](runbook-incident-response.md) | Klassifikation (SEV-1 bis SEV-4), Compromise-Indikatoren, Sofortmassnahmen, Forensik, Notification (intern + Customer + Behoerde 72h-Frist + Betroffene Art. 34), Post-Incident-Review, Drill-Schedule | On-Call-Engineer (24/7) |
| [runbook-token-rotation.md](runbook-token-rotation.md) | Rotation pro Token-Klasse — RS256-JWT-Signing-Keys, OpenBao-AppRole Secret-ID, INTERNAL-Service-Token, Google-OAuth-Client-Secret. Pre-Flight, Roll-Out, Verifikation, Rollback | Operator (quartalsweise) |

## TODO Phase 7

Diese Runbooks sind noch zu schreiben:

- `runbook-openbao-bootstrap.md` — OpenBao-Cluster initial deployen + Auto-Unseal verkabeln
- `runbook-restore-pitr.md` — Postgres Point-in-Time-Recovery fuer Customer-Initiierte Restore-Requests
- `runbook-vault-snapshot-restore.md` — OpenBao-Raft-Snapshot zurueck einspielen (Drill-Pflicht quartalsweise)
- `runbook-kek-rotation.md` — KEK-Rotation in OpenBao-Transit + Rewrap aller DEKs
- `runbook-deploy-cloud-run.md` — Standard-Deploy-Pipeline + Rollback-Pfad
- `runbook-monitoring-dashboards.md` — Welche Dashboards + Alerts pro Pilot aufgesetzt sind
- `runbook-audit-export.md` — Manuelle + automatisierte Audit-Export-Workflows fuer Customer-Anfragen
- `runbook-user-erasure.md` — GDPR-Erase-Workflow operativ (was passiert wann, was kann Operator sehen, wie validiert man Crypto-Shredding)

## Konventionen

- Jeder Runbook hat einen **Status-Header** (Draft / Stable / Deprecated)
- **Last-update** mit ISO-Datum
- Plan-Reference zu PLAN-architecture-v1.md oder relevantem ADR
- Konkrete Befehle in `bash`-Bloecken — Placeholder in `<...>` markiert
- Acceptance-Checkliste am Ende fuer Verifikation
- Audit-Event-Namen + SQL-Beispiele fuer Verifikations-Queries

## Zugriff

Runbooks sind **nicht-sensitiv** und liegen im Repo. Konkrete Pilot-Konfigurationen (Customer-spezifische Werte fuer Platzhalter) liegen im Customer-Account-Vault (NICHT in git).
