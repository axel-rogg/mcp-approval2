# Threat-Synthesis 2026-05-17 — Master-Übersicht

> **Trigger:** User-Frage 2026-05-17: "Was müssen wir noch berücksichtigen? Es gibt Grenzen die wir vielleicht nicht erfüllen können. Man will ja daten die wir in mcp-knowledge2 speichern teilbar machen aber auch verschlüsseln."
> **Quellen:** 4 parallele Spezialisten-Briefs (Crypto, Identity, Operations, Privacy) plus vorherige Cross-Cutting-Review.
> **Files:**
> - `docs/security/THREAT-REVIEW-2026-05-17.md` (Cross-Cutting, ~2400 Wörter)
> - `/tmp/threat-spec-crypto.md` (1780 Wörter)
> - `/tmp/threat-spec-identity.md` (1880 Wörter)
> - `/tmp/threat-spec-ops.md` (1695 Wörter)
> - `/tmp/threat-spec-privacy.md` (1713 Wörter)
> - `THREAT-MODEL.md` (Baseline: Secret-Storage at-rest + erweiterte Sektionen)

---

## 1. Executive Summary

mcp-approval2 + KC2 haben eine **überdurchschnittlich starke App-Schicht** (RLS, AES-GCM mit AAD, KMS-Envelope, WebAuthn-UV, OAuth-2.1 + PKCE + DCR, Audit-Pseudonymisierung, PII-Mask, Erase-Cascade). Die echten Probleme liegen woanders:

1. **Drei strukturelle Trilemmas** sind durch Code nicht lösbar — sie sind Policy-/Topology-Entscheidungen:
   - **E2EE × Server-Side-Search × Sharing** (Crypto) → man kann zwei haben, nicht drei
   - **Recovery × Zero-Trust gegen Operator** (Identity K1) → jeder Recovery-Pfad ist Hintertür
   - **Right-to-Erase × Active-Backups × Plaintext-Embeddings** (Privacy + Crypto) → sofort vollständig löschen geht nicht
2. **Ops-Schicht ist defended-by-hope.** Restore-Drill nie gelaufen, R2-Object-Lock inaktiv, kein WORM-Audit, effektiv keine Alerts, Bus-Faktor=1 ohne Treuhänder-Pfad.
3. **Privat-Pilot ist NICHT DSGVO-light.** Art. 2(2)c-Ausnahme greift bei 5-15 Testern nicht. Axel ist Verantwortlicher, alle Cloud-Anbieter sind Auftragsverarbeiter.
4. **Zwei real-existing god-mode-Secrets** (`JWT_SECRET` HS256, `MCP_KNOWLEDGE_SERVICE_TOKEN` legacy) sind heute ohne Token-Invalidierung nicht rotierbar — der Doppler-Leak vom 2026-05-16 hat das real gemacht.
5. **Per-User-KEK fehlt.** Heute teilen alle User dasselbe Master + Salt — ein gephishter Freund kann andere mit-leaken. Stufe-2-Hardening ist im Privat-Pilot *wichtiger* als im Corporate (Blast-Radius statt Compliance).

---

## 2. Master-Themenliste (was die 4 Specs gefunden haben)

Codierung: **C** = Crypto-Spec, **I** = Identity-Spec, **O** = Ops-Spec, **P** = Privacy-Spec, **X** = Cross-Cutting.

### 2.1 Daten-System-Zugriff
| # | Thema | Domäne |
|---|---|---|
| 1 | E2EE-Trilemma: Server-Side-Embeddings + FTS5 + Sharing nicht beide voll erfüllbar | C |
| 2 | `description` + `title` + `keywords` sind plaintext in DB (FTS5-Anforderung) | C |
| 3 | Sharing-Bodies: heute `501 shared-body-not-implemented` — Empfänger sieht nur Metadaten | C |
| 4 | Embedding-Inversion-Attacks: 30-90% Token-Rekonstruktion aus Vector möglich | C |
| 5 | Vertex AI / Cloudflare-AI-Gateway sieht plaintext Embedding-Source | C, P |
| 6 | `disable_data_retention=true` für Vertex im Code nicht verifiziert | P |
| 7 | Body-Revisions (`object_revisions`) bei Erase nicht cascadiert | C |
| 8 | `MCP_KNOWLEDGE_SERVICE_TOKEN` ist god-mode gegen KC2; Scope-Split-Tokens code-ready, Doppler-Werte fehlen | X, O |
| 9 | OBO-JWT-Forgery via `JWT_RS256_PRIVATE_KEY_PEM`-Leak = universeller KC2-Bypass | X |

