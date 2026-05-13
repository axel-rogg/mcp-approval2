# ADR-0006: First-Login-First-Admin Bootstrap

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §0, §3.3](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

Wie wird beim Bootstrap einer neuen Instance der erste Admin angelegt? Manuelles DB-Seed waere fehleranfaellig. Hardcoded Email per Env-Var ist starr. Es braucht ein deterministisches Bootstrap-Pattern.

## Considered Options

- Option A: Env-Var `BOOTSTRAP_ADMIN_EMAIL` setzt fixen Admin
- Option B: First-Login-First-Admin — bei leerer users-Tabelle wird erster eingeloggter User automatisch Admin
- Option C: CLI-Befehl `bun run bootstrap:admin <email>` mit DB-Seed

## Decision Outcome

**Chosen option:** Option B (First-Login-First-Admin), because es deterministisch, ohne Env-Konfiguration und ohne Operator-Eingriff funktioniert. Bootstrap-Mode wird ueber `count(users WHERE status='active') == 0` erkannt; Steady-Mode danach.

## Consequences

- Gut: Kein Env-Var, kein CLI-Eingriff, Setup einfach. Audit-Event `admin.bootstrap` wird emittiert.
- Schlecht: Race-Window: bei mehreren Personen die gleichzeitig OAuth-Flow starten ist der "erste" race-abhaengig. Mitigation: Bootstrap-Mode hat eine kurze Lebenszeit (erste Person nach Deploy).
- Folge-Decisions: [ADR-0005](0005-google-oauth-identity-provider.md), [ADR-0019](0019-audit-schema-day-zero-sink-later.md)

## Pros and Cons of the Options

### Option A — Env-Var Bootstrap
- + Deterministisch
- − Aenderung des Admins braucht Env-Update + Restart
- − Email-Tippfehler beim Deploy moeglich

### Option B — First-Login-First-Admin
- + Kein Operator-Eingriff noetig
- + Bootstrap-Gate ueber count==0 trivial
- − Race-Window theoretisch
- − Bei versehentlichem Multi-Tab-Login: erster gewinnt

### Option C — CLI-Bootstrap
- + Explizit
- − Erfordert Container/Pod-Shell-Zugriff
- − Operator-Schritt zusaetzlich
