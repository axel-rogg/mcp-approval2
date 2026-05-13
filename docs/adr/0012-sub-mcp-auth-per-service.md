# ADR-0012: Sub-MCP-Auth pro Service entschieden

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §0, §9.2](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

Jeder Sub-MCP (Jira, GitLab, GitHub, GWS, Cloudflare, GCloud) hat eigene Auth-Anforderungen: manche unterstuetzen OAuth, manche nur PAT/API-Token. Soll ein einheitliches Auth-Schema erzwungen werden (z.B. OAuth-only) oder pro Service entschieden?

## Considered Options

- Option A: OAuth-only, Services ohne OAuth-Support werden nicht supported
- Option B: Pro Service entschieden — OAuth wo verfuegbar, PAT als Fallback
- Option C: PAT-only, einheitlich Token-Eingabe via Form

## Decision Outcome

**Chosen option:** Option B (Pro Service entschieden), because reale Service-Realitaet das vorgibt — GitLab hat keinen verbreiteten OAuth-Flow, Atlassian ist hybrid. UI zeigt pro Service "Connect via OAuth" oder "Add API Token" je Faehigkeit.

## Consequences

- Gut: Maximaler Support-Surface, jeder Service kann eingebunden werden. OAuth wo es geht (bessere UX + Revoke).
- Schlecht: UI muss zwei Patterns parallel pflegen (OAuth-Redirect-Flow + Token-Eingabe-Form). Credential-Schema muss `kind` discriminator (`oauth_refresh` vs `api_token`) tragen.
- Folge-Decisions: [ADR-0011](0011-centralized-credential-storage.md)

## Pros and Cons of the Options

### Option A — OAuth-only
- + Einheitlich, Revoke moeglich
- − Schliesst GitLab + viele Niche-Services aus

### Option B — Pro Service
- + Maximaler Service-Support
- + OAuth wo verfuegbar (bessere UX)
- − UI duplex, Schema multi-kind
- − Approval-Token-Storage-Pattern braucht beides

### Option C — PAT-only
- + Einheitlich
- − Kein OAuth-Revoke
- − Schlechtere UX
- − Long-lived PATs sind Security-Schwaeche