### 2.2 Identity / Auth / Recovery
| # | Thema | Domäne |
|---|---|---|
| 10 | HS256 für MCP-Access-Tokens (`JWT_SECRET`) — Symmetric, Leak = Total-Forgery aller Sessions | I, X |
| 11 | Sub-MCP-User-JWT nutzt denselben `JWT_SECRET` — Worker-Compromise = approval2-Session-Forge | I |
| 12 | Auth-Middleware Revocation-Hook vorhanden aber nicht beschaltet — kein global Revoke ohne Ablauf | I |
| 13 | Recovery-vs-Zero-Trust (K1): Email-Compromise = Total-Account-Takeover trotz Passkey | I |
| 14 | Recovery-Magic-Link `rawToken` plaintext im `email_outbox` → Operator-DB-Read = Highjack | I |
| 15 | Multi-Origin-Passkey (K2): 3 Origins × 2 Devices = 6 Passkeys pro User; Apex ohne A-Record | I |
| 16 | Write-Mode (240min) ohne per-Call-UV, ohne Anomaly-Cap → Tab-Hijack-Multiplikator | I |
| 17 | `BOOTSTRAP_ADMIN_EMAIL` warn-only statt fail-CLOSED in production | I |
| 18 | Refresh-Token-Lookup ist sequenz SELECT+UPDATE statt atomic — paralleler Refresh schlüpft durch | I |
| 19 | Keine CSP / X-Frame-Options / Referrer-Policy aktiv | I |
| 20 | CSRF-Schutz nur auf `/admin/kc-proxy/*`, nicht auf `/auth/*` oder `/oauth/*` | I |
| 21 | Hard-Dependency Google-OIDC: User-Suspend = kein Login mehr | I |
| 22 | Claude.ai-Client-Token-Storage out-of-our-control; Revocation greift erst nach 30 min | I |

### 2.3 Operations / Backup / Forensik
| # | Thema | Domäne |
|---|---|---|
| 23 | Restore-Drill nie scharf gefahren; RPO/RTO unbenannt | O |
| 24 | Neon Free-Tier 6h-PITR ist zu klein | O |
| 25 | R2 Object-Lock / Versionierung Out-of-Band-TF, vermutlich nicht aktiviert | O |
| 26 | GCP-KMS-Key-Loss-Recovery hat keinen Plan; Doppler-Lockout = Stack-Total-Loss | O |
| 27 | Cross-Region-DR existiert nicht (Single-region fra) | O |
| 28 | Audit-Log fail-soft (`audit.ts:71-74`); kein WORM-Mirror, kein DB-Trigger | O, X |
| 29 | Effektiv keine Alerts: OTel No-Op-Stub; nur Daily-Smoke als Detection | O |
| 30 | Approval-Display-Templates rendern Plaintext-Tool-Args in DB + Logs | O |
| 31 | Container-Base-Image (`node:22-alpine`) nicht SHA-pinned | O |
| 32 | GH-Actions tag-pinned (`@v4`, `@master`), nicht SHA-pinned | O |
| 33 | Kein `npm audit` als CI-Fail-Gate | O |
| 34 | Incident-Playbook ist V1/Hetzner-Welt; Fly + GCP nicht abgebildet | O |
| 35 | Bus-Faktor=1, kein Recovery-Material bei Treuhänder | O |
| 36 | Cost-Anomaly-Detection fehlt komplett (Vertex-Loop = 50+ €/Tag möglich) | O |

