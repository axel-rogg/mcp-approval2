# Sub-Prozessor-Liste

**Status:** Template / Living Document (Stand 2026-05-13)
**Plan-Reference:** [DPA-Template §5](DPA-template.md), [ADR-0003](../adr/0003-eu-only-data-residency.md), [ADR-0018](../adr/0018-google-vertex-ai-eu-region.md)

> Diese Liste ist Anlage A zum [DPA-Template](DPA-template.md). Jede Aenderung wird dem Auftraggeber mind. 30 Tage im Voraus an `{{KUNDE_DSB}}` mitgeteilt; Widerspruchsrecht gemaess DPA §5.

> **Wichtig:** Diese Liste ist eine **Vorlage**. Der konkrete Sub-Prozessor-Mix pro Pilot kann abweichen (z. B. wenn Customer eigenes Postgres betreibt). Pro Pilot wird die Liste **konkretisiert** und im Customer-Account-Vault gepflegt.

---

## 1. Stand der Sub-Prozessoren

| ID | Anbieter | Service | Datenkategorien | Standort der Verarbeitung | DPA-Status | Kontakt |
|---|---|---|---|---|---|---|
| SP-01 | Google Cloud EMEA Ltd. | Cloud SQL Postgres (Datenhaltung) | Alle User-Daten + Audit-Log | `europe-west1` (Belgien) oder `europe-west3` (Frankfurt) | Google Cloud DPA (Customer-acceptance signed) | gcp-dpo@google.com |
| SP-02 | Google Cloud EMEA Ltd. | Cloud Run (Compute) | Process-Memory (kurz), Logs | Gleiche Region wie SP-01 | siehe SP-01 | siehe SP-01 |
| SP-03 | Google Cloud EMEA Ltd. | Cloud KMS (CMEK) | Encryption-Keys (Customer-managed) | Gleiche Region | siehe SP-01 | siehe SP-01 |
| SP-04 | Google LLC | Vertex AI Embeddings | Embedding-Input (kurz-lived), keine Speicherung | `europe-west4` (Niederlande) | siehe SP-01 + EU-SCC + TIA | siehe SP-01 |
| SP-05 | Google LLC | Google OAuth 2.0 / Identity | User-Email, OAuth-Refresh-Token | EU-region | Google API Services User Data Policy | siehe SP-01 |
| SP-06 | OpenBao (self-hosted) | Vault-Service (Secret-Storage + Transit) | KEK + AppRole-Auth | `{{OPENBAO_LOCATION}}` (typischerweise EU-Rechenzentrum des Auftragsverarbeiters oder Co-Located mit SP-01) | Kein extra DPA (eigene Infrastruktur des Auftragsverarbeiters) | `{{ANBIETER_DSB}}` |
| SP-07 | Cloudflare Inc. | DNS + WAF (optional) | Connection-Metadaten (IP, User-Agent) | EU-PoP, mit Cloudflare Data Localization Suite (EU-only) | Cloudflare DPA | dpo@cloudflare.com |
| SP-08 | `{{SIEM_PROVIDER}}` | SIEM / Audit-Log-Forwarding (optional) | Audit-Events | `{{SIEM_LOCATION}}` (EU-only) | `{{SIEM_DPA_REF}}` | `{{SIEM_DPO}}` |

---

## 2. Risiko-Klassifikation pro Sub-Prozessor

### SP-01 / SP-02 / SP-03 — Google Cloud EMEA Ltd.

- **Vertragspartner:** Google Cloud EMEA Ltd. (Sitz Irland, EU)
- **Mutterkonzern:** Google LLC (USA)
- **Drittland-Risiko:** Daten werden in EU verarbeitet, aber Mutter-Konzern unterliegt US-Recht (CLOUD Act)
- **Mitigation:** CMEK (kunde-owned Key) → Google kann nicht entschluesseln, auch nicht auf US-Behoerden-Anordnung
- **TIA-Status:** durchgefuehrt am `{{TIA_GCP_DATUM}}`, Ergebnis: niedrig nach Schrems II + EU-SCC + CMEK

