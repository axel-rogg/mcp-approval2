# Runbook: Token-Rotation

**Status:** Draft (Phase 6 → Phase 7 Pilot-Readiness)
**Last update:** 2026-05-13
**Plan-Reference:** [PLAN-architecture-v1.md §3, §15](../plans/active/PLAN-architecture-v1.md), [ADR-0010](../adr/0010-openbao-kek-provider.md), [ADR-0012](../adr/0012-sub-mcp-auth-per-service.md), [ADR-0015](../adr/0015-jwt-service-to-service-auth.md)

Ziel: Pro Token-Klasse die Standard-Rotation dokumentiert — Schritt-fuer-Schritt mit Pre-Flight, Roll-Out, Verifikation, Rollback.

> **Grundsatz:** Token-Rotation muss **breaking-change-frei** sein. Jede Klasse hat eine Overlap-Period (alte + neue Version koexistieren), sodass kein Service-Restart eine Downtime erzeugt.

---

## Uebersicht der Token-Klassen

| Klasse | Owner | Rotation-Frequenz (Pflicht) | Rotation-Frequenz (Empfohlen) | Overlap |
|---|---|---|---|---|
| RS256-JWT-Signing (Service-Boundary) | OpenBao kv/mcp-approval2/jwt | 12 Monate | 6 Monate | JWKS multi-key |
| OpenBao AppRole Secret-ID | OpenBao approle | 90 Tage | 30 Tage | secret-id-ttl ueberlapt |
| INTERNAL-Service-Token (mcp-approval2 ↔ mcp-knowledge2) | OpenBao kv/mcp-approval2/internal | 90 Tage | 30 Tage | dual-accept ueber Env |
| Google-OAuth-Client-Secret | GCP Console | bei compromise | 12 Monate | n/a (single secret) |
| User-Session-JWT | rotiert beim Refresh, kurz | n/a | n/a | n/a |
| Recovery-Token | TTL `RECOVERY_TTL_SEC` (24h) | n/a | n/a | n/a |
| Invite-Token | TTL `INVITE_TTL_SEC` (24h) | n/a | n/a | n/a |

---

## 1. RS256-JWT-Signing-Keys

Verwendet fuer Service-zu-Service-Auth zwischen mcp-approval2 und mcp-knowledge2 (siehe [ADR-0015](../adr/0015-jwt-service-to-service-auth.md)).

mcp-approval2 signiert mit dem Private Key, mcp-knowledge2 verifiziert ueber den JWKS-Endpoint (`/v1/jwks.json` von mcp-approval2).

### 1.1 Pre-Flight

- [ ] OpenBao erreichbar + AppRole-Auth funktioniert
- [ ] mcp-knowledge2 cached JWKS mit `max-age <= 5min` (Caller-Side)
- [ ] Aktuelle KID + Erstellungs-Datum dokumentiert

```bash
vault kv get -format=json kv/mcp-approval2/jwt | jq '.data.data | {kid, created_at}'
```

### 1.2 Generieren

```bash
# Neuer Key
openssl genpkey -algorithm RSA -pkcs8 -out priv-new.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -in priv-new.pem -pubout -out pub-new.pem

# KID erzeugen (zeitstempel-basiert)
NEW_KID="key-$(date -u +%Y%m%d)-1"
echo "New KID: $NEW_KID"
```

### 1.3 In OpenBao ablegen (versioned)

```bash
# Aktuellen Key als _previous markieren (manuell in KV2-Metadaten)
vault kv metadata put kv/mcp-approval2/jwt custom_metadata='{"rotation_status":"previous"}'

# Neuen Key als _current schreiben
vault kv put kv/mcp-approval2/jwt \
  private_key_pem=@priv-new.pem \
  public_key_pem=@pub-new.pem \
  kid="$NEW_KID" \
  prev_kid=$(vault kv get -format=json kv/mcp-approval2/jwt | jq -r '.data.data.kid')
```

### 1.4 JWKS-Endpoint aktualisieren

