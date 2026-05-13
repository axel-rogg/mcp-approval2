# ADR-0022: Portable Adapter-Layer (Db/Blob/Kek/Ai)

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §2, §13](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

Primary-Runtime ist Postgres-Self-Host, Sekundaer ist CF Workers (D1). AI-Provider ist Vertex AI mit moeglichem Switch spaeter. KEK ist OpenBao mit moeglichem Switch zu Cloud-KMS. Wie wird Portabilitaet im Code abgebildet?

## Considered Options

- Option A: Direkt-Code gegen Postgres/Vertex/OpenBao, CF-Variante als separater Fork
- Option B: Adapter-Layer (DbAdapter / BlobAdapter / KekProvider / AiAdapter), Impl-Switch per Env
- Option C: Vollstaendige Abstraktion ueber JDBC-aehnlichen Generic-Driver

## Decision Outcome

**Chosen option:** Option B (Adapter-Layer), because beide Runtimes (Postgres-Native + D1+Vec) supported werden muessen und AI/KEK/Blob alle Provider-Switch erfordern koennen. Adapter-Pattern erlaubt Test-Doubles und Multi-Runtime ohne Fork. Vollstaendige Generic-Abstraktion (Option C) waere Over-Engineering.

## Consequences

- Gut: Multi-Runtime ohne Code-Fork, Provider-Switch ohne Schema-Aenderung, Test-Doubles trivial. Vertex AI → andere AI ohne Refactor moeglich; OpenBao → Cloud-KMS ohne Refactor; pgvector → Qdrant ohne Refactor.
- Schlecht: Mehr Boilerplate (Interfaces + Impls), Code-Surface groesser. Layer-Disziplin noetig — Domain-Code darf nicht durch-Adapter-leaken.
- Folge-Decisions: [ADR-0001](0001-greenfield-vs-refactor.md), [ADR-0002](0002-deploy-target-postgres-primary.md), [ADR-0010](0010-openbao-kek-provider.md), [ADR-0018](0018-google-vertex-ai-eu-region.md), [ADR-0021](0021-hono-drizzle-pgvector-stack.md)

## Pros and Cons of the Options

### Option A — Direkt-Code
- + Schnellste Implementation
- − CF-Variante als Fork divergiert
- − Provider-Switch wird zu Refactor

### Option B — Adapter-Layer
- + Multi-Runtime und Provider-Switch ohne Refactor
- + Test-Doubles
- − Mehr Boilerplate
- − Layer-Disziplin noetig

### Option C — Generic-Driver
- + Vollstaendig portabel
- − Over-Engineering
- − DB-spezifische Features (RLS, pgvector) nicht abbildbar
