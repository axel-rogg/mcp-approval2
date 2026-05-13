# Runbooks — Index

Operative Playbooks fuer mcp-approval2 Pilot-Betrieb. Diese Files sind fuer Operator (DevOps + On-Call-Engineers) gedacht — nicht fuer Endkunden.

## Verfuegbar

| Runbook | Status | Use-Case |
|---|---|---|
| [pilot-onboarding](runbook-pilot-onboarding.md) | Stable | Schritt-fuer-Schritt vom leeren GCP-Project bis zum lauffaehigen Pilot |
| [pilot-smoke](runbook-pilot-smoke.md) | Stable | Smoke-Tests gegen laufenden Pilot |
| [incident-response](runbook-incident-response.md) | Stable | SEV-Klassifikation, Forensik, Notification, Post-Incident |
| [token-rotation](runbook-token-rotation.md) | Stable | Application-Token-Rotation (RS256-JWT, INTERNAL, OAuth-Client) |
| [fly-deploy](runbook-fly-deploy.md) | Stable | Fly.io-Deploy + Operations (Legacy hobby-Setup) |
| [cloudflare-deploy](runbook-cloudflare-deploy.md) | Draft | Cloudflare-Workers-Deploy (Sub-MCPs) |
| [hetzner-deploy](runbook-hetzner-deploy.md) | Ready | Hetzner Initial-Deploy + Updates (Privat-Pilot) |
| [hetzner-rotate-vault](runbook-hetzner-rotate-vault.md) | Ready | OpenBao-Vault Token + AppRole + Transit-Key Rotation |
| [hetzner-backup-restore](runbook-hetzner-backup-restore.md) | Ready | DB-Dump + Vault-Snapshot + Restore-Verfahren |
| [hetzner-disaster-recovery](runbook-hetzner-disaster-recovery.md) | Ready | Komplett-Wiederherstellung (VM-Loss, DB-Corruption, Vault-Loss) |
| [hetzner-to-gcp-migration](runbook-hetzner-to-gcp-migration.md) | Stub | Migration-Pfad zu GCP (Phase 2) |
| [multi-instance-operations](runbook-multi-instance-operations.md) | Stub | Parallelbetrieb privat + business |

## TODO Phase 7

Diese Runbooks sind noch zu schreiben:

- `runbook-openbao-bootstrap.md` — OpenBao-Cluster initial deployen + Auto-Unseal verkabeln
- `runbook-restore-pitr.md` — Postgres Point-in-Time-Recovery fuer Customer-Initiierte Restore-Requests
- `runbook-vault-snapshot-restore.md` — OpenBao-Raft-Snapshot zurueck einspielen (Drill-Pflicht quartalsweise)
- `runbook-kek-rotation.md` — KEK-Rotation in OpenBao-Transit + Rewrap aller DEKs
- `runbook-deploy-cloud-run.md` — Standard-Deploy-Pipeline + Rollback-Pfad (GCP)
- `runbook-monitoring-dashboards.md` — Welche Dashboards + Alerts pro Pilot aufgesetzt sind
- `runbook-audit-export.md` — Manuelle + automatisierte Audit-Export-Workflows fuer Customer-Anfragen
- `runbook-user-erasure.md` — GDPR-Erase-Workflow operativ (was passiert wann, was kann Operator sehen, wie validiert man Crypto-Shredding)

## Konventionen

- Jeder Runbook hat einen **Status-Header** (Draft / Stable / Ready / Stub / Deprecated)
- **Last-update** mit ISO-Datum
- Plan-Reference zu PLAN-architecture-v1.md, PLAN-hetzner-deployment.md oder relevantem ADR
- Konkrete Befehle in `bash`-Bloecken — Placeholder in `<...>` markiert
- Acceptance-Checkliste am Ende fuer Verifikation
- Audit-Event-Namen + SQL-Beispiele fuer Verifikations-Queries

## Zugriff

Runbooks sind **nicht-sensitiv** und liegen im Repo. Konkrete Pilot-Konfigurationen (Customer-spezifische Werte fuer Platzhalter) liegen im Customer-Account-Vault (NICHT in git).
