# PLAN — mcp-approval2 Architektur (Greenfield, Multi-User, Portable)

> **Status: ⚠️ ENTWURF v0 — Decision-Document vor Code-Beginn**
>
> Erstellt: 2026-05-13. Ziel: ein internes MCP-Server-System fuer ein
> Unternehmen (5-15 Pilot-User, spaeter potenziell mehr), das gleichzeitig
> als persoenliches Tool nutzbar bleibt (Solo-Owner-Use-Case). Keine
> Implementation, sondern Architektur-Decisions die VOR der ersten Code-
> Zeile zu treffen sind. Jede `⚠️`-Markierung ist eine Entscheidung die
> mit Operator durchgegangen werden muss.
>
> Vorlauf-Konversation: 2026-05-13 Diskussion ueber Multi-User-Strategien
> fuer [mcp-approval](https://github.com/axel-rogg/mcp-approval).
> Entscheidung: kein Refactor des Bestand-Repos, sondern Greenfield
> in diesem Repo mit Lessons-Learned + selektivem Code-Reuse.
> Begleitende Subagent-Recherche: Multi-User-SaaS-Patterns, MCP-Protokoll-
> Spec (Nov 2025), Credential-Storage-Patterns (siehe Sektion 6).

---

## 1. Zweck und Anforderungen

### 1.1 Harte Anforderungen

1. **Multi-User von Tag 0** — keine `'bearer'`-als-Sentinel, keine
   `ALLOWED_EMAILS[0]`-Hardcoding. Tenant- und User-Identity sind
   First-Class-Citizens im Type-System.
2. **Portable Runtime** — derselbe Code laeuft auf Cloudflare Workers
   UND auf Self-Host (Node/Bun/Deno + Postgres + S3-kompatibel + Vector-DB).
   Begruendung: privater Use-Case auf CF, Firma-Use-Case on-prem oder
   in Firma-Cloud — keine Doppel-Codebase.
3. **Credential-Sicherheit absolut** — externe Service-Credentials
   (OAuth-Refresh-Tokens, API-Tokens fuer Jira/Confluence/GitLab/GitHub,
   Passwords wo unvermeidbar) duerfen NICHT durch Dritte auslesbar sein,
   inklusive Server-Operator. Verlangt mindestens Envelope-Encryption +
   externem KEK-Provider; optional WebAuthn-PRF fuer hochsensitive
   Credentials.
4. **DSGVO/Compliance-tauglich** — Right-to-Export, Right-to-Erasure
   (Crypto-Shredding), Audit-Log immutable, Datenresidenz konfigurierbar.
5. **MCP-Spec-Compliant** (Nov 2025 Update) — OAuth 2.1 + PKCE +
   Resource-Indicators (RFC 8707), Dynamic Client Registration
   unterstuetzt fuer Claude.ai-Clients.
6. **WYSIWYS-Prinzip** beibehalten — was die Approval-UI zeigt, wird
   ausgefuehrt. Kein Tool laeuft ohne Approval-Signoff fuer State-
   modifying-Operationen.

### 1.2 Nicht-Ziele (explizit aus dem Scope)

- Multi-Cloud-Active-Active (ein Deployment laeuft auf einer Runtime,
  nicht gleichzeitig auf mehreren).
- Confidential Computing / TEE (Cloudflare Workers + Container-Hosts
  unterstuetzen das nicht produktiv).
- Threshold-Cryptography (Shamir Secret Sharing) — operativ unverhaeltnis-
  maessig fuer <100 User.
- E2E-Encryption fuer User-Content (Memos/Docs/Skills) — bricht Tool-
  Execution, weil Worker Plaintext braucht.

### 1.3 Skalierungs-Annahmen

| Phase | User | Tenants | Tool-Calls/Tag |
|---|---|---|---|
| Pilot Q1 | 5-15 | 1 (eine Firma) | 1-5k |
| Pilot Q2-Q4 | 15-50 | 1-3 | 10-50k |
| Hypothetisch Q5+ | 50-200 | 1-10 | 100-500k |

Architektur muss bis Phase 3 ohne Re-Plattformierung tragen. Multi-Tenant
in einer Instanz statt N Worker-Forks — das ist der wesentliche
Unterschied zum bestehenden mcp-approval-Setup.

---

## 2. Architektur-Uebersicht

```
   MCP-Client (Claude.ai / Claude Code / Custom)
        │
        │ HTTPS, MCP-Streamable-HTTP, OAuth 2.1 + PKCE
        ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  mcp-approval2 (portable Hono.js)                            │
   │                                                              │
   │  Request-Lifecycle:                                          │
   │  ┌──────────────────────────────────────────────────────┐    │
   │  │ 1. TLS-Termination (CF / Reverse-Proxy)              │    │
   │  │ 2. OAuth 2.1-Resource-Server: JWT validieren,        │    │
   │  │    resolve (tenant_id, user_id, scopes)              │    │
   │  │ 3. Rate-Limit pro user + pro tenant                  │    │
   │  │ 4. Tenant-Context in Hono c.set() injizieren         │    │
   │  │ 5. RLS-GUC setzen (Postgres) ODER scoped-DB-Wrapper  │    │
   │  │    (SQLite/D1)                                       │    │
   │  │ 6. Tool-Dispatch via Registry, Capability-Check      │    │
   │  │ 7. Credential-Resolver fuer Sub-Tool-Auth (JIT)      │    │
   │  │ 8. Approval-Gate fuer State-modifying Tools          │    │
   │  │ 9. Tool-Execution + IPI-Output-Filter                │    │
   │  │ 10. Audit-Log emit + Response                        │    │
   │  └──────────────────────────────────────────────────────┘    │
   │                                                              │
   │  Adapter-Layer (Runtime-agnostisch):                         │
   │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐         │
   │  │ DbAdapter│ │BlobAdapter│ │ VecAdapter│ │ AiAdapter│       │
   │  └──────────┘ └──────────┘ └──────────┘ └──────────┘         │
   │      │            │             │             │              │
   │      ▼            ▼             ▼             ▼              │
   └──────┼────────────┼─────────────┼─────────────┼──────────────┘
          │            │             │             │
   ┌──────┴──┐  ┌──────┴──┐  ┌───────┴──┐  ┌───────┴──┐
   │ Postgres│  │   S3    │  │  Qdrant  │  │  vLLM    │  ← Self-Host
   │ (+RLS)  │  │ (MinIO/ │  │ (Multi-  │  │ (OpenAI- │
   │         │  │  R2/AWS)│  │  Tenant) │  │  API)    │
   └─────────┘  └─────────┘  └──────────┘  └──────────┘
          │            │             │             │
          ▼            ▼             ▼             ▼
   ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌──────────┐
   │   D1    │  │   R2    │  │Vectorize │  │workers-ai│  ← CF Workers
   └─────────┘  └─────────┘  └──────────┘  └──────────┘
```

**Schluessel-Design-Prinzipien:**

1. **Tenancy ist orthogonal zu Runtime.** Multi-User funktioniert auf
   CF Workers genauso wie auf Postgres-Self-Host. Adapter-Layer
   abstrahiert nur das WO.
2. **Tenant-Context fliesst durch jeden Layer.** Hono-Middleware setzt
   ihn nach Auth, DB-Adapter erzwingt ihn bei jedem Query, Crypto
   bindet ihn als AAD, Audit-Log enthaelt ihn pflichtmaessig.
3. **Defense-in-Depth bei Isolation.** Postgres: RLS. SQLite/D1: scoped
   Repository-Wrapper. Smoke-Test pro Endpoint: User A's Token darf
   User B's Daten nicht erreichen.
4. **Crypto-Provider als Strategie.** Lokal (Master+HKDF) fuer Dev,
   Vault/OpenBao fuer Production, KMS fuer Cloud-Native. Plus
   optionales PRF-Layer fuer hochsensitive Credentials.

> ⚠️ **Decision 2-A:** Wird der erste Production-Deploy CF Workers
> oder Self-Host? Beide moeglich, aber CI/Smoke-Pipeline und Default-
> Storage-Adapter mussen jeweils angepasst sein. **Empfehlung:**
> Self-Host (Postgres) als Primary, weil das die Multi-Tenant-Story
> komplett ist (RLS). CF-Mode als Sekundaer, wenn die Pilot-Firma
> CF erlaubt.

---

## 3. Identity & Authentication

### 3.1 User-Identity-Modell

```
tenant_id    UUID   — eine Firma / Org-Unit
user_id      UUID   — eine Person, eindeutig im Tenant
external_id  TEXT   — IdP-Subject (z.B. Google sub, Azure oid)
email        TEXT   — fuer UI / Notification (NICHT als ID)
display_name TEXT
created_at   INTEGER
status       TEXT   — 'active', 'invited', 'suspended', 'deleted'
```

**Wichtig:** `email` ist KEIN Primary-Key. Email-Adressen aendern sich
(Heirat, Domain-Wechsel), `external_id` aus dem IdP bleibt stabil.
Mapping `(idp_provider, external_id) → user_id` ist die Auth-Bruecke.

### 3.2 IdP-Strategie

**Phase 1 (5-15 User):** eigenes Google-OAuth, kostet 0, ALLOWED_EMAILS
wird zur `tenants.allowed_email_domains`-Tabelle erweitert. Login-Flow
gibt einen sealed Session-Token, der `(tenant, user, email, claims)`
traegt.

**Phase 2 (Enterprise-Onboarding):** WorkOS AuthKit als unified
SSO-Provider (SAML/OIDC/Azure AD/Okta/Google Workspace) +
SCIM-Receiver. ~$125/Tenant/Monat, kein Selbst-Implementieren von
SAML (Empfehlung Subagent-Recherche, siehe §15).

**Was JETZT gebaut werden muss (auch wenn Phase 1):**

- `IdentityProvider`-Interface mit zwei Implementierungen:
  `GoogleOAuthProvider` (Phase 1) + `OidcProvider`-Stub (Phase 2-ready)
- Login-Endpoint gibt **Session-Token** zurueck (JWT, signed, kurzlebig
  ~30 min, refresh-rotation), NICHT direkt den IdP-Token
- Eigener Session-Token enthaelt: `sub=user_id`, `tid=tenant_id`,
  `iss=mcp-approval2`, `aud=mcp-approval2-api`, `exp`, plus
  `device_id` fuer Device-Trust

### 3.3 Session-Management

- **Refresh-Token-Rotation** (RFC 9700-Best-Practice): bei jedem
  Refresh wird der alte Refresh-Token revoked, neuer ausgegeben.
  Replay-Detection: alter Token erneut benutzt → komplette
  User-Session-Familie revoked, User wird zwangs-relogged.
- **Revocation-List** in Redis/KV (kurzlebig, 30 Tage TTL — passt
  zur Refresh-Token-Lifetime). Auf D1/SQLite-Setup: Tabelle
  `revoked_tokens(jti, revoked_at)` mit Cron-Sweep.
- **Device-Trust:** bei Login von neuem Browser/Device → Email-
  Notification + 24h-Cooldown auf High-Risk-Actions (Credential-
  Export, GDPR-Erase-Approve).

### 3.4 WebAuthn / Passkeys

- Mindestens **2 Passkeys pro User enrollen** (Pflicht-Onboarding-
  Schritt). Single-Passkey-Recovery ist UX-Killer.
- Synced-Passkey-Risk: iCloud/Google-Account-Kompromittierung leakt
  Passkeys. Fuer **Operator-Accounts (Tenant-Admin)** wird
  **Device-Bound-Hardware-Key** (YubiKey/Titan) als zweiter Faktor
  Pflicht.
- WebAuthn-Origin wird konfigurierbar (`BASE_URL`-Env-Var), nicht
  hartkodiert — Voraussetzung fuer Portable.

> ⚠️ **Decision 3-A:** Single-Tenant-Pilot mit einer Email-Domain
> (`@firma.de`)? Oder Multi-Tenant mit Tenant-Switcher in UI?
> **Empfehlung:** Single-Tenant fuer Pilot, Multi-Tenant-Code-Pfad
> trotzdem ab Tag 0 da (sonst Refactor in Phase 2). User sieht nie
> einen Tenant-Switcher in Phase 1.

> ⚠️ **Decision 3-B:** Wer ist erster Admin? Bootstrap-Problem: der
> erste User legt den Tenant an. Eigener Bootstrap-Endpoint mit
> Shared-Secret aus Env-Var (`BOOTSTRAP_TOKEN`) als One-Shot.

---

## 4. Authorization (Tenant-Isolation + Sharing)

### 4.1 Tenant-Isolation: zwei-stufige Defense

**Stufe 1 — DB-seitig (Postgres):** Row-Level Security ist Pflicht.

```sql
CREATE POLICY tenant_isolation ON documents
  USING (tenant_id = current_setting('app.current_tenant')::uuid);

CREATE POLICY user_can_read ON documents
  FOR SELECT USING (
    tenant_id = current_setting('app.current_tenant')::uuid
    AND (
      visibility = 'tenant'
      OR owner_id = current_setting('app.current_user')::uuid
      OR id IN (
        SELECT resource_id FROM share_grants
        WHERE granted_to = current_setting('app.current_user')::uuid
        AND revoked_at IS NULL
      )
    )
  );
```

Pro Request: Transaction oeffnen, `SET LOCAL app.current_tenant = '...'`
+ `SET LOCAL app.current_user = '...'` als Erstes. Selbst wenn ein
Tool-Code `WHERE tenant_id = ?` vergisst, returnt RLS 0 Rows
(fail-closed). **Pflicht-Pattern:** Connection-Pooler im Session-Mode
(z.B. Supavisor session-mode), NIE Transaction-Pooling — sonst
Race-Conditions zwischen `SET LOCAL` und Query.

**Stufe 2 — App-seitig (alle Adapter, auch SQLite/D1):**
Repository-Pattern erzwingen.

```ts
// ERLAUBT:
const docs = await ctx.db.scoped(tenantId, userId)
  .from('documents')
  .where({ kind: 'note' })
  .all();

// ESLint-VERBOTEN (no-restricted-syntax):
const docs = await ctx.db.raw().execute(
  'SELECT * FROM documents WHERE kind = ?', ['note']
);
// → CI-Fail. Bei berechtigtem Bedarf: explizit
//   `ctx.db.unsafe('reason: ...')` mit Code-Review-Pflicht.
```

`db.scoped(tenant, user)` injiziert WHERE-Clauses automatisch, plus
fuer Postgres-Pfad ein `SET LOCAL`. Single Public API, kein Tool
greift direkt auf den Connection-Pool zu.

### 4.2 Permission-Modell: ReBAC light → SpiceDB ab >50 User mit Sharing

**Phase 1 (5-15 User, simple Sharing):** App-Layer-Permissions in
Postgres.

```sql
CREATE TABLE share_grants (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL,
  resource_kind TEXT NOT NULL,  -- 'doc', 'skill', 'app'
  resource_id   UUID NOT NULL,
  granted_to    UUID NOT NULL,  -- user_id
  granted_by    UUID NOT NULL,
  scope         TEXT NOT NULL,  -- 'read' | 'write' | 'admin'
  granted_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  revoked_at    INTEGER
);

CREATE INDEX idx_share_grants_lookup
  ON share_grants(tenant_id, granted_to, revoked_at);
```

Zentraler `canAccess(user, action, resource)`-Helper. Jeder Query-Pfad
ruft den Helper VOR dem DB-Hit, RLS macht's nochmal DB-seitig. Defense-
in-Depth.

**Phase 2 (>50 User, Sharing across tenants, Marketplace):**
SpiceDB self-hosted. ReBAC mit Zanzibar-Faithfulness, ZedTokens loesen
das "New Enemy Problem". OpenFGA als guenstigere Alternative wenn
SpiceDB-Operator-Last zu hoch.

### 4.3 Sharing-Modelle entscheiden BEVOR Code

Wichtige Entscheidung — drei Sharing-Modi koennen alle gleich aussehen
und sind faktisch verschiedene Architekturen:

| Modus | Pattern | Komplexitaet |
|---|---|---|
| **Intra-User-only** | Keine Sharing-Tabelle, alles owner-scoped | Trivial |
| **Intra-Tenant-Sharing** | `share_grants` mit `granted_to` im selben Tenant | Mittel |
| **Cross-Tenant-Marketplace** | Public-Skills/Apps + Cross-Tenant-Grants + Authz-Reflektion | Hoch |

> ⚠️ **Decision 4-A:** Welches Sharing-Modell? **Empfehlung Phase 1:**
> Intra-Tenant-Sharing nur fuer Skills + Docs (User koennen Wissen
> teilen), Apps + Credentials bleiben strikt owner-only.

> ⚠️ **Decision 4-B:** Tenant-Admin-Rolle: kann der Admin User-Daten
> sehen? **Empfehlung:** Nein default, Admin kann nur User-Listen +
> Audit-Logs + Quotas sehen. Inhaltliche Daten nie. Wenn benoetigt:
> "Impersonation"-Feature mit Audit + User-Notification.

---

## 5. Credential-Storage (zentraler User-Use-Case)

> Dies ist der Kern der User-Frage: wie speichern wir Jira-Passwords,
> GitLab-PATs, OAuth-Refresh-Tokens sicher, sodass weder Dritte noch
> der Server-Operator selbst sie auslesen koennen.

### 5.1 Credential-Typen

| Typ | Beispiel | Lifetime | Refresh-Verhalten |
|---|---|---|---|
| `oauth_refresh` | Google, GitHub, Atlassian, GitLab OAuth | 7-90 Tage | auto-refresh bei jedem Tool-Call |
| `api_token` | GitLab PAT, GitHub PAT, Confluence API-Token | Monate-Jahre | manuell-rotiert |
| `password` | Jira Basic-Auth (legacy) | beliebig | manuell |
| `service_account` | GCP-Service-Account-JSON | Schluessel-abhaengig | manuell |
| `ssh_key` | Git-Push-Keys | beliebig | manuell |
| `mtls_cert` | Client-Cert + Key + CA-Chain | Monate-Jahre | manuell |

Jeder Typ hat dieselbe Encryption-Architektur, andere Lifecycle.

### 5.2 Encryption-Layer (Envelope-Encryption + optional PRF)

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 5 (optional Hardening): WebAuthn-PRF-XOR              │
│   nur fuer markierte hochsensitive Credentials               │
│   PRF-Output XORed mit DEK; Decryption nur user-anwesend     │
├─────────────────────────────────────────────────────────────┤
│ Layer 4: KEK (Key-Encryption-Key) — pro User                │
│   Provider-pluggable:                                        │
│    - LocalKekProvider (Dev): HKDF(master, salt=user_id)      │
│    - VaultTransitKekProvider (Self-Host Prod):               │
│        OpenBao Transit-Engine, Key verlaesst Vault NIE       │
│    - CloudKmsKekProvider (Cloud): AWS/GCP/Azure KMS          │
│   KEK wird NICHT in der DB gespeichert (Vault haelt sie)     │
├─────────────────────────────────────────────────────────────┤
│ Layer 3: DEK (Data-Encryption-Key) — pro Credential          │
│   Random 32-Byte AES-256-GCM-Key, NUR fuer dieses Secret     │
│   DEK wird mit KEK gewrapped (AES-GCM, Vault-Operation)      │
│   Wrapped-DEK in DB-Spalte `wrapped_dek` gespeichert         │
├─────────────────────────────────────────────────────────────┤
│ Layer 2: AAD-Bindung                                         │
│   `creds|{tenant}|{user}|{provider}|{type}|{credential_id}` │
│   Bindet ciphertext an Kontext — Replay/Substitution unsafe  │
├─────────────────────────────────────────────────────────────┤
│ Layer 1: Ciphertext in DB                                    │
│   AES-256-GCM, random 12-Byte Nonce, mit AAD                 │
└─────────────────────────────────────────────────────────────┘
```

### 5.3 Schema

```sql
CREATE TABLE credentials (
  id              UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  user_id         UUID NOT NULL,             -- owner
  provider        TEXT NOT NULL,             -- 'jira', 'gitlab', 'github', 'confluence'
  kind            TEXT NOT NULL,             -- 'oauth_refresh' | 'api_token' | 'password' | ...
  label           TEXT NOT NULL,             -- user-facing name, z.B. 'work-jira'

  -- Crypto-Material
  ciphertext      BYTEA NOT NULL,            -- AES-GCM(plaintext)
  nonce           BYTEA NOT NULL,            -- 12 bytes
  wrapped_dek     BYTEA NOT NULL,            -- Vault.encrypt(dek, kek_ref)
  aad             TEXT NOT NULL,             -- 'creds|{tenant}|{user}|{provider}|{kind}|{id}'
  kek_ref         TEXT NOT NULL,             -- 'vault://transit/keys/tenant-7?version=3'
  alg             TEXT NOT NULL DEFAULT 'A256GCM',

  -- Optional: PRF-Layer
  prf_required    BOOLEAN NOT NULL DEFAULT FALSE,
  prf_credential_id BYTEA,                   -- WebAuthn-Credential-ID, fuer PRF-Lookup

  -- Metadata (plaintext, fuer Listing ohne Decrypt)
  meta_json       JSONB,                     -- scopes, host, etc.

  -- Lifecycle
  created_at      INTEGER NOT NULL,
  rotated_at      INTEGER,
  last_used_at    INTEGER,
  expires_at      INTEGER,                   -- fuer oauth_refresh, api_token

  UNIQUE (tenant_id, user_id, provider, label)
);

CREATE INDEX idx_creds_user ON credentials(tenant_id, user_id);
CREATE INDEX idx_creds_expires ON credentials(expires_at)
  WHERE expires_at IS NOT NULL;

-- RLS
CREATE POLICY tenant_isolation_creds ON credentials
  USING (tenant_id = current_setting('app.current_tenant')::uuid
         AND user_id = current_setting('app.current_user')::uuid);
-- Credentials sind STRICTLY owner-only, kein Sharing
```

### 5.4 KEK-Provider — drei Implementierungen

#### A) `LocalKekProvider` (nur Dev / Single-Node-Self-Host)

```ts
class LocalKekProvider implements KekProvider {
  constructor(private master: Uint8Array) {}

  async wrap(dek: Uint8Array, tenantId: string, userId: string) {
    const kek = await hkdf(this.master, salt(tenantId, userId));
    return aesGcmEncrypt(kek, dek);
  }
  async unwrap(wrapped: Uint8Array, tenantId: string, userId: string) {
    const kek = await hkdf(this.master, salt(tenantId, userId));
    return aesGcmDecrypt(kek, wrapped);
  }
}
```

Master-Key liegt als Env-Var/Worker-Secret. **Akzeptabel** fuer:
- Solo-User Self-Host (Privat-Setup, ein Operator = Owner = User)
- Dev / Smoke-Test

**Nicht akzeptabel** fuer:
- Multi-User-Production (Operator hat Plaintext-Zugriff = bricht das
  Versprechen "darf Operator nicht auslesen")

#### B) `VaultTransitKekProvider` (Self-Host Production, Empfehlung)

```
Vault/OpenBao laeuft als separater Service.
Transit-Engine: Encrypt-as-a-Service.
Pro Tenant ein Key: vault://transit/keys/tenant-{id}
mcp-approval2 hat kurzlebigen Vault-Token (AppRole, 1h TTL).

DEK wrap: POST /v1/transit/encrypt/tenant-{id} {plaintext: dek}
          → ciphertext
DEK unwrap: POST /v1/transit/decrypt/tenant-{id} {ciphertext}
          → dek

Key verlaesst Vault NIE. Operator-Compromise von mcp-approval2 leaked
Vault-Token, aber nicht Master-Material. Token-Rotation regelmaessig.

Audit: Vault loggt jede Encrypt/Decrypt-Operation separat — forensik-
fest, kann nicht durch mcp-approval-Operator manipuliert werden.
```

OpenBao statt Vault: MPL2-Open-Source-Fork, kein BSL-Lizenz-Risk
(2026-Stand). Funktional aequivalent fuer Transit-Engine. Empfehlung
Subagent.

#### C) `CloudKmsKekProvider` (Cloud-Native Deploy)

- **AWS KMS**: pro Tenant ein KMS-Key, mcp-approval2 hat IAM-Role
  mit `kms:Encrypt`/`kms:Decrypt` auf den Key-Ring. Key liegt in
  AWS-HSM, kommt nie raus.
- **GCP KMS / Azure Key Vault**: aequivalent.
- **Cloudflare Secrets Store**: **NICHT geeignet als per-user-KEK-
  Store** (2025-Beta, account-scoped). Nutzbar fuer Worker-Secrets
  (Vault-Token, KMS-Credentials), nicht als KEK-Quelle.

### 5.5 PRF-Layer (Optional Hardening)

Nur fuer als `prf_required=TRUE` markierte Credentials.

```
WebAuthn-Authentifizierung mit PRF-Extension:
  navigator.credentials.get({
    publicKey: {
      challenge: <random>,
      allowCredentials: [{id: prf_credential_id, type: 'public-key'}],
      extensions: { prf: { eval: { first: aadAsSalt } } }
    }
  })
  → prfOutput (32 bytes, deterministisch fuer denselben User+Salt)

DEK-Decryption:
  rawDek = vault.unwrap(wrapped_dek)
  effectiveDek = xor(rawDek, prfOutput)
  plaintext = aesGcmDecrypt(effectiveDek, ciphertext, aad)
```

**Threat-Coverage:**
- Operator-Compromise: hat Vault-Access, kann `rawDek` bekommen, aber
  ohne PRF-Output kein `effectiveDek` → kein Plaintext.
- User muss bei jedem Use anwesend sein (Passkey-Prompt) → fuer
  Sub-Tools die im Hintergrund laufen (z.B. Cron-Tools) ist PRF
  ungeeignet → opt-in pro Credential.

**Production-Readiness:** Chrome/Edge/Safari 18+/Firefox 148+
unterstuetzen PRF (Stand 2026). Firefox <148 und alte Windows-Builds
nicht — als opportunistic upgrade, nicht Hard-Requirement.

**Recovery-Killer:** PRF-Output ist credential-spezifisch. Verliert
User alle Passkeys, sind PRF-protected Credentials **endgueltig
verloren**. Mitigation:
1. Mindestens 2 enrollte Passkeys
2. Recovery-Path: User re-OAuth'd / re-API-Token-paste, das ist
   vertretbar fuer einzelne Credentials, nicht fuer Daten-Recovery

> ⚠️ **Decision 5-A:** PRF von Anfang an oder nachtraeglich? **Empfehlung:**
> Schema von Anfang an PRF-ready (`prf_required` + `prf_credential_id`
> Spalten), Implementierung optional in Phase 2. User-Flag pro
> Credential: "extra-secure" → triggert PRF-Enrollment.

> ⚠️ **Decision 5-B:** Welcher KEK-Provider als Production-Default?
> **Empfehlung:**
> - Pilot mit eigener Vault/OpenBao-Instance (10€-VPS reicht fuer
>   Pilot-Volume)
> - Wenn Firma eigene KMS hat (Azure Key Vault, AWS KMS): den nutzen
>   statt Vault, weniger Operations-Last
> - Wenn Cloudflare-First-Deploy: KMS via API von Workers callen,
>   nicht Cloudflare Secrets Store

### 5.6 OAuth-Refresh-Flow (besonderer Lifecycle)

OAuth-Tokens haben ein eigenes Refresh-Pattern:

```
User-Tool-Call → 
  Credential-Resolver fetched (wrapped_dek + ciphertext)
  → Vault.unwrap → DEK
  → optional PRF-Lookup
  → AES-GCM-Decrypt → refresh_token (plain, in Memory)
  → Token-Exchange mit Provider:
       POST https://oauth2.provider.com/token
            grant_type=refresh_token, refresh_token=...
       → access_token (1h), new refresh_token (manchmal)
  → If new refresh_token: re-encrypt + persist
  → access_token in Memory-Cache (Request-scoped) → API-Call
  → Memory-Cache discard nach Response
```

**Token-Rotation-Sicherheit:** wenn Provider neuen Refresh-Token
ausgibt, **alten sofort revoken-Versuch** (best-effort, nicht alle
Provider unterstuetzen das). Replay-Detection: wenn alter Refresh-
Token nochmal benutzt wird → mark suspicious, alle Credentials des
Users markieren fuer Re-Auth.

**REAUTH_REQUIRED-Sentinel:** wenn Refresh fehlschlaegt (invalid_grant
nach Provider-Side-Revoke), Tool returnt klare Error-Response
`{ status: 'REAUTH_REQUIRED', provider: 'jira', reauth_url: '...' }`.
MCP-Client zeigt User Re-Auth-Prompt (MCP-Elicitation).

### 5.7 Sub-MCP-Server (Jira, Confluence, GitLab) — Credential-Verteilung

Heute in mcp-approval: Sub-Worker (mcp-gws, etc.) speichern Tokens
selbst. **Greenfield-Entscheidung:** zentralisieren oder dezentralisieren?

**Empfehlung: zentralisieren** — alle Credentials in mcp-approval2-
DB, Sub-MCP-Server bekommen JIT-Token via interne API.

```
Sub-MCP-Server (z.B. mcp-jira) → 
  GET https://mcp-approval2/internal/credentials/{user}/{provider}
  Authorization: Bearer <service-account-token>
  → { access_token: '...', expires_at: ... }  (short-lived, request-scoped)
```

Vorteile:
- Einheitliche Encryption-Story (ein Vault, ein Audit-Log)
- Single-Point-of-Rotation
- Re-Auth-UX unified in einer PWA, nicht pro Sub-Server

Nachteile:
- Sub-MCP-Server abhaengig von mcp-approval2-Availability
- Bei Network-Partition Sub-Tools tot
- Mitigation: short-Cache (5 min) in Sub-Server fuer aktive Sessions

> ⚠️ **Decision 5-C:** Zentral oder dezentral? **Empfehlung:** zentral,
> wenn Sub-MCP-Server im selben Netz/Cluster laufen. Dezentral akzeptabel
> wenn Sub-MCP-Server an Drittparteien gehosted werden (z.B. Vendor
> betreibt Jira-MCP, Firma betreibt mcp-approval2 — dann Cross-Org-
> Trust-Boundary).

### 5.8 Threat-Modell-Matrix

| Bedrohung | Local | Vault | Vault+PRF |
|---|---|---|---|
| DB-Leak (Snapshot/Dump) | broken (Master in Env) | safe (KEK extern) | safe |
| Operator-Compromise (Code-Owner) | broken | partial (Vault-Token leakt, kein Plain) | safe (kein Plain ohne User) |
| Memory-Dump on live Worker | window (DEK in Memory) | window (DEK in Memory) | window (DEK + PRF in Memory waehrend Request) |
| Cross-User-Leak (Bug-Class) | mitigiert nur wenn AAD korrekt | safe (Vault prueft Key-Ring) | safe |
| Network-MITM | TLS-abhaengig | TLS-abhaengig | TLS-abhaengig |
| Insider-Attack (anderer User) | safe (per-user-KEK) | safe | safe |
| Cold-Backup-Leak (alte DB-Snapshots) | broken (Master kann gleich bleiben) | safe (Vault-Key-Rotation) | safe |

### 5.9 GDPR-Crypto-Shredding

Right-to-Erasure (Art. 17) ist mit Envelope-Encryption elegant
loesbar:

```
User-Delete-Trigger:
  1. Soft-Delete-Marker auf user_id (30-Tage-Grace)
  2. Nach 30 Tagen: Hard-Delete
     a) Vault.destroyKey('transit/keys/tenant-X-user-Y')
     b) DELETE credentials WHERE user_id = ...
     c) DELETE user-content-rows (objects/docs/skills/apps/memos)
     d) audit_log Eintrag bleibt (Pseudonym ersetzt PII)
