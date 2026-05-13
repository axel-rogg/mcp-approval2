# ADR-0005: Google-OAuth als Identity-Provider

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §0, §3](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

Welcher Identity-Provider wird fuer Login genutzt? Optionen: eigene Google-OAuth, eigene Microsoft-OAuth, WorkOS/Auth0 als Aggregator, oder Firmen-IdP via SAML/OIDC. Der Pilot soll schnell starten, die User haben Gmail-Accounts (User-Entscheidung).

## Considered Options

- Option A: Eigene Google-OAuth (jeder Gmail-Account, Invite-Pflicht enforcet Membership)
- Option B: WorkOS (Aggregator, deckt Google + Microsoft + SAML ab)
- Option C: SAML/OIDC mit Firmen-IdP

## Decision Outcome

**Chosen option:** Option A (Eigene Google-OAuth), because die User explizit "jeder mit beliebiger Gmail" entschieden haben und Domain-Restriction so nicht moeglich ist. Invite-Liste enforcet Membership. WorkOS-Komplexitaet + Cost fuer Pilot nicht gerechtfertigt. Spaeter optional als Phase-2-Erweiterung.

## Consequences

- Gut: Schneller Setup, bekannter Code-Pfad (mcp-approval-Reuse), keine externe Dependency.
- Schlecht: Invite-Flow muss handgebaut sein (Magic-Link). Bei Erweiterung auf Microsoft/SAML kommt zweiter IdP-Pfad dazu.
- Folge-Decisions: [ADR-0006](0006-first-login-first-admin.md), [ADR-0008](0008-scim-phase-2.md), [ADR-0017](0017-admin-no-user-data-access.md)

## Pros and Cons of the Options

### Option A — Eigene Google-OAuth
- + Schnell, Code aus mcp-approval reusable
- + Keine externe Service-Dependency
- − Invite-Flow handgebaut
- − Erweiterung auf andere IdP heisst zweite Implementation

### Option B — WorkOS
- + Multi-IdP-Pfad ab Tag 1
- + Enterprise-SAML supported
- − Cost + zusaetzliche externe Dependency
- − Pilot-Scope-Overkill

### Option C — SAML/OIDC mit Firmen-IdP
- + Enterprise-konform
- − Firma hat moeglicherweise keinen IdP fuer den Pilot eingerichtet
- − Pilot-Setup deutlich aufwendiger