mcp-approval2 publishet **beide** Keys (current + previous) im JWKS, damit mcp-knowledge2 Tokens die mit dem alten Key signiert sind weiterhin verifizieren kann.

Pseudo-Implementation (in `src/mcp/oauth/jwks.ts`):
```ts
// JWKS endpoint returns both current + previous keys
const keys = [
  await loadFromVault('kv/mcp-approval2/jwt/current'),
  await loadFromVault('kv/mcp-approval2/jwt/previous'),
].filter(Boolean);
return { keys: keys.map(toJwk) };
```

Redeploy mcp-approval2 mit den neuen Env-Vars:
- `JWT_RS256_PRIVATE_KEY_PEM` = neuer Private Key
- `JWT_RS256_PUBLIC_KEY_PEM` = neuer Public Key
- `JWT_KID` = neue KID
- `JWT_RS256_PREVIOUS_PUBLIC_KEY_PEM` = alter Public Key (fuer JWKS-Listing)
- `JWT_PREVIOUS_KID` = alte KID

### 1.5 Verifikation

```bash
# JWKS muss beide Keys haben
curl https://<kunde>.mcp.example.com/v1/jwks.json | jq '.keys[] | {kid, alg}'
# Erwartet: 2 Keys
```

Im mcp-knowledge2-Log:
- `service.jwt.verify.success` mit altem kid (waehrend Roll-Out)
- `service.jwt.verify.success` mit neuem kid (sobald mcp-approval2 mit neuem Key signiert)

### 1.6 Cutover

Nach 24h Overlap (alle laufenden JWTs sollten expired sein, default TTL 5min):

```bash
# Alte JWKS-Eintraege entfernen
vault kv delete kv/mcp-approval2/jwt/previous
# Redeploy mcp-approval2 ohne JWT_RS256_PREVIOUS_PUBLIC_KEY_PEM
```

### 1.7 Audit-Events

- `service.jwt.key.rotated` mit `details.old_kid`, `details.new_kid`
- `service.jwt.key.previous_removed` nach Cutover

### 1.8 Rollback

Wenn nach Roll-Out unerwartete Errors:
```bash
# Schnellster Pfad: alte Key-Version wieder zur current machen
vault kv rollback -version=<N-1> kv/mcp-approval2/jwt
# Redeploy mcp-approval2
```
Effekt: alle neuen Tokens werden wieder mit dem alten Key signiert, mcp-knowledge2 cached JWKS mit beiden + verifiziert beide.

---

## 2. OpenBao-AppRole Secret-ID

mcp-approval2 authentifiziert sich gegen OpenBao via AppRole (siehe [ADR-0010](../adr/0010-openbao-kek-provider.md)). Secret-ID hat TTL (typisch 30d), MUSS regelmaessig rotiert werden.

### 2.1 Pre-Flight

- [ ] AppRole-Name bekannt (`mcp-approval2-server`)
- [ ] Aktuelle Secret-ID-TTL bekannt
  ```bash
  vault read auth/approle/role/mcp-approval2-server/role-id
  vault list auth/approle/role/mcp-approval2-server/secret-id
  ```
- [ ] Deployment-Pipeline (Cloud Run) kann Secret-Mounts re-mounten

### 2.2 Neue Secret-ID generieren

```bash
NEW_SID=$(vault write -f auth/approle/role/mcp-approval2-server/secret-id \
  -format=json | jq -r '.data.secret_id')
echo "$NEW_SID" | gpg --armor --encrypt -r operator@<kunde>.example.com > new-sid.gpg
```

### 2.3 In GCP Secret Manager schreiben

```bash
echo -n "$NEW_SID" | gcloud secrets versions add VAULT_SECRET_ID --data-file=-
```

Cloud Run picked die neue Version beim naechsten Deploy (oder via `gcloud run services update` mit `--update-secrets`):
```bash
gcloud run services update mcp-approval2 --region=eu-west1 \
  --update-secrets VAULT_SECRET_ID=VAULT_SECRET_ID:latest
```

