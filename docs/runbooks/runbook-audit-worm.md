# Runbook: WORM-Audit-Sink aktivieren (P2-8)

> **Status:** dormant (Family-Mode braucht das nicht). Aktivieren wenn Compliance-Audit (SOC-2 / ISO-27001) ansteht.

## Was ist das

`apps/server/src/services/audit-sink.ts` enthaelt einen `GcsWormSink` der Audit-Events als immutable NDJSON-Files in einen GCS-Bucket mit `retention_policy` schreibt. Ein einmal geschriebenes Object kann fuer die Retention-Periode NICHT geloescht oder ueberschrieben werden — auch nicht vom Bucket-Owner.

Postgres `audit_log` bleibt source-of-truth fuer Live-Queries. GCS ist defense-in-depth fuer Tamper-Evidence + Compliance.

## Aktivierungs-Sequenz (Operator)

### 1. Terraform-Variable umstellen

In [terraform/environments/privat/terraform.tfvars](../../terraform/environments/privat/terraform.tfvars) (oder via env-var):

```hcl
gcs_audit_enabled        = true
gcs_audit_retention_days = 90  # SOC-2-Mindestmass. ISO-27001 oft 365+.
gcs_audit_location       = "EUROPE-WEST3"  # Single-region, EU-only.
```

### 2. Terraform apply

```bash
cd /workspaces/mcp-approval2
bash scripts/doppler-run-terraform.sh plan \
  -target=google_storage_bucket.audit_worm \
  -target=google_service_account.audit_writer \
  -target=google_service_account_key.audit_writer_key \
  -target=google_storage_bucket_iam_member.audit_writer_create \
  -target=doppler_secret.gcs_audit_sa_json \
  -target=doppler_secret.gcs_audit_bucket \
  -out=/tmp/audit-worm.tfplan

# Review zeigt: bucket, SA, key, IAM-binding, 2 doppler secrets — alles neu.
bash scripts/doppler-run-terraform.sh apply /tmp/audit-worm.tfplan
```

### 3. Doppler-Secret AUDIT_SINK_MODE setzen

TF pusht `GCS_AUDIT_BUCKET` + `GCS_AUDIT_SA_JSON` automatisch. Den Mode-Switch muss der Operator setzen:

```bash
doppler secrets set AUDIT_SINK_MODE pg+gcs \
  --project mcp-approval2 --config fly
```

Optionen:
- `pg+gcs` — Postgres + GCS (recommended, Pg bleibt source-of-truth)
- `combined+gcs` — Postgres + Otel + GCS (wenn schon OTLP-Forwarder konfiguriert)
- `gcs` — NUR GCS (nicht empfohlen, Pg-Verfuegbarkeit ist Pflicht-Sink)

### 4. Sync + Fly deploy

```bash
bash deploy/fly/sync-secrets.sh
fly deploy --remote-only -a mcp-approval2
```

### 5. Verifizieren

```bash
# Trigger einen Audit-Event (Login oder beliebiges Tool-Call)
# Dann GCS pruefen:
gcloud storage ls gs://${gcs_audit_bucket}/audit/

# Erwartung: yyyy/mm/dd/-Pfade mit ts-rand-action.json-Files
gcloud storage cat gs://${gcs_audit_bucket}/audit/2026/05/18/$(date +%s)*-*.json | head -1
```

### 6. WORM-Lock (irreversibel, fuer Audit-Day)

Standardmaessig ist `is_locked = false` — d.h. die Retention-Period kann verkuerzt werden. Fuer einen echten Compliance-Audit muss locked=true gesetzt werden (irreversibel, kein TF-rollback):

```bash
gcloud storage buckets update gs://${gcs_audit_bucket} --lock-retention-policy
# Confirm prompt: yes
```

**Achtung:** ab hier ist die Retention-Period 100% lock-in. Auch GCP-Support kann das nicht zurueckdrehen. Nur die Bucket-Loeschung mit allen Daten ist moeglich.

## Deaktivieren (Rollback)

Wenn `is_locked = false`:

1. `AUDIT_SINK_MODE=pg` in Doppler setzen
2. Re-deploy approval2
3. TF: `gcs_audit_enabled = false` + apply (bucket bleibt mit retention bestehen — manuell loeschen sobald retention abgelaufen)

Wenn `is_locked = true`:
- Re-deploy approval2 mit `AUDIT_SINK_MODE=pg`
- Bucket muss bis Retention-Ablauf stehen bleiben
- Storage-Cost-Schaetzung: bei 1k Audit-Events/Tag x ~2 KB/event = ~60 MB/Monat = ~0.01 EUR/Monat (vernachlaessigbar)

## GDPR-Hinweis: Konflikt Erase-Requests

Wenn ein User Erase verlangt (`knowledge.user.erased` Audit-Event), wird:

- Postgres `audit_log` pseudonymisiert (Code-Pfad: GDPR-Service)
- GCS WORM-Audit bleibt **unveraendert** in Retention-Window

Das ist **legal hold pattern** — Compliance-Audit-Trail darf nicht ueber GDPR-Erase loeschbar werden. Audit-Eintraege enthalten keine direkten PII-Felder (nur user-uuid-references). Bei strengerer Interpretation muss der Operator GDPR-Compliance-Statement entsprechend anpassen.

## Cross-Reference

- [apps/server/src/services/audit-sink.ts](../../apps/server/src/services/audit-sink.ts) — `GcsWormSink`-Klasse + `createAuditSink`-Factory
- [terraform/environments/privat/gcs-audit-worm.tf](../../terraform/environments/privat/gcs-audit-worm.tf) — TF-Bucket + SA + IAM
- [docs/security/SECURITY_ISSUES.md](../security/SECURITY_ISSUES.md) — Audit-Compliance-Anforderungen
- Cross-Repo: ADR-0011 (KMS-Single-Region-Begruendung) gilt analog hier
