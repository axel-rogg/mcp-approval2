# ADR-0007: 1 Passkey + Email-Recovery

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §0, §3.4](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

Wie viele Passkeys werden pro User erlaubt/erzwungen? Bei mehreren Passkeys ist UX bequem (Geraete-Wechsel), aber PRF-Output kann zwischen Credentials abweichen — Re-Enter / Multi-Wrap-Pfad noetig. Wie geht Recovery wenn Passkey verloren?

## Considered Options

- Option A: Mehrere Passkeys + Multi-Wrap (jeder Credential wraps DEK pro Passkey)
- Option B: 1 Passkey + Email-Magic-Link-Recovery + Passkey-Re-Enroll-Pflicht (Re-Enter-PRF-Akzeptanz)
- Option C: 1 Passkey + Backup-Recovery-Codes (printed)

## Decision Outcome

**Chosen option:** Option B (1 Passkey + Email-Recovery), because Multi-Wrap-Engineering aufwendig und fehleranfaellig ist (PRF-Output divergiert) und der User explizit Re-Enter-Pflicht bei Passkey-Verlust akzeptiert hat. PRF-protected Credentials werden bei Recovery als 'invalidated' markiert, User muss externe Tokens neu eintragen.

## Consequences

- Gut: Einfacher Code-Pfad, keine Multi-Wrap-Komplexitaet. Audit-Event bei Recovery klar.
- Schlecht: User muss bei Passkey-Verlust alle Credentials neu eintragen — "Inconvenience-tax". Kein Mobile-Backup-Pfad.
- Folge-Decisions: [ADR-0009](0009-webauthn-prf-from-day-zero.md), [ADR-0011](0011-centralized-credential-storage.md)

## Pros and Cons of the Options

### Option A — Mehrere Passkeys + Multi-Wrap
- + Geraete-Wechsel UX
- + Kein Re-Enter
- − Multi-Wrap-Engineering (DEK wrapped pro Credential)
- − PRF-Output-Divergenz schwer zu testen

### Option B — 1 Passkey + Email-Recovery
- + Simple Crypto-Pfad
- + Recovery deterministisch
- − Re-Enter bei Verlust
- − Email als Recovery-Channel ist Voraussetzung

### Option C — 1 Passkey + Backup-Codes
- + Offline-Recovery
- − User-Erfahrung schlecht (Codes irgendwo aufschreiben)
- − Recovery-Codes brauchen sichere Speicherung
