# ADR-0019: Audit-Schema ab Tag 1, Sink-Wahl spaeter

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §0, §6](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

Audit-Log ist Compliance-Pflicht. Aber Sink-Wahl (Postgres-only, GCS-WORM, OTel-Stream zu SIEM) haengt vom Customer-IT-Setup ab. Wann wird Sink-Wahl getroffen?

## Considered Options

- Option A: Sink-Wahl ab Tag 1 (Postgres-only) + Migration spaeter
- Option B: Schema ab Tag 1, Sink-Adapter-Pattern, default Postgres-Append-Only + optionale Sinks via Env
- Option C: Audit-Log spaeter in Phase 3 implementieren

## Decision Outcome

**Chosen option:** Option B (Schema ab Tag 1, Sink-Adapter), because Audit-Schema-Migrations spaeter teuer waeren (Pflicht-Events von Anfang an), aber die konkrete Sink-Choice mit Firma-IT abgestimmt werden muss. Adapter-Pattern (`AuditSink`-Interface) erlaubt Sink-Switch ohne Code-Change.

## Consequences

- Gut: Pflicht-Events ab Tag 1 (alle Auth/Permission/Credential/Data/Tool-Events), Schema stabil, Sink-Switch ohne Schema-Migration. PostgresAuditSink + optionales CombinedAuditSink (GCS-WORM / OTel) ohne Refactor.
- Schlecht: Konkrete SIEM-Integration in Phase 1-2 mit Firma zu klaeren. Pilot-Setup hat nur Postgres-Sink.
- Folge-Decisions: [ADR-0006](0006-first-login-first-admin.md), [ADR-0009](0009-webauthn-prf-from-day-zero.md), [ADR-0017](0017-admin-no-user-data-access.md)

## Pros and Cons of the Options

### Option A — Sink fix ab Tag 1
- + Klare Implementation
- − Spaeter Migration zu anderer Sink schwer
- − SIEM-Integration nicht antizipiert

### Option B — Schema fix, Sink-Adapter
- + Pflicht-Events ab Tag 1
- + Sink-Switch ohne Schema-Migration
- + Multi-Sink-Combined supported
- − Adapter-Pattern initial Engineering

### Option C — Audit spaeter
- + Pilot-Geschwindigkeit
- − Compliance-Risk
- − Retro-Logging nicht moeglich
