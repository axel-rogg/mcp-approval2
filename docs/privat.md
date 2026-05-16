# privat.md — Private-Mode-Setup für mcp-approval2

> **Status:** ✅ Aktiv 2026-05-17 (Fly.io-Switch von Hetzner)
> **Owner:** Axel
> **Schwester-Doc:** [`mcp-knowledge2/docs/STRATEGIE-pilot.md`](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/STRATEGIE-pilot.md)
> **Auslöser:** User-Decision 2026-05-17 — Operations-Last bei Hetzner-Self-Host ist für Solo-Operator nicht durchhaltbar (OS-Patches, Reboots, SSH-Hygiene). Fly.io übernimmt diese Schicht. **GCP-Kompatibilität (business-Mode) bleibt Prio** — Adapter-Pattern + Provider-Switch-Matrix unverändert.

Diese Datei dokumentiert die ehrliche Pilot-Linie für mcp-approval2 im **privat-Modus** (Solo-User axelrogg@gmail.com + bis 2-5 Family/Friends), zeigt welche Ressourcen mit dem Schwester-Service mcp-knowledge2 geteilt werden können, und bewahrt die Provider-Switch-Matrix für eine spätere Migration in den **business-Modus** (Google Cloud) ohne Code-Refactor.

## 1. Was „privat" hier bedeutet

- **Single-Tenant**: 1 Familien-Setup = 1 Instance. Solo-User axelrogg + bis 2-5 Family/Friends-Allowlist, DSGVO-light.
- **Cost-Cap-Ziel**: ~10-12 €/Monat für die komplette Approval-Stack (approval2 + knowledge2 + Postgres + Blob + Backups).
- **Operations-Cap**: ~1.5-2.5h/Monat Total-Wartung. Self-Host-Aufwand (OS-Patches, SSH-Hygiene, Reboots) **explizit verlagert** auf Fly.io.
- **Eine ehrliche Decision-Linie**: keine Multi-Cloud-Orchestrierung, keine HA, keine Region-Replicas.
- **Mit Wechsel-Option zu business**: jede Komponente hat ein definiertes GCP-Gegenstück, das per Env-Var oder Manifest-Switch aktiviert wird — kein Code-Refactor.

## 2. Aktuelle Architektur-Linie (Stand 2026-05-17)

| Service | Compute | Datenbank | KMS | Blob | Embeddings |
|---|---|---|---|---|---|
| **mcp-approval2** | **Fly.io App** (`mcp-approval2`, fra, shared-cpu-1x 512MB, auto-stop) — ~0-3 €/mo unter Free-Allowance | Fly Postgres (`mcp-approval2-pg`, shared-cpu-1x + 3GB) — ~3 €/mo | **OpenBao** als separate Fly-App (`mcp-approval2-openbao`, min=1, 1GB Volume) — ~2 €/mo | Cloudflare R2 EU (S3-API) | nicht benötigt heute |
| **mcp-knowledge2** | **Fly.io App** (`mcp-knowledge2`, fra, shared-cpu-1x 512MB, min=1) — ~3 €/mo | Fly Postgres (`mcp-knowledge2-pg`, shared-cpu-1x + 3GB) — ~3 €/mo | **`hkdf_local`** (env-Master) — kein OpenBao | Cloudflare R2 EU (S3-API) | Vertex AI EU `text-embedding-005` |

**Beide Services nutzen denselben Operations-Pfad (`flyctl`).** Stack-Unifizierung war der Haupt-Driver für den Switch von Hetzner-Self-Host (siehe §9.4).

