# ADR-0023: Shared Codebase, Isolated Environments für Family/Self-Host/Corporate-Modi

**Status:** Accepted
**Date:** 2026-05-17
**Deciders:** Axel + Claude (Family-Hardening-Folgearbeit nach Commit 95e1997)
**Plan-Reference:** [THREAT-MODEL.md §Deployment-Kontext](../../THREAT-MODEL.md#deployment-kontext-drei-realistische-szenarien) · ADR-0004 · ADR-0022

## Context and Problem Statement

Seit Family-Hardening-Sprint (2026-05-17 abend) ist das THREAT-Modell auf **drei distinkte Deployment-Szenarien** umgestellt:
- **Familie im Haushalt** (2-5 Personen, Art. 2(2)c DSGVO greift) — primärer Modus, live
- **Self-Host für Freunde** (jeder Freund deployed eigene Instance, Axel raus aus DSGVO-Kette)
- **Corporate GCP-VPC** (20-500 User, 4-6 Wochen Compliance-Programm — DPIA/AVV/TIA/VVT/DPO)

Daraus resultiert die Skalierungs-Frage: wenn der Stack je in Richtung Corporate-Kunden (auch nur kleines internes Team, 10-20 Leute) bewegt wird — wie wird das Setup vom Family-Live-Betrieb getrennt? Bestehende Codebase erweitern, branchen, oder forken?

## Considered Options

- **Option A: Single-Codebase, Multi-Environment** — `main` für alle Modi, Unterschiede nur per Env-Vars + Feature-Flags + Doppler-Project. Infra konsequent isoliert (eigenes GCP-Project + Doppler-Project + Domain).
- **Option B: Long-Lived Branch pro Mode** — `main` für Family, `business/v1` für Corporate. Cherry-Pick zwischen Branches.
- **Option C: Fork (zweites Repo)** — `mcp-approval2-business` als separates Repo, eigene CI/CD, eigene Infra.
- **Option D: Multi-Tenant-Runtime** — `tenant_id`-First-Class-Column, eine Instance für mehrere Customers (= Revert von ADR-0004).

## Decision Outcome

**Chosen option:** Option A (Single-Codebase, Multi-Environment), weil:

- ADR-0004 (Strict Single-Tenant per Instance) meint **Instance-Isolation**, nicht **Code-Isolation**. Codebase darf — soll — geteilt sein, *Infra* ist strikt getrennt.
- ADR-0022 (Portable Adapter-Layer) ist genau dafür gebaut: `DbAdapter`, `BlobAdapter`, `KekProvider`, `KnowledgeAdapter` sind alle factory-pattern, Provider-Switch per Env-Var ohne Code-Refactor.
- `terraform/environments/business/` existiert bereits im Repo als Skeleton (Cloud-Run + Cloud-SQL + GCP-KMS-HSM-Pfad). Ausbau heißt nicht Refactor.
- Family-Hardening (Phase 1) ist **gleichzeitig** Corporate-Vorarbeit: Per-User-KEK, RS256-Access-Tokens, Audit-Append-Only-Trigger, JWT-Key-Rotation sind beidseits sinnvoll und werden nur einmal gebaut.
- Bug-Fixes + Security-Patches wirken automatisch auf alle Modi.

## Konkrete Strategie-Trennlinie

### Codebase: shared
- `main`-Branch für alle Modi
- Keine Long-Lived-Branches pro Customer
- Feature-Flags + Env-Vars statt `if (mode === 'corporate')`-Block-Statements

### Infra: konsequent getrennt
| Resource | Family | Corporate (pro Customer) |
|---|---|---|
| Cloud-Account | Axel's Privat | GCP-Project pro Customer |
| Compute | Fly.io App | Cloud Run Service |
| DB | Neon Free Tier | Cloud SQL HA + 7d PITR |
| KMS | GCP software-protected CryptoKey | Cloud HSM (FIPS-140-2 L3) |
| Backup | R2 EU | GCS Object-Lock-Bucket |
| Secrets | Doppler-Project `mcp-approval2`/`privat` | Doppler-Project pro Customer oder GCP Secret Manager |
| Domain | `ai-toolhub.org` | Customer-Domain |
| Terraform-Env | `terraform/environments/privat/` | `terraform/environments/business/` (Skeleton existiert) |
| TF-State | R2-Backend privat | separater GCS-Backend pro Customer |

### Konfiguration: Env-Vars + Feature-Flags
- `NODE_ENV`, `KEK_PROVIDER`, `DB_DIALECT`, `BLOB_BACKEND`, `EMAIL_PROVIDER` → Modus-Auswahl
- Feature-Flags pro Customer: `PER_USER_KEK_ENABLED`, `MCP_ACCESS_TOKEN_ALG`, `AUDIT_WORM_SINK`, `SHARING_CONSENT_MODAL`, `STEP_UP_AUTH_DANGER_TOOLS`
- Defaults im Code so wählen, dass Family-Modus = sicher per Default, Corporate-Modus = Pflicht-Flags via Env

### Phasen-Roadmap (Folge-Decisions)
1. **Shared-Hardening (~3-4 Wochen)** — Per-User-KEK + HS256→RS256 + Audit-Trigger + JWT-Rotation. Nützt Family + Corporate gleichzeitig. Wird heute eingeplant unabhängig von Customer-Bedarf.
2. **Business-Env-Ausbau (~3-4 Wochen, pre-Customer)** — `terraform/environments/business/` füllen: Cloud-Run + Cloud-SQL-HA + GCS-WORM + Cloud-HSM + Workload-Identity-Federation + mTLS via VPC SC.
3. **Compliance-Programm (~2-3 Wochen pro Customer)** — DPIA + AVV-Set + TIAs + VVT + DPO-Benennung. **Legal-Layer, nicht Engineering** — pro Customer.

### Spezial: Corporate-Light (B2B-internal, kleines Team)
Für **interne Teams in deiner eigenen Firma** (B2B-internal, nicht externer Customer):
- AVV mit sich selbst entfällt
- DPIA entfällt oft (Art. 35 — kein hohes Risiko bei kleinen internen Tools)
- Joint-Controller-Vereinbarung entfällt (Mitarbeiter sind keine Joint Controller)
- Realistisch in **1-2 Wochen** statt 4-6 Wochen — Phase 1 + Phase 2, ohne Phase 3

## Consequences

### Vorteile
- **Eine Bug-Fix-Quelle** für alle Modi (Family + Self-Host-Defaults + Corporate)
- **Family-Hardening ist Corporate-Vorarbeit** — kein Aufwand-Doppel
- **Adapter-Pattern (ADR-0022) wird voll ausgenutzt** — Provider-Switch ohne Refactor
- **ADR-0004 (Single-Tenant)** bleibt valide und unverändert
- **Infra-Isolation** garantiert Customer-Crypto-Boundary

### Nachteile / Risiken
- **Feature-Flag-Komplexität** wächst — Disziplin nötig damit kein "if (corporate)"-Spaghetti entsteht
- **Family-Modus muss kompatibel bleiben** mit allen Corporate-Hardening-Patches — kann nicht "auf eine niedrigere Stufe zurückfallen" sobald gemeinsamer Code da ist
- **Per-Customer-Onboarding hat Overhead** — neue Instance pro Customer ist ~2-3 Wochen Setup (TF + Domain + Doppler + Email)
- **10+ Customers werden ops-teuer** — pro Customer eigene Migration + Backup-Drill + Security-Patch-Deploy. Dann wird ADR-0004-Revert relevant.

### Was NICHT zu tun ist
- **Kein Fork** (Option C) — Drift-Garantie, doppelte Maintenance
- **Kein Long-Lived-Branch-Modell** (Option B) — klassische Branch-Hölle
- **Kein Multi-Tenant-Runtime-Revert** (Option D) — würde ADR-0004 verwerfen, Schema-Refactor mit 6+ Monaten Aufwand, RLS-Bug-Risiko massiv

### Follow-up
- Folge-Decision: konkrete Liste der Shared-Hardening-Items als eigener Plan (`PLAN-shared-hardening-2026-Q3.md`), wenn Phase 1 startet.
- Folge-Decision: Feature-Flag-Konvention (Env-Var-basiert vs. DB-basiert vs. Config-File) wird beim ersten Corporate-Sprint entschieden.
- Folge-Decision: Trigger für ADR-0004-Revisit (Multi-Tenant) wäre 10+ Corporate-Customers — heute weit entfernt.

## Pros and Cons of the Options

### Option A — Single-Codebase, Multi-Environment ✅
- + Eine Bug-Fix-Quelle
- + Adapter-Pattern (ADR-0022) wird voll ausgenutzt
- + ADR-0004 bleibt valide
- − Feature-Flag-Disziplin nötig
- − Onboarding-Overhead pro Customer (~2-3 Wochen TF + Setup)

### Option B — Long-Lived Branch pro Mode
- + Klare Trennung im Repo
- − Cherry-Pick-Hölle
- − Drift unvermeidlich
- − Security-Patch muss zweimal merged werden

### Option C — Fork (zweites Repo)
- + Maximale Isolation
- − Doppelte Maintenance, massive Drift
- − Kein gemeinsames Hardening mehr
- − Verstößt nicht gegen ADR-0004, aber gegen den Spirit (single codebase, multiple instances)

### Option D — Multi-Tenant-Runtime
- + Operative Effizienz bei 10+ Customers
- − Wäre Revert von ADR-0004
- − Schema-Refactor ~6+ Monate
- − Cross-Tenant-Bug-Risiko sehr hoch (RLS-Leaks bei jedem Schema-Change)
- − Crypto-Material-Trennung wird komplexer

## Cross-References

- [ADR-0004 — Strict Single-Tenant per Instance](0004-strict-single-tenant-per-instance.md): Codebase-Sharing vs. Instance-Isolation — diese ADR präzisiert ADR-0004 auf der Codebase-Achse.
- [ADR-0022 — Portable Adapter Layer](0022-portable-adapter-layer.md): die technische Voraussetzung für Option A.
- [THREAT-MODEL.md §Deployment-Kontext](../../THREAT-MODEL.md#deployment-kontext-drei-realistische-szenarien): die drei Szenarien im Detail.
- [docs/runbooks/runbook-family-hardening.md](../runbooks/runbook-family-hardening.md): Family-Modus-Operator-Sprint.
- [terraform/environments/business/](../../terraform/environments/business/): Skeleton für Corporate-Infra.
