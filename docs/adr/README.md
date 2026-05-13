# Architecture Decision Records

Dieses Verzeichnis enthaelt die Architecture Decision Records (ADRs) fuer mcp-approval2.

## Was ist ein ADR?

Ein ADR (Architectural Decision Record) dokumentiert eine signifikante Architektur-Entscheidung: was war der Kontext, welche Optionen wurden erwogen, welche wurde gewaehlt und mit welcher Begruendung, welche Konsequenzen folgen daraus. ADRs sind unveraenderlich — eine spaetere Aenderung wird durch einen NEUEN ADR mit `Supersedes: ADR-XXXX` dokumentiert, nicht durch Editieren des alten.

Format: [MADR](https://adr.github.io/madr/) (Markdown Architectural Decision Records).

## Wann ist ein neuer ADR faellig?

Wenn eine Entscheidung getroffen wird, die spaeter "warum haben wir das so?"-Fragen ausloesen kann. Konkret:

- Wahl eines Frameworks, einer Library, eines externen Service
- Entscheidung ueber Architektur-Patterns (Service-Boundary, Tenancy-Modell, Auth-Strategie)
- Schema-Design-Entscheidungen mit langer Lebensdauer
- Trade-offs zwischen Optionen mit erheblichen Folgewirkungen

Bei Aenderung einer existierenden Entscheidung: neuen ADR mit `Status: Accepted, Supersedes: ADR-XXXX` anlegen. Den alten ADR auf `Status: Superseded by ADR-YYYY` aendern.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-greenfield-vs-refactor.md) | Greenfield statt Refactor von mcp-approval | Accepted |
| [0002](0002-deploy-target-postgres-primary.md) | Postgres Self-Host als Primary-Deploy-Target | Accepted |
| [0003](0003-eu-only-data-residency.md) | EU-only Datenresidenz | Accepted |
| [0004](0004-strict-single-tenant-per-instance.md) | Strict Single-Tenant per Instance | Accepted |
| [0005](0005-google-oauth-identity-provider.md) | Google-OAuth als Identity-Provider | Accepted |
| [0006](0006-first-login-first-admin.md) | First-Login-First-Admin Bootstrap | Accepted |
| [0007](0007-one-passkey-plus-email-recovery.md) | 1 Passkey + Email-Recovery | Accepted |
| [0008](0008-scim-phase-2.md) | SCIM auf Phase 2 verschoben | Accepted |
| [0009](0009-webauthn-prf-from-day-zero.md) | WebAuthn-PRF von Anfang an aktiv | Accepted |
| [0010](0010-openbao-kek-provider.md) | OpenBao Self-Hosted als KEK-Provider | Accepted |
| [0011](0011-centralized-credential-storage.md) | Zentrale Credential-Storage in mcp-approval2 | Accepted |
| [0012](0012-sub-mcp-auth-per-service.md) | Sub-MCP-Auth pro Service entschieden | Accepted |
| [0013](0013-mcp-knowledge2-separate-storage-service.md) | mcp-knowledge2 als paralleles Storage-Service-Repo | Accepted |
| [0014](0014-sharing-logic-in-storage-service.md) | Sharing-Logik im Storage-Service (mcp-knowledge2) | Accepted |
| [0015](0015-jwt-service-to-service-auth.md) | JWT-Service-to-Service-Auth zwischen mcp-approval2 und mcp-knowledge2 | Accepted |
| [0016](0016-shareable-docs-skills-apps.md) | Docs/Skills/Apps teilbar, Credentials nicht | Accepted |
| [0017](0017-admin-no-user-data-access.md) | Admin hat keinen User-Daten-Zugriff, kein Impersonation | Accepted |
| [0018](0018-google-vertex-ai-eu-region.md) | Google Vertex AI in EU-Region | Accepted |
| [0019](0019-audit-schema-day-zero-sink-later.md) | Audit-Schema ab Tag 1, Sink-Wahl spaeter | Accepted |
| [0020](0020-fulltime-engineering-12-14-weeks.md) | Vollzeit-Engineering, 12-14 Wochen bis Pilot-Start | Accepted |
| [0021](0021-hono-drizzle-pgvector-stack.md) | Hono.js + Drizzle + pgvector als Stack | Accepted |
| [0022](0022-portable-adapter-layer.md) | Portable Adapter-Layer (Db/Blob/Kek/Ai) | Accepted |

## Plan-Reference

Alle ADRs verweisen auf [PLAN-architecture-v1.md](../plans/active/PLAN-architecture-v1.md). Dort steht der konsolidierte Kontext der Decision-Session (2026-05-13, Bundle 1-6).
