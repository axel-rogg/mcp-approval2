# Runbook: Pilot-Onboarding

**Status:** Draft (Phase 6 → Phase 7 Pilot-Readiness)
**Last update:** 2026-05-13
**Plan-Reference:** [PLAN-architecture-v1.md](../plans/active/PLAN-architecture-v1.md), [ADR-0006](../adr/0006-first-login-first-admin.md), [ADR-0010](../adr/0010-openbao-kek-provider.md), [ADR-0013](../adr/0013-mcp-knowledge2-separate-storage-service.md)

Ziel: Schritt-fuer-Schritt Anleitung um einen neuen Pilot-Customer (Single-Tenant, eigene Instanz) lauffaehig zu kriegen — von leerem GCP-Project bis "User kann sich einloggen + erstes Tool ausfuehren".

Dieses Runbook ist fuer einen **Operator** geschrieben (DevOps oder Backend-Engineer, der GCP / Postgres / OpenBao bedienen kann). Nicht fuer Endkunden.

---

## 1. Voraussetzungen (T-7 Tage)

Bevor das eigentliche Onboarding startet, muss die Infrastruktur stehen.

### 1.1 GCP-Project

- Eigenes GCP-Project pro Pilot (`mcp-approval2-<kunde>`)
- Region: **europe-west1** oder **europe-west3** (DSGVO, siehe [ADR-0003](../adr/0003-eu-only-data-residency.md))
- APIs enabled:
  - Cloud SQL Admin API
  - Cloud Run Admin API (oder GKE, je nach Deploy-Target)
  - Secret Manager API (fuer Bootstrap-Tokens; OpenBao haelt KEK)
  - Cloud KMS API (optional — falls OpenBao-Auto-Unseal via KMS gewuenscht)
  - Vertex AI API + Embeddings API (siehe [ADR-0018](../adr/0018-google-vertex-ai-eu-region.md))
  - Identity Platform / OAuth 2.0 Client (fuer Google-Login, siehe [ADR-0005](../adr/0005-google-oauth-identity-provider.md))

### 1.2 Postgres Cloud SQL EU

- **Instance:** Cloud SQL Postgres 16, region `europe-west1`
- **HA:** primary + 1 read-replica (HA wird nicht von Cloud SQL Free-Tier abgedeckt)
- **Storage:** SSD, automatic increase, **encrypted-at-rest mit kunde-owned CMEK** (Cloud KMS-Key in eu-west1)
- **Backups:** automatic, daily, **7-Tage Retention** + PITR enabled
- **Networking:** private IP only, kein public endpoint. App-Layer (Cloud Run) ueber VPC-Connector.
- **Extensions:**
  ```sql
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  CREATE EXTENSION IF NOT EXISTS "vector";  -- pgvector fuer KC2
  ```

### 1.3 OpenBao deployt

Siehe separates Runbook (TODO: `runbook-openbao-bootstrap.md` Phase 7).

Wichtige Konfiguration:
- **Storage-Backend:** integrated raft, eigene VM (`europe-west1-a`) oder GKE-StatefulSet
- **Auto-Unseal:** GCP Cloud KMS (gleicher Key wie Cloud SQL CMEK)
- **Audit-Devices:** mindestens 2 (file + syslog), TTL ≥ 90d
- **Auth-Methods enabled:**
  - `approle` fuer mcp-approval2-Server
  - `approle` fuer mcp-knowledge2-Server
  - `userpass` oder `oidc` fuer Operator-Access
- **Policies:** least-privilege pro Service (siehe `terraform/openbao-policies/`)

### 1.4 DNS + TLS

- Pilot-Subdomain: `<kunde>.mcp.example.com` (oder Customer-eigene Domain)
- TLS via Let's Encrypt oder Customer-CA, **min. TLS 1.3**
- HSTS preload mit 365d max-age (siehe Cloudflare zone-settings im Mirror-Repo)
- WAF-Rule: rate-limit auf `/v1/auth/*` (20 req/min), `/oauth/*` (10 req/min)

### 1.5 Sub-MCP-Server (mcp-knowledge2)

- Separate Cloud Run Instance: `<kunde>.knowledge.mcp.example.com`
- Eigene Postgres-Connection (kann SAME instance + separate DB sein, oder separate Cloud SQL — pro Pilot entscheiden)
- Eigene OpenBao-AppRole