### 2.4 Alte Secret-ID destroyen

**Erst nach erfolgreichem Health-Check!**

```bash
# Health-Check
curl https://<kunde>.mcp.example.com/healthz | jq '.dependencies.vault'
# Erwartet: { "status": "ok", "last_token_age_ms": <kleiner Wert> }

# Erst dann alte Secret-IDs cleanen
OLD_SID_ACCESSORS=$(vault list -format=json auth/approle/role/mcp-approval2-server/secret-id \
  | jq -r '.[]')
for accessor in $OLD_SID_ACCESSORS; do
  # NICHT den frisch erzeugten löschen — Accessor des neuen aus 2.2 zwischenspeichern
  vault write auth/approle/role/mcp-approval2-server/secret-id-accessor/destroy \
    secret_id_accessor="$accessor"
done
```

### 2.5 Audit-Events

- `vault.approle.secret_id.rotated`
- `vault.approle.secret_id.destroyed` (alte)

### 2.6 Rollback

Schwierig — wenn die alte Secret-ID schon destroyed ist, kein Rollback moeglich. Mitigation: vor destroy einen Health-Check, sonst neue Secret-ID nochmal erzeugen + redeploy.

---

## 3. INTERNAL-Service-Token

Pre-shared Bearer-Token fuer den Reverse-Pfad: mcp-knowledge2 (und andere First-Party-Services) rufen `mcp-approval2 /internal/v1/*` mit diesem Token auf. Verwendet fuer GDPR-Cascade, Audit-Forwarding, etc.

Siehe `MCP_APPROVAL_INTERNAL_TOKEN` in [src/lib/config.ts](../../apps/server/src/lib/config.ts).

### 3.1 Pre-Flight

- [ ] Aktuelle Token-Version bekannt (`vault kv get -format=json kv/mcp-approval2/internal | jq '.data.metadata.version'`)
- [ ] mcp-approval2-Code unterstuetzt `MCP_APPROVAL_INTERNAL_TOKEN` + `MCP_APPROVAL_INTERNAL_TOKEN_PREVIOUS` (dual-accept) — wenn nicht: vor Rotation einen Patch + Deploy

### 3.2 Generieren

```bash
NEW_TOKEN=$(openssl rand -hex 48)
```

### 3.3 Roll-Out (dual-accept)

```bash
# 1) Neuen Token in OpenBao schreiben + previous-Feld setzen
OLD_TOKEN=$(vault kv get -format=json kv/mcp-approval2/internal | jq -r '.data.data.token')
vault kv put kv/mcp-approval2/internal \
  token="$NEW_TOKEN" \
  previous="$OLD_TOKEN"

# 2) mcp-approval2 redeploy — akzeptiert beide Tokens
gcloud run services update mcp-approval2 ...

# 3) Verifikation: mcp-knowledge2-Auth-Calls weiterhin OK
curl https://<kunde>.mcp.example.com/healthz | jq '.dependencies.internal_token'

# 4) mcp-knowledge2 redeploy mit dem neuen Token
gcloud run services update mcp-knowledge2 ...

# 5) Smoke: mcp-knowledge2 → mcp-approval2 /internal/v1/audit ping
curl https://<kunde>.knowledge.mcp.example.com/v1/admin/smoke/internal-auth
# Erwartet: { "status": "ok" }
```

### 3.4 Cutover

Nach 24h Overlap:
```bash
# previous Feld leeren
vault kv put kv/mcp-approval2/internal token="$NEW_TOKEN"
# mcp-approval2 redeploy (accepts only current)
```

### 3.5 Audit-Events

- `service.internal_token.rotated`
- `service.internal_token.previous_removed`

### 3.6 Rollback

Wenn nach Schritt 4 Authentication-Failures:
```bash
# previous wieder als token setzen
vault kv put kv/mcp-approval2/internal \
  token="$OLD_TOKEN" \
  previous="$NEW_TOKEN"
# mcp-approval2 redeploy
# mcp-knowledge2 redeploy mit OLD_TOKEN
```

