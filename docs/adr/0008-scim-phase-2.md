# ADR-0008: SCIM auf Phase 2 verschoben

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §0, §1.2](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

SCIM 2.0 ist der Enterprise-Standard fuer User-Provisioning. Soll fuer den Pilot SCIM-Endpoints bereitgestellt werden (auch als Stub), oder verschoben bis ein Customer wirklich danach fragt?

## Considered Options

- Option A: SCIM-Endpoint-Stubs ab Tag 1
- Option B: Phase 2 nichts — SCIM erst wenn Enterprise-Customer nachfragt
- Option C: SCIM-Schema-ready (DB-Spalten kompatibel), keine Endpoints

## Decision Outcome

**Chosen option:** Option B (Phase 2 nichts), because der Pilot-Customer kein SCIM fordert und SCIM-Endpoint-Engineering nicht trivial ist (gruppen/filter/patch ops). Invite-Flow per Magic-Link reicht fuer 5-15 User vollkommen. Schema bleibt offen genug, dass SCIM spaeter retrofittable ist.

## Consequences

- Gut: Engineering-Zeit gespart fuer Pilot-Phase, Surface minimal.
- Schlecht: Wenn unerwartet ein Enterprise-Customer SCIM fordert, ist Retrofit eine separate Phase.
- Folge-Decisions: [ADR-0005](0005-google-oauth-identity-provider.md), [ADR-0020](0020-fulltime-engineering-12-14-weeks.md)

## Pros and Cons of the Options

### Option A — SCIM ab Tag 1
- + Enterprise-ready Surface
- − Erheblicher Engineering-Aufwand
- − Test-Surface gross (SCIM-Test-Suites)

### Option B — Phase 2 nichts
- + Engineering-Zeit gespart
- + Klare Pilot-Scope
- − Spaeter Retrofit-Kosten

### Option C — Schema-ready
- + Mittelweg
- − SCIM-Schema-Vorbereitung ohne Endpoint-Test bringt wenig Sicherheit