### 2.4 Crypto-Hygiene
| # | Thema | Domäne |
|---|---|---|
| 37 | Per-User-KEK fehlt — Master-Leak + `dek_salt` = alle User-DEKs ableitbar | C |
| 38 | `destroyKey` ist Memory-Only-Flag; HKDF rederiviert KEK nach Restart | C |
| 39 | KEK-Master `CLOUD_KMS_WRAPPED_MASTER_B64` lebt nur in Doppler — kein Offline-Backup | C, O |
| 40 | Backup-Boundary endet bei Cloud-Provider-Key, nicht user-DEK (R2-Token + Master = decryptable) | C |
| 41 | KEK-Rotation `rotate(old,new)` ist No-Op; kein Re-Wrap-Code-Pfad | C |
| 42 | AES-GCM-Hygiene ist sauber (Nonce random, AAD pipe+assertNonEmpty) — **kein Bug** | C |
| 43 | WebAuthn-PRF-Layer existiert für Credentials, nicht für KC2-Objects | C |
| 44 | Quantum-Resistance: RSA-2048 (JWT-Sign, SA-JSON) harvest-now-decrypt-later anfällig | C |

### 2.5 Privacy / DSGVO / Compliance
| # | Thema | Domäne |
|---|---|---|
| 45 | Privat-Ausnahme Art. 2(2)c greift NICHT für 5-15 Tester | P |
| 46 | Keine Datenschutzerklärung in PWA | P |
| 47 | Sub-Prozessor-Liste für Privat nicht ausgefüllt; keine signed DPAs | P |
| 48 | 6 von 9 Anbietern haben US-Mutter; CLOUD-Act + Schrems-II, keine TIAs | P |
| 49 | Doppler sieht Plaintext-Secrets — DPA-pflichtig sobald nicht-Axel-User | P |
| 50 | PII-Mask: 7 Regex-Klassen; Namen/Adressen/Diagnosen/freier Text bleiben | C, P |
| 51 | Sharing = Joint Controllership Art. 26 — UI + Konsens fehlen | P |
| 52 | Right-to-Erase + Neon-PITR: 6h-Restore-Window inverse Lösch-Anfrage | P |
| 53 | Right-to-Erase + R2-Backup (shared Key): Per-User-Erase aus Backups unmöglich | P, C |
| 54 | Right-to-Erase + pgvector: Inversion-Attacks bewahren Quasi-Personenbezug | P, C |
| 55 | Edge-Logs (Fly, CF, GCP) Retention nicht user-steuerbar | P |
| 56 | Incident-Notification-Template (Art. 33) als TODO markiert | P, O |

---

## 3. Master-Gegenüberstellung Privat (Freunde 5-15) vs. Corporate (VPC, 20-500)

Risiko-Codes: 🔴 CRITICAL / 🟠 HIGH / 🟡 MEDIUM / 🟢 LOW / ⚪ N/A

