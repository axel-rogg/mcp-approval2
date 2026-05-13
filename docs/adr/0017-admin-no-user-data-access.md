# ADR-0017: Admin hat keinen User-Daten-Zugriff, kein Impersonation

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §0, §4.1](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

Welche Rechte hat der Admin? In klassischen Enterprise-Tools kann Admin meist "act as User" (Impersonation). Das ist Compliance-Risiko (Operator-Compromise) und Trust-Bruch. Welche Admin-Surface?

## Considered Options

- Option A: Admin = Super-User mit Impersonation + Daten-Zugriff
- Option B: Admin = User-Mgmt + Audit-Log + Quotas, KEINE User-Inhalte, kein Impersonation
- Option C: Admin kann via temporaeren Grant Daten-Zugriff bekommen (mit Audit)

## Decision Outcome

**Chosen option:** Option B (Admin = User-Mgmt only), because Operator-Compromise-Resistenz Kern-Argument des Pilots ist. Admin sieht User-Liste, Audit-Log, Quotas; keine Inhalte. Wenn Admin Support braucht: User-Email + Audit-Range, kein Live-Zugriff.

## Consequences

- Gut: Klare Trust-Story, Admin kann Daten nicht versehentlich/absichtlich einsehen. Compliance-konform (Confidentiality-Garantie auch gegenueber Operator).
- Schlecht: Support-Workflows sind aufwendiger — Admin muss User um Hilfe bitten, kann nicht selbst nachschauen. Bei Bug-Reports nur Audit + User-Cooperation.
- Folge-Decisions: [ADR-0009](0009-webauthn-prf-from-day-zero.md), [ADR-0016](0016-shareable-docs-skills-apps.md), [ADR-0019](0019-audit-schema-day-zero-sink-later.md)

## Pros and Cons of the Options

### Option A — Super-User Admin
- + Klassischer Operator-Workflow
- − Operator-Compromise-Risiko maximal
- − Trust-Bruch gegenueber Usern

### Option B — Restricted Admin
- + Klare Compliance-Story
- + Operator-Compromise-Resistenz
- − Support-Workflows aufwendiger

### Option C — Temp-Grant
- + Mittelweg
- − Trust-Story-Verwaesserung
- − Grant-Workflow-Engineering noetig
