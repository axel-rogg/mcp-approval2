# ADR-0011: Google Cloud KMS als KEK-Provider (privat-Mode)

**Status:** Accepted
**Date:** 2026-05-17
**Deciders:** Axel (Decision), Claude (Analyse)
**Supersedes:** [ADR-0010](./0010-openbao-kek-provider.md) für den privat-Mode (OpenBao bleibt als alternative Selfhosting-Variante dokumentiert)
**Plan-Reference:** [docs/privat.md §9.3](../privat.md), [terraform/environments/privat/gcp-kms.tf](../../terraform/environments/privat/gcp-kms.tf)

## Context and Problem Statement

ADR-0010 entschied 2026-05-13 OpenBao als KEK-Provider mit Begründung „lizenzfrei + Self-Host-fit + Per-User-Crypto-Shredding". Bei der praktischen Umsetzung 2026-05-17 (Fly.io-Switch + Multi-User-Pilot mit 2-3 Testern) stellte sich heraus:

1. **OpenBao verlangt Offline-Key-Storage** (3 Unseal-Keys + Root-Token via Paper-Wallet oder verschlüsseltem USB). Der Solo-Operator hat keinen USB und keinen Paper-Wallet-Workflow. Würden die Unseal-Keys in Doppler liegen, hätte ein Doppler-Breach automatisch OpenBao mit-kompromittiert — der Sicherheitsmehrwert wäre weg.
2. **Operations-Burden** ist Permanent: Unseal nach jedem Container-Restart, secret_id-Rotation alle 90d, monatliche Volume-Snapshots. Skaliert nicht bei Solo-Operator mit ~1.5h/Monat Wartungsbudget.
3. **GCP ist ohnehin Stack-Member**: Google OIDC für IdP (AS-3), Vertex AI für Embeddings, business-Mode-TF-Skeleton vorhanden. Cloud-KMS dazuzunehmen erzeugt keine *neue* Abhängigkeit.
4. **Multi-User-Pilot** (2-3 Tester) braucht echtes Crypto-Shredding (DSGVO Art. 17). Cloud-KMS bietet das via `cryptoKeyVersions.destroy` mit `destroy_scheduled_duration`. Für skalierbares Per-User-Crypto-Shredding würde man später per-user Sub-Keys ableiten (HKDF + Sub-Key-Lifecycle).

## Considered Options

- **A — OpenBao auf Fly bleiben** (status quo per ADR-0010): scheitert an Offline-Key-Storage-Anforderung.
- **B — Google Cloud KMS multi-region `eu`** (diese Entscheidung).
- **C — Cloud Run + Cloud SQL ganzheitlich** (business-Mode komplett): zu früh, kostet 5-40 €/mo statt 10-13 €/mo, kein GCP-Compute für privat-Mode gewünscht.
- **D — AWS KMS**: würde GCP-Lock-In gegen AWS-Lock-In tauschen, aber AWS ist nicht im Stack — zusätzliche Account-/Billing-/Auth-Surface ohne Mehrwert.

## Decision Outcome

**Chosen: Option B (Google Cloud KMS multi-region `eu`).**

