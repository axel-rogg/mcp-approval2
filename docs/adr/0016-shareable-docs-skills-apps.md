# ADR-0016: Docs/Skills/Apps teilbar, Credentials nicht

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §0, §4.3](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

Welche Resource-Kinds sind innerhalb der Firma teilbar? Wissens-Sharing (Docs) ist Kernfunktion. Aber Credentials? Memos? Audit-Log? Es braucht klare Sharing-Scope-Definition.

## Considered Options

- Option A: Alles teilbar inklusive Credentials (per User-Wahl)
- Option B: Docs/Skills/Apps teilbar; Credentials NIE teilbar (owner-only-Garantie); Memos persoenlich; Audit owner-only
- Option C: Nur Docs teilbar, Skills/Apps owner-only

## Decision Outcome

**Chosen option:** Option B (Docs/Skills/Apps teilbar, Credentials/Memos/Audit owner-only), because Credentials-Sharing Compliance-Story bricht (Owner-only-Garantie) und Memos per Definition persoenlich (Personal Memory). Wissens-Sharing (Docs/Skills/Apps) ist Pilot-Kern-Use-Case.

## Consequences

- Gut: Klare Sharing-Scope, RLS-Policy fuer credentials enforct owner-only strikt, Memos bleiben semantic Personal-Recall.
- Schlecht: Memos koennen nicht im Team geteilt werden (kein Default-shareable). Spaeter ggf. opt-in shareable als Erweiterung.
- Folge-Decisions: [ADR-0011](0011-centralized-credential-storage.md), [ADR-0014](0014-sharing-logic-in-storage-service.md), [ADR-0017](0017-admin-no-user-data-access.md)

## Pros and Cons of the Options

### Option A — Alles teilbar
- + Maximale Flexibilitaet
- − Credentials-Sharing schwaecht Operator/Compliance-Story
- − Schwer auditierbar

### Option B — Docs/Skills/Apps teilbar
- + Klare Scope-Definition
- + Owner-only-Garantie fuer Credentials
- + Memos bleiben persoenlich
- − Spaeter Erweiterung fuer Memo-Sharing waere extra Phase

### Option C — Nur Docs
- + Sehr restriktiv
- − Skills/Apps-Reuse nicht moeglich
- − Pilot-Team-Use-Case eingeschraenkt
