# Runbook: Incident-Response

**Status:** Draft (Phase 6 → Phase 7 Pilot-Readiness)
**Last update:** 2026-05-13
**Plan-Reference:** [PLAN-architecture-v1.md §6](../plans/active/PLAN-architecture-v1.md), [ADR-0019](../adr/0019-audit-schema-day-zero-sink-later.md)

Ziel: Operationelles Playbook fuer Security-Incidents — von Detection ueber Sofortmassnahmen, Forensik bis Notification. Pflicht-Lektuere fuer alle On-Call-Engineers.

> **Grundsatz:** Im Zweifel **handeln**, dann **dokumentieren**. Audit-Log + immutable Postgres-Sink protokollieren alles automatisch; Operator-Action verbessert das nicht. Aber jede Action MUSS innerhalb von 4h in einem Incident-Ticket landen.

---

## 0. Klassifikation

| Severity | Beispiel | SLA-Reaktion |
|---|---|---|
| **SEV-1** | Active credential compromise (KEK leaked, master-token published), Datenexfiltration | 15 min Akknowledge, 1h Mitigation |
| **SEV-2** | Audit-anomaly (admin-action ohne Audit-Eintrag), unusual access pattern | 1h Akknowledge, 4h Mitigation |
| **SEV-3** | Rate-limit-Spikes, suspected bruteforce, single-user-suspicious activity | 4h Akknowledge, 24h Mitigation |
| **SEV-4** | False-positive, retroactive review notwendig | 24h triage |

---

## 1. Compromise-Indikatoren

Was wir aktiv beobachten (Monitoring-Dashboard / Alerts):

### 1.1 Audit-Anomalies

**Symptom:** Eine Action erwartet einen Audit-Eintrag, der ist nicht da.

Konkrete Queries:
```sql
-- 1) Login-Successes ohne preceding webauthn.assert
SELECT u.id, u.email, ll.created_at AS login_ts
  FROM audit_log ll
  LEFT JOIN audit_log wa
    ON wa.actor_user_id = ll.actor_user_id
   AND wa.action = 'webauthn.assert.success'
   AND wa.created_at BETWEEN ll.created_at - interval '30 seconds' AND ll.created_at
  JOIN users u ON u.id = ll.actor_user_id
 WHERE ll.action = 'user.login.success'
   AND ll.created_at > now() - interval '1 hour'
   AND wa.id IS NULL;

-- 2) Tool-Calls ohne approval-Eintrag fuer sensitive Tools
SELECT * FROM audit_log
 WHERE action = 'tool.call.success'
   AND details->>'tool_name' IN ('docs.put', 'docs.delete', 'apps.delete', 'credentials.create')
   AND request_id NOT IN (
     SELECT request_id FROM audit_log
      WHERE action = 'approval.granted'
        AND created_at > now() - interval '24 hours'
   );

-- 3) Admin-Actions ohne aktive admin-Session
SELECT al.* FROM audit_log al
  LEFT JOIN sessions s
    ON s.user_id = al.actor_user_id
   AND al.created_at BETWEEN s.created_at AND COALESCE(s.revoked_at, s.expires_at)
 WHERE al.action LIKE 'admin.%'
   AND s.id IS NULL;
```

Wenn eine dieser Queries Rows liefert: **SEV-2 mindestens**.

### 1.2 Rate-Limit-Spikes

**Symptom:** `audit_log.action = 'rate_limit.exceeded'` > 100 events in 5 min fuer einen einzelnen `actor_user_id` oder `ip`.

```sql
SELECT ip, actor_user_id, count(*)
  FROM audit_log
 WHERE action = 'rate_limit.exceeded'
   AND created_at > now() - interval '5 minutes'
 GROUP BY ip, actor_user_id
HAVING count(*) > 100
 ORDER BY count(*) DESC;
```

### 1.3 Vault-403s

**Symptom:** mcp-approval2-Logs zeigen `audit.sink.otel.failed` oder OpenBao-403 in den HTTP-Logs.

- Wenn 403 von OpenBao → AppRole-Secret-ID gerollt oder revoked → **SEV-1** (Server kann nicht mehr decrypten)
- Wenn 5xx von OpenBao → Vault-Cluster down → **SEV-1** (gleicher Effekt)

### 1.4 Unerwartete Schema-Aenderungen

**Symptom:** Migration-Log zeigt eine angewandte Migration die der Operator nicht ausgeloest hat (CI-Push-Job, der nicht autorisiert war).

```sql
SELECT * FROM _migrations_log ORDER BY applied_at DESC LIMIT 10;
```

Wenn unbekannter `applied_by` oder `git_sha` → **SEV-1**.

### 1.5 OAuth-Anomaly

- `google.token.exchange.failure` Spike → mglw. compromised redirect_uri
- `oauth.client.register` outside business-hours + nicht von Admin → **SEV-2**

---