```

**EDPB-Position (2026):** Crypto-Shredding (Key-Destruction) wird als
Erasure anerkannt, sofern Ciphertext nachweisbar unrecoverable ist.
Vault-Key-Destroy + Ciphertext-bleibt-im-Cold-Backup ist akzeptiert.

---

## 6. Audit-Logging

### 6.1 Anforderungen

| Standard | Forderung |
|---|---|
| SOC2 CC7.2 | All security events logged, immutable, 1 Jahr online |
| ISO27001 A.12.4 | Event-Logging, Operator-Activities, Fault-Logging |
| GDPR Art. 30 | Records of Processing Activities — Per-User-Actions |

### 6.2 Schema

```sql
CREATE TABLE audit_log (
  id            UUID PRIMARY KEY,
  ts            INTEGER NOT NULL,
  tenant_id     UUID NOT NULL,
  actor_user_id UUID,                    -- NULL fuer System-Events
  actor_type    TEXT NOT NULL,           -- 'user' | 'system' | 'admin'
  action        TEXT NOT NULL,           -- 'auth.login.success', 'credential.read', ...
  resource_kind TEXT,
  resource_id   UUID,
  before_hash   TEXT,                    -- sha256 von resource state before
  after_hash    TEXT,                    -- sha256 von resource state after
  ip            INET,
  user_agent    TEXT,
  request_id    UUID,                    -- correlation-id
  result        TEXT NOT NULL,           -- 'success' | 'denied' | 'error'
  details       JSONB                    -- struktuierte Extra-Info, KEINE Plaintext-Secrets
);

