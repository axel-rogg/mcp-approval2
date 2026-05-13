# ADR-0004: Strict Single-Tenant per Instance

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §0, §1.2, §3.1](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

Pilot ist 1 Firma mit 5-15 Usern. Mittelfristig kommen ggf. weitere Firmen dazu. Tenancy-Modell entscheidend fuer Schema: `tenant_id` als First-Class-Column (Multi-Tenant) oder strikt eine Instance pro Firma (Single-Tenant pro Instance, B-Pattern)?

## Considered Options

- Option A: Multi-Tenant mit `tenant_id`-Column in jeder Tabelle + RLS-Policy
- Option B: Strict Single-Tenant pro Instance, neue Firma = neue Instance (B-Pattern)
- Option C: Hybrid — Single-Tenant jetzt, Multi-Tenant-Refactor wenn 2. Firma kommt

## Decision Outcome

**Chosen option:** Option B (strict Single-Tenant pro Instance), because Multi-Tenant-Schema fuer 1 Pilot ein Over-Engineering ist und der Refactor-Pfad zu Multi-Tenant nicht im Pilot-Scope sein soll. Wenn weitere Firma kommt: zweite Instance forken — kein Tenant-Switcher in UI noetig, kein Cross-Tenant-Bug-Risiko, klarere Crypto-Trennung (separate Vault-Per-Instance).

## Consequences

- Gut: Schema deutlich einfacher (kein `tenant_id`), keine Cross-Tenant-Leaks moeglich, Crypto-Material per Instance getrennt, RLS-Policies nur auf `owner_id` + Sharing-Grants.
- Schlecht: Mehrere Firmen = mehrere Instances mit eigener Ops-Last (Backups, Updates). Skalierung auf 10+ Firmen wird operativ teuer.
- Folge-Decisions: [ADR-0001](0001-greenfield-vs-refactor.md), [ADR-0010](0010-openbao-kek-provider.md), [ADR-0017](0017-admin-no-user-data-access.md)

## Pros and Cons of the Options

### Option A — Multi-Tenant
- + Einmal-Deploy fuer alle Kunden
- + Operative Effizienz bei vielen Tenants
- − Cross-Tenant-Bug-Risiko hoch (RLS-Lecks)
- − Schema-Komplexitaet (tenant_id ueberall)
- − Crypto-Material trennung nicht so sauber

### Option B — Strict Single-Tenant
- + Klare Isolation, kein Cross-Tenant-Risiko
- + Schema einfach, RLS einfacher
- + Pro Firma eigener Crypto-Stack (Vault-Per-Instance)
- − Operative Last bei vielen Instances

### Option C — Hybrid
- + Pilot-Geschwindigkeit
- − Refactor-Risiko spaeter sehr gross
- − Migration eines aktiven Tenants zu Multi-Tenant schwer
