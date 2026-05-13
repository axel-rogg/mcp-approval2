# ADR-0002: Postgres Self-Host als Primary-Deploy-Target

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §0, §13](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

Der Pilot-Kunde ist eine Firma in EU mit Compliance-Anforderungen (DSGVO). Cloudflare Workers (D1) ist die heutige Runtime des Bestands, aber fuer Enterprise-Pilot ist Postgres-Self-Host (spaeter GCP Cloud SQL) attraktiver — RLS, mature SQL-Stack, OpenBao-Integration, Vertex-AI-Naehe. Welche Runtime ist Primary, welche Sekundaer?

## Considered Options

- Option A: Cloudflare Workers + D1 als Primary
- Option B: Self-Host Postgres als Primary (spaeter GCP Cloud SQL EU), CF als Sekundaer fuer Privat-Setup
- Option C: Nur GCP von Anfang an

## Decision Outcome

**Chosen option:** Option B (Postgres Self-Host primary, CF secondary), because die Firma-Anforderungen (RLS, mature Operator-Tools, EU-Region-Wahl explizit, OpenBao Integration) Postgres-erst rechtfertigen. CF bleibt erlaubt als sekundaerer Adapter fuer Privat-Setup von Axel. GCP-Cloud-SQL kommt spaeter ohne Architektur-Aenderung.

## Consequences

- Gut: RLS first-class, OpenBao easy, pgvector verfuegbar, Operator-Erfahrung gross.
- Schlecht: Adapter-Layer-Pflicht fuer beide Runtimes — kein CF-only Quick-Path. Mehr Engineering-Aufwand initial.
- Folge-Decisions: [ADR-0003](0003-eu-only-data-residency.md), [ADR-0021](0021-hono-drizzle-pgvector-stack.md), [ADR-0022](0022-portable-adapter-layer.md)

## Pros and Cons of the Options

### Option A — CF Workers Primary
- + Bestehende mcp-approval-Erfahrung
- + Edge-Performance, Coop-Bypass via workers.dev
- − D1 hat keine RLS, Multi-User-Isolation muss App-Layer-only
- − Firma will eher klassischen Compliance-Stack (Postgres)
- − OpenBao-Integration schwerer (Workers-Network-Egress)

### Option B — Postgres Primary, CF Secondary
- + RLS als zweite Defense-Layer
- + Mature SQL/Backup/Replication
- + pgvector statt separater Vector-DB
- + Portable Adapter-Layer macht CF spaeter noch moeglich
- − Adapter-Pflicht von Anfang an (mehr Code)
- − Self-Host-Ops fuer Pilot

### Option C — Nur GCP von Anfang
- + EU-Region klar
- + Vertex-AI-Naehe
- − Lock-in early, Self-Host fuer Privat unmoeglich
- − Hoehere Cost in Pilot-Phase