| # | Thema | Privat-Prio | Corporate-Prio | Realistic-Aufwand |
|---|---|---|---|---|
| **Trilemmas / Strukturell** | | | | |
| 1 | E2EE-Trilemma ehrlich kommunizieren | 🟠 (UI-Hint) | 🟠 (Marketing-Pflicht) | 30min Doku |
| 13 | K1 Recovery-vs-Zero-Trust | 🟠 (Operator-Transparenz) | 🔴 (MFA-Recovery Pflicht) | 4h vs 1 Woche |
| 52-54 | Erase-Konflikte mit Backup + Vector | 🟡 (ehrliche Doku reicht) | 🔴 (Crypto-Shred + Backup-Filter Pflicht) | 1h Doku vs 1 Woche |
| **App-Schicht** | | | | |
| 2 | Plaintext title/description | 🟡 (PWA-Hint im Editor) | 🟡 (User-Education + Klassifikation) | 30min |
| 3 | Sharing-Body nicht implementiert | 🟡 (Feature fehlt, nicht Bug) | 🟠 (Use-Case kritisch) | ~4 Tage Build |
| 4-6 | Embedding-PII-Leak | 🟠 (PII-Mask erweitern + `embed=false`-Default) | 🔴 (Egress-Filter oder Embed-Verzicht) | 2h vs 2 Wochen |
| 7 | object_revisions in Erase-Cascade | 🟠 | 🔴 | 2h |
| **God-Mode-Secrets** | | | | |
| 8 | KC2-Scope-Split-Tokens aktivieren (M3) | 🔴 sofort | 🔴 sofort | 30min Operator-Task |
| 9 | JWT_RS256-Key-Rotation (M4) | 🟠 | 🔴 | ~6h |
| 10 | HS256 → RS256 für Access-Tokens (M2) | 🟠 (vor 2. User) | 🔴 sofort | ~4h |
| 11 | Sub-MCP-JWT shared Secret | 🟡 | 🟠 | ~6h (RS256+JWKS) |
| **Identity / Recovery** | | | | |
| 12 | Revocation-Hook beschalten | 🟡 | 🟠 | ~1h |
| 14 | Recovery-Plaintext aus Outbox | 🟠 | 🔴 | ~3h |
| 15 | Related-Origin-File auf Apex (K2 fixen) | 🟠 (UX-blockierend) | 🟠 | ~6h |
| 16 | Write-Mode-Anomaly-Cap | 🟡 | 🟠 | ~4h |
| 19-20 | CSP + CSRF-Middleware | 🟠 | 🔴 | ~3h |
| 21 | Google-Hard-Dependency | 🟢 (akzeptieren) | 🟠 (Second IdP) | nicht lösen |
| **Operations** | | | | |
| 23 | Restore-Drill scharf fahren | 🔴 sofort | 🔴 sofort | ~30min |
| 25 | R2 Object-Lock aktivieren | 🔴 sofort | 🔴 sofort | ~10min |
| 26 | KMS-Key + Doppler Offline-Backup | 🔴 (Bus-Faktor) | 🔴 (Compliance) | ~2h |
| 27 | Cross-Region-DR | 🟢 (akzeptieren) | 🟠 | nicht im Pilot |
| 28 | Audit-Log Append-Only-Trigger + WORM-Sink | 🟠 (sozialer Vertrag) | 🔴 (M1, Compliance) | ~3h |
| 29 | GCP-Monitoring-Alerts (KMS-Rate, 5xx, Neon-Storage) | 🟠 | 🔴 | ~30min |
| 31-32 | Container + Action SHA-Pinning | 🟡 | 🟠 | ~2h |
| 34 | Incident-Playbook auf Fly/GCP aktualisieren | 🟠 | 🔴 | ~3h |
| 35 | Recovery-Material bei Treuhänder | 🔴 (Bus-Faktor 1) | 🟠 (Multi-Operator existiert) | ~2h |
| 36 | Cost-Anomaly + Billing-Budget | 🟠 (Vertex-Loop) | 🟠 | ~30min |
| **Crypto** | | | | |
| 37 | Per-User-KEK in KMS (Stufe 2) | 🔴 **wichtiger als Corporate** | 🟠 (Per-Tenant statt Per-User) | ~6-8h + 0.20 €/Mo |
| 38 | Crypto-Shred Persistent statt Memory-Flag | 🟠 | 🔴 (Art. 17) | ~1 Tag |
| 40 | R2-Backup mit user-DEK statt Provider-Key | 🟡 (akzeptieren + Doku) | 🔴 | nicht trivial |
| 43 | PRF-Wrap auf Refresh-Tokens + SA-JSON | 🟠 (sub-MCP-RAM-Theft) | 🟠 | ~6h |
| **Privacy** | | | | |
| 45 | DSGVO-Anwendbarkeit akzeptieren | 🔴 (Mind-Shift) | ⚪ trivial gegeben | 0h |
| 46 | Datenschutzerklärung `/privacy` | 🔴 | 🔴 | ~2h |
| 47 | Sub-Prozessor-Liste + DPAs | 🟠 | 🔴 | ~3h (DPAs einholen) |
| 48 | TIA pro Drittland-Transfer | 🟡 (ehrlich reduziert) | 🔴 | ~1h × 6 |
| 49 | Doppler-DPA + ggf. Vendor-Wechsel | 🟠 | 🔴 | ~1h für DPA |
| 50 | PII-Mask erweitern + Vertex retention=off | 🟠 | 🔴 | ~2h |
| 51 | Sharing-Konsens-Modal in PWA | 🟠 (sozial) | 🔴 (Art. 26) | ~1h Pilot, ~2 Tage Corporate |
| 56 | Incident-Notification-Mini-Plan (Art. 33) | 🟠 | 🔴 | ~1h |

---

## 4. Grenzen die wir realistisch NICHT erfüllen können (konsolidiert)

