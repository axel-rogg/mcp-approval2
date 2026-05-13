# ADR-0021: Hono.js + Drizzle + pgvector als Stack

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §13](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

Welcher konkrete Tech-Stack fuer mcp-approval2: Web-Framework, ORM, Vector-Store? Anforderungen: portable (Postgres + CF-D1), TypeScript-strict, Pilot-tauglich.

## Considered Options

- Option A: Hono.js + Drizzle (Postgres+SQLite Dialect-Branches) + pgvector
- Option B: Express + Prisma + Qdrant
- Option C: Hono.js + raw SQL + Qdrant
- Option D: NestJS + TypeORM

## Decision Outcome

**Chosen option:** Option A (Hono.js + Drizzle + pgvector), because Hono.js portable (Node + Workers + Bun + Deno) und in mcp-approval bereits eingesetzt. Drizzle hat Postgres-RLS first-class und SQL-near Syntax. pgvector vermeidet zweite DB im Pilot-Scope (bis >5M Vec); Qdrant-Migration via Adapter spaeter moeglich.

## Consequences

- Gut: Portable Runtime, RLS first-class, kein zweiter Vector-DB-Operator-Stack.
- Schlecht: Bei >5M Vektoren Performance-Limit von pgvector erreicht — Migration auf Qdrant noetig. Hono.js juenger als Express (kleineres Ecosystem).
- Folge-Decisions: [ADR-0002](0002-deploy-target-postgres-primary.md), [ADR-0022](0022-portable-adapter-layer.md)

## Pros and Cons of the Options

### Option A — Hono + Drizzle + pgvector
- + Portable
- + RLS first-class
- + One DB fuer Pilot
- − pgvector-Limits bei sehr grossen Indexen
- − Hono.js juenger

### Option B — Express + Prisma + Qdrant
- + Ecosystem
- − Express weniger portable (Node-only)
- − Prisma RLS nicht so natuerlich
- − Zwei DBs operativ

### Option C — Hono + raw SQL + Qdrant
- + Maximum-Kontrolle
- − ORM-Vorteile verloren (Migrations, Type-Inference)

### Option D — NestJS + TypeORM
- + Mature
- − Schwergewichtig fuer Pilot
- − Nicht Workers-portable
