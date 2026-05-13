# ADR-0018: Google Vertex AI in EU-Region

**Status:** Accepted  
**Date:** 2026-05-13  
**Deciders:** Axel + Claude (Decision-Session)  
**Plan-Reference:** [PLAN-architecture-v1.md §0, §8](../plans/active/PLAN-architecture-v1.md)

## Context and Problem Statement

Welcher AI-Provider fuer Chat + Embeddings? Anthropic Claude, OpenAI, Google Vertex AI, lokales Llama? Datenresidenz EU-only, Pilot-Geschwindigkeit, eine API mit beiden Modi (Embed + Chat) bevorzugt.

## Considered Options

- Option A: Multi-Provider (Anthropic + OpenAI + ...) mit Adapter
- Option B: Google Vertex AI (Gemini fuer Chat, text-embedding-005 fuer Embed, EU-Region)
- Option C: Anthropic Claude + separater Embedding-Provider
- Option D: Self-Hosted Llama + bge-m3

## Decision Outcome

**Chosen option:** Option B (Google Vertex AI, EU-Region europe-west3/4), because eine API beide Modi abdeckt, EU-Region explizit verfuegbar, GCP-Cloud-SQL-Naehe spaeter ein Stack-Vorteil ist und der Pilot keine Multi-Provider-Komplexitaet braucht.

## Consequences

- Gut: Eine Inference-API, EU-Region klar, text-embedding-005 fuer pgvector geeignet (768-dim), Gemini 3 Flash fuer Chat.
- Schlecht: Vendor-Lock-in (Adapter-Layer mitigatable). Cost-Controls pro User Pflicht (Vertex-Quotas + App-Layer-Budget). Service-Account-Key wird selbst zu sensiblem Credential.
- Folge-Decisions: [ADR-0003](0003-eu-only-data-residency.md), [ADR-0011](0011-centralized-credential-storage.md), [ADR-0022](0022-portable-adapter-layer.md)

## Pros and Cons of the Options

### Option A — Multi-Provider
- + Flexibilitaet
- − Engineering-Aufwand fuer Adapter pro Provider
- − Cost-Tracking pro Provider doppelt

### Option B — Vertex AI EU
- + Eine API, beide Modi
- + EU-Region klar
- − Vendor-Lock-in
- − Service-Account-Key-Management

### Option C — Claude + extra Embed
- + Best-in-Class Chat
- − Zweite API fuer Embed noetig
- − EU-Residency-Pruefung pro Provider

### Option D — Self-Hosted Llama
- + Volle Kontrolle
- − GPU-Ops im Pilot-Scope nicht realistisch
- − Quality-Gap zu Frontier-Models
