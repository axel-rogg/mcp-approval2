# ADR-0001: Greenfield statt Refactor von mcp-approval

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §1](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

mcp-approval ist ein gewachsener Single-User-MCP-Server auf Cloudflare Workers mit ca. 80 Tools, Single-User-Annahmen tief im Code (z.B. `ALLOWED_EMAILS[0]`), CF-D1/R2-spezifischen Bindings und einer Storage-Architektur, die jetzt erst per Service-Boundary ausgelagert wird. Fuer einen Multi-User-Pilot in einer Firma reicht das nicht — soll daraus weiter-refactored werden oder ein neues Repo gestartet?

## Considered Options

- Option A: Refactor von mcp-approval inkrementell zu Multi-User
- Option B: Greenfield mcp-approval2 + paralleles mcp-knowledge2

## Decision Outcome

**Chosen option:** Option B (Greenfield), because die Single-User-Annahmen ueberall im Bestand sitzen, eine portable Runtime (Postgres-Self-Host primary, CF secondary) ein neues Adapter-Pattern braucht und parallel mit dem Pilot-Tempo (12-14 Wochen) gefahren werden soll. Mit Refactor waere die Code-Surface zu lange in inkonsistentem Zustand.

## Consequences

- Gut: Klares Schema-Design ohne Legacy-Migrations, Multi-User-Isolation from Tag 1, Adapter-Layer-Pattern sauber etablierbar.
- Schlecht: Reuse aus mcp-approval erfolgt selektiv (Crypto, WebAuthn-Code, Approval-Pattern) — alles andere wird neu portiert. Doppelte Aufwand fuer initiale Tools.
- Folge-Decisions: [ADR-0013](0013-mcp-knowledge2-separate-storage-service.md), [ADR-0020](0020-fulltime-engineering-12-14-weeks.md), [ADR-0022](0022-portable-adapter-layer.md)

## Pros and Cons of the Options

### Option A — Refactor
- + Bestehende Tools bleiben verfuegbar
- + Schrittweise Migration moeglich
- − Single-User-Annahmen sind durchgaengig, Refactor-Pfad lang
- − Lange Inkonsistenz-Phase im Code
- − CF-Workers-Spezifika sind schwer rueckwirkend zu abstrahieren

### Option B — Greenfield
- + Sauberes Schema ab Tag 1
- + Multi-User-Isolation als First-Class-Concern
- + Portable Adapter-Layer von Anfang an
- − Initialer Aufwand, viele Tools neu portieren
- − 2 Repos zu pflegen (mcp-approval2 + mcp-knowledge2)
