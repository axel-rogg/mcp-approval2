# Runbooks — Index

Operative Playbooks fuer mcp-approval2 Pilot-Betrieb. Diese Files sind fuer Operator (DevOps + On-Call-Engineers) gedacht — nicht fuer Endkunden.

## Verfuegbar

| Runbook | Status | Use-Case |
|---|---|---|
| [pilot-onboarding](runbook-pilot-onboarding.md) | Stable | Schritt-fuer-Schritt vom leeren GCP-Project bis zum lauffaehigen Pilot |
| [pilot-smoke](runbook-pilot-smoke.md) | Stable | Smoke-Tests gegen laufenden Pilot |
| [incident-response](runbook-incident-response.md) | Stable | SEV-Klassifikation, Forensik, Notification, Post-Incident |
| [token-rotation](runbook-token-rotation.md) | Stable | Application-Token-Rotation (RS256-JWT, INTERNAL, OAuth-Client) |
| [fly-deploy](runbook-fly-deploy.md) | **Primary** | **Fly.io-Deploy + Operations (privat-Mode-Pfad, Stand 2026-05-17)** |
| [cloudflare-deploy](runbook-cloudflare-deploy.md) | Draft | Cloudflare-Workers-Deploy (Sub-MCPs) |
| [family-hardening](runbook-family-hardening.md) | Stable | ~4h Operator-Sprint fuer privat-Mode (Passkey/R2-Lock/Restore-Drill/Safe-Brief) |
| [operator-recovery-brief](operator-recovery-brief.md) | Template | Bus-Faktor-1-Recovery (Print + Safe + Treuhaender) |
| [audit-worm](runbook-audit-worm.md) | Optional | P2-8 GCS-WORM-Audit-Sink aktivieren (Compliance SOC-2/ISO-27001) |

## Deprecated (Audit-Trail / Notfall-Reset)

Folgende Runbooks dokumentieren den historischen Hetzner-Self-Host-Pfad
(2026-05-13 bis 2026-05-17). Sie sind nicht mehr Teil der aktuellen
Architektur (Switch auf Fly.io per [docs/privat.md §9.4](../privat.md)),
bleiben aber als Audit-Trail / Disaster-Recovery-Reaktivierungs-Material:

| Runbook | Use-Case (deprecated) |
|---|---|
| [hetzner-deploy](runbook-hetzner-deploy.md) | Hetzner Initial-Deploy + Updates |
| [hetzner-rotate-vault](runbook-hetzner-rotate-vault.md) | OpenBao-Vault Rotation (Hetzner-VM-bound — Fly-Variante: fly-deploy Operations-Section) |
| [hetzner-backup-restore](runbook-hetzner-backup-restore.md) | DB-Dump + Vault-Snapshot + Restore (Hetzner-VM-bound) |
| [hetzner-disaster-recovery](runbook-hetzner-disaster-recovery.md) | Komplett-Wiederherstellung (VM-Loss, DB-Corruption, Vault-Loss) |
| [hetzner-auto-deploy](runbook-hetzner-auto-deploy.md) | GH-Actions-Auto-Deploy gegen Hetzner-VM |
| [hetzner-to-gcp-migration](runbook-hetzner-to-gcp-migration.md) | Migration Hetzner → GCP (durch Fly→GCP-Migration in privat.md §8 ersetzt) |
| [vm-start-stop](runbook-vm-start-stop.md) | Hetzner-VM Power-Management |
| [vm-destroy-recreate](runbook-vm-destroy-recreate.md) | Hetzner-VM destroy + re-provision |
| [coop-bypass](runbook-coop-bypass.md) | Hetzner-FQDN als Zscaler-Bypass (Fly hat das Problem nicht) |
| [multi-instance-operations](runbook-multi-instance-operations.md) | Parallelbetrieb privat + business (Stub — überarbeiten wenn business-Mode aktiv) |

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
