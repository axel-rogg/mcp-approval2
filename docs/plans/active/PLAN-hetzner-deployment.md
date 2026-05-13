# PLAN — Hetzner Deployment fuer mcp-approval2

> **Status: ⚠️ DRAFT — bereit fuer Implementation, kein Code in dieser Datei**
>
> Erstellt: 2026-05-13 nach Multi-Cloud-Review (Burst 9). Dieser Plan
> definiert das Privat-Pilot-Deployment auf Hetzner CX21 mit Pfad zu
> spaeterer GCP-Cloud-Run-Migration ohne Code-Aenderungen.
>
> **Schwester-Plan:** [mcp-knowledge2 PLAN-hetzner-deployment](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/plans/active/PLAN-hetzner-deployment.md)
> — beide Services laufen auf derselben Hetzner-VM, separater Agent ist
> fuer mcp-knowledge2-Refactor verantwortlich.

---

## 0. TL;DR

- **Plattform:** Hetzner Cloud CX21 (4 vCPU, 8 GB RAM, EU-Frankfurt)
- **Domain:** Cloudflare-managed `ai-toolhub.org`-Zone (terraform-managed, **bestehend**)
- **Kosten:** **~6 €/Monat** (CX21 5.83€ + minor traffic + snapshot 0.50€)
- **Architektur:** Single VM, docker-compose mit allen Services
- **Provisioning:** **Terraform** (Hetzner-Provider `hetznercloud/hcloud` + Cloudflare-Provider)
- **Postgres:** intern im docker-compose (Phase 1) → spaeter Cloud SQL extern (Phase 2)
- **Sub-MCPs:** bleiben auf Cloudflare Workers (cross-cloud HTTPS akzeptabel)
- **Multi-Instance:** **privat (Hetzner) + business (GCP) parallel** mit identischer
  Codebase, separaten Terraform-Workspaces, eigenen Domains
- **Code-Refactor erforderlich:** NEIN — der bestehende Node-Container-Stack
  funktioniert out-of-the-box auf Hetzner UND GCP Cloud Run
- **Migration zu GCP:** Container-Image bleibt identisch, separater Terraform-
  Workspace `business` deployed parallel auf GCP Cloud Run + Cloud SQL

---

## 1. Architektur

