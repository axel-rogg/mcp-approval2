# ADR-0003: EU-only Datenresidenz

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §0, §8](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

Pilot-Firma ist in EU, DSGVO-Standard ist Pflicht. Alle Daten — Postgres, Blob-Storage, Vector-DB, Vault, AI-Inference — muessen in EU-Region liegen. Welche Regionen / welche Provider erfuellen das?

## Considered Options

- Option A: Multi-Region, US-Fallback erlaubt
- Option B: Strikt EU-only fuer alle Komponenten (DSGVO-Standard)
- Option C: EU + manuelle Audit-Trail fuer Cross-Region-Egress

## Decision Outcome

**Chosen option:** Option B (strikt EU-only), because die Firma DSGVO-Standard fuer einen Pilot erwartet und Cross-Region-Audit-Pfade unnoetigen Compliance-Aufwand bringen. Konkret: Postgres EU-Region, R2/GCS EU-Bucket, OpenBao EU-Self-Host, Vertex AI europe-west3/4.

## Consequences

- Gut: Klare DSGVO-Story, kein Datentransfer-Mechanismus (SCC) noetig fuer Pilot.
- Schlecht: Manche AI-Modelle erst spaeter in EU verfuegbar; weniger Provider-Optionen.
- Folge-Decisions: [ADR-0002](0002-deploy-target-postgres-primary.md), [ADR-0018](0018-google-vertex-ai-eu-region.md)

## Pros and Cons of the Options

### Option A — Multi-Region
- + Mehr Provider/Modelle verfuegbar
- − DSGVO-Compliance schwer auditierbar
- − Cross-Region-Egress muss dokumentiert + minimiert werden

### Option B — Strikt EU-only
- + Klare Compliance-Story, einfache Audit
- + Kein SCC-Mechanismus noetig
- − AI-Modell-Auswahl beschraenkter
- − Wenn Provider EU-Region ausfaellt: keine Fallback-Region

### Option C — EU + Audit
- + Flexibilitaet
- − Audit-Engineering nicht trivial
- − Compliance-Risk wenn Egress versehentlich