| # | Grenze | Begründung | Beste verbliebene Mitigation |
|---|---|---|---|
| G1 | **Echtes E2EE für Objects mit Server-Side-Search** | Embeddings brauchen Plaintext; FTS5 braucht Plaintext-Tokens; Trilemma | "Encrypted-at-rest mit Operator-Trust" ehrlich kommunizieren, nie "E2EE" labeln |
| G2 | **Title/Description verschlüsseln** | FTS5 funktioniert nicht über Ciphertext | PWA-Editor-Hint: "Geheimnisse gehören in Body" |
| G3 | **PII-Schutz in Embeddings für freien Text** | Regex erwischt strukturierte Pattern, nicht Namen/Adressen/Diagnosen | `embed=false`-Default für sensitive Memos + LLM-Pre-Mask wenn Budget |
| G4 | **Zero-Trust gegen Operator** | Jeder Recovery-Pfad ist by-design Hintertür für die primäre Auth | Operator-Activity sichtbar im User-Audit + sozialer Vertrag explizit |
| G5 | **Single-Sign-On über alle 3 Origins ohne 3-fach-Enroll** | Apex hat keinen A-Record; Related-Origin-File ist 6h Arbeit, aber kein 2h-Quickfix | Related-Origin-Setup (P3 Identity) oder eine Origin als Default verbindlich |
| G6 | **Hard-Dependency Google** | Google-Account-Suspend = kein Login-Pfad mehr, selbst mit Passkey | Second IdP (vervierfacht IdP-Code, im Privat nicht lohnend) |
| G7 | **Multi-Recipient-Crypto für Sharing** | Heute `501`; Build ist ~4 Tage Multi-Recipient AES-GCM + Re-Wrap-Tabelle | Phase 2; bis dahin Sharing = "Metadaten plus Body wirft 501" dokumentieren |
| G8 | **Sofortige + vollständige Löschung aus Backup** | Neon-PITR 6h-7d + R2-Backup mit shared Key | Per-User-KEK + Retention-Lapse + ehrliche Doku |
| G9 | **Crypto-Shredding ohne Per-User-KMS-Key** | HKDF rederiviert KEK aus Master | Per-User-CryptoKey in GCP-KMS (0.20 €/Mo bei 3 Usern) + persistent destroyed-refs |
| G10 | **CLOUD-Act-Resistenz für Fly-Worker-Memory** | Fly Inc. ist US, Memory ist plaintext | EU-SCCs + DPF + ehrliche TIA |
| G11 | **Erase aus Vertex AI < 72h** | Google-intern Black-Box | `disable_data_retention=true` verifizieren + DPF + Vertrauen |
| G12 | **Fly-Platform-Compromise / GCP-Account-Suspension / KMS-Key-Destroy ohne Offline-Master** | Single-Vendor-Pfade ohne Mitigation | Akzeptierte Restrisiken **explizit kommunizieren**, nicht verschweigen |
| G13 | **Quantum-Resistance** | RSA-2048 (JWT, SA-JSON) harvest-now-decrypt-later | Niemand löst das production heute; akzeptieren bis NIST-PQC mainstream |
| G14 | **Bus-Faktor 1 vollständig auflösen** | Solo-Operator-Modell; Multi-Operator wäre Architektur-Shift | Recovery-Material bei Treuhänder + 4-Wochen-Outage offen kommunizieren |
| G15 | **Vollständige Audit-Compliance ohne WORM** | Postgres-Audit-Log ist INSERT-only-by-convention | WORM-Sink (GCS Object-Lock) als M1, Trigger BEFORE UPDATE OR DELETE — aber kein Echtzeit-Tamper-Proof |

---

## 5. Pragmatische Empfehlung — was wirklich sinnvoll + machbar ist

### 5.1 Pilot-Mindest-Pflicht (Privat, vor Tester-Öffnung) — **~24h Operator-Sprint**

Diese Items sind **fast alle <4h einzeln**, aber konsolidiert schließen sie ~80% der wahrscheinlichen Pilot-Incident-Klassen.

