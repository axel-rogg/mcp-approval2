# ADR-0011: Zentrale Credential-Storage in mcp-approval2

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §0, §5.1, §5.4](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

Sub-MCP-Server (cf, github, gws, gcloud, utils) brauchen User-Credentials (OAuth-Tokens, API-Keys). Heute haben sie eigene D1-Tabellen je Sub-MCP. Soll das so bleiben (dezentral) oder werden Credentials zentral in mcp-approval2 gehalten und Sub-MCPs holen JIT?

## Considered Options

- Option A: Dezentral — jeder Sub-MCP haelt eigene Credentials in eigener DB
- Option B: Zentral in mcp-approval2, Sub-MCPs holen JIT via interne API
- Option C: Zentral in mcp-knowledge2 (Storage-Service)

## Decision Outcome

**Chosen option:** Option B (Zentral in mcp-approval2), because PRF + Vault zentralisiert sein muss (Operator-Compromise-Resistenz), der Approval-Flow eh in mcp-approval2 lebt und Sub-MCPs Token request-scoped halten koennen. mcp-knowledge2 ist Storage-Service fuer User-Content (Docs/Skills/Apps), nicht fuer Credentials.

## Consequences

- Gut: Einheitliche Crypto-Policy, Audit-Trail aller Decrypts an einer Stelle, kein Re-Implement der Vault/PRF-Pfade in jedem Sub-MCP.
- Schlecht: Sub-MCP-Migration auf JIT-Pattern noetig, Network-Roundtrip pro Tool-Call (caching mitigatable). Service-to-Service-Auth muss eingerichtet werden.
- Folge-Decisions: [ADR-0010](0010-openbao-kek-provider.md), [ADR-0012](0012-sub-mcp-auth-per-service.md), [ADR-0015](0015-jwt-service-to-service-auth.md), [ADR-0016](0016-shareable-docs-skills-apps.md)

## Pros and Cons of the Options

### Option A — Dezentral
- + Kein Roundtrip
- + Sub-MCPs isoliert
- − Crypto-Policy mehrfach implementiert
- − PRF-Pfad in jedem Sub-MCP doppelt
- − Audit-Trail fragmentiert

### Option B — Zentral in mcp-approval2
- + Einheitliche Crypto/Audit-Policy
- + PRF-Integration einmal
- + Sub-MCP-Migration einheitlich
- − Network-Hop pro Tool-Call
- − mcp-approval2 wird kritischer Single-Point-of-Trust

### Option C — Zentral in mcp-knowledge2
- + Storage-Service nutzt eh schon Vault
- − mcp-knowledge2 wird PII-sensitiver
- − Sharing-Logik (in mcp-knowledge2) und Credential-Only-Owner-Garantie clashen logisch