**Warum mcp-approval2 OpenBao behält, mcp-knowledge2 nicht:**
- approval2 ist DEK-Authority für Cross-Service-Encryption — OpenBao Transit ist das audit-akzeptierte Werkzeug + Bridge zu Cloud-KMS (business-Mode)
- knowledge2 ist DEK-Consumer (holt DEKs via approval2's `/internal/v1/dek/*` API) — braucht kein eigenes KMS-Layer
- HKDF-local in knowledge2 reicht weil der Master-Key nur einen Backup-Master-Key-Wrap macht (keine DEK-Distribution)

## 3. Shared Resources (Cost-Saving)

Was zwischen mcp-approval2 und mcp-knowledge2 (beide auf Fly) geteilt wird:

| Resource | Geteilt? | Detail |
|---|---|---|
| **Doppler-Workplace** (`axelrogg`) | ✅ ja | Zwei separate Projects (`mcp-approval2`, `mcp-knowledge2`) im selben Workplace. Ein Personal-Token mit `workplace:admin` deckt beide ab. |
| **Cloudflare Account + Zone `ai-toolhub.org`** | ✅ ja | Subdomains: `mcp2.ai-toolhub.org` + `app2.ai-toolhub.org` (approval2) + `knowledge2.ai-toolhub.org` (knowledge2). Zone-Settings (TLS-strict, HSTS, always-use-https) zone-weit aktiv. Custom-Domains via `fly certs add` + CF CNAME → `*.fly.dev`. |
| **Cloudflare API-Token** | ✅ ja | Ein Token mit DNS-Edit + R2-Bucket-Edit + Workers-AI-Read Scopes. Liegt in beiden Doppler-Configs als `CLOUDFLARE_API_TOKEN`. |
| **Cloudflare R2 Account + Buckets** | ✅ ja (1 Account, 4 Buckets) | `mcp-approval2-blob` + `mcp-approval2-backup` (approval2) + `mcp-knowledge2-blob` + `mcp-knowledge2-backup` (knowledge2). Free-Tier deckt alle ab. |
| **Google Cloud Project** (z.B. `axelrogg-private`) | ✅ ja | Ein Project, zwei separate OAuth-2.0-Clients (jeweils eigener Redirect-URI). Vertex AI Service-Account-JSON für knowledge2-Embeddings. |
| **Cross-Service `SERVICE_TOKEN`** | ✅ ja (gleicher Wert) | OBO-Bridge approval2 → knowledge2. Generiert mit `openssl rand -hex 32`, in beiden Doppler-Configs identisch. |
| **`ALLOWED_EMAILS` (Whitelist)** | ✅ Konvention identisch | `axelrogg@gmail.com,manuelrogg1@gmail.com` in beiden Doppler-Configs. Beide Services prüfen das gleich nach Google-OAuth-Callback. |
| **Fly.io Account + Org** | ✅ ja | Beide Apps im `personal` Org. Fly Anycast + 6PN Private Network out-of-box, `mcp-approval2-openbao.internal:8200` etc. resolved zwischen Apps. |

## 4. Strikt getrennte Resources (Sicherheits-Boundary)

Was bewusst NICHT geteilt wird:

| Resource | Warum getrennt | Risiko bei Sharing |
|---|---|---|
| **`BACKUP_MASTER_KEY`** | Pro Service unique (32 Bytes random) | Cross-Compromise: Leak einer Service-Vault → beide Backup-Reihen lesbar |
| **`MASTER_KEY_BASE64`** / OpenBao-Transit-Keys | Pro Service unique | Cross-Compromise auf Body-Encryption-Layer |
| **Postgres-DBs** (`mcp-approval2-pg` vs `mcp-knowledge2-pg`) | Eine pro Service, eigener Schema-Hash, eigene Migrations | Cross-Schema-Bug + Row-Bleed bei RLS-Fehlern |
| **Doppler-Projects** (`mcp-approval2`, `mcp-knowledge2`) | Strikt getrennt | Wenn jemand approval2-Doppler-Service-Token bekommt, soll er nicht automatisch knowledge2-Secrets sehen |
| **R2-Buckets** (4 separate Buckets) | Pro Service eigene data+backup Pair | Bucket-Cred-Leak begrenzt Scope |
| **Google OAuth Client Secrets** | Pro Service separater Client | Hijack auf einen erlaubt nicht den anderen |
| **`SELF_OAUTH_ISSUER`-Domains** | Verschieden (mcp2 vs knowledge2) | Aud-Claim trennt Token klar — knowledge2 akzeptiert keine approval2-Token und umgekehrt |
| **EdDSA-Signing-Keys** (OAuth-Facade) | Pro Service in-process generiert + at-rest encrypted | Token-Forgery wird auf jeweiligen Service eingegrenzt |
| **OpenBao-Instance** (`mcp-approval2-openbao`) | nur approval2, knowledge2 nutzt hkdf_local | knowledge2-Compromise hat keine OpenBao-Surface |

## 5. Provider-Switch-Matrix: privat (Fly) → business (Google Cloud)

**Das Designziel:** Same code, same env-var-keys, only values swap. Adapter-Factory-Pattern in [`packages/adapters/`](../packages/adapters/) selektiert per `KEK_PROVIDER` / `BLOB_PROVIDER` zur Laufzeit. Hier die kanonische Mapping-Tabelle für mcp-approval2:

| Env-Var / Setting | `privat` (Solo, Fly.io) | `business` (Google Cloud) |
|---|---|---|
| `NODE_ENV` | `production` | `production` |
| Compute-Target | Fly.io App, `shared-cpu-1x` 512MB, auto-stop | Cloud Run gen2 (europe-west4) minScale=1 |
| `DATABASE_URL` | injected by `fly postgres attach` → `postgres://...@mcp-approval2-pg.flycast:5432/mcp_approval2` | `postgres://app:<pw>@/approval?host=/cloudsql/<proj>:<region>:<inst>` |
| Postgres-Hoster | Fly Postgres (Stolon-cluster mit pgvector) | Cloud SQL Postgres 16 mit `cloudsql.enable_pgvector_extension=on` |
| `KEK_PROVIDER` | `openbao` | `cloud_kms` (Cloud-KMS-wrapped master + HKDF-derive) |
| `VAULT_ADDR` / `VAULT_TOKEN` | `http://mcp-approval2-openbao.internal:8200` + Root-Token aus VM-Setup | unset (cloud_kms aktiv) |
| `VAULT_APPROLE_ROLE_ID` / `VAULT_APPROLE_SECRET_ID` | gesetzt **wenn AppRole** (sonst Static-Token) | unset |
| `CLOUD_KMS_KEY_NAME` + `CLOUD_KMS_WRAPPED_MASTER_B64` | unset | gesetzt |
| `BLOB_PROVIDER` | `s3` (Cloudflare R2 EU) | `gcs` (native via Workload-Identity-Federation, no HMAC) ODER weiter `s3` mit GCS-S3-Interop |
| `BLOB_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` | unset (gcs-native) ODER `https://storage.googleapis.com` (s3-interop) |
| `BLOB_BUCKET` | `mcp-approval2-blob` (R2-EU) | GCS-Bucket im selben Project |
| `BACKUP_BUCKET` | `mcp-approval2-backup` (R2-EU, separate API-Token) | GCS-Bucket im selben Project |
| OAuth-IdP | Google OIDC | Google OIDC (gleich) |
| `SELF_OAUTH_ISSUER` | `https://mcp2.ai-toolhub.org` | `https://mcp.company.com` (Business-Domain) |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | privat-OAuth-Client | business-OAuth-Client (Workspace-Restricted via `GOOGLE_HD_ALLOWLIST`) |
| `ALLOWED_EMAILS` | `axelrogg@gmail.com,manuelrogg1@gmail.com` | CSV der Workspace-User |
| `ALLOWED_ORIGINS` | `https://mcp2.ai-toolhub.org,https://app2.ai-toolhub.org` | `https://mcp.company.com,https://app.company.com` |
| Embedding-Provider (falls approval2 ihn nutzt) | nicht aktiv (KC2 macht die Embeddings) | wenn nötig: Vertex AI (Workload Identity) |
| TLS-Frontend | Fly Anycast + Let's Encrypt (`fly certs add`) | Cloud Run managed cert ODER External LB |
| DNS | Cloudflare CNAME `mcp2.ai-toolhub.org` → `mcp-approval2.fly.dev` (proxied=false wegen WebAuthn-Origin) | Cloud DNS oder CF (gleiche Origin-Constraint für Passkey) |
| Observability | pino → stdout → `fly logs` | pino → Cloud Logging (stdout) |
| Backup-Storage | R2 (CF), `s3://mcp-approval2-backup/...` | GCS, `gs://mcp-approval2-backup-business/...` |
| Monitoring | `/metrics` Prometheus-text + Fly metrics scraper | Cloud Monitoring (Managed Prometheus) |

**Kritischer Punkt** für die Kompatibilität: die App-Code-Pfade kennen nur die env-var-Namen, nicht den Provider. KEK-Provider-Selection in [`apps/server/src/index.ts:121-175`](../apps/server/src/index.ts#L121-L175) ist 4-stufig:

1. `VAULT_ADDR` + `VAULT_APPROLE_ROLE_ID` + `VAULT_APPROLE_SECRET_ID` → **OpenBao mit AppRole** (production-Pfad — wäre auch für Fly geeignet)
2. `VAULT_ADDR` + `VAULT_TOKEN` → **OpenBao mit StaticToken** (Solo-Pilot-Pfad, Stand 2026-05-17)
3. `MASTER_KEY_BASE64` → **LocalKekProvider** (dev/Fallback)
4. (none) → no-credentials-mode

Für business-Mode-Migration: Schritt 1+2 weg, neuer Branch für `KEK_PROVIDER=cloud_kms` ergänzen — Adapter ist als `CloudKmsKekProvider` in `packages/adapters/src/kek/` zu implementieren (heute Skeleton, business-Phase). Migration privat → business ist daher: **Doppler-Config-Werte tauschen + redeploy**, nicht „Code anfassen".

## 6. Konkrete Setup-Liste für privat-Mode (Fly)

Was muss in Doppler `mcp-approval2 / privat` aktiv sein, damit der Fly-Deploy läuft:

**Generate via `openssl rand` (in Doppler ablegen):**
- `MASTER_KEY_BASE64` — 32-Byte für app-internal-crypto (Fallback wenn OpenBao temp nicht erreichbar), base64
- `SERVICE_TOKEN` — 32-Byte hex, **gleicher Wert wie in `mcp-knowledge2 / privat`**
- `BACKUP_MASTER_KEY` — 32-Byte base64
- `MCP_APPROVAL_INTERNAL_TOKEN` — 32-Byte hex, für `/internal/v1/dek/*` Auth zwischen knowledge2 und approval2
- `JWT_RS256_PRIVATE_KEY_PEM` + `JWT_RS256_PUBLIC_KEY_PEM` — RSA-2048 für OBO-Token-Signing
- `JWT_KID` — `key-<YYYY-MM-DD>` aus Setup-Tag
- `JWT_SECRET` — 32-Byte hex (HS256-Fallback)

**External (Google Cloud / Cloudflare / OAuth):**
- `GOOGLE_OAUTH_CLIENT_ID` + `_SECRET` — approval2-Client (Redirect: `https://mcp2.ai-toolhub.org/auth/google/callback`)
- `CLOUDFLARE_API_TOKEN` — gleicher Token wie für knowledge2 (DNS+R2 reicht für approval2)

**Provider-Setup (privat-Modus auf Fly):**
- `KEK_PROVIDER=openbao` (impliziert von `VAULT_ADDR` gesetzt; Selection-Logic in [index.ts:121-175](../apps/server/src/index.ts#L121-L175))
- `VAULT_ADDR=http://mcp-approval2-openbao.internal:8200` (Fly internal-DNS)
- `VAULT_TOKEN=<root-token-aus-openbao-init>` — generiert beim `bao operator init` über `fly ssh console -a mcp-approval2-openbao`
- `VAULT_TRANSIT_PATH=transit`
- `BLOB_PROVIDER=s3`
- `BLOB_ENDPOINT=https://<account>.r2.cloudflarestorage.com` (siehe CF-R2-Dashboard für Account-Endpoint)
- `BLOB_REGION=auto`
- `BLOB_ACCESS_KEY` + `BLOB_SECRET_KEY` — aus CF-Dashboard R2 API-Token (data-Bucket Scope: read+write+delete)
- `BLOB_BUCKET=mcp-approval2-blob`
- `BLOB_PATH_STYLE=true`
- `BACKUP_BUCKET=mcp-approval2-backup` (separate API-Token mit nur write+read, kein delete)

**Domain + Whitelist:**
- `BASE_URL=https://mcp2.ai-toolhub.org`
- `WEBAUTHN_RP_ID=mcp2.ai-toolhub.org`
- `WEBAUTHN_ORIGINS=https://mcp2.ai-toolhub.org`
- `SELF_OAUTH_ISSUER=https://mcp2.ai-toolhub.org`
- `ALLOWED_EMAILS=axelrogg@gmail.com,manuelrogg1@gmail.com`
- `ALLOWED_ORIGINS=https://mcp2.ai-toolhub.org,https://app2.ai-toolhub.org`

**Cross-Service mit knowledge2:**
- `MCP_KNOWLEDGE_URL=https://knowledge2.ai-toolhub.org` (oder `https://mcp-knowledge2.fly.dev` bis Custom-Domain aktiv)
- knowledge2-Side: `MCP_APPROVAL_JWKS_URL=https://mcp2.ai-toolhub.org/.well-known/jwks.json` (aktiviert OBO-Pfad)
- knowledge2-Side: `MCP_APPROVAL_BASE_URL=https://mcp2.ai-toolhub.org` (für `/internal/v1/dek/*` Aufrufe)

**Was Fly automatisch managed (NICHT in Doppler):**
- `DATABASE_URL` — injected durch `fly postgres attach`
- TLS-Cert (automatisch via `fly certs add mcp2.ai-toolhub.org`)
- Internal-DNS (`*.internal` resolved out-of-box)

## 7. Cost-Estimate

| Position | privat (Fly.io komplett) | business (Google Cloud) |
|---|---|---|
| approval2 Compute | Fly App, free unter 3-Machine-Allowance bei auto-stop | Cloud Run gen2 minScale=1 ~8 €/mo |
| approval2 Postgres | Fly Postgres `shared-cpu-1x` + 3GB ~3 €/mo | Cloud SQL Postgres 16 db-custom-1-3840 ~50 €/mo |
| approval2 OpenBao | Fly App `shared-cpu-1x` 256MB + 1GB Volume ~2 €/mo | (Cloud KMS, kein OpenBao) ~0.06 €/mo per Key + 0.03 €/10k Ops |
| approval2 Blob | R2 EU, 10GB Free-Tier <1 €/mo | GCS <1 €/mo |
| approval2 Backup | R2 EU, separate Bucket <1 €/mo | GCS <1 €/mo |
| **approval2 subtotal** | **~5-6 €/mo** | **~60 €/mo** |
| **knowledge2 (Fly, getrennt)** | **~5-7 €/mo** | **~60 €/mo (Cloud Run + Cloud SQL)** |
| **Cross-Service Shared** | Doppler free, CF free | Doppler free, CF free |
| **TOTAL** | **~10-13 €/mo** | **~120 €/mo** |
| **3-Jahres-TCO** | **~430 €** | **~4300 €** |
| **Operations-Aufwand/Monat** | **~1.5-2.5h** | **~3-5h** |

Faktor ~9-12× Kostenunterschied + ~30-50% mehr Ops bei business. Treiber für business-Cost: Cloud SQL ist preisintensiv, Cloud Run minScale=1 always-on.

## 8. Migration-Pfad privat → business

Wenn ein Pilot-Customer GCP-Compliance verlangt:

1. **Doppler-Config-Klon**: neuer Config `business` parallel zu `privat`, alle Provider-Werte auf GCP-Variante umgestellt (siehe §5).
2. **GCP-Projekt provisionieren**: WIF-Pool, Service-Accounts, Cloud SQL, GCS-Buckets, Cloud KMS Key, Secret-Manager (per Terraform — siehe [`terraform/environments/business/`](../terraform/environments/business/)).
3. **OAuth-Clients neu**: business-Workspace-restricted Clients in der Google Cloud Console + Doppler-Update.
4. **`KEK_PROVIDER=cloud_kms` aktivieren**: requires `CloudKmsKekProvider`-Implementierung in `packages/adapters/src/kek/`. Skeleton existiert, business-Phase-Build.
5. **Migrations laufen**: gleicher Code-Stand, Migrations werden auf der neuen Cloud-SQL-DB ausgeführt (`npm run db:migrate` via `release_command`).
6. **Data-Migration**: einmaliger Postgres-Dump → Cloud SQL Restore + Bucket-Mirror (R2 → GCS via `rclone` oder Manual-Sync).
7. **Cutover**: DNS umstellen (CF CNAME von `mcp-approval2.fly.dev` zu Cloud-Run-FQDN), OAuth-Redirect-URI in Console updaten, Fly-Apps `fly apps destroy` (oder pausieren via `fly scale count 0`).

**Was sich NICHT ändert**: Code, Migrations, Schema, App-Logik, Tests, Adapter-Factory-Pattern. **Same code-base, only Doppler-values + Terraform-environment-swap.**

## 9. Decisions (2026-05-16/17, durch Subagent-Audits + User-Decision gestützt)

### 9.1 Blob-Provider: **Cloudflare R2 (EU jurisdiction)** für beide Services

Begründung (2026-05-16):
- **Cost-Cap trivial**: 10 GB Storage + unbegrenzter Egress liegen im **Free Tier** — 0 €/Monat statt 5,99 €/Monat Hetzner OS Mindestpreis
- **Zone-Konsistenz** mit `ai-toolhub.org`-Terraform-Setup: `cloudflare_r2_bucket` mit `location='eu'` ist 4-Zeiler im selben Apply
- **Cross-Service**: knowledge2 nutzt parallel R2 — ein Provider, eine Doppler-Secret-Set, eine Backup-Policy
- **Migrations-Pfad zu GCS** (business): identischer S3-Adapter, nur `forcePathStyle=false` + HMAC-Keys-Source — keine Code-Änderung
- **S3-API-Kompatibilität verifiziert**: [`packages/adapters/src/blob/s3.ts`](../packages/adapters/src/blob/s3.ts) ist provider-agnostisch — alle Kandidaten erfüllen das

Verworfen: **Tigris** (5 GB Free, danach $0.02/GB), **Hetzner OS** (5,99 €/Mo Paket-Mindestpreis), **B2** (Stack-Inkonsistenz).

### 9.2 Backup-Bucket: **gleicher CF-Account, gehärteter Pfad** (kein Dual-Account)

Begründung (2026-05-16):
- AES-256-GCM mit unique `BACKUP_MASTER_KEY` pro Service deckt **Provider-Insider-Read** und **Bucket-Credential-Leak** bereits ab
- Solo-Operator hat keine Bandbreite für 2x Token-Rotation + 2x MFA-Recovery-Setup
- Stattdessen: **harden den Backup-Pfad strikt im selben Account**:
  - Dedicated Backup-Bucket (`mcp-approval2-backup`) separat vom Data-Bucket (`mcp-approval2-blob`)
  - Eigener API-Token mit nur `s3:PutObject` + `s3:GetObject` Scope — **kein Delete-Permission** für den Backup-Cron
  - **R2 Object-Lock / Bucket-Versioning** für 30-90 Tage Compliance-Mode aktiviert (verhindert Malicious-Delete + Ransomware-Reset)
  - Token liegt NUR im Backup-Cron-Pfad, nicht in Worker-Runtime
  - **Quartalsweise Cold-Offline-Backup**: ein verschlüsselter pg_dump auf lokale Disk (externe SSD im Schrank) — das ist die echte 3-2-1-Air-Gap-Schicht

### 9.3 KEK-Provider: **OpenBao bleibt — jetzt als separate Fly-App**

Begründung (2026-05-16, angepasst 2026-05-17):
- **Both providers fully implemented**: `LocalKekProvider` + `OpenBaoKekProvider` mit Auth-Helpers (`StaticTokenAuth`, `AppRoleAuth`), alle aus [`packages/adapters/src/index.ts`](../packages/adapters/src/index.ts) re-exportiert. Selection-Logic in [`apps/server/src/index.ts:121-175`](../apps/server/src/index.ts#L121-L175) wählt 4-stufig.
- **Business-Mode-Konsistenz**: Cloud-KMS wäre die echte business-Linie (statt OpenBao); die Bridge dorthin ist konzeptionell näher an OpenBao (Wrapped-Master + Key-Versioning) als an in-process-HKDF
- **Multi-User-Korrektheit** mit `hkdf_local` ist gegeben (HKDF mit Salt=`utf8(kekRef)` + AAD-Binding), aber OpenBao bietet zusätzlich persistente Crypto-Shred (`destroyKey`) + native Key-Versioning
- **OpenBao als Fly-App**: `fly.openbao.toml` + `deploy/fly/Dockerfile.openbao` + `openbao-config.hcl` sind im Repo. Internal-DNS `mcp-approval2-openbao.internal:8200` resolved zwischen Fly-Apps in derselben Region

**Operational-Trade-Off Fly-OpenBao:**
- Nach jedem OpenBao-Machine-Restart muss manueller Unseal-Schritt erfolgen (`fly ssh console -a mcp-approval2-openbao` → `bao operator unseal` × 2 mit gespeicherten Keys)
- Volume-Snapshot via `fly volumes snapshots create -a mcp-approval2-openbao` monatlich (Crypto-Shred-Backup)
- Unseal-Keys **offline gespeichert** (Paper-Wallet / verschlüsselter USB) — diese sind das einzige Recovery-Material falls Volume verloren

### 9.4 Compute-Target: **Fly.io statt Hetzner-VM** (User-Decision 2026-05-17)

**Auslöser:** Solo-Operator-Realismus bei Security-Wartung. Hetzner-VM erfordert ~5-10h/Monat Operations-Last (OS-Patches, Reboots, SSH-Hygiene, Caddy-Updates, fail2ban-Monitoring). Diese Last skaliert nicht bei Privatperson — Patches werden verschoben, Logs nicht geprüft, CVEs akkumulieren.

**Fly.io übernimmt:**
- OS-Patches + Kernel-Updates (Firecracker-VM-Base)
- Container-Runtime-Updates
- SSH-Brute-Force-Schutz (kein Public-SSH zu VMs, nur via WireGuard `fly ssh`)
- Firewall-Default-Deny-all (außer dokumentierte Ports in fly.toml)
- TLS-Cert-Issuance + Rotation (Let's Encrypt automatisch)
- DDoS-Protection (Anycast)
- Postgres-Engine-Patches + daily automatic backups
- Network-Isolation zwischen Apps (6PN private network)

**Was Operator trotzdem macht:**
- App-Code-Updates (`fly deploy`)
- Container-Image-Rebuild bei npm-CVEs
- Fly-Account-MFA + Recovery-Codes offline
- OpenBao-Unseal-Keys offline sichern
- Backup-Restore-Test quartalsweise

**Operations-Reduktion: ~5-10h/Monat → ~1.5-2.5h/Monat.** Über 1 Jahr: ~40-90h Ersparnis.

**Trade-offs akzeptiert:**
- Vendor-Lock-In (Fly-spezifisch: flycast, 6PN, Fly-Postgres-Stolon)
- Outage-Risk während Fly-Incidents (2024 mehrere mehrstündige Total-Unavailable-Windows)
- US-Owner-Jurisdiction (EU-Hosting, aber CLOUD-Act theoretisch relevant für Compliance-strict Customers — für privat-Mode unkritisch)

**Hetzner-Pfad bleibt als Audit-Trail erhalten:** Code in `deploy/hetzner/`, Skripte in `scripts/vm-*`, Runbooks in `docs/runbooks/runbook-hetzner-*` werden als deprecated/archived markiert, nicht gelöscht. Historisches Reset-Material für Disaster-Recovery / Reactivation.

### 9.5 Verworfene Alternativen

- **Coolify auf Hetzner** (self-host PaaS): zwar günstiger als Fly, aber Operator-Verantwortung für die Coolify-Host-VM bleibt — verschiebt das Problem nicht
- **Mini-PC zuhause + Cloudflare-Tunnel**: maximale Daten-Souveränität, aber Strom-Verbrauch + Hardware-Wartung + USV-Setup ist neue Operations-Surface
- **Supabase als Backend**: maximaler Vendor-Lock, kein OpenBao-Equivalent, GCP-Migration wäre Rewrite
- **PocketBase / Notion-API-Backend**: kein Multi-User-Auth-Pfad, kein WebAuthn-PRF-Surface
- **Cloudflare Workers nativ**: ~50-75h Build-Aufwand, dual-runtime-Maintenance, Vector-Dim-Konflikt mit GCP

## 10. Referenzen

- [STATUS.md](./STATUS.md) — Pre-Cutover Snapshot
- [plans/active/PLAN-as3-autonomous.md](./plans/active/PLAN-as3-autonomous.md) — AS-3-Architektur (Code-Complete)
- [plans/active/PLAN-architecture-v1.md](./plans/active/PLAN-architecture-v1.md) — 22 Architektur-Entscheidungen Baseline
- [`deploy/fly/README.md`](../deploy/fly/README.md) — Operative Anleitung Fly-Deploy
- [`deploy/fly/deploy.sh`](../deploy/fly/deploy.sh) — 8-Schritt-Interactive-Deploy
- [`fly.toml`](../fly.toml) + [`fly.openbao.toml`](../fly.openbao.toml) — App-Configs
- [`terraform/environments/privat/`](../terraform/environments/privat/) — Doppler + GitHub + CF-Zone (Fly-Resources via flyctl, nicht Terraform)
- [`terraform/environments/business/`](../terraform/environments/business/) — Skeleton für GCP-Variante
- Schwester-Repo:
  - [`mcp-knowledge2/docs/STRATEGIE-pilot.md`](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/STRATEGIE-pilot.md) — knowledge2 Fly-Pilot-Linie
  - [`mcp-knowledge2/docs/PILOT-READINESS.md`](https://github.com/axel-rogg/mcp-knowledge2/blob/main/docs/PILOT-READINESS.md) — knowledge2 Sign-off-Checkliste

## 11. Deprecated/Archived Hetzner-Material

Folgende Files dokumentieren den historischen Hetzner-Pfad (2026-05-13 bis 2026-05-17). Sie sind nicht mehr Teil der aktuellen Architektur, bleiben aber als Audit-Trail / Notfall-Reset-Material erhalten:

- `deploy/hetzner/` — docker-compose-Stack, Caddy, vault-init, setup.sh, update.sh, backup.sh, render-config.sh, postgres-init.sql, healthcheck.sh, cloud-init.yaml.tpl
- `scripts/vm-destroy-only.sh`, `scripts/vm-destroy-recreate.sh`, `scripts/pilot-smoke-hetzner-local.sh`, `scripts/pilot-smoke-hetzner-remote.sh`, `scripts/hetzner-ssh-into.sh`, `scripts/doppler-vm-sync.sh`
- `docs/runbooks/runbook-hetzner-*.md`, `runbook-vm-*.md`, `runbook-coop-bypass.md`
- `terraform/modules/hetzner-mcp-instance/` (Module)
- `terraform/modules/cloudflare-dns/` (DNS-A-Records für Hetzner-VM-IP — Fly nutzt CNAME via `fly certs add`)
- `terraform/environments/privat/main.tf` — Hetzner-VM-Module-Block entfernt; Doppler+GitHub+CF-Zone-data bleibt
- `.github/workflows/deploy-hetzner.yml`, `.github/workflows/smoke-hetzner.yml` (durch Fly-Pendants ersetzt)
- `docs/plans/active/PLAN-hetzner-deployment.md` — durch dieses Dokument abgelöst

## 12. Wartungs-Notiz

Dieses Dokument ist die **kanonische Single-Source-of-Truth für privat-Mode-Architektur-Entscheidungen** in mcp-approval2. Bei Änderungen an Compute-Target, KEK-Provider oder Cross-Service-Sharing → hier aktualisieren, dann STATUS.md verlinken, dann CLAUDE.md Plan-Index erweitern.

Cross-Konsistenz mit `mcp-knowledge2/docs/STRATEGIE-pilot.md` halten: was hier als „shared" deklariert ist, muss dort spiegelbildlich auftauchen.