| # | Item | Domäne | Aufwand |
|---|---|---|---|
| **Sofort (heute)** | | | |
| 1 | **M3** — KC2-Scope-Split-Tokens (`_ERASE/_SYNC/_OPS`) in Doppler setzen | X | 30min |
| 2 | **Restore-Drill** auf Neon-Branch-from-time scharf fahren | O | 30min |
| 3 | **R2 Object-Lock / Versionierung** verifizieren + aktivieren | O | 10min |
| 4 | **GCP-Monitoring-Alerts** (KMS-Rate > 100/min, Fly 5xx > 5%, Neon-Storage > 80%) | O | 30min |
| 5 | **GCP Billing-Budget** + Pub/Sub-Alert auf 20 €/Mo | O | 15min |
| 6 | **Vertex `disable_data_retention=true`** im Code verifizieren | P, C | 15min |
| 7 | **`BOOTSTRAP_ADMIN_EMAIL` fail-CLOSED in production** | I | 30min |
| **Diese Woche** | | | |
| 8 | **Audit-Log Append-Only-Trigger** + Pub/Sub → GCS-Object-Lock-Sink (M1) | O | ~3h |
| 9 | **Doppler-Backup** (GPG-export → externe SSD beim Treuhänder) + Recovery-Material aller 5 Konten | O | ~2h |
| 10 | **KMS-Master Offline-Decrypt-Test** + Master-Plaintext verschlüsselt zum Treuhänder | O, C | ~1h |
| 11 | **Recovery-Magic-Link rawToken** aus `email_outbox.body_html` raus | I | ~3h |
| 12 | **Operator-Activity-Sichtbarkeit** in User-PWA-Settings-Tab | I | ~4h |
| 13 | **PII-Mask erweitern** (Namen-Heuristik, Adressen, Datumsformate) | C, P | ~2h |
| 14 | **Datenschutzerklärung `/privacy`** in PWA | P | ~2h |
| 15 | **Sub-Prozessor-Liste** für Privat ausfüllen, DPAs der 9 Anbieter abrufen | P | ~3h |
| 16 | **Self-Service-Erase-Button** + Export-Button in PWA-Settings | P | ~1h |
| 17 | **Sharing-Konsens-Modal** vor Share-Aktion ("Geteilt bleibt geteilt") | P | ~1h |
| 18 | **PWA-Editor-Hint** "Titel ist suchbar = serverseitig sichtbar" | C | ~30min |
| 19 | **Tester-One-Pager** (Operator-Trust, Recovery-Pfad, Datenschutz, Kontakt) | I, P | ~1h |
| 20 | **Incident-Mini-Plan** (Art. 33 72h-Template, Kontakt-Liste) | P, O | ~1h |
| **Summe** | | | **~24h** |

### 5.2 Phase-2 (1-3 Monate nach Pilot-Start)

Diese werden Pflicht sobald *zweiter* Tester aktiv ist oder bei klarem Skalierungs-Signal.

| # | Item | Aufwand | Wert |
|---|---|---|---|
| 21 | **Per-User-KEK in GCP-KMS** (Stufe 2) — Blast-Radius pro User isolieren | ~6-8h + 0.20 €/Mo | sehr hoch |
| 22 | **Crypto-Shred Persistent** (DB-Tabelle `destroyed_user_refs` + Backup-Restore-Filter) | ~1 Tag | hoch |
| 23 | **HS256 → RS256** für MCP-Access-Tokens (M2) | ~4h | hoch |
| 24 | **JWT_RS256-Key-Rotation** mit kid-Pool + JWKS-Multi-Key (M4) | ~6h | hoch |
| 25 | **Related-Origin-File** auf Apex `ai-toolhub.org` (K2 fixen) | ~6h | hoch (UX) |
| 26 | **Write-Mode-Anomaly-Cap** (max 50 write-Calls pro Session) | ~4h | mittel |
| 27 | **Auth-Middleware Revocation-Hook** beschalten | ~1h | mittel |
| 28 | **CSP + secure-headers** Middleware | ~1h | mittel |
| 29 | **CSRF-Middleware** auf `/auth/*` + `/oauth/*` | ~2h | mittel |
| 30 | **PRF-Wrap** auf `_oauth_refresh_token` + `_service_account_json` | ~6h | hoch |
| 31 | **object_revisions in Erase-Cascade** | ~2h | hoch (DSGVO) |
| 32 | **Container + GH-Action SHA-Pinning** + Renovate-Digest-Tracking | ~2h | mittel |
| 33 | **Fly-Log-Drain** zu BigQuery/Cloud-Logging | ~30min | mittel |
| 34 | **PWA Session-List + Revoke-Button** | ~6h | mittel |
| 35 | **Sharing-Body Multi-Recipient-Crypto** (echtes shared body) | ~4 Tage | hoch (Feature) |
| **Summe Phase 2** | | **~10-12 Tage** | |

### 5.3 Was im Privat-Pilot zu lassen ist (Over-Engineering)