**Implementation:**
- Region: `eu` (multi-region, routet auto. zur nächsten verfügbaren EU-Region — typisch europe-west3 Frankfurt für Fly `fra`-Origin)
- Protection Level: SOFTWARE (HSM ist 16× teurer; für Pilot mit 3 Testern overkill)
- Project: `axelrogg-ai-tools` (vorhandenes GCP-Projekt)
- KeyRing: `mcp-approval2-privat` (single Ring, beide Services teilen ihn)
- CryptoKey: `user-dek-master`, ENCRYPT_DECRYPT, auto-rotate alle 90d, `prevent_destroy=true`
- Service-Accounts: `mcp-approval2-fly` + `mcp-knowledge2-fly` (separater Audit-Trail in Cloud Logging)
- Beide SAs: `roles/cloudkms.cryptoKeyDecrypter` (nur Decrypt — minimal permission surface)
- Master-Key: 32-byte random in TF-State (`random_bytes`), KMS-gewrappt via `google_kms_secret_ciphertext`, ciphertext in Doppler als `CLOUD_KMS_WRAPPED_MASTER_B64`
- Per-ref KEK: Boot-Time-Unwrap des Master + HKDF-SHA-256(master, salt=utf8(ref), info=...) — identisches Pattern wie [`LocalKekProvider`](../../packages/adapters/src/kek/local.ts), nur master-Source anders
- Code-Adapter: [`CloudKmsKekProvider`](../../packages/adapters/src/kek/cloud_kms.ts) (analog zu KC2-Pendant [`mcp-knowledge2/src/adapters/kms/cloud_kms.ts`](https://github.com/axel-rogg/mcp-knowledge2/blob/main/src/adapters/kms/cloud_kms.ts))

## Consequences

**Gut:**
- Kein Offline-Key-Storage — TF-Apply provisioniert alles in ~3 Min ohne Operator-Ceremony
- Kein Unseal nach Restart — Container fährt selbst hoch
- FIPS 140-2 L1 (Software-Tier) — Master-Plaintext verlässt die Google-HSM-Infrastruktur nie außer dem 32-byte-Decrypt-Result beim Boot
- Multi-Region-Resilience inklusive (zone-failover transparent)
- Audit-Trail in Cloud Logging — jeder Decrypt-Call mit Principal sichtbar
- Per-Service-Account-Isolation: knowledge2-SA-Compromise leakt nicht approval2-Material und umgekehrt
- Künftiger Switch zu business-Mode ist EIN Env-Var-Wechsel + neues KMS-Key (kein Code-Refactor)

**Trade-offs / akzeptiert:**
- **Vendor-Lock-In zu Google Cloud** — aber GCP ist ohnehin Stack-Member (Google OIDC, Vertex AI, business-Mode-Skeleton). Migration weg von GCP wäre projekt-weite Aufgabe, nicht nur KMS-Tausch.
- **Service-Account-Keys (JSON) sind long-lived** — Future-Hardening via Workload-Identity-Federation für Fly OIDC ist möglich, aber im Pilot-Scope nicht eingebaut. Rotation-Cadence: alle 6-12 Monate via `terraform apply -replace=google_service_account_key.*`.
- **TF-State enthält 32-byte Master-Plaintext** — R2-EU-Backend ist at-rest-encryptet, gleicher blast-radius wie die anderen sensitive TF-Resources (`vault_approle_auth_backend_role_secret_id`, `doppler_secret`-Werte mit `lifecycle.ignore_changes`).
- **Crypto-Shredding pro User ist *simuliert*** (in-memory destroyed-Set wie LocalKekProvider) — echtes Per-User-Crypto-Shredding würde per-user KMS-Keys oder per-user Sub-Keys erfordern. Bei 3 Testern via DSGVO-Erase ausreichend, bei skaliertem Multi-Tenant müsste das aufgerüstet werden.

**Schlecht:**
- OpenBao-Material (Adapter-Code in `packages/adapters/src/kek/openbao*.ts`, TF unter `terraform/environments/privat-openbao/`, fly.openbao.toml, deploy/fly/Dockerfile.openbao) ist nicht mehr Default-Pfad — Maintenance-Aufwand (Security-Updates an OpenBao-Bao-Versions) bleibt für die optionale Selfhosting-Variante, ohne dass es aktiv genutzt wird. Im Sinne von Documentation-as-Code: explizit als alternative Variante markiert, kein Toter Code.

## Rollback

Falls Cloud-KMS zurückgenommen werden muss (z.B. GCP-Compliance-Anforderung weg, oder Cost-Explosion):

1. `KMS_PROVIDER` in beiden Doppler-Configs auf `local` (Fallback) oder `openbao` (Switch zur Selfhosting-Variante)
2. Service-Restart zieht neue Provider-Selection
3. Re-Wrap-Migration aller existierenden encrypted Daten ist möglich (per-ref KEK ist deterministisch aus Master ableitbar — neue Master, alle DEKs neu wrappen)

Selfhosting-Pfad ist via [`terraform/environments/privat-openbao/`](../../terraform/environments/privat-openbao/) jederzeit applybar (siehe dortige README für Pre-Conditions).
