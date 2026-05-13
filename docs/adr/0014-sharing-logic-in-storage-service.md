# ADR-0014: Sharing-Logik im Storage-Service (mcp-knowledge2)

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §0, §4.2, §7](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

Sharing-Grants (User A teilt Doc mit User B) brauchen einen logischen Ort. Sie koennten in mcp-approval2 leben (Permission-Service) oder in mcp-knowledge2 (zusammen mit der Ressource). Wo gehoeren sie hin?

## Considered Options

- Option A: Sharing-Grants in mcp-approval2 (Permission-Service)
- Option B: Sharing-Grants in mcp-knowledge2 (zusammen mit Ressource)
- Option C: Hybrid (Approval-Side weiss von Grants, Storage-Side enforct)

## Decision Outcome

**Chosen option:** Option B (Sharing-Grants in mcp-knowledge2), because RLS-Policies dort gegen `share_grants`-Tabelle implementiert werden koennen (DB-Layer-Defense) und die Ressource selbst dort lebt. mcp-approval2 muesste sonst per Storage-Operation die Grants nachschlagen — doppelte Round-trips.

## Consequences

- Gut: Single-Source-of-Truth fuer Grants, RLS-Policy als Defense-in-Depth, weniger Roundtrips.
- Schlecht: Cross-Service-Sharing-UI muss Daten aus beiden Services holen (User-Namen aus approval2, Grants aus knowledge2). Konsolidierung mit paralleler mcp-knowledge2-Agent-Arbeit noetig.
- Folge-Decisions: [ADR-0013](0013-mcp-knowledge2-separate-storage-service.md), [ADR-0016](0016-shareable-docs-skills-apps.md)

## Pros and Cons of the Options

### Option A — Grants in mcp-approval2
- + Permission-Service zentralisiert
- − Pro Storage-Op zusaetzlicher Lookup
- − Storage-Service kann nicht RLS-self-enforce

### Option B — Grants in mcp-knowledge2
- + RLS-Policy direkt anwendbar
- + Single-Source-of-Truth fuer Resource+Grants
- − Cross-Service-UI muss joinen
- − mcp-knowledge2 erbt User-Konzept

### Option C — Hybrid
- + Flexibilitaet
- − Komplexitaet hoch
- − Sync-Probleme