---

## 2. Initial-Setup (T-0)

### 2.1 Env-Vars

Operator legt im GCP Secret Manager (oder als Cloud Run Env-Secret-Mount) alle Pflicht-Vars an. Pflicht laut [src/lib/config.ts](../../apps/server/src/lib/config.ts):

| Var | Quelle | Beispiel |
|---|---|---|
| `NODE_ENV` | static | `production` |
| `PORT` | static | `8080` (Cloud Run) |
| `ORIGIN` | DNS | `https://<kunde>.mcp.example.com` |
| `DATABASE_URL` | Cloud SQL Connector | `postgres://app@/db?host=/cloudsql/...` |
| `DATABASE_DIALECT` | static | `postgres` |
| `JWT_SECRET` | OpenBao | `$(openssl rand -hex 32)` (>=32 chars) |
| `JWT_ISSUER` | DNS | `https://<kunde>.mcp.example.com` |
| `JWT_AUDIENCE` | static | `mcp-approval2-api` |
| `JWT_RS256_PRIVATE_KEY_PEM` | OpenBao | Siehe 2.3 |
| `JWT_RS256_PUBLIC_KEY_PEM` | OpenBao | Siehe 2.3 |
| `JWT_KID` | OpenBao | `key-<YYYYMMDD>-1` |
| `MCP_APPROVAL_INTERNAL_TOKEN` | OpenBao | `$(openssl rand -hex 48)` (>=32 chars) |
| `GOOGLE_CLIENT_ID` | GCP OAuth Client | aus Cloud Console |
| `GOOGLE_CLIENT_SECRET` | GCP OAuth Client | aus Cloud Console |
| `GOOGLE_REDIRECT_URI` | DNS | `https://<kunde>.mcp.example.com/v1/auth/google/callback` |
| `RP_ID` | DNS | `<kunde>.mcp.example.com` (NICHT die Wildcard!) |
| `RP_NAME` | static | `mcp-approval2 (<kunde>)` |
| `RP_ORIGIN` | DNS | gleich wie `ORIGIN` |
| `KNOWLEDGE_URL` | DNS | `https://<kunde>.knowledge.mcp.example.com` |
| `VAULT_ADDR` | static | `https://vault.<region>.internal:8200` |
| `LOG_LEVEL` | static | `info` (Pilot) / `warn` (Production-Hardening) |
| `AUDIT_OTEL_ENDPOINT` | optional | `https://siem.<kunde>.intern/audit` falls SIEM-Forward gewuenscht |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optional | leer lassen in Pilot (Phase 7) |

> **Wichtig:** `MASTER_KEY_BASE64` ist NICHT fuer Production. Wenn gesetzt, faellt der Server auf den `LocalKekProvider` zurueck und ignoriert OpenBao. Production-Setup: nur `VAULT_ADDR` setzen + AppRole-Credentials separat (`VAULT_ROLE_ID`, `VAULT_SECRET_ID`).

### 2.2 DB-Migration

Operator startet die Migrations-Job einmalig:

```bash
# Lokal oder via Cloud Run Job
DATABASE_URL=... npm run db:migrate
DATABASE_URL=... npm run db:status   # zeigt applied migrations
```

Erwartete Output:
- `migrations applied: <N>`
- `migrations pending: 0`

Wenn pending > 0: STOP, manuell pruefen welche Migration fehlt.

### 2.3 RS256-Keys generieren

JWT-Signing-Keys fuer die Service-Boundary `mcp-approval2 → mcp-knowledge2` (siehe [ADR-0015](../adr/0015-jwt-service-to-service-auth.md)).

```bash
# Private key (PKCS#8)
openssl genpkey -algorithm RSA -pkcs8 -out priv.pem -pkeyopt rsa_keygen_bits:2048
# Public key (SPKI)
openssl rsa -in priv.pem -pubout -out pub.pem
```

Beide in OpenBao ablegen (separates KV-Mount, NIE in Secret Manager Klartext):
```bash
vault kv put kv/mcp-approval2/jwt \
  private_key_pem=@priv.pem \
  public_key_pem=@pub.pem \
  kid="key-$(date +%Y%m%d)-1"
```