```
Internet
   │
   │ HTTPS (Caddy auto-Lets-Encrypt SSL)
   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Hetzner Cloud CX21 (eu-west-1 / Frankfurt)                      │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Docker-Compose-Stack (bridge-network: internal)           │  │
│  │                                                            │  │
│  │  ┌─────────┐                                               │  │
│  │  │  caddy  │ ← :443, :80, auto-SSL via Lets-Encrypt        │  │
│  │  └────┬────┘                                               │  │
│  │       │ reverse-proxy:                                     │  │
│  │       │   mcp-approval2.firma.de   → mcp-approval2:8787    │  │
│  │       │   knowledge.firma.de       → mcp-knowledge2:8788   │  │
│  │       │   app.firma.de             → mcp-approval2:8787/app│  │
│  │       │                                                    │  │
│  │  ┌────▼───────┐  ┌──────────────┐  ┌──────────────────┐    │  │
│  │  │mcp-        │  │mcp-knowledge2│  │ OpenBao          │    │  │
│  │  │approval2   │←─JWT────────────│  │ (KEK + Transit)  │    │  │
│  │  │ :8787      │  │ :8788        │  │ :8200            │    │  │
│  │  └──────┬─────┘  └─────┬────────┘  └──────────────────┘    │  │
│  │         │              │                                   │  │
│  │         └──────┬───────┘                                   │  │
│  │                │ Postgres-Connection                       │  │
│  │         ┌──────▼──────────┐                                │  │
│  │         │ postgres        │                                │  │
│  │         │ pgvector pg16   │                                │  │
│  │         │ DBs: approval2, │                                │  │
│  │         │      knowledge2 │                                │  │
│  │         │ :5432           │                                │  │
│  │         └──────┬──────────┘                                │  │
│  │                │                                           │  │
│  │         ┌──────▼──────────┐                                │  │
│  │         │ Docker-Volumes  │                                │  │
│  │         │   pgdata        │                                │  │
│  │         │   vault-data    │                                │  │
│  │         │   blob-storage  │                                │  │
│  │         └─────────────────┘                                │  │
│  │                                                            │  │
│  │  ┌─────────────────────────────────────────────────────┐   │  │
│  │  │ Backups: nightly via systemd-timer → snapshot       │   │  │
│  │  │ Hetzner Snapshot (0.012 €/GB/Monat)                 │   │  │
│  │  └─────────────────────────────────────────────────────┘   │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘

       ↕ HTTPS cross-cloud Calls ↕

┌──────────────────────────────────────────────────────────────┐
│ Cloudflare Workers (Sub-MCPs bleiben da)                     │
│   cf.ai-toolhub.org     — Cloudflare-MCP (DCR-OAuth)         │
│   github-mcp...         — GitHub-MCP (Anthropic-hosted)      │
│   gws.ai-toolhub.org    — mcp-gws (eigener Worker)           │
│   utils.ai-toolhub.org  — mcp-utils (eigener Worker)         │
│   gcloud.ai-toolhub.org — mcp-gcloud (eigener Worker)        │
│                                                              │
│ Sub-MCPs callen mcp-approval2 fuer JIT-Credentials:          │
│   POST https://mcp-approval2.firma.de/internal/v1/...        │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Decisions (final)

| Decision | Wahl | Begruendung |
|---|---|---|
| Plattform | **Hetzner CX21** (privat) + **GCP Cloud Run** (business, parallel) | EU-Frankfurt, DSGVO, Daten-Hoheit. Identische Codebase, separate Terraform-Workspaces. |
| Container-Orchestrierung | **docker-compose** (Hetzner) + **Cloud Run** (GCP) | Single-VM-Pilot privat, Auto-Scale business |
| Postgres-Hosting | Hetzner: im docker-compose. GCP: Cloud SQL Postgres mit pgvector | Phase 1 pragmatisch, beide identisches Connection-String-Interface |
| pgvector | ✅ via `pgvector/pgvector:pg16` Image bzw. `CREATE EXTENSION vector` in Cloud SQL | Built-in |
| OpenBao | Hetzner: im docker-compose (file-backend). GCP: optional GCP KMS direkt. | KEK-Abstraktion via Adapter-Layer |
| Reverse-Proxy + SSL | Hetzner: **Caddy** mit Lets-Encrypt. GCP: integrated Cloud Run HTTPS | Auto-SSL beider Seiten |
| **Provisioning** | **Terraform** mit Modul-Pattern: `terraform/modules/{hetzner,gcp,cloudflare}/` | Reproducible, cloud-agnostisch wo moeglich |
| **Domain-Management** | **Cloudflare-Terraform** (existing in `mcp-approval/terraform/` als Vorbild) — DNS-Records zeigen auf Hetzner-VMs oder Cloud-Run-Domains | Single-Source-of-Truth |
| **Multi-Instance** | **Terraform Workspaces**: `privat` (Hetzner) + `business` (GCP), beides parallel | User kann Privat + Firma gleichzeitig pflegen |
| Domain-Schema | `mcp2.ai-toolhub.org`, `knowledge2.ai-toolhub.org`, `app2.ai-toolhub.org` (privat); business-Subdomain konfigurierbar | Bestehende Zone wiederverwenden, alte mcp.ai-toolhub.org bleibt fuer Migration |
| Sub-MCPs | Bleiben auf Cloudflare Workers | Cross-Cloud-Call OK. Migration auf X-User-JWT = separater Task |
| Backups | Hetzner: Snapshots (taeglich) + DB-Dump zu Storage Box. GCP: Cloud SQL automated backups | Automated, pro Plattform native |
| Monitoring | Phase 1: Docker/Cloud Logs. Phase 2: Grafana Cloud free-tier oder GCP Monitoring | |

---

## 2.1 Multi-Instance-Pattern (privat + business parallel)

User-Anforderung: **beide Plattformen parallel** verwenden. Privat-Pilot
auf Hetzner, Firma-Pilot auf GCP, **identische Codebase**, **getrennte
Daten**, **eigene Domains**.

```
┌─────────────────────────────────────────────────────────────────┐
│  Single Codebase: mcp-approval2 + mcp-knowledge2                │
│  (12-Factor-Container, Plattform-agnostisch)                    │
└─────────────────────────────┬───────────────────────────────────┘
                              │
              ┌───────────────┴────────────────┐
              │  Terraform Workspaces          │
              └───────────────┬────────────────┘
              ┌───────────────┴────────────────┐
              ▼                                ▼
┌──────────────────────────────┐  ┌──────────────────────────────┐
│ Workspace: PRIVAT             │  │ Workspace: BUSINESS           │
│                               │  │                               │
│ Cloud:    Hetzner Cloud       │  │ Cloud:    GCP                 │
│ Region:   eu-frankfurt        │  │ Region:   europe-west4         │
│ Compute:  CX21 (single VM)    │  │ Compute:  Cloud Run            │
│ DB:       Postgres on-VM      │  │ DB:       Cloud SQL Postgres   │
│ KMS:      OpenBao on-VM       │  │ KMS:      GCP KMS              │
│ Blob:     MinIO on-VM         │  │ Blob:     GCS                  │
│                               │  │                               │
│ Domains:                      │  │ Domains:                      │
│ - mcp.ai-toolhub.org          │  │ - mcp.<business-domain>       │
│   (oder mcp2.* zur Sicherheit)│  │ - knowledge.<business-domain> │
│ - knowledge.ai-toolhub.org    │  │ - app.<business-domain>       │
│ - app.ai-toolhub.org          │  │                               │
│                               │  │                               │
│ Operator: du privat           │  │ Operator: du als Firma-IT     │
│ Cost:     ~7 €/Monat          │  │ Cost:     ~30-50 €/Monat       │
└───────────────┬───────────────┘  └────────────────┬──────────────┘
                │                                   │
                └───────────────┬───────────────────┘
                                ▼
              ┌─────────────────────────────────────┐
              │ Shared: Cloudflare DNS              │
              │ (Zone ai-toolhub.org bereits        │
              │  terraform-managed, siehe           │
              │  mcp-approval/terraform/)           │
              │                                     │
              │ Sub-MCPs bleiben CF-Workers fuer    │
              │ beide Instances:                    │
              │  - cf.ai-toolhub.org                │
              │  - gws.ai-toolhub.org               │
              │  - utils.ai-toolhub.org             │
              │  - gcloud.ai-toolhub.org            │
              └─────────────────────────────────────┘
