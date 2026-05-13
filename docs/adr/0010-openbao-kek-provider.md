# ADR-0010: OpenBao Self-Hosted als KEK-Provider

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §0, §5.2](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

Fuer Envelope-Encryption von Credentials wird ein Key-Encryption-Key-Provider (KEK) gebraucht. Optionen sind Cloud-KMS (GCP/AWS), HashiCorp Vault (BUSL-Lizenz seit 2023) oder OpenBao (Vault-Fork unter MPL2). Welcher Provider ist Pilot-tauglich + EU-konform + lizenzfrei?

## Considered Options

- Option A: GCP Cloud-KMS (Managed, EU-Region)
- Option B: HashiCorp Vault (BUSL-Lizenz)
- Option C: OpenBao Self-Hosted (MPL2-Lizenz, Vault-Fork)
- Option D: AWS-KMS

## Decision Outcome

**Chosen option:** Option C (OpenBao Self-Hosted), because MPL2-Lizenz frei und Self-Host-fit fuer Pilot. Transit-Engine erlaubt Per-User-Keys (Crypto-Shredding bei User-Delete). EU-Self-Host trivial. Cloud-KMS waere Vendor-Lock-in, Vault waere lizenztechnisch riskant fuer ggf. Mehr-Customer-Setup spaeter.

## Consequences

- Gut: Lizenzfrei, Per-User-Transit-Keys ermoeglichen GDPR-Crypto-Shred (Key-Destroy = unrecoverable), Audit-Trail aller Decrypts.
- Schlecht: Self-Host-Ops noetig (eigener Container, eigene Postgres/SQLite-Backend, TLS-Pflege). AppRole-Auth-Bootstrap nicht-trivial.
- Folge-Decisions: [ADR-0009](0009-webauthn-prf-from-day-zero.md), [ADR-0011](0011-centralized-credential-storage.md)

## Pros and Cons of the Options

### Option A — GCP Cloud-KMS
- + Managed
- + EU-Region verfuegbar
- − Vendor-Lock-in
- − Per-User-Keys-Pattern weniger natuerlich

### Option B — HashiCorp Vault
- + Mature
- − BUSL-Lizenz seit 2023, Multi-Customer-Setup juristisch unklar
- − Self-Host-Ops

### Option C — OpenBao
- + MPL2-Lizenzfrei
- + API-kompatibel mit Vault Pre-Fork
- + Per-User-Transit-Keys
- − Self-Host-Ops noetig
- − Juenger als Vault, weniger Production-Track-Record

### Option D — AWS-KMS
- + Managed
- − Vendor-Lock-in, kein GCP-Stack-Fit