Dann `JWT_RS256_PRIVATE_KEY_PEM` etc. aus Vault binden (Cloud Run Secret Mount oder OpenBao Agent Sidecar).

mcp-knowledge2 bekommt **nur die public_key_pem** via JWKS-Endpoint von mcp-approval2 (`/v1/jwks.json`).

### 2.4 Vault-Bootstrap

```bash
npm run vault:bootstrap
```

Liest `VAULT_ADDR`, erzeugt die initialen Pfade (`kv/mcp-approval2/*`), prueft AppRole-Auth, gibt ein Smoke-OK aus.

---

## 3. First-Admin

Zwei Pfade — siehe [ADR-0006](../adr/0006-first-login-first-admin.md):

### Pfad A: First-Login-First-Admin (Pilot-Default)

1. Operator setzt `ALLOW_FIRST_LOGIN_ADMIN=true` als Env (siehe ADR-0006).
2. Erster User der sich via Google-OAuth einloggt wird automatisch `role='admin'` gesetzt.
3. Nach erfolgreichem ersten Login: `ALLOW_FIRST_LOGIN_ADMIN=false` setzen + Cloud Run redeploy.

### Pfad B: db:seed (explizit)

```bash
DATABASE_URL=... npm run db:seed -- --email=admin@firma.de --role=admin
```

Erzeugt einen User-Row mit `role='admin'`, ohne Login. Beim ersten Login matched die Email + role wird beibehalten.

**Audit-Log-Pflicht:** Beide Pfade erzeugen einen Eintrag `user.admin.bootstrap` mit `actor_user_id=NULL` + `details.method='first-login' | 'db-seed'`.

---

## 4. User-Invites

Sobald der First-Admin sich eingeloggt + WebAuthn-Passkey + PRF registriert hat:

1. Admin oeffnet **PWA** unter `https://<kunde>.mcp.example.com/admin/users/invites`
2. Click "Neuen User einladen"
3. Email-Adresse eingeben + Rolle ("member" Default, "admin" optional)
4. Invite wird via Email versendet (TTL default 24h, siehe `INVITE_TTL_SEC`)
5. User klickt Invite-Link, durchlaeuft Google-OAuth + Passkey-Setup + PRF-Setup
6. **First-Login-Audit-Event:** `user.invite.accepted`

Bei Bedarf Recovery (User verliert Passkey):
- Admin geht zu `/admin/users/<id>` → "Recovery-Token ausstellen"
- Token (TTL `RECOVERY_TTL_SEC`, Default 24h) via Out-of-Band-Channel an User
- User registriert neuen Passkey, alte Passkeys werden invalidiert (`webauthn.invalidated`)

---

## 5. Sub-MCP-Server-Registration

Damit der Pilot Tools nutzen kann muss mcp-knowledge2 (oder ein anderes Sub-MCP-Backend) bei mcp-approval2 registriert sein.

### 5.1 Admin-API-Call

```bash
curl -X POST https://<kunde>.mcp.example.com/v1/admin/sub-mcp \
  -H "Authorization: Bearer <admin-session-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "knowledge",
    "base_url": "https://<kunde>.knowledge.mcp.example.com",
    "auth_type": "jwt_rs256",
    "jwt_audience": "mcp-knowledge2",
    "scopes": ["docs:read", "docs:write", "search:run"],
    "trust_level": "first_party"
  }'
```

### 5.2 Verifikation

Sofort danach:
```bash
curl https://<kunde>.mcp.example.com/v1/admin/sub-mcp -H "Authorization: Bearer ..."
# Erwartete Antwort: enthaelt "knowledge" mit status="connected" + last_health_at < 60s
```

mcp-approval2 macht automatisch einen ersten Health-Probe: `GET <base_url>/v1/health` mit dem RS256-JWT. Wenn das 200 zurueckkommt → connected.

---

## 6. Pilot-Smoke (End-to-End)

Operator + Customer-Lead durchlaufen folgenden Smoke-Test (mit echter User-Identity):