---

## 4. Google-OAuth-Client-Secret

`GOOGLE_CLIENT_SECRET` ist single-secret, kein Overlap moeglich. Rotation = Brief-Downtime fuer Login-Flow (Sekunden, bis Redeploy durch ist).

### 4.1 Pre-Flight

- [ ] Maintenance-Window kommunizieren (Pilot: 5 min Login-Outage)
- [ ] GCP-Console-Access zum OAuth-Client
- [ ] Backup-Login fuer Admin (z.B. emergency-access-Recovery-Token im Safe)

### 4.2 Neuen Secret in GCP erzeugen

1. GCP Console → APIs & Services → Credentials → OAuth Client
2. "Add Secret" (GCP unterstuetzt 2 active Secrets gleichzeitig)
3. Neues Secret kopieren

### 4.3 In OpenBao + GCP Secret Manager schreiben

```bash
vault kv put kv/mcp-approval2/google \
  client_id="<unchanged>" \
  client_secret="<new>"

echo -n "<new>" | gcloud secrets versions add GOOGLE_CLIENT_SECRET --data-file=-
```

### 4.4 Redeploy + Verifikation

```bash
gcloud run services update mcp-approval2 ...
# Login-Smoke (in Inkognito-Browser)
# → Google-Login + Callback → Session sollte greifen
```

### 4.5 Altes Secret in GCP loeschen

GCP Console → "Delete old secret"

### 4.6 Audit-Events

- `oauth.google.client_secret.rotated`

### 4.7 Rollback

Wenn Login-Smoke failt:
- GCP Console → altes Secret wieder aktivieren (innerhalb 30 Tagen moeglich)
- OpenBao + Secret Manager zurueck auf alte Version
- Redeploy

---

## 5. Multi-Service-Rotation-Sequenz

Bei einem groesseren Compromise wo **alles** rotiert werden muss — Reihenfolge:

1. Google-OAuth-Client-Secret (4) — Login-Flow zuerst absichern
2. OpenBao-AppRole Secret-ID (2) — Server-Vault-Auth absichern
3. KEK-Rotation in OpenBao Transit (siehe [runbook-incident-response.md §2.2 C](runbook-incident-response.md))
4. INTERNAL-Service-Token (3) — Service-Boundary absichern
5. RS256-JWT-Signing-Keys (1) — Token-Trust absichern
6. **Alle aktiven User-Sessions revoken:**
   ```bash
   curl -X POST https://<kunde>.mcp.example.com/v1/admin/sessions/revoke-all \
     -H "Authorization: Bearer <admin>"
   ```
7. Audit-Event `admin.sessions.revoke_all` schreiben

Gesamt-Downtime mit Drill: ~15 min. Ohne Drill: ~2h.

---

## 6. Drill-Checkliste

Pro Klasse mindestens 1x / Quartal:
- [ ] Vollstaendige Rotation durchspielen (in Staging-Env)
- [ ] Smoke-Test gruen
- [ ] Audit-Eintraege im Log vorhanden
- [ ] Rollback testen
- [ ] Drill-Report in `docs/incidents/drills/<klasse>-<datum>.md`

---

## 7. Acceptance-Kriterien fuer Production

- [ ] Alle 4 aktiven Klassen haben dokumentierte LastRotation + NextRotationDue
- [ ] OpenBao-KV2-Versioning aktiv (mind. 5 Versionen retained)
- [ ] Cloud Run Secret Manager Auto-Pickup verifiziert
- [ ] JWKS Multi-Key-Support live (im aktuellen Code: TODO Phase 7)
- [ ] Dual-Accept fuer INTERNAL_TOKEN live (im aktuellen Code: TODO Phase 7)
- [ ] Alle Rotations triggern Audit-Events
- [ ] Operator hat mind. 1 Drill durchgefuehrt
