# Runbook: Hetzner-to-GCP Migration

> **Status:** Stub — Phase 2 (nach Hetzner-Pilot-Erfolg)
> **Letzte Verifikation:** 2026-05-13
> **Estimated time:** TBD (planned ~5-7 Tage Engineering, siehe Plan-Ref)

Migration des kompletten Stacks von Hetzner-Single-VM zu GCP-Cloud-Run +
Cloud-SQL. **Wird erst relevant wenn Hetzner-Pilot stabil laeuft** und
business-Production benoetigt wird (Phase 2 in Multi-Cloud-Plan).

## Status

Dieser Runbook ist ein **Stub**. Der detaillierte Migrationspfad wird
ausgearbeitet sobald:

1. Hetzner-Pilot laeuft min. 4 Wochen ohne Major-Incidents
2. business-User-Anforderungen klar sind (Multi-Tenancy? SLA? Region?)
3. GCP-Projekt provisioned + IAM aufgesetzt

## Referenz

[PLAN-hetzner-deployment §9 — Migrations-Pfad zu GCP](../plans/active/PLAN-hetzner-deployment.md#9-migrations-pfad-zu-gcp-phase-2-spaeter)

## High-Level Migration-Steps (Bullet-List)

1. **GCP-Projekt anlegen**
   - Cloud SQL Postgres (mit pgvector-extension via `CREATE EXTENSION vector`)
   - Cloud Run mcp-approval2-service + mcp-knowledge2-service
   - GCP KMS (statt OpenBao) — KEK-Adapter via `packages/adapters/src/kek/gcp-kms.ts`
   - Cloud Scheduler fuer Cron-Tasks
   - Vertex AI ist bereits funktional (gemeinsam zwischen Privat + Business)

2. **Daten-Migration**
   - pg_dump auf Hetzner → upload → pg_restore in Cloud SQL
   - Vault → GCP KMS: alle DEKs re-wrap (Skript bauen, ein-malig)
   - Blob-Storage (falls vorhanden): local-fs → GCS-Bucket

3. **Config-Switch (Container bleibt identisch)**
   - `DATABASE_URL` → Cloud SQL Connection-Pool oder Unix-Socket
   - `KEK_BACKEND=openbao` → `KEK_BACKEND=gcp-kms`
   - `BLOB_BACKEND=local-fs` → `BLOB_BACKEND=gcs`
   - Secrets von `.env` → GCP Secret Manager

4. **DNS-Switchover (atomic)**
   - Terraform-Workspace `business` apply
   - DNS-Records auf Cloud-Run-Domain umstellen (CNAME)
   - Cutover-Fenster: TTL temporaer auf 60s, dann switch, dann TTL back

5. **Hetzner-VM**
   - Option A: ausschalten + Snapshot behalten (Failover)
   - Option B: weiterlaufen als privat-Instance (parallel zu business)
   - Option C: komplett abreissen wenn Single-Tenant-Migration

## TODO (Phase 2)

Wenn dieser Runbook aktiviert wird, ausarbeiten:

- [ ] Pre-Flight-Checklist (Cloud SQL pgvector-Extension verfuegbar?)
- [ ] Pre-Migration-Backup-Strategie
- [ ] Re-Wrap-Skript fuer DEKs (OpenBao Transit → GCP KMS)
- [ ] Step-by-Step Timeline mit RTO-Targets
- [ ] Rollback-Plan falls Cutover scheitert
- [ ] Cost-Vergleich-Update (Hetzner ~7€/Mo vs GCP ~30-50€/Mo)
- [ ] Sub-MCP-Side-Effects (X-User-JWT-Pattern Migration parallel?)
- [ ] User-Notification-Workflow
- [ ] Post-Migration-Smoke + DNS-Verifikation

## Referenzen

- [PLAN-hetzner-deployment §9](../plans/active/PLAN-hetzner-deployment.md#9-migrations-pfad-zu-gcp-phase-2-spaeter)
- [PLAN-hetzner-deployment §2.1 Multi-Instance](../plans/active/PLAN-hetzner-deployment.md#21-multi-instance-pattern-privat--business-parallel)
- [runbook-multi-instance-operations.md](runbook-multi-instance-operations.md)
- [runbook-hetzner-backup-restore.md](runbook-hetzner-backup-restore.md)