### SP-04 — Vertex AI

- **Konfiguration:** Embedding-API mit `disable_data_retention=true` (Vertex AI Data Governance Setting)
- **Daten-Lifetime:** Embeddings werden synchron berechnet + returnt, nicht gespeichert
- **Training:** Vertex AI nutzt Customer-Data NICHT fuer Modell-Training (in der EU-Region per ADR-0018 abgesichert)
- **TIA-Status:** durchgefuehrt am `{{TIA_VERTEX_DATUM}}`, Ergebnis: niedrig

### SP-05 — Google OAuth

- **Daten:** Email + Refresh-Token (kein OAuth-Scope fuer Google Workspace Inhalte ueber Identity-Scope hinaus, separate Gateway-Auth fuer Workspace-Tools)
- **Verarbeitung:** Authentication, kein zusaetzlicher Use-Case
- **TIA-Status:** N/A (Standard Google Identity Service)

### SP-06 — OpenBao

- **Self-hosted:** Auftragsverarbeiter betreibt OpenBao selbst (Open-Source, no SaaS-Beziehung)
- **Wenn auf GCP betrieben:** unterfaellt indirekt SP-01-Drittlandrisiko, aber Auto-Unseal-KEK ist kunde-owned (CMEK)
- **Hosting-Alternative pro Pilot:** Customer kann OpenBao on-prem oder im Customer-eigenen Cloud-Account hosten (TODO Phase 7: dokumentieren als Pilot-Option)

### SP-07 — Cloudflare

- **Optional:** nur wenn DNS + WAF ueber Cloudflare laeuft (statt direktem Cloud-Run-Endpoint)
- **Cloudflare DLS (Data Localization Suite):** garantiert EU-only Verarbeitung
- **TLS-Termination:** im PoP → TLS-Pass-through oder Re-Encrypt zu Cloud Run

### SP-08 — Optionaler SIEM-Forwarder

- **Pilot-Default:** nicht aktiv (Audit-Log nur Postgres)
- **Wenn aktiv:** OpenTelemetry-OTLP-Endpoint mit Customer-eigenem SIEM-Cluster
- **Pflicht:** EU-only-Cluster, eigenes DPA mit Customer

---

## 3. Drittland-Transfer-Übersicht

| Transfer | Rechtsgrundlage | Mitigation |
|---|---|---|
| Google Cloud EMEA Ltd. (EU) → Google LLC (USA) als Mutterkonzern | EU-SCC + Google Cloud DPA + TIA | CMEK, Audit-Log-Reviews, kein US-Personal-Access auf Customer-Data dokumentiert |
| Vertex AI EU-Region → Google LLC Trainings-Datacenter (USA, hypothetisch) | EU-SCC + Vertex AI Data Governance | `disable_data_retention=true`, keine Training-Verwendung |

Keine weiteren Drittland-Transfers.

---

## 4. Aenderungsprozess

1. Neuer Sub-Prozessor wird intern beim Auftragsverarbeiter evaluiert (TOM-Check, DPA-Reading, TIA falls Drittland)
2. Mind. 30 Tage vor Live-Schaltung: Notification an Customer-DSB
3. Customer hat 30 Tage Widerspruchsrecht
4. Bei Widerspruch: Pilot-Endigungsfrist nach DPA
5. Bei Akzeptanz: Update dieser Datei + Audit-Event `compliance.sub_processor.added`

Bei Removal eines Sub-Prozessors: Audit-Event `compliance.sub_processor.removed` + Customer-Notification.

---

## 5. Versions-Historie

| Version | Datum | Aenderung |
|---|---|---|
| 0.1 | 2026-05-13 | Initial-Liste (Pilot-Template) |
| | | |