## 2. Sofort-Massnahmen (T+0 bis T+15min)

### 2.1 Triage

1. **Page einsehen:** PagerDuty / Email-Alarm. Was ist der Trigger?
2. **Audit-Log live ansehen:** `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100`
3. **Tracing:** wenn OTel aktiv → `request_id` in Trace-Backend suchen, sonst pino-Logs in Cloud Logging filtern

### 2.2 Compromise → Containment

Reihenfolge je nach Vermutung:

**A) User-Account compromised:**
```bash
# Session sofort revoken
curl -X POST https://<kunde>.mcp.example.com/v1/admin/users/<id>/suspend \
  -H "Authorization: Bearer <operator-admin-token>"
```
Effekt: alle aktiven Sessions des Users werden invalidiert (`sessions.revoked_at = now()`), alle Refresh-Tokens revoked, Login wird geblockt. Audit-Event: `admin.user.suspend`.

**B) Service-Token compromised** (`MCP_APPROVAL_INTERNAL_TOKEN` leaked):
```bash
# 1) Neues Token generieren
NEW_TOKEN=$(openssl rand -hex 48)
# 2) In OpenBao schreiben
vault kv put kv/mcp-approval2/internal token="$NEW_TOKEN"
# 3) Cloud Run redeploy mit neuem Env-Var (Secret Manager Auto-Pickup, dann revision-rollout)
gcloud run services update mcp-approval2 --region=eu-west1 \
  --update-secrets MCP_APPROVAL_INTERNAL_TOKEN=mcp-approval2-internal:latest
# 4) mcp-knowledge2 redeploy (gleicher Schritt)
```
Siehe [runbook-token-rotation.md](runbook-token-rotation.md) §3 fuer Detail.

**C) KEK / Master-Key compromised:**
1. **KEK rotieren** in OpenBao:
   ```bash
   vault write -f transit/keys/mcp-approval2/rotate
   ```
2. **Alle DEKs re-wrappen** — Cron-Job `credentials.rewrap` triggert das automatisch im naechsten Schedule, oder manuell:
   ```bash
   npm run credentials:rewrap-all -- --new-kek-version=N+1
   ```
3. **Alte KEK-Version destroy** (NICHT vor erfolgreichem Rewrap!):
   ```bash
   vault write transit/keys/mcp-approval2/config min_decryption_version=N+1
   ```

**D) Datenexfiltration vermutet:**
1. **Network-Egress blocken** — Cloud Armor / WAF Policy auf `egress-to-customer-cidr-only`.
2. **DB-Read-Replicas pausieren** (verhindert weitere Reads).
3. **Audit-Log-Snapshot:** sofort `pg_dump audit_log` + verschluesselt nach GCS schreiben — **vor** weiteren Massnahmen, damit der Forensik-Trail intakt bleibt.
4. Eskalation: Datenschutzbeauftragter + Geschaeftsleitung.

### 2.3 Mitigation-Acknowledge

Innerhalb der SLA-Frist:
- Incident-Ticket eroeffnen (Jira/Linear)
- Status auf "Mitigated" wenn die unmittelbare Gefahr weg ist
- Audit-Event `admin.incident.mitigated` manuell schreiben (via `/v1/admin/audit` API):
  ```bash
  curl -X POST https://<kunde>.mcp.example.com/v1/admin/audit \
    -H "Authorization: Bearer <admin-token>" \
    -d '{"action": "admin.incident.mitigated", "details": {"incident_id": "INC-1234", "severity": "SEV-1"}}'
  ```

---

## 3. Forensik (T+15min bis T+24h)

### 3.1 Audit-Export

```bash
# Voller Audit-Log seit Incident-Start
psql $DATABASE_URL -c "\COPY (
  SELECT * FROM audit_log
   WHERE created_at >= '<incident-start>'::timestamptz
   ORDER BY created_at
) TO 'audit-export-INC-1234.csv' WITH CSV HEADER"

# Encrypted + Storage
gpg --encrypt --recipient operator@<kunde>.example.com audit-export-INC-1234.csv
gsutil cp audit-export-INC-1234.csv.gpg gs://<kunde>-incident-forensics/
```

### 3.2 OpenTelemetry-Traces

Wenn OTel aktiv (siehe [src/lib/observability.ts](../../apps/server/src/lib/observability.ts)):
- Trace-Backend (Tempo/Jaeger/Cloud Trace) nach `request_id` filtern
- Spans zeigen Service-Boundary-Calls (mcp-approval2 → mcp-knowledge2) mit Latenz + Status
- Export der relevanten Traces als JSON, zur Forensik-Mappe legen

Wenn OTel NICHT aktiv (Pilot-Default):
- pino-Logs in Cloud Logging filtern: `jsonPayload.request_id="<id>"`
- Export via `gcloud logging read` + json-dump

### 3.3 Timeline-Rekonstruktion