- Vollständiges E2EE für Objects — Trilemma, ehrlich kommunizieren reicht
- Client-Side-Embedding in WASM auf Mobile — Akku-Killer, 3s pro Schreiben
- Cloud HSM (Stufe 4) — State-Actor-Tier
- SSE / Deterministic Encryption auf description — bricht FTS5-DE/EN-Mix
- Selbst-gehostetes Embedding-Modell — 80 €/Mo Minimum
- mTLS zwischen Workloads — Fly-Org ist Single-Trust-Boundary
- 4-Augen-Operator-Workflow — Solo-Operator
- WORM-Sink in dedizierter SIEM — GCS-Object-Lock-Bucket reicht (~0 € bis 1 GB)
- Second IdP-Fallback (GitHub/Apple) — Code-Vervierfachung für seltenen Edge-Case
- Cross-Region-DR — Pilot kann 6h Single-Region-Outage tolerieren

### 5.4 Corporate-Pfad (eigenes Projekt, 4-6 Wochen)

Wenn der Stack je in Richtung 20+ User in regulierter Branche geht, ist das ein **Compliance-Programm**, kein Provider-Switch. Mindest-Programm aus Privacy-Spec §8:

- DPIA (DSB-freigegeben) — 1-3 Tage/Iteration
- Signed AVVs mit allen Sub-Prozessoren — 1 Woche Legal
- TIA pro Drittland-Transfer (~6 Stück) — 2 Tage
- Verarbeitungsverzeichnis (VVT) — 1 Tag
- Joint-Controller-Vereinbarung für Sharing — 2 Tage
- Right-to-Erase mit Crypto-Shred-Garantie + Backup-Sperre — 1 Woche Engineering
- Incident-Response 72h-Pipeline + quartalsweiser Drill — 2 Tage + ongoing
- DPO benannt — sofort
- WORM-Audit-Log + SIEM-Integration (M1) — bereits in Privat-Phase-1
- Workload-Identity-Federation statt SA-JSON (NIST-800-63) — 1 Woche
- Cloud HSM statt software-protected CryptoKey — 1 Tag Setup, +1.50 €/Key/Mo
- mTLS + Cert-Pinning + Egress-Allowlist im VPC — 1-2 Wochen
- Step-Up-Auth pro Tool-Sensitivity (per-Call WebAuthn-UV für `danger`) — 1 Woche
- HSM-fähige Hardware-Token (Yubikey) für alle Mitarbeiter — Org-Policy

---

## 6. Conclusion (für Operator-Lesung)

- Die **App-Schicht ist gut gebaut**. Die offenen Hebel sind nicht "wir haben falsch programmiert", sondern strukturelle Entscheidungen und Ops-Schicht-Härtung.
- **Drei Trilemmas** kann man nicht weg-codieren — sie sind als solche zu kommunizieren statt als "irgendwie geht das auch".
- **Privat ≠ DSGVO-light.** 5-15 Tester sind keine Privat-Ausnahme. Das ist die wichtigste Mind-Shift-Botschaft.
- **Privat-Pilot ist mit ~24h Operator-Sprint vertretbar** — der größte Wert pro Stunde liegt in Restore-Drill + R2-Object-Lock + Audit-WORM + Doppler-Backup + Datenschutzerklärung + Self-Service-Erase + Operator-Activity-Sichtbarkeit.
- **Per-User-KEK** ist im Privat-Pilot *wichtiger* als im Corporate-VPC (Blast-Radius statt Compliance) — ~6-8h + 0.20 €/Mo bei 3 Usern, definitiv vor *zweitem* Tester.
- **Drei akzeptierte Restrisiken explizit kommunizieren:** Fly-Platform-Compromise, GCP-Account-Suspension, KMS-Key-Destroy ohne Offline-Master. Diese überlebt der Stack realistisch nicht — Tester sollten das wissen.
- **Bus-Faktor 1 ist die größte unausgesprochene Grenze.** 4 Wochen Krankenhaus = Service ohne Restore-Pfad. Treuhänder + Recovery-Material offline ist die einzige Mitigation, die nicht Multi-Operator braucht.
- **Corporate ist 4-6 Wochen Compliance-Programm.** Kein Provider-Switch, sondern eigenes Projekt mit Legal + Engineering.
