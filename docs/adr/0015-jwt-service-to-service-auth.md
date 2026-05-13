# ADR-0015: JWT-Service-to-Service-Auth zwischen mcp-approval2 und mcp-knowledge2

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §0, §2.1](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

mcp-approval2 muss mit mcp-knowledge2 als User reden (z.B. "User X liest Doc Y"). User-Identitaet muss durchgereicht werden ohne dass mcp-knowledge2 mcp-approval2 vertrauen muss (Defense-in-Depth). Welcher Mechanismus?

## Considered Options

- Option A: Static Service-Account-Bearer + User-ID-Header (Trust-Header)
- Option B: Kurzlebige JWTs (60s lifetime) signed by mcp-approval2, JWKS-validated by mcp-knowledge2
- Option C: mTLS + User-Context-Header

## Decision Outcome

**Chosen option:** Option B (JWT mit JWKS-Validation), because User-Identity kryptografisch durchgereicht wird (kein Trust-on-Trust), mcp-knowledge2 kann mcp-approval2 nicht imitieren und Token-Replay-Window kurz (60s). JWKS-Endpoint `/.well-known/jwks.json` mit Rotating-Keys, mcp-knowledge2 cached 24h.

## Consequences

- Gut: Cryptographic-Identity-Passthrough, kein Service-Token-Refresh-Pfad noetig, JWKS-Rotation supported.
- Schlecht: JWT-Signing + JWKS-Endpoint-Pflege noetig, Cross-Service-Test-Setup aufwendiger.
- Folge-Decisions: [ADR-0013](0013-mcp-knowledge2-separate-storage-service.md), [ADR-0014](0014-sharing-logic-in-storage-service.md)

## Pros and Cons of the Options

### Option A — Static Bearer + Trust-Header
- + Einfach
- − User-ID-Header = Trust-on-Trust, falls Bearer kompromittiert kann Caller jeden User imitieren
- − Defense-in-Depth schwach

### Option B — JWT mit JWKS
- + Cryptographic User-Identity
- + 60s-Lifetime macht Replay schwer
- + JWKS-Rotation operativ moeglich
- − JWKS-Caching + Network-Roundtrip
- − Pflicht-Pflege Signing-Key

### Option C — mTLS + Header
- + Network-Layer-Security
- − User-Identity bleibt Header-Trust
- − mTLS-Cert-Management aufwendig
