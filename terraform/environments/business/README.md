# Environment: `business`

**Status:** ✅ Active (2026-05-15) — provisioniert GCP-Resources für eine
mcp-knowledge2 business-Instance auf Cloud Run + Cloud SQL + GCS + Cloud KMS.

**Schwester-Workspace:** [`privat/`](../privat/) — Hetzner-Pilot mit
OpenBao + Hetzner Object Storage + Cloudflare Workers AI.

Beide Workspaces nutzen die gleiche mcp-knowledge2-Codebase mit dem gleichen
Container-Image. Differenz ist nur env-driven via Adapter-Pattern (siehe
`src/adapters/{blob,kms,embed}/index.ts` für die Factory-Pattern).

## Was hier provisioniert wird

| Resource | Provider | Zweck |
|---|---|---|
| `google_kms_key_ring` + `crypto_key.master` | Cloud KMS | Master-Key-Wrap für `KMS_PROVIDER=cloud_kms` |
| `google_kms_crypto_key.sql_cmek` | Cloud KMS | CMEK für Cloud SQL at-rest |
| `google_sql_database_instance` | Cloud SQL | Postgres 16 + pgvector, private-IP, PITR, 30-Backups |
| `google_storage_bucket` | GCS | Blob-Backend für `BLOB_PROVIDER=gcs` |
| `google_service_account.knowledge2_runtime` | IAM | Cloud-Run-Runtime SA mit KMS/SQL/Vertex/GCS-Rollen |
| `doppler_project.knowledge2_business` | Doppler | Secret-Store, auto-befüllt mit DB-URL/KMS/Blob/Vertex-Config |

## Was hier **nicht** ist (manuell, post-apply)

- **Cloud Run Service**: image-push + erste Migration vor service-create
  (chicken-and-egg) → via `gcloud run deploy` nach TF-Apply
- **Workload Identity Federation für GitHub Actions** — eigenes Modul
- **Cloud Load-Balancer + managed-SSL** für Custom-Domain
- **Monitoring/Alerting** (Cloud Monitoring)
- **`CLOUD_KMS_WRAPPED_MASTER_B64`** — operator-step nach apply (TF würde den
  plaintext master in den state schreiben — explizit vermieden)

Konkrete Post-Apply-Schritte stehen als Kommentar am Ende von `main.tf`.

## Bootstrap

```bash
# 1. Auth
gcloud auth application-default login --project=firma-knowledge-prod

# 2. Init + Apply
cd /workspaces/mcp-approval2/terraform/environments/business
terraform init
terraform apply \
  -var "gcp_project_id=firma-knowledge-prod" \
  -var "cloudflare_zone_id=…" \
  -var "domain_knowledge=knowledge.firma.com"

# 3. Outputs für die Post-Steps:
terraform output kms_key_name
terraform output sql_instance_connection_name
terraform output runtime_service_account_email
terraform output doppler_business_dashboard
terraform output -raw doppler_business_run_token  # für Cloud Run DOPPLER_TOKEN env
```

## Variables (siehe `variables.tf`)

| Variable | Required | Default |
|---|---|---|
| `gcp_project_id` | ✓ | — |
| `gcp_region` | nein | `europe-west4` (Frankfurt) |
| `cloudflare_zone_id` | ✓ | — |
| `cloudflare_api_token` | ✓ (sensitive) | — |
| `domain_knowledge` | ✓ | — |
| `container_image` | nein | `ghcr.io/axel-rogg/mcp-knowledge2:latest` |

## State

R2-Backend mit Key `business/terraform.tfstate` im selben Bucket wie
`privat/` (`mcp-approval2-tf-state-eu`), unterschiedlicher Path. Niemals
Cross-State-Operationen zwischen privat und business.

## Verwandte Doku

- [docs/plans/active/PLAN-hetzner-deployment.md](../../../docs/plans/active/PLAN-hetzner-deployment.md) §14 — Multi-Instance-Pattern
- [mcp-knowledge2/docs/runbooks/runbook-gcp-deploy.md](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/runbooks/runbook-gcp-deploy.md) — Cloud-Run-Deploy-Runbook
- [src/adapters/blob/gcs.ts](https://github.com/axel-rogg/mcp-knowledge2/blob/main/src/adapters/blob/gcs.ts) + [src/adapters/kms/cloud_kms.ts](https://github.com/axel-rogg/mcp-knowledge2/blob/main/src/adapters/kms/cloud_kms.ts) — KC2-Adapter-Implementationen
