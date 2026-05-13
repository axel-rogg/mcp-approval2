# ADR-0020: Vollzeit-Engineering, 12-14 Wochen bis Pilot-Start

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §0, §11](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

Wie viel Engineering-Bandbreite ist verfuegbar und wann soll der Pilot starten? Davon haengen Phasen-Scope, Feature-Cuts und Decision-Tightness ab.

## Considered Options

- Option A: Teilzeit/Part-Time, Pilot in 6+ Monaten
- Option B: Vollzeit ohne Pause, Pilot 12-14 Wochen
- Option C: Vollzeit + Team (mehrere Engineers)

## Decision Outcome

**Chosen option:** Option B (Vollzeit ohne Pause, 12-14 Wochen), because der Pilot-Drive konkret ist und kein zusaetzliches Team verfuegbar. Phasen 0-6 sind so geschnitten, dass jede Woche eine sichtbare Demo gibt.

## Consequences

- Gut: Klarer Zeitplan, fokussiert. 6 Phasen klar definiert (Skeleton, Auth, Credentials/Vault, mcp-knowledge2-Integration, MCP-Protocol+Tools, Sub-MCP, Pilot-Hardening).
- Schlecht: Eng getakteter Zeitplan, keine Pufferzone. Bei Decision-Drift in einer Phase muss eine spaetere geschoben werden.
- Folge-Decisions: [ADR-0001](0001-greenfield-vs-refactor.md), [ADR-0008](0008-scim-phase-2.md), [ADR-0019](0019-audit-schema-day-zero-sink-later.md)

## Pros and Cons of the Options

### Option A — Teilzeit, 6+ Monate
- + Mehr Puffer
- − Pilot-Drive nicht erfuellbar
- − Kontext-Verlust bei langen Pausen

### Option B — Vollzeit 12-14 Wochen
- + Pilot-Start absehbar
- + Fokus, weniger Context-Switching
- − Hohe Eigentakt, kein Puffer
- − Burn-out-Risiko

### Option C — Team
- + Schneller
- − Kein Team verfuegbar
- − Onboarding-Kosten
