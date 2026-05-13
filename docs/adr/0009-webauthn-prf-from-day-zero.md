# ADR-0009: WebAuthn-PRF von Anfang an aktiv

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §0, §5.3](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

WebAuthn-PRF erlaubt es, einen pseudozufaelligen Output pro Authentication zu generieren, der als zusaetzliche Crypto-Schicht (XOR mit DEK) genutzt werden kann. Damit ist ein Operator (mit DB+Vault-Zugriff) ohne PRF-Output trotzdem nicht in der Lage Credentials zu entschluesseln. Soll PRF ab Tag 1 voll integriert sein oder schrittweise nachgeruestet?

## Considered Options

- Option A: PRF schema-ready, aber erst spaeter aktiviert
- Option B: PRF von Anfang an voll implementiert (alle sensitiven Credentials)
- Option C: Kein PRF, nur Vault-KEK

## Decision Outcome

**Chosen option:** Option B (PRF von Anfang an voll), because Operator-Compromise-Resistenz Kern-Argument des Pilots ist. Schrittweises Nachruesten waere Migration teurer Credentials. PRF-Eval ist Teil des Approval-Flows (WYSIWYS) — konvergiert sauber.

## Consequences

- Gut: Operator-Compromise resistent ab Tag 1, klare Security-Story.
- Schlecht: +1 Woche Engineering, Cron-Tools koennen keine PRF-Credentials nutzen (Opt-out pro Credential noetig), Recovery-Pfad muss alle PRF-Credentials invalidieren.
- Folge-Decisions: [ADR-0007](0007-one-passkey-plus-email-recovery.md), [ADR-0010](0010-openbao-kek-provider.md), [ADR-0011](0011-centralized-credential-storage.md)

## Pros and Cons of the Options

### Option A — PRF schema-ready
- + Engineering verteilt
- − Migration aller bestehenden Credentials spaeter unhandlich
- − Operator-Compromise bleibt offen bis PRF aktiv

### Option B — PRF voll ab Tag 1
- + Konsistente Security-Story
- + Approval-Flow + PRF-Eval konvergiert (gleicher User-Schritt)
- − +1 Woche Engineering
- − Cron-Tool-Inkompatibilitaet, Opt-out pro Credential

### Option C — Kein PRF
- + Einfacher
- − Operator-Compromise nicht abgedeckt
- − Schwaechere Compliance-Story