```

**Wichtig: Beide Instances haben getrennte Daten.** User-Datenbanken,
Credentials, Audit-Logs sind komplett unabhaengig. Es gibt KEINE
Cross-Instance-Calls.

Was geteilt ist:
- **Cloudflare-Zone** `ai-toolhub.org` (DNS-Records pro Instance)
- **Container-Image** (`ghcr.io/axel-rogg/mcp-approval2:vN.M`)
- **Sub-MCPs** auf Cloudflare (beide Instances callen dieselben Sub-MCPs,
  aber mit unterschiedlichen User-Identities — Sub-MCPs scopen per
  `JWT.iss`-Discriminator: `mcp-approval2-privat` vs `mcp-approval2-business`)

> ⚠️ **Open Decision 2.1:** Soll Sub-MCPs **separate Worker-Instances** pro
> Instance bekommen (mcp-gws-privat.ai-toolhub.org vs mcp-gws-business.*)?
> ODER **eine Sub-MCP-Instance** mit `iss`-basiertem Scope-Switching?
>
> **Empfehlung:** Phase 1 eine Sub-MCP-Instance + `iss`-Scope.
> Phase 2 falls Conflict-Issues: getrennte Worker-Instances.

## 2.2 Terraform-Strategie

### Existing State

`mcp-approval` hat bereits ein **47-Resources-Terraform-Setup**:
[terraform/](https://github.com/axel-rogg/mcp-approval/tree/main/terraform).
Managed wird die `ai-toolhub.org`-Zone in Cloudflare. R2-Backend fuer
State, `terraform plan` = no-changes verified am 2026-05-13.

Das wird **wiederverwendet + erweitert**, nicht neu gebaut.

### Neue Terraform-Module fuer mcp-approval2

```
mcp-approval2/terraform/
├── README.md                                 — Multi-Instance + Workspace-Doku
├── versions.tf                                — Provider-Versions (hcloud, cloudflare, google)
├── variables.tf                               — Shared-Variables
├── backend.tf                                 — R2-Backend (gleicher wie mcp-approval)
│
├── modules/                                   — Reusable Module
│   │
│   ├── hetzner-mcp-instance/                  — Hetzner-Stack
│   │   ├── main.tf                            — hcloud_server + Network + Firewall + Snapshot-Policy
│   │   ├── cloud-init.tf                      — VM-Bootstrap-Skript-Template
│   │   ├── variables.tf
│   │   └── outputs.tf                         — VM-IP, SSH-key, etc.
│   │
│   ├── gcp-mcp-instance/                      — GCP Cloud Run + Cloud SQL
│   │   ├── main.tf                            — google_cloud_run_v2_service + cloud_sql + KMS
│   │   ├── iam.tf                             — Service-Account + IAM-Bindings
│   │   ├── variables.tf
│   │   └── outputs.tf                         — Cloud-Run-URL, SQL-Connection-Name
│   │
│   ├── cloudflare-dns/                        — DNS-Records (cloud-agnostisch)
│   │   ├── main.tf                            — cloudflare_dns_record (A/AAAA fuer Hetzner, CNAME fuer Cloud Run)
│   │   └── variables.tf
│   │
│   └── shared-config/                         — Shared Env-Schema
│       └── env-template.tf                    — locals fuer pro-Instance env-vars
│
└── environments/                              — Workspaces / Instance-Configs
    ├── privat/                                — privat-Hetzner-Instance
    │   ├── main.tf                            — uses hetzner-mcp-instance + cloudflare-dns
    │   ├── variables.tf
    │   └── terraform.tfvars                   — instance-specific values (NICHT committed)
    │
    └── business/                              — business-GCP-Instance
        ├── main.tf                            — uses gcp-mcp-instance + cloudflare-dns
        ├── variables.tf
        └── terraform.tfvars                   — business-specific values (NICHT committed)
```

### Provider-Auswahl

```hcl
# versions.tf
terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.48"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"          # gleiches wie mcp-approval
    }
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"          # nur fuer business-Workspace
    }
  }
}
```

### Hetzner-Module (Skizze)

```hcl
# modules/hetzner-mcp-instance/main.tf

resource "hcloud_ssh_key" "operator" {
  name       = "${var.instance_name}-operator"
  public_key = var.operator_ssh_public_key
}

resource "hcloud_server" "mcp" {
  name        = "${var.instance_name}-mcp"
  server_type = "cx21"
  location    = "fsn1"           # Frankfurt
  image       = "ubuntu-24.04"
  ssh_keys    = [hcloud_ssh_key.operator.id]
  user_data   = templatefile("${path.module}/cloud-init.yaml.tpl", {
    docker_compose_url     = var.docker_compose_url
    initial_secrets_url    = var.initial_secrets_url
    domain_main            = var.domain_main
    domain_knowledge       = var.domain_knowledge
    domain_app             = var.domain_app
  })
  
  labels = {
    instance    = var.instance_name
    environment = var.environment
  }
}