CREATE INDEX idx_audit_tenant_ts ON audit_log(tenant_id, ts DESC);
CREATE INDEX idx_audit_actor ON audit_log(actor_user_id, ts DESC);
```

**Append-only enforcement:** DB-User der App hat NUR `INSERT`-Recht
auf `audit_log`. Kein `UPDATE`, kein `DELETE`. Operator-Admin-Account
kann lesen, aber nicht modifizieren.

### 6.3 Was loggen — Pflicht-Events

- **Auth:** `auth.login.success`, `auth.login.failed`, `auth.logout`,
  `auth.session.refresh`, `auth.passkey.enrolled`, `auth.passkey.revoked`
- **Permission:** `permission.granted`, `permission.revoked`,
  `permission.escalation_attempted`
- **Credential:** `credential.created`, `credential.read` (jeder
  Decrypt!), `credential.rotated`, `credential.deleted`
- **Data:** `data.created`, `data.read` (nur sensitive resources),
  `data.exported`, `data.deleted`
- **Admin:** `admin.user.created`, `admin.user.suspended`,
  `admin.settings.changed`, `admin.impersonation_started`
- **Tool:** `tool.invoked` (mit args-hash, NICHT plaintext),
  `tool.approved`, `tool.denied`, `tool.completed`

### 6.4 Off-Site Cold-Archive

- Monatlich audit_log → encrypted JSON → S3-Object-Lock (WORM)
  oder R2-mit-Compliance-Retention
- 7 Jahre Aufbewahrung (SOC2-Default), kann pro Tenant konfiguriert
  werden
- Audit-Log-Export ist eigener Tool-Call mit Admin-Approval

> ⚠️ **Decision 6-A:** SIEM-Integration noetig (Sentinel, Splunk,
> Datadog)? **Empfehlung:** OpenTelemetry-Emit als optional Feature,
> default off. Wenn Pilot-Firma SIEM hat, OTel-Endpoint konfigurieren.

---

## 7. Storage-Adapter (Portable Runtime)

### 7.1 Interface-Hierarchie

```ts
interface DbAdapter {
  scoped(tenant: string, user: string): ScopedDb;
  unsafe(reason: string): RawDb;          // Code-Review-Pflicht
  transaction<T>(fn: (tx: ScopedDb) => Promise<T>): Promise<T>;
  migrate(): Promise<void>;
}