1. **Login:** `<kunde>.mcp.example.com` → Google → Passkey → PRF → Session-Cookie gesetzt
2. **Approval-Setup:** PWA zeigt "Pending Setup" → User registriert Passkey + PRF-Extension
3. **Tool-List:** PWA → "Verfuegbare Tools" zeigt mindestens `system.health`, `system.echo`, `docs.search` (wenn KC connected)
4. **Tool-Call (low-risk):** `system.echo` mit `{"msg": "hi"}` → sofortige Antwort, KEIN Approval-Prompt
5. **Tool-Call (sensitiv):** `docs.put` mit `{"content": "..."}` → **Approval-Prompt** in PWA → User signed mit Passkey + PRF → Tool-Call laeuft durch → Result kommt zurueck
6. **Audit-Log-Check:** Operator queriet `audit_log` Tabelle:
   ```sql
   SELECT action, actor_user_id, result, created_at
     FROM audit_log
    WHERE created_at > now() - interval '5 minutes'
    ORDER BY created_at DESC;
   ```
   Erwartete Eintraege: `user.login.success`, `webauthn.register`, `tool.call.start`, `approval.granted`, `tool.call.success`.

Wenn alle 6 Schritte gruen: Pilot ist live.

---

## 7. Backup-Verification

Nach erfolgreichem Smoke-Test, BEVOR der Customer produktiv geht:

### 7.1 DB-Dump (verifiziert)

```bash
gcloud sql export sql <instance> gs://<kunde>-backups/manual-pilot-day-0.sql.gz \
  --database=mcp_approval2 --offload
```

Pruefen: Bucket-Listing zeigt das File + size > 0.

### 7.2 Vault-Snapshot

```bash
vault operator raft snapshot save /tmp/vault-pilot-day-0.snap
gsutil cp /tmp/vault-pilot-day-0.snap gs://<kunde>-vault-backups/
```

### 7.3 Restore-Drill (optional, empfohlen)

Erstes Restore-Drill innerhalb von 14 Tagen nach Go-Live durchfuehren — siehe [runbook-incident-response.md](runbook-incident-response.md) §3.

---

## 8. Acceptance-Checkliste

- [ ] GCP-Project + Cloud SQL + OpenBao stehen
- [ ] DNS + TLS aktiv, HSTS preloaded
- [ ] Env-Vars im Secret Manager, NICHT als Klartext in Cloud-Run-Config
- [ ] DB-Migrations applied + `pending: 0`
- [ ] RS256-Keys in OpenBao + JWKS-Endpoint reachable
- [ ] First-Admin erfolgreich eingeloggt + Passkey + PRF
- [ ] `ALLOW_FIRST_LOGIN_ADMIN=false` (wenn Pfad A genutzt)
- [ ] Sub-MCP `knowledge` registriert + status=connected
- [ ] Smoke-Test alle 6 Schritte gruen
- [ ] DB-Backup manuell verifiziert
- [ ] Vault-Snapshot manuell verifiziert
- [ ] Customer-Lead hat DPA + DPIA unterschrieben (siehe [docs/compliance/](../compliance/))
- [ ] Incident-Response-Channel etabliert (PagerDuty / Email-Alias)

---

## Troubleshooting

| Symptom | Wahrscheinliche Ursache | Fix |
|---|---|---|
| `Invalid environment configuration` beim Start | Pflicht-Env-Var fehlt | `npm run health-check` lokal mit dem env file |
| `OPENBAO 403` im Log | AppRole-Secret-ID expired | Re-rotate, siehe [runbook-token-rotation.md](runbook-token-rotation.md) §2 |
| WebAuthn-Register failt mit "RP-ID mismatch" | `RP_ID` != Browser-Host | RP_ID = naked subdomain, OHNE Schema, OHNE Port |
| Tool-Call haengt bei "executing" | Sub-MCP-Server nicht erreichbar | `/v1/admin/sub-mcp/<id>/health` polling, Network/Firewall pruefen |
| Audit-Log leer obwohl Calls laufen | `AUDIT_OTEL_ENDPOINT` falsch, blockt Pg | OTel ist sekundaer, Pg muss immer schreiben — Migration `audit_log` pruefen |

---

## Nach dem Onboarding

- Operator setzt automatischen Monitoring-Dashboard auf (siehe Phase 7 TODO)
- Customer-Lead bekommt Login + Admin-Doku
- Erstes Audit-Review nach 7 Tagen Produktivlauf
- DPIA-Review nach 30 Tagen