resource "hcloud_firewall" "mcp" {
  name = "${var.instance_name}-mcp-firewall"
  
  rule {
    direction = "in"
    protocol  = "tcp"
    port      = "22"
    source_ips = var.allowed_ssh_ips   # nur Operator-IPs
  }
  
  rule {
    direction = "in"
    protocol  = "tcp"
    port      = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
  
  rule {
    direction = "in"
    protocol  = "tcp"
    port      = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

resource "hcloud_firewall_attachment" "mcp" {
  firewall_id = hcloud_firewall.mcp.id
  server_ids  = [hcloud_server.mcp.id]
}

# Optional: Volume fuer Persistent-Storage (statt VM-Disk only)
resource "hcloud_volume" "data" {
  name      = "${var.instance_name}-data"
  size      = 20    # GB
  location  = "fsn1"
  format    = "ext4"
}

resource "hcloud_volume_attachment" "data" {
  volume_id = hcloud_volume.data.id
  server_id = hcloud_server.mcp.id
  automount = true
}

# Optional: Daily-Snapshot-Policy (via Hetzner Auto-Snapshot)
# Note: Auto-Snapshots sind aktuell nicht Terraform-managed —
# manuell ueber Cloud Console aktivieren, oder hcloud-CLI-Skript
```

### Cloudflare-DNS-Modul (Skizze)

```hcl
# modules/cloudflare-dns/main.tf

resource "cloudflare_dns_record" "mcp" {
  zone_id = var.zone_id
  name    = var.domain_mcp
  type    = "A"
  content = var.mcp_ipv4
  proxied = var.proxied            # true = via Cloudflare-Proxy, false = direct
  ttl     = 1                       # auto when proxied
}

resource "cloudflare_dns_record" "knowledge" {
  zone_id = var.zone_id
  name    = var.domain_knowledge
  type    = "A"
  content = var.knowledge_ipv4
  proxied = var.proxied
  ttl     = 1
}

resource "cloudflare_dns_record" "app" {
  zone_id = var.zone_id
  name    = var.domain_app
  type    = "A"
  content = var.app_ipv4
  proxied = var.proxied
  ttl     = 1
}

# AAAA-Records optional fuer IPv6 (Hetzner gibt IPv6 inkludiert)
# CNAME-Records fuer Cloud-Run-Variante stattdessen
```

### Workspace-Pattern

```bash
# Bootstrap privat-instance
cd terraform/environments/privat
terraform init
terraform plan
terraform apply

# Bootstrap business-instance
cd terraform/environments/business
terraform init
terraform plan
terraform apply

# Beide laufen unabhaengig, eigene State-Files (im R2-Backend)
```

State-Files:
- Privat: `s3://mcp-tf-state/mcp-approval2/privat/terraform.tfstate`
- Business: `s3://mcp-tf-state/mcp-approval2/business/terraform.tfstate`

### Was Terraform NICHT managed (out-of-band)

- Cloud-init-Script (Bootstrap-Inhalt — wird vom Terraform geliefert, aber execution ist VM-internal)
- Docker-Compose-Updates (laufen via `bash deploy/hetzner/update.sh` auf VM)
- Application-Secrets (wandern via `wrangler secret put`-Equivalent: Hetzner = via ENV in `.env` auf VM, GCP = via Secret Manager)
- Vault-Token (One-Shot bei OpenBao-Init, Backup-Pflicht)
- WebAuthn-Credentials (per-User, in DB)
- DB-Snapshots (Hetzner Auto-Snapshot, Cloud SQL Auto-Backup)

### Cloudflare-Integration mit `mcp-approval`-Terraform

Strategie: **erst pruefen, dann erweitern**.

Existing `mcp-approval/terraform/`:
- managed `mcp.ai-toolhub.org` (Worker), `app.ai-toolhub.org` (Worker), etc.
- bei Cutover muss alter Worker-DNS entfernt + neuer A-Record auf Hetzner-IP gesetzt werden

**Cutover-Strategie (sicher):**

1. Phase A: Hetzner-Instance auf `mcp2.ai-toolhub.org` + `knowledge2.ai-toolhub.org` + `app2.ai-toolhub.org` (separate Subdomain-Namen, KEIN Konflikt)
2. Phase B: Pilot-Smoke + User-Migration verifizieren
3. Phase C: Cutover: alte Worker-Routes entfernen, A-Records auf `mcp.ai-toolhub.org` etc. umstellen via `mcp-approval/terraform/` Patch
4. Phase D: alte Worker stilllegen oder als Failover behalten

Initial-Plan: nur `mcp2/knowledge2/app2` — Phase-A-Subdomains. Sicherer und kollidiert nicht.



### 3.1 Deploy-Verzeichnis

```
deploy/hetzner/
├── README.md                       — Step-by-Step Setup-Guide
├── docker-compose.yml              — Stack-Definition
├── docker-compose.override.yml.example — local-dev overrides
├── .env.example                    — Vollstaendiger Env-Vars-Katalog
├── Caddyfile.tpl                   — Reverse-Proxy + SSL (mit ${DOMAIN}-Substitution)
├── cloud-init.yaml.tpl             — VM-Bootstrap-Template (von Terraform befuellt)
├── setup.sh                        — Initial-Setup (vault-init, db-migrate, seed)
├── update.sh                       — git pull + docker-compose up -d
├── backup.sh                       — DB-Dump + Vault-Snapshot zu Storage Box
├── restore.sh                      — Restore von Backup
├── postgres-init.sql               — Initial-DB-Setup (CREATE EXTENSION vector, etc.)
└── healthcheck.sh                  — Status aller Services

deploy/gcp/                         — Parallel-deployment-Pfad fuer business
├── README.md
├── Dockerfile.cloudrun             — Cloud-Run-optimiert (PORT-env, eager-start)
├── cloudbuild.yaml                 — GCP Cloud Build pipeline
├── service.yaml                    — Cloud Run service (terraform-managed alternative)
├── migrate-job.yaml                — Cloud Run Jobs fuer DB-Migration
└── cloud-scheduler.yaml            — Cron-Tasks via Cloud Scheduler
```

### 3.2 Docker-Setup

```
Dockerfile.hetzner                  — fokussierte Variante (kein OpenBao-Sidecar wie bei Fly)
                                      Falls existierender Dockerfile.server portable genug:
                                      bestehende Variante uebernehmen
```

### 3.3 Doku

```
docs/runbooks/runbook-hetzner-deploy.md           — Operations
docs/runbooks/runbook-hetzner-rotate-vault.md     — Vault-Token-Rotation
docs/runbooks/runbook-hetzner-backup-restore.md   — Backup-Verfahren
docs/runbooks/runbook-hetzner-disaster-recovery.md — Komplett-Wiederherstellung
docs/runbooks/runbook-hetzner-to-gcp-migration.md  — spaeterer Migration-Pfad
```

### 3.4 Optional (Phase 2)

```
deploy/hetzner/monitoring/
├── grafana-cloud-config.yml
├── prometheus-scrape.yml           — wenn /metrics in Phase 2 hinzukommt
└── alerts.yml
```

---

## 4. Docker-Compose-Skeleton (vorgesehene Struktur)

```yaml
# deploy/hetzner/docker-compose.yml (Inhalt-Plan, nicht final)

version: '3.9'

services:
  # ─── Reverse-Proxy ─────────────────────────────────────
  caddy:
    image: caddy:2-alpine
    ports: ['80:80', '443:443']
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on: [mcp-approval2, mcp-knowledge2]
    restart: unless-stopped

  # ─── Postgres mit pgvector ─────────────────────────────
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_MULTIPLE_DATABASES: approval2,knowledge2
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./postgres-init.sql:/docker-entrypoint-initdb.d/01-init.sql:ro
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U app']
      interval: 10s
    restart: unless-stopped

  # ─── OpenBao (KEK + Transit-Engine) ────────────────────
  openbao:
    image: quay.io/openbao/openbao:latest
    environment:
      BAO_LOCAL_CONFIG: |
        storage "file" { path = "/vault/data" }
        listener "tcp" { address = "0.0.0.0:8200"  tls_disable = 1 }
        ui = true
    volumes:
      - vault-data:/vault/data
    command: server
    restart: unless-stopped

  # ─── mcp-approval2 (Haupt-Service) ─────────────────────
  mcp-approval2:
    image: ghcr.io/axel-rogg/mcp-approval2:${TAG:-latest}
    environment:
      DATABASE_URL: postgres://app:${POSTGRES_PASSWORD}@postgres:5432/approval2
      VAULT_ADDR: http://openbao:8200
      VAULT_TOKEN: ${VAULT_TOKEN}
      BASE_URL: https://${APPROVAL_DOMAIN}
      WEBAUTHN_RP_ID: ${APPROVAL_DOMAIN}
      JWT_RS256_PRIVATE_KEY_PEM: ${JWT_RS256_PRIVATE_KEY_PEM}
      JWT_RS256_PUBLIC_KEY_PEM: ${JWT_RS256_PUBLIC_KEY_PEM}
      JWT_KID: ${JWT_KID}
      MCP_APPROVAL_INTERNAL_TOKEN: ${MCP_APPROVAL_INTERNAL_TOKEN}
      KNOWLEDGE_URL: http://mcp-knowledge2:8788  # intra-network
      # Sub-MCPs auf CF (cross-cloud HTTPS):
      GATEWAY_CF_URL: https://cf.ai-toolhub.org
      GATEWAY_GITHUB_URL: https://github-mcp.your-vendor
      GATEWAY_GWS_URL: https://gws.ai-toolhub.org
      GATEWAY_UTILS_URL: https://utils.ai-toolhub.org
      GATEWAY_GCLOUD_URL: https://gcloud.ai-toolhub.org
      # AI
      VERTEX_AI_PROJECT_ID: ${VERTEX_AI_PROJECT_ID}
      VERTEX_AI_REGION: europe-west4
      GOOGLE_APPLICATION_CREDENTIALS: /secrets/vertex-sa.json
      # OAuth
      GOOGLE_OAUTH_CLIENT_ID: ${GOOGLE_OAUTH_CLIENT_ID}
      GOOGLE_OAUTH_CLIENT_SECRET: ${GOOGLE_OAUTH_CLIENT_SECRET}
    volumes:
      - ./secrets/vertex-sa.json:/secrets/vertex-sa.json:ro
    depends_on:
      postgres: { condition: service_healthy }
      openbao:  { condition: service_started }
    restart: unless-stopped

  # ─── mcp-knowledge2 (Storage-Service) ──────────────────
  # Wird von Schwester-Plan vom paralllelen Agent gepflegt.
  # Bindings:
  #   - postgres:5432 (DB: knowledge2)
  #   - mcp-approval2:8787 fuer JWKS + DEK-Resolve
  mcp-knowledge2:
    image: ghcr.io/axel-rogg/mcp-knowledge2:${TAG:-latest}
    environment:
      DATABASE_URL: postgres://app:${POSTGRES_PASSWORD}@postgres:5432/knowledge2
      JWKS_URL: http://mcp-approval2:8787/.well-known/jwks.json
      JWT_ISSUER: mcp-approval2
      JWT_AUDIENCE: mcp-knowledge2
      MCP_APPROVAL_BASE_URL: http://mcp-approval2:8787
      MCP_APPROVAL_INTERNAL_TOKEN: ${MCP_APPROVAL_INTERNAL_TOKEN}
      VERTEX_REGION: europe-west4
      VERTEX_SERVICE_ACCOUNT_JSON: ${VERTEX_SERVICE_ACCOUNT_JSON_B64}
      MASTER_KEY: ${KNOWLEDGE_MASTER_KEY_BASE64}
    depends_on:
      postgres: { condition: service_healthy }
      mcp-approval2: { condition: service_started }
    restart: unless-stopped

volumes:
  pgdata:
  vault-data:
  caddy-data:
  caddy-config:
```

---

## 5. Caddyfile-Plan

```caddyfile
# Caddy v2 — Auto-SSL via Lets-Encrypt

{
  email admin@firma.de
}

mcp-approval2.firma.de {
  reverse_proxy mcp-approval2:8787
}

knowledge.firma.de {
  reverse_proxy mcp-knowledge2:8788
}

app.firma.de {
  # PWA — gleicher Backend, /app/-Pfad
  reverse_proxy mcp-approval2:8787
  rewrite * /app{uri}
}
```

---

## 6. Setup-Schritte (Operator-Workflow)

### Phase 1: Hetzner-VM mieten + DNS

```
1. Hetzner Cloud Console → Server → Add
   - Image: Ubuntu 24.04
   - Type: CX21
   - Location: Frankfurt
   - Network: IPv4 + IPv6
   - Volume: 0 (StorageBox spaeter optional)
   - Cloud-config: aus deploy/hetzner/cloud-init.yaml
   
2. DNS-Provider:
   - mcp-approval2.firma.de  A → <VM-IPv4>
   - knowledge.firma.de       A → <VM-IPv4>
   - app.firma.de             A → <VM-IPv4>
   - (AAAA-Records optional fuer IPv6)
```

### Phase 2: VM-Bootstrap (~5 min automatisch)

`cloud-init.yaml` macht:
- apt update + install docker + git
- 2GB swap-file
- ufw allow 80,443,22
- fail2ban
- automatic security updates
- git clone /workspaces/mcp-approval2

### Phase 3: Initial-Setup (manuell, ~15 min)

```bash
# SSH zur VM
ssh root@<VM-IP>
cd /opt/mcp-approval2

# Secrets generieren
bash deploy/hetzner/generate-secrets.sh > /opt/mcp-approval2/.env

# DNS-Propagation pruefen
dig +short mcp-approval2.firma.de

# Stack starten
docker compose -f deploy/hetzner/docker-compose.yml up -d

# OpenBao initialisieren (one-shot)
bash deploy/hetzner/vault-init.sh
# → speichert unseal-keys + root-token in /opt/mcp-approval2/.vault-init-output
# → SOFORT OFFLINE-BACKUP MACHEN!

# DB migrieren
docker compose exec mcp-approval2 node scripts/migrate.js
docker compose exec mcp-knowledge2 node scripts/migrate.js

# Pilot-Smoke
bash deploy/hetzner/healthcheck.sh
```

### Phase 4: First-User-Onboarding

```
1. Browser: https://app.firma.de
2. Google-OAuth-Login
3. First-Login-First-Admin Bootstrap (User wird Admin)
4. Passkey enrollen
5. Invite weitere User: POST /v1/admin/invites
```

---

## 7. Operations-Runbooks (siehe `docs/runbooks/`)

### Updates

```bash
ssh root@<VM-IP>
cd /opt/mcp-approval2
git pull
docker compose -f deploy/hetzner/docker-compose.yml pull
docker compose -f deploy/hetzner/docker-compose.yml up -d
docker compose exec mcp-approval2 node scripts/migrate.js
```

### Backup

- Hetzner-Snapshot: `automated daily snapshots` aktivieren (0.012€/GB/Monat)
- DB-Dump: `bash deploy/hetzner/backup.sh` → Hetzner Storage Box
- Vault: Daten sind im pgdata-Volume mit drin, Snapshot reicht
- Frequency: taeglich, 7-Tage-Retention

### Rotation

- Vault-Token: alle 90 Tage
- RS256-JWT-Keys: jaehrlich (mit Overlap)
- INTERNAL-Service-Token: bei Personalwechsel
- Postgres-Passwoerter: jaehrlich

### Disaster Recovery

- VM-Failure: neue VM, cloud-init, Snapshot-Restore, dann `bash setup.sh`
- DB-Corruption: pg_restore aus Backup
- Vault-Loss: aus unseal-keys + offline-backup wiederherstellen
- **Wenn Vault-Loss + Backup-Loss: alle credentials weg, User muessen
  re-OAuth-en (PRF-Pattern macht das akzeptabel)**

---

## 8. Sub-MCP-Strategie (bestaetigt)

**cf, github bleiben auf Cloudflare** — fremd, nicht migrationsbar.

**gws, utils, gcloud bleiben auf Cloudflare** — eigene Worker, akzeptabel
weil Cross-Cloud-Call funktioniert. Aber: Migration auf X-User-JWT-Pattern
ist Pflicht (siehe [docs/migration/sub-mcp-server-migration-guide.md](../../migration/sub-mcp-server-migration-guide.md)).

**Cross-Cloud-Call-Flow:**
```
User → app.firma.de (Hetzner)
     → mcp-approval2 (Hetzner)
     → MCP-Client requests gws:calendar.list
     → mcp-approval2 forwards to https://gws.ai-toolhub.org (CF)
     → gws Worker callt mcp-approval2 fuer JIT-Token:
        POST https://mcp-approval2.firma.de/internal/v1/credentials/resolve
     → Token bekommen, Google-Calendar-API callen
     → Antwort an User
```

**Latency:** pro Tool-Call 60-160ms zusaetzlich (vs. Single-Cloud).
Im Approval-Roundtrip (~3-5 Sekunden mit User-Click) irrelevant.

**Auth-Token-Sicherheit:**
- mcp-approval2 → Sub-MCP via Service-Bearer-Token (statisch, TLS-protected)
- Sub-MCP → mcp-approval2 via Service-Bearer + User-JWT (RS256, 60s TTL)
- JWKS-Cache 5 min in jedem Sub-MCP

---

## 9. Migrations-Pfad zu GCP (Phase 2 spaeter)

Wenn ihr Firma-Production braucht (z.B. nach Pilot-Erfolg):

```
1. GCP-Projekt anlegen:
   - Cloud SQL Postgres (mit pgvector-extension)
   - Cloud Run mcp-approval2-service
   - Cloud Run mcp-knowledge2-service
   - GCP KMS (statt OpenBao)
   - Cloud Scheduler fuer Cron
   - Vertex AI ist bereits funktional

2. Daten-Migration:
   - pg_dump auf Hetzner → upload → pg_restore in Cloud SQL
   - Vault → GCP KMS: keys re-wrap (Skript bauen)

3. Config-Switch (Container bleibt gleich!):
   - DATABASE_URL → Cloud SQL Connection-Pool
   - KMS_BACKEND → gcp-kms statt openbao
   - BLOB_BACKEND → gcs statt local-fs (falls Blob nicht extern)

4. DNS-Switchover:
   - mcp-approval2.firma.de → Cloud Run Domain-Mapping
   - knowledge.firma.de    → Cloud Run Domain-Mapping
   
5. Hetzner-VM behalten als Backup-Failover oder ausschalten
```

**Aufwand:** ~5-7 Tage Engineering (siehe Multi-Cloud-Plan Phase 3).

---

## 10. Implementation-Tasks (fuer Implementations-Burst)

### Task A — Deploy-Files Hetzner (1-2 Tage)
- [ ] `deploy/hetzner/docker-compose.yml` final
- [ ] `deploy/hetzner/Caddyfile.tpl` (template mit ${DOMAIN}-Variablen)
- [ ] `deploy/hetzner/cloud-init.yaml.tpl` (von Terraform substituiert)
- [ ] `deploy/hetzner/.env.example` (vollstaendiger Env-Vars-Katalog)
- [ ] `deploy/hetzner/postgres-init.sql`
- [ ] `deploy/hetzner/generate-secrets.sh`
- [ ] `deploy/hetzner/setup.sh`
- [ ] `deploy/hetzner/update.sh`
- [ ] `deploy/hetzner/backup.sh`
- [ ] `deploy/hetzner/restore.sh`
- [ ] `deploy/hetzner/healthcheck.sh`
- [ ] `deploy/hetzner/vault-init.sh`

### Task B — Deploy-Files GCP (1-2 Tage)
- [ ] `deploy/gcp/Dockerfile.cloudrun` (Cloud-Run-optimiert)
- [ ] `deploy/gcp/cloudbuild.yaml`
- [ ] `deploy/gcp/migrate-job.yaml` (Cloud Run Job fuer DB-migrations)
- [ ] `deploy/gcp/cloud-scheduler.yaml` (Cron-Tasks)
- [ ] `deploy/gcp/README.md`

### Task C — Terraform-Modules (2-3 Tage)
- [ ] `terraform/versions.tf` (hcloud + cloudflare + google Provider)
- [ ] `terraform/backend.tf` (R2-Backend, gleicher wie mcp-approval)
- [ ] `terraform/modules/hetzner-mcp-instance/` (VM + Firewall + Volume + Cloud-init)
- [ ] `terraform/modules/gcp-mcp-instance/` (Cloud Run + Cloud SQL + KMS + IAM)
- [ ] `terraform/modules/cloudflare-dns/` (A/AAAA/CNAME records per Instance)
- [ ] `terraform/environments/privat/` (uses hetzner + cloudflare-dns modules)
- [ ] `terraform/environments/business/` (uses gcp + cloudflare-dns modules)
- [ ] `terraform/README.md` (Workspaces-Pattern + Bootstrap-Doku)

### Task D — Dockerfile-Optimierung (0.5 Tag)
- [ ] Pruefen ob existierender `deploy/fly/Dockerfile.server` portable genug
- [ ] Multi-Stage-Build optimieren (deps → build → runtime)
- [ ] Cloud-Run-Variante mit PORT-Env (von Cloud Run gesetzt)
- [ ] GitHub-Container-Registry-Push-Workflow

### Task E — GCP-Adapter (1.5 Tage)
- [ ] `packages/adapters/src/kek/gcp-kms.ts` (GCP KMS Adapter, statt OpenBao)
- [ ] `packages/adapters/src/blob/gcs.ts` (GCS Adapter, statt S3/MinIO)
- [ ] Config-Schema-Update: `KEK_BACKEND=openbao|gcp-kms`, `BLOB_BACKEND=s3|gcs`
- [ ] Tests + Drizzle-config fuer Cloud-SQL-Connector

### Task F — Runbooks (1 Tag)
- [ ] `docs/runbooks/runbook-hetzner-deploy.md`
- [ ] `docs/runbooks/runbook-gcp-deploy.md`
- [ ] `docs/runbooks/runbook-hetzner-rotate-vault.md`
- [ ] `docs/runbooks/runbook-gcp-rotate-kms.md`
- [ ] `docs/runbooks/runbook-hetzner-to-gcp-migration.md` (Pfad fuer spaeteren Cutover)
- [ ] `docs/runbooks/runbook-multi-instance-operations.md` (privat + business parallel)

### Task G — Schwester-Plan-Sync (0.5 Tag)
- [ ] Mit mcp-knowledge2-Agent abgleichen:
  - DATABASE_URL-Format (Postgres-URL bei Hetzner + Unix-Socket bei Cloud SQL)
  - JWKS_URL korrekt
  - INTERNAL-Service-Token shared
  - Cross-Instance-Konflikte vermeiden (eigene DB-Namen, eigene KEK-Refs)

### Task H — Smoke-Tests (0.5 Tag)
- [ ] `scripts/pilot-smoke-hetzner.sh`
- [ ] `scripts/pilot-smoke-gcp.sh`
- [ ] Test Cross-Cloud-Subagent-Calls (Hub auf Hetzner ruft Sub-MCPs auf CF)

### Task I — GitHub Actions CI (0.5 Tag)
- [ ] Build + Push Docker-Image (multi-arch amd64+arm64) bei tag-push
- [ ] Optional: Terraform-plan auf PR (read-only)

**Gesamt-Aufwand:** ca. **8-10 Tage** Engineering bis beide Plattformen
deploy-bar (Hetzner + GCP parallel).

---

## 11. Kosten-Detail

| Komponente | Kosten/Monat |
|---|---|
| Hetzner CX21 (4 vCPU, 8 GB RAM, 80 GB SSD) | 5.83 € |
| Hetzner Snapshot-Storage (~20 GB taeglich) | ~0.50 € |
| Optional: Hetzner Storage Box (1 TB, Backups) | 4.00 € |
| IPv4 (inkludiert) | 0 € |
| Traffic (20 TB inkl.) | 0 € |
| Domain (firma.de) | ~10 €/Jahr ≈ 0.85 €/Mo |
| **Total Privat-Pilot** | **~7 €/Monat** |

Plus optional:
- Vertex AI Pay-per-Token: ~1-4 €/Monat fuer Hobby-Last
- Total inkl. AI: ~10-12 €/Monat

---

## 12. Open Decisions vor Implementation

- [ ] Domain-Wahl (mcp-approval2.firma.de? eigene Top-Level?)
- [ ] Hetzner Snapshot taeglich vs nur on-demand? (taeglich = 0.50 €/Mo extra)
- [ ] Storage Box fuer Backups oder Hetzner-internal? (Storage Box: 4 €/Mo, Hetzner Snapshots: 0.50 €/Mo)
- [ ] Vault file-backend vs raft-backend? (file = simpler, raft = HA-ready aber nicht bei single-node noetig) — Empfehlung: file
- [ ] Wer ist erster Admin? First-Login-First-Admin reicht (bereits implementiert)
- [ ] Sub-MCP-Migration: parallel zum Hetzner-Setup oder spaeter?
  Empfehlung: erst Hetzner stabilisieren, dann Sub-MCPs migrieren.

---

## 13. Naechste Schritte nach Plan-Approval

1. Implementation-Burst starten (Tasks A-F parallel via Subagenten)
2. Lokal mit docker-compose testen
3. Pilot-Smoke gruen
4. **DANN** echte Hetzner-VM mieten und `bash deploy/hetzner/setup.sh`

**Keine vorzeitige Code-Action.** Plan-Approval first.

---

## 14. Referenzen

- [Multi-Cloud-Review (Burst 9 Output)](./PLAN-architecture-v1.md) — Multi-Cloud-Analyse
- [Schwester-Plan mcp-knowledge2 Hetzner](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/plans/active/PLAN-hetzner-deployment.md)
- [Sub-MCP-Migration-Guide](../../migration/sub-mcp-server-migration-guide.md)
- [docs/STATUS.md](../../STATUS.md) — aktueller Build-Stand