interface BlobAdapter {
  put(key: string, body: Uint8Array | ReadableStream, meta?: BlobMeta): Promise<void>;
  get(key: string): Promise<ReadableStream | null>;
  head(key: string): Promise<BlobMeta | null>;
  delete(key: string): Promise<void>;
  list(prefix: string, cursor?: string): AsyncIterator<BlobMeta>;
}

interface VecAdapter {
  upsert(namespace: string, vectors: VectorRecord[]): Promise<void>;
  query(namespace: string, vector: Float32Array, opts: QueryOpts): Promise<Match[]>;
  delete(namespace: string, ids: string[]): Promise<void>;
}

interface AiAdapter {
  embed(model: string, texts: string[]): Promise<Float32Array[]>;
  chat(model: string, messages: ChatMessage[], opts?: ChatOpts): Promise<ChatResponse>;
  // OpenAI-compatible-Subset
}

interface KekProvider {
  wrap(dek: Uint8Array, ref: KekRef): Promise<Uint8Array>;
  unwrap(wrapped: Uint8Array, ref: KekRef): Promise<Uint8Array>;
  rotate(oldRef: KekRef, newRef: KekRef): Promise<void>;
}
```

### 7.2 Adapter-Implementierungen

| Adapter | CF Workers | Self-Host (Postgres) | Self-Host (SQLite) | Dev |
|---|---|---|---|---|
| Db | D1 + Drizzle | Postgres + Drizzle + RLS | SQLite + Drizzle | SQLite |
| Blob | R2 (S3-API) | MinIO / AWS S3 | local FS | local FS |
| Vec | Vectorize | Qdrant / pgvector | sqlite-vss (limited) | sqlite-vss |
| Ai | workers-ai | vLLM (OpenAI-API) / OpenAI direct | Ollama | Ollama |
| Kek | KMS via API | OpenBao | LocalKekProvider | LocalKekProvider |

**Drizzle als ORM:** First-Class RLS-Support fuer Postgres (`pgPolicy`,
`crudPolicy`), funktioniert auch fuer SQLite mit Dialect-Branches.
Workers-Support voll. Empfehlung Subagent gegen Prisma (Prisma-Workers
2026 noch wonky) und gegen Kysely (kein RLS-Helper).

**Caveat Drizzle:** Schema fuer Postgres und SQLite ist NICHT 1:1.
JSONB, ILIKE, Timestamp-Handling, RLS sind Postgres-only. Pragmatisch:
zwei Schema-Files (`schema.pg.ts` / `schema.sqlite.ts`) mit shared
`types.ts` fuer Domain-Typen. Query-Layer in einem Repository-Pattern
abstrahieren.

**Qdrant als Vector-DB:** First-Class Multi-Tenant-Namespaces, kein
manueller Query-Filter noetig. pgvector als Alternative wenn Postgres
ohnehin im Stack, brauchbar bis ~5M Vektoren/Tenant. **sqlite-vss
SKIP fuer Production** — kein produktiver Multi-Tenant-Support.

**vLLM als Self-Host AI:** OpenAI-kompatible API (Embeddings + Chat),
180+ concurrent requests vs Ollamas 40 bei H100 (Subagent-Benchmark).
Ollama nur als Dev-Tool. Embeddings: bge-m3 oder nomic-embed-text-v2.

### 7.3 Cron-Triggers portabel

CF-Worker hat native Cron-Triggers. Self-Host nicht.

**Loesung:** Cron-Jobs sind HTTP-Endpoints (`POST /internal/cron/{task}`),
External Scheduler (systemd-timer / node-cron / k8s-CronJob / GitHub-
Actions-Schedule) callt sie. CF-Mode: `scheduled()`-Handler callt
intern denselben Endpoint. **Ein Code-Pfad, zwei Trigger-Sources.**

### 7.4 Migration aus mcp-approval (Code-Reuse)

**Uebernehmen 1:1 (battle-tested, subtil):**

| Quelle | Ziel | Anmerkung |
|---|---|---|
| `src/crypto/` (AES-GCM, HKDF, AAD-Konventionen) | `lib/crypto/` | Encryption-Primitive, wenig zu aendern |
| `src/auth/webauthn.ts` | `lib/auth/webauthn.ts` | Origin-Logik konfigurierbar machen, sonst gleich |
| `src/auth/google.ts` | `lib/auth/idp/google.ts` | hinter `IdentityProvider`-Interface |
| `migrations/*` | `migrations/postgres/` + `migrations/sqlite/` | Schema-Branches, neu portieren |
| Push-Notification-VAPID | `lib/push/` | unveraendert |
| `pwa/*` Approval-UI | `app/` | Re-Theme + Multi-User-Login + Tenant-Switcher |

**Uebernehmen als Inspiration (Pattern, neuer Code):**

- Approval-Flow (`pending_approvals`-Tabelle, WebAuthn-Sign-Off)
  — wird user-scoped from-day-1
- IPI-Output-Filter — bleibt Konzept, neue Implementation mit
  Tool-Sanitization-Pass
- Apps-Subsystem (Composable-UI-Blocks) — wahrscheinlich NICHT
  im Pilot-Scope, spaeter portieren wenn benoetigt

**Wegwerfen:**

- 65 der 80 Tools (Skills-System, Apps-System, Composable-UI,
  Capability-Search — alles overkill fuer Pilot)
- D1-Region wnam → neuer Postgres-Cluster in weur, oder D1
  weur-only
- 5-Sub-Worker-Komplexitaet → start mit 1 Worker + Sub-MCP-Server
  on-demand (Jira/Confluence/GitLab kommen wenn Pilot-User sie
  brauchen)

---

## 8. MCP-Protokoll-Compliance (Nov 2025)

### 8.1 Auth-Pflichten

MCP-Spec (Nov 2025 Update) macht **OAuth 2.1 + PKCE Pflicht** fuer
public-remote-Server. Resource-Indicators (RFC 8707) Pflicht gegen
"confused deputy"-Attacks.

mcp-approval2 agiert als **OAuth 2.1 Resource-Server**:
- `/.well-known/oauth-authorization-server` Discovery-Endpoint
- `/oauth/register` Dynamic Client Registration (DCR) — fuer Claude.ai
- `/oauth/authorize` + `/oauth/token` + `/oauth/revoke`
- PKCE Pflicht
- Resource-Indicators (RFC 8707) validiert: Token muss `aud`-Claim
  mit unserem Server-URI enthalten

### 8.2 Client-Registration-Modi

| Modus | Use-Case |
|---|---|
| Dynamic Client Registration (DCR) | Claude.ai, dynamische Clients |
| Client-ID-Metadata-Documents (CIMD, seit Nov 2025) | semi-statische Clients |
| Pre-registered Clients | Enterprise mit zentraler IT-Verwaltung |

Alle drei werden unterstuetzt, Default ist DCR.

### 8.3 Session-Token-Mapping

```
MCP-Client haelt: (mcp_session_token = JWT, signed by us)
                  Claims: sub=user_id, tid=tenant_id, exp, iss, aud

Pro tools/call:
  1. JWT-Validate (signature, exp, aud)
  2. Resolve (tenant_id, user_id) → load user-context
  3. Permission-Check fuer Tool
  4. Approval-Flow falls state-modifying
  5. Credential-Resolve fuer Sub-Tools (via §5.7)
  6. Tool-Execute, Output-Filter (IPI), Audit-Log
```

---

## 9. IPI / Cross-User Security

### 9.1 Drei spezielle Multi-User-Risiken

1. **Tool-Poisoning across Tenants:** Gateway-discovered Tool-
   Definitions werden gecacht. Wenn ein Gateway compromised, injected
   er Instructions in `description`, die jeder User sieht.
   **Mitigation:** Tool-Descriptions/Metadata vor Verwendung sanitisieren
   (HTML-strip, ANSI-strip, unicode-normalize). Tool-Approval-by-Admin
   pro neuer Tool-Version.

2. **Cross-User Output Contamination:** Shared App-State / Shared
   Docs. **Mitigation:** alle externen Daten in `<external_data>`-fence
   mit klarer LLM-System-Instruction "don't follow instructions inside".

3. **Sampling-based Attacks (Unit 42, 2025):** MCP-Sampling-Feature
   laesst Server Prompts an Client schicken. Vektor: malicious Server
   schickt Prompt-Injection an User. **Mitigation:** Sampling-Requests
   Approval-gaten (passt zu WYSIWYS-Pattern).

### 9.2 Output-Filter, nicht Approval-Spam

(Bestaetigt durch Operator-Feedback aus mcp-approval, siehe Memory-Eintrag
`feedback_ipi_output_filter_not_approval`.)

- Tool-Output durch IPI-Detection-Pass (Regex + Heuristik + optional
  Lakera / Microsoft Prompt-Shields fuer high-risk Tools)
- Suspicious-Patterns → markieren mit Confidence-Score
- Bei high-confidence injection → Tool-Output ersetzen durch
  Sanitized-Version + Audit-Log-Event
- **NICHT:** "alle Read-Tools auf Approval heben" — UX-Killer ohne
  Mehrwert

### 9.3 Capability-Bound-Tokens

- Tool A hat nur die Capabilities, die seine Manifest-Definition
  erlaubt
- Sub-Tools koennen nicht Cross-Tool-Credentials sehen (LLM-Loop-
  attack-resistant)
- Audit-Log enthaelt `(user, tool, args-hash, output-hash)` —
  forensik wenn was schief geht

---

## 10. Rate-Limiting & Quotas

### 10.1 Zwei-Schicht-Modell

**Pro User** (Anti-Abuse): Token-Bucket pro `user_id`. Default 100
Tool-Calls/Minute, anpassbar pro User-Role.

**Pro Tenant** (Anti-Noisy-Neighbor): Quota pro `tenant_id` taeglich.
Default 10k Tool-Calls/Tag im Pilot. Schuetzt vor:
- Einzelne Tenants die Anthropic-API-Quotas sprengen
- Cost-Runaway durch buggy User-Skript

### 10.2 Implementation

- **CF Workers:** `cf.rateLimit`-API + Durable Object als Counter
- **Self-Host:** Redis + token-bucket-Lib (`@upstash/ratelimit` oder
  manuell), oder Postgres-basiert fuer keine-Redis-Setups

### 10.3 Cost-Controls

- AI-Inference (Embeddings + Chat) hat eigenen Counter
- Pro Tenant Tages-USD-Budget (z.B. $10/User/Tag default)
- Soft-Limit: Warning-Toast in UI
- Hard-Limit: Tool-Block + Admin-Notification

---

## 11. Onboarding / Offboarding

### 11.1 Onboarding-Flow (Phase 1)

```
1. Tenant-Admin invitet User via Email:
   POST /admin/invites { email, tenant_id, default_role }
   → Email-Link mit signed Invite-Token (24h TTL)

2. User klickt Link → /accept-invite?token=...
   → Google-OAuth-Login (must match invited email)
   → User-Record erstellt (status='active')
   → Passkey-Enrollment (Pflicht, mindestens 2)
   → Welcome-PWA mit naechsten Schritten

3. User connectet externe Services on-demand:
   → 'Connect Jira' → OAuth-Redirect → Refresh-Token gespeichert
   → 'Add GitLab PAT' → Form mit PAT-Input → encrypted-stored
```

### 11.2 Offboarding-Flow

```
Tenant-Admin: 'Suspend User' →
  - User-Status → 'suspended'
  - Alle aktiven Sessions revoken
  - 30-Tage-Grace-Period
  - Audit-Log emit

Nach 30 Tagen ODER 'Delete User' sofort:
  - GDPR-Erase-Trigger
  - Vault.destroyKey(tenant-X-user-Y)
  - DELETE FROM credentials WHERE user_id = ...
  - DELETE FROM <user-content-tables> WHERE owner_id = ...
  - audit_log Eintrag bleibt (PII pseudonymisiert)
```

### 11.3 SCIM-Provisioning (Phase 2)

RFC 7644-konformer Endpoint:
- `/scim/v2/Users` (Pflicht: GET, POST, PATCH — Azure AD nutzt
  NUR PATCH, kein PUT)
- `/scim/v2/Groups` (Group-Membership = Role-Assignment)
- Deprovisioning sofort: SCIM-Delete = User-Suspend + Tokens-Revoke +
  Credential-Crypto-Shred

> ⚠️ **Decision 11-A:** SCIM in Phase 1 schon stubben, oder erst
> Phase 2? **Empfehlung:** Interface da, Endpoints stubben mit 501-
> Response, vollstaendig in Phase 2.

---

## 12. Recovery-Flows

### 12.1 Lost Passkey

- **Mindestens 2 Passkeys** pro User enrollen. Wenn einer weg:
  zweiter funktioniert.
- Wenn alle weg:
  1. Email-Verification (signed Magic-Link)
  2. 24h-Cooldown auf High-Risk-Actions
  3. Re-Enrollment Passkey
  4. Wenn PRF-protected Credentials: Daten weg, User muss
     re-OAuth/re-API-Token fuer jeden Provider

### 12.2 Account-Takeover-Prevention

- Sign-in-from-new-device → Email-Notification
- Sign-in-from-new-country → Email + 24h-Cooldown
- Synced-Passkey-Risk: Tenant-Admin-Accounts brauchen Hardware-Key
  (YubiKey/Titan) als zweiten Faktor

### 12.3 Master-Key-Loss

Wenn `LocalKekProvider`: Master-Key-Verlust = alle Credentials weg.
Mitigation: Master-Key in 2 Places (Worker-Secret + Offline-Backup).

Wenn `VaultKekProvider`: Vault hat eigenes Backup. Vault-Cluster-
Loss = Catastrophe. Vault-Backup-Strategy Pflicht.

Wenn `KmsKekProvider`: Cloud-Provider haftet fuer Key-Persistence.
Trotzdem Audit-Trail fuer Key-Lifecycle.

---

## 13. Open Decisions — Phase 0 Checkliste

(Konsolidiert aus den ⚠️-Markern. Pre-Implementation-Pflicht.)

**Architektur:**
- [ ] §2-A: First Production-Deploy CF Workers oder Self-Host?
- [ ] §3-A: Single-Tenant Pilot oder Multi-Tenant-UI ab Tag 1?
- [ ] §3-B: Bootstrap-Admin-Flow festlegen
- [ ] §4-A: Sharing-Modell (Intra-User / Intra-Tenant / Cross-Tenant)
- [ ] §4-B: Tenant-Admin-Rights — Impersonation ja/nein
- [ ] §5-A: PRF-Layer von Anfang an oder Phase 2
- [ ] §5-B: KEK-Provider fuer Production-Default
- [ ] §5-C: Credential-Storage zentral oder dezentral pro Sub-MCP-Server
- [ ] §6-A: SIEM-Integration aktiv oder optional
- [ ] §11-A: SCIM Phase 1 stub oder Phase 2 nichts

**Tech-Stack-Bestaetigung:**
- [ ] Hono.js als Framework — bestaetigt
- [ ] Drizzle als ORM — bestaetigt
- [ ] Postgres als Primary DB (Self-Host), D1 als CF-Workers-Alternative — bestaetigt
- [ ] Qdrant + pgvector + Vectorize als Vec-Trio — bestaetigt
- [ ] vLLM (Prod) + Ollama (Dev) + OpenAI (Cloud-Fallback) — bestaetigt
- [ ] OpenBao als Vault — Lizenz-Klaerung mit Unternehmen
- [ ] WorkOS als SSO-Provider — Budget-Klaerung fuer Phase 2

**Operativ:**
- [ ] Pilot-Firma: Cloud-Hosting-Vorgaben (CF erlaubt, Azure, AWS, on-prem)?
- [ ] Pilot-Firma: SIEM/Audit-Sink vorhanden?
- [ ] Pilot-Firma: SSO/IdP-Vorgaben (Azure AD Tenant-Verfuegbarkeit)?
- [ ] Pilot-Firma: DPA + Datenresidenz-Anforderungen
- [ ] Engineering-Bandbreite: 9-12 Wochen verfuegbar? Solo oder Team?

---

## 14. Roll-Out-Phasen

**Phase 0 — Decisions + Setup (1-2 Wochen):**
- Open Decisions §13 alle durchgegangen
- Tech-Stack final bestaetigt
- mcp-approval2-Repo-Skeleton (package.json, tsconfig, monorepo-Layout)
- CI-Setup (build, test, lint, RLS-Smoke)
- Decision-Records (ADRs) committed

**Phase 1 — Skeleton + Auth (Woche 3-4):**
- Hono + Drizzle Postgres-Skeleton
- IdP-Interface + Google-OAuth-Provider
- Session-JWT-Issuer + Refresh-Rotation
- WebAuthn-Enrollment + Login
- Bootstrap-Admin-Flow

**Phase 2 — Tenancy + Credential-Store (Woche 5-7):**
- Tenants/Users/Roles-Schema + RLS-Policies
- KekProvider-Interface + LocalKekProvider + VaultTransitKekProvider
- credentials-Tabelle + Envelope-Encryption
- credential.CRUD-Tools (mit Approval)
- Audit-Log immutable

**Phase 3 — MCP-Protocol-Server (Woche 8-9):**
- OAuth 2.1 + PKCE + DCR Endpoints
- MCP-Streamable-HTTP-Transport
- Tool-Registry + Tool-Dispatch
- Approval-Flow (WebAuthn-signed) + WYSIWYS-PWA

**Phase 4 — Tool-Surface + Sub-MCP (Woche 10-12):**
- 10-15 Core-Tools portiert
- IPI-Output-Filter
- Internal Credential-API fuer Sub-MCP-Server
- Erster Sub-MCP-Server (Jira oder GitLab) als Test

**Phase 5 — Pilot-Hardening (Woche 13-14):**
- Rate-Limits + Quotas
- GDPR-Tools (Export, Erase)
- Smoke-Test-Suite (RLS-Tests Pflicht)
- Doku + Runbook fuer Pilot-Onboarding
- Production-Deploy + Pilot-Start

**Total bis Pilot-Start: 12-14 Wochen.** Realistisch 14-18 mit
Engineering-Slack.

---

## 15. Reuse-Mapping aus mcp-approval

Was wir aus dem bestehenden Repo uebernehmen vs neu schreiben:

| Domain | Bestand | Greenfield |
|---|---|---|
| Crypto-Primitive | `src/crypto/` | reuse (lib/crypto/) |
| WebAuthn | `src/auth/webauthn.ts` | reuse + multi-user-anpassung |
| Google-OAuth | `src/auth/google.ts` | reuse hinter IdP-Interface |
| Migration-Patterns | `migrations/*` | neu (Drizzle-Migrations) |
| Tools (~80) | 80 | 10-15 portiert |
| Storage-Layer | `src/objects/api.ts` | komplett neu mit Adapter |
| MCP-Server | `src/mcp/*` | neu (Streamable-HTTP-Conform-2025) |
| Approval-Flow | `src/approve/*` | neu (multi-user-aware) |
| PWA | `assets/app.js` | neu (Multi-User-Login, Tenant-aware) |
| Gateway-Pattern | `src/gateway/*` | neu (zentralisiertes Credential-Store) |
| Sub-MCP-Server | mcp-gws/utils/etc | bleiben separate Repos, neue Auth |
| knowledge-core | Source-of-Truth | evt. uebernehmen mit Filter-Audit |

---

## 16. Referenzen

**Externe Quellen (Subagent-Recherche 2026-05-13):**

- [WebAuthn PRF Production Readiness](https://www.corbado.com/blog/passkeys-prf-webauthn)
- [Envelope-Encryption-Pattern](https://n.demir.io/articles/envelope-encryption-the-security-pattern-every-cloud-developer-should-know/)
- [HashiCorp Vault vs OpenBao](https://digitalis.io/post/choosing-a-secrets-storage-hashicorp-vault-vs-openbao)
- [Drizzle ORM RLS Docs](https://orm.drizzle.team/docs/rls)
- [SpiceDB / ReBAC / Zanzibar](https://authzed.com/docs/spicedb/concepts/zanzibar)
- [GDPR Crypto-Shredding](https://oneuptime.com/blog/post/2026-02-17-how-to-set-up-crypto-shredding-for-gdpr-right-to-erasure-compliance-in-google-cloud/view)
- [MCP Authorization Spec (Anthropic)](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [MCP Spec Updates Nov 2025](https://auth0.com/blog/mcp-specs-update-all-about-auth/)
- [MCP Sampling Attack Vectors](https://unit42.paloaltonetworks.com/model-context-protocol-attack-vectors/)
- [SCIM Provisioning B2B SaaS](https://www.descope.com/blog/post/scim-providers-b2b-saas)
- [SOC2 Audit Log Requirements](https://marutitech.com/ultimate-soc2-audit-logs-tech-guide/)
- [pgvector vs Qdrant Comparison](https://www.tigerdata.com/blog/pgvector-vs-qdrant)
- [Ollama vs vLLM Production Benchmark](https://developers.redhat.com/articles/2025/08/08/ollama-vs-vllm-deep-dive-performance-benchmarking)
- [Refresh Token Rotation (RFC 9700)](https://www.serverion.com/uncategorized/refresh-token-rotation-best-practices-for-developers/)
- [IDOR Prevention OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html)
- [Synced Passkey Bypass Risks (Q4 2025)](https://thehackernews.com/2025/10/how-attackers-bypass-synced-passkeys.html)

**Bestand-Referenzen (mcp-approval):**

- `CLAUDE.md` — aktuelle Architektur, Single-User-Konventionen
- `docs/plans/active/PLAN-multi-user-isolation.md` — verworfene
  Strategie-B2-Variante, Vorlage fuer Kontext
- `docs/runbooks/runbook-auth-and-access.md` — bestehende Auth-Doku

---

**Naechster Schritt:** Open Decisions §13 mit Operator durchgehen,
DANN Phase 0 starten. Kein Code vor abgeschlossener Decision-Liste.
