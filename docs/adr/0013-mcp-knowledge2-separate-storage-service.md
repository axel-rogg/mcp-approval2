# ADR-0013: mcp-knowledge2 als paralleles Storage-Service-Repo

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §0, §2.1, §7](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

Soll User-Content-Storage (Docs/Skills/Apps/Memos) in mcp-approval2 selbst leben (Monolith) oder in einem separaten Service (mcp-knowledge2)? Bestand hat schon knowledge-core, aber mit anderen Annahmen. Multi-User-Faehigkeit muss Schema-zentral umgesetzt sein.

## Considered Options

- Option A: Storage-Layer in mcp-approval2 selbst (Monolith)
- Option B: Paralleles Greenfield-Repo mcp-knowledge2 mit Service-Boundary
- Option C: Bestehendes knowledge-core uebernehmen + Multi-User retrofit

## Decision Outcome

**Chosen option:** Option B (Paralleles Greenfield-Repo mcp-knowledge2), because Service-Boundary klare Separation gibt (Auth + Approval in mcp-approval2, Storage + Sharing in mcp-knowledge2), Hybrid-Search + pgvector in separater DB sauberer ist und der Bestand knowledge-core single-user-baked ist (nicht trivial retrofittbar).

## Consequences

- Gut: Klare Separation, mcp-knowledge2 kann von anderen Services genutzt werden, eigene Audit + RLS Policies. JWT-Service-to-Service-Auth saubere Boundary.
- Schlecht: 2 Repos zu pflegen, JWKS-Validation-Setup, Network-Hop pro Storage-Op, Konsolidierungs-Hinweis im Plan (paralleler Agent arbeitet daran).
- Folge-Decisions: [ADR-0001](0001-greenfield-vs-refactor.md), [ADR-0014](0014-sharing-logic-in-storage-service.md), [ADR-0015](0015-jwt-service-to-service-auth.md)

## Pros and Cons of the Options

### Option A — Monolith
- + Kein Network-Hop
- + Einfacher Deploy
- − Service-Boundary unklar, Sharing-Logic vermischt mit Auth
- − Reuse durch andere Services schwer

### Option B — mcp-knowledge2 separat
- + Klare Boundary, Reuse moeglich
- + Separate DBs, kein Cross-DB-Zugriff
- − 2 Repos, JWT-Pflege
- − Network-Roundtrip

### Option C — knowledge-core retrofit
- + Bestand reuse
- − Single-User-Annahmen tief im Code
- − Retrofit-Risiko hoch
