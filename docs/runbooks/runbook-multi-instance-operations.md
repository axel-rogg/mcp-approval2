# Runbook: Multi-Instance Operations (privat + business parallel)

> **Status:** Stub — wird relevant wenn business-Instance aufgesetzt wird
> **Letzte Verifikation:** 2026-05-13
> **Estimated time:** TBD (planned ~1 Tag Doku-Ausarbeitung)

Operations-Patterns fuer den parallelen Betrieb der privat-Instance
(Hetzner) und business-Instance (GCP) mit identischer Codebase aber
getrennten Daten + Domains.

## Status

Dieser Runbook ist ein **Stub**. Wird ausgearbeitet sobald die business-Instance
real aufgesetzt wird. Bis dahin: privat-Instance laeuft solo, dieses File
dokumentiert nur die konzeptionelle Struktur.

## Referenz

[PLAN-hetzner-deployment §2.1 — Multi-Instance-Pattern](../plans/active/PLAN-hetzner-deployment.md#21-multi-instance-pattern-privat--business-parallel)

## Konzept-Uebersicht

```
Single Codebase: mcp-approval2 + mcp-knowledge2
              │
       ┌──────┴──────┐
       │ Terraform   │
       │ Workspaces  │
       └──────┬──────┘
   ┌──────────┴──────────┐
   ▼                     ▼
┌─────────────┐    ┌─────────────┐
│  PRIVAT     │    │  BUSINESS   │
│  Hetzner    │    │  GCP        │
│  CX21       │    │  Cloud Run  │
│  ~7 €/Mo    │    │  ~30-50 €/Mo│
└─────┬───────┘    └─────┬───────┘
      │                  │
      └──────┬───────────┘
             ▼
   ┌─────────────────────┐
   │ Shared:             │
   │ - CF Zone           │
   │ - Sub-MCPs (CF)     │
   │ - Container-Image   │
   └─────────────────────┘
```

**Wichtig:** Beide Instances haben **getrennte Daten** (User-DBs, Credentials,
Audit-Logs sind komplett unabhaengig). KEINE Cross-Instance-Calls.

## Terraform-Workspaces

```bash
# State-Files
# Privat:   s3://mcp-tf-state/mcp-approval2/privat/terraform.tfstate
# Business: s3://mcp-tf-state/mcp-approval2/business/terraform.tfstate

# Operations pro Workspace
cd terraform/environments/privat
terraform plan && terraform apply

cd terraform/environments/business
terraform plan && terraform apply
```

## Operations-Patterns die ANDERS sind

| Operation | privat (Hetzner) | business (GCP) |
|---|---|---|
| Deploy | `bash deploy/hetzner/update.sh` ueber SSH | `gcloud run deploy` via Cloud Build |
| Logs | `docker compose logs -f` | `gcloud logging read` / Cloud Logging UI |
| DB-Backup | `pg_dumpall` ueber Container | Cloud SQL Automated Backups |
| KEK-Rotation | OpenBao `transit/keys/.../rotate` | GCP KMS CMEK version-rotate |
| Scaling | manuell (groesserer VM-Type) | Auto-Scale (Cloud Run) |
| Monitoring | Docker logs + Hetzner Console | Cloud Monitoring + Alerts |
| Region | `fsn1` (Frankfurt) fix | `europe-west4` (oder mehrere) |
| SSL | Caddy + Lets-Encrypt | Google-managed Certs |

## Operations-Patterns die GLEICH sind

- Code-Updates: gleicher `git pull` (Container-Image identisch)
- DB-Schema-Migrations: gleiches `scripts/migrate.js`
- Sub-MCP-Calls: beide callen dieselben CF-Worker (cf, gws, utils, gcloud)
- User-Onboarding: gleicher OAuth-Flow + WebAuthn-Enrollment
- Smoke-Tests: gleiche `healthcheck.sh`-Logik (URL ist parametrized)

## TODO (Phase 2)

Wenn dieser Runbook aktiviert wird, ausarbeiten:

- [ ] Side-by-Side Operations-Reference (welcher Befehl pro Plattform)
- [ ] Cross-Instance-Audit (zwei Audit-Streams zusammenfuehren?)
- [ ] Sub-MCP-Scope-Discriminator-Pattern dokumentieren (`iss=mcp-approval2-privat`
      vs `iss=mcp-approval2-business`)
- [ ] Backup-Cadence pro Instance
- [ ] Rotation-Cadence-Synchronisation (gleiche Kalender-Slots oder versetzt?)
- [ ] Cost-Tracking pro Instance
- [ ] Open Decision 2.1 finalisieren: shared Sub-MCP-Worker mit iss-Switch
      ODER separate Worker-Instances pro Hub
- [ ] Disaster-Recovery-Kreuzschutz (kann eine Instance als Failover dienen?)
- [ ] Multi-Instance Pilot-Smoke-Skript

## Referenzen

- [PLAN-hetzner-deployment §2.1](../plans/active/PLAN-hetzner-deployment.md#21-multi-instance-pattern-privat--business-parallel)
- [PLAN-hetzner-deployment §2.2 Terraform-Strategie](../plans/active/PLAN-hetzner-deployment.md#22-terraform-strategie)
- [runbook-hetzner-deploy.md](runbook-hetzner-deploy.md)
- [runbook-hetzner-to-gcp-migration.md](runbook-hetzner-to-gcp-migration.md)