Standard-Mapping:
1. Trigger-Event aus dem Alarm (z.B. `rate_limit.exceeded`)
2. Vorherige User-Activity (1h davor) aus audit_log
3. Korrelierte HTTP-Logs (request_id)
4. Sub-MCP-Boundary-Calls (mcp-knowledge2 audit_log, separater Server)
5. Output-Trail: was hat der Compromise effektiv gelesen / geschrieben?

Format: Markdown-Timeline in `docs/incidents/<INC-id>.md` (separater Branch, nicht in `main`).

---

## 4. Notification

### 4.1 Intern (T+1h)

- Slack #security: erste Statusnachricht mit Severity + Containment-Status
- Geschaeftsleitung: bei SEV-1, in jeder Phase Update
- Datenschutzbeauftragter: bei jeder PII-Exposure-Vermutung (auch wenn unbestaetigt)

### 4.2 Customer (T+24h spaetestens, bei PII-Risk eher)

Email an Customer-Lead + DPA-vertraglich definierten Sicherheits-Kontakt:
- **Was** ist passiert (faktisch, ohne Spekulation)
- **Welche Daten** waren potenziell betroffen (Kategorien, NICHT konkrete Records)
- **Welche Massnahmen** sind erfolgt
- **Was sollte der Customer tun** (z.B. User-Passwoerter aendern, OAuth-Apps revoken)

Template: `docs/compliance/incident-notification-template.md` (TODO Phase 7).

### 4.3 Behoerde (DSGVO Art. 33 — 72h-Frist)

**Pflicht wenn:** personenbezogene Daten kompromittiert sind UND ein Risiko fuer Betroffene besteht.

- Adressat: zustaendige Aufsichtsbehoerde im Land des Verantwortlichen (NICHT mcp-approval2's Land — siehe DPA-Klausel `verantwortlicher.aufsichtsbehoerde`)
- Format: Schriftliches Notification-Form der Behoerde (zB BayLDA online-Formular)
- Inhalt:
  - Art des Vorfalls
  - Kategorien + Anzahl Betroffener
  - Folgen
  - Massnahmen
- **Frist: 72h ab Kenntnisnahme** (NICHT ab Vorfall)
- Operator + Datenschutzbeauftragter unterschreiben

Bei Nicht-EU-Customer: zusaetzliche Pflichten je nach Jurisdiktion (CCPA, PIPEDA, etc.) — Anwalt einbeziehen.

### 4.4 Betroffene (DSGVO Art. 34)

**Pflicht wenn:** ein **hohes Risiko** fuer die Rechte und Freiheiten der Betroffenen besteht.

- Direkt an jede betroffene Person (Email, In-App-Banner)
- Klare Sprache, keine Anwalts-Floskeln
- Was, wie, was tun

Template: `docs/compliance/data-subject-notification-template.md` (TODO Phase 7).

---

## 5. Post-Incident-Review

Innerhalb 14 Tagen nach Mitigation:
1. **Blameless Post-Mortem** in `docs/incidents/<INC-id>.md`:
   - Timeline (siehe 3.3)
   - Root-Cause
   - Was lief gut / schlecht
   - Action-Items (3-5 konkrete Verbesserungen mit Owner + Frist)
2. **ADR** wenn ein Architecture-Change folgt
3. **Audit-Log-Retention-Check:** Vorfall + 90d sind in der `audit_log` Tabelle erhalten, auch nach Standard-Retention (Default 365d) — manuell verlaengern wenn Forensik-Trail laenger gebraucht

---

## 6. Drill-Schedule

Pflicht-Drills pro Pilot:

| Drill | Frequenz | Last-Run | Owner |
|---|---|---|---|
| Restore-from-Backup (PITR) | 1x / Quartal | — | DBA |
| Vault-Snapshot-Restore | 1x / Quartal | — | Platform |
| KEK-Rotation + Rewrap | 1x / 6 Monate | — | Platform |
| User-Suspend-Drill | 1x / Quartal | — | On-Call |
| Audit-Export + GPG-Encrypt | 1x / Quartal | — | On-Call |

Jeder Drill-Run wird als Audit-Event `admin.drill.<type>` protokolliert + im `docs/incidents/drills/` als Bericht abgelegt.

---

## 7. Eskalations-Kette

```
Detection (Monitoring / Alert)
   │
   ▼
On-Call-Engineer (PagerDuty primary)
   │  (15 min ACK / SEV-1, 1h ACK / SEV-2)
   ▼
Tech-Lead + Security-Lead
   │  (bei SEV-1 oder PII)
   ▼
Geschaeftsleitung + Datenschutzbeauftragter
   │  (bei Behoerde-Notification-Pflicht)
   ▼
Customer-Lead (Customer-Side) + DPA-Sicherheits-Kontakt
```

Telefonnummern + Email-Aliasse: `docs/compliance/contacts.md` (TODO Phase 7, NICHT in git — separater Secret-Store).
