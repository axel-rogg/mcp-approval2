# Runbook: Family-Hardening (Privat-Modus mcp-approval2)

> **Status:** ✅ Aktiv 2026-05-17
> **Scope:** mcp-approval2 + mcp-knowledge2 im Family-Modus (Haushalt, 2-5 Personen).
> **Trigger:** Family-Hardening-Decision aus [THREAT-MODEL.md](../../THREAT-MODEL.md) §Deployment-Kontext.
> **Dauer:** ~4h Operator-Sprint, einmalig.
>
> Dieser Runbook **deckt nicht ab:**
> - Self-Host-für-Freunde-Szenario (jeder Freund deployed selbst, eigene Verantwortung)
> - Corporate-GCP-VPC-Szenario (eigenes 4-6 Wochen Compliance-Programm)

---

## Was dieses Programm leistet

Schliesst die **Top-7 echten Außen-Risiken** im Family-Modus mit minimalem Aufwand. Defense-in-Depth bleibt unverändert (TLS, OAuth, RLS, KMS, WebAuthn-Passkey). Was hier dazukommt:

| # | Vektor | Maßnahme | Risiko-Klasse |
|---|---|---|---|
| 1 | Phishing eines Familienmitglieds | Google-Passkey + Recovery-Codes offline | HIGH |
| 2 | Operator-Phishing (Doppler/GCP/Fly/GitHub) | Passkey/2FA + Backup-Login-Pfade | HIGH |
| 3 | Ransomware-Botnet kompromittiert R2-Backup | R2 Object-Lock + Versioning | MEDIUM |
| 4 | XSS-Lücke kompromittiert Cookies | HSTS + X-Frame-Options + nosniff (Code-Change live) | MEDIUM |
| 5 | CSRF auf POST-Auth-Endpoint | Origin-Check-Middleware (Code-Change live) | MEDIUM |
| 6 | Bus-Faktor 1 (Operator weg → Familie aussperrt) | Recovery-Brief im häuslichen Safe | HIGH (Auswirkung) |
| 7 | Cost-Anomaly (buggy Loop → 500 €/Tag) | GCP Billing-Budget + Alert | LOW (Wahrscheinlichkeit) |

Bewusst weglassen: Per-User-KEK, WORM-Audit-Sink, Multi-Recipient-Sharing-Crypto, Datenschutzerklärung, Sub-Prozessor-DPAs, mTLS, Cross-Region-DR. Begründung: [THREAT-MODEL.md](../../THREAT-MODEL.md) §Deployment-Kontext.

---

## §1 — Google-Account Härtung (~45min, 0 €)

Da alle anderen kritischen Dienste (GCP, Fly, Doppler, ggf. GitHub, Neon) entweder direkt oder via Google-SSO am Google-Account hängen, ist das **der einzige wichtigste Schritt.**

### 1.1 Operator-Account (Axel)

- [ ] **Passkey aktivieren** auf https://myaccount.google.com/signinoptions/passkeys
  - Mindestens ein Passkey auf Phone (für Mobile) + ein Passkey auf Laptop (für Browser)
  - Wenn Browser-Passkeys per iCloud Keychain / Google Password Manager synced sind: das genügt als Zweit-Faktor
- [ ] **Recovery-Codes herunterladen** auf https://myaccount.google.com/recovery-options
  - 10 Einmal-Codes als PDF/Text speichern → in den Safe-Brief (§5)
- [ ] **Backup-Telefon + Backup-Email** setzen
- [ ] **Geräte-Review:** `myaccount.google.com/device-activity` — unbekannte Geräte rauswerfen
- [ ] **(Optional)** Erweiterten Schutz prüfen auf `myaccount.google.com/advancedprotection` — kann zu strikt sein, je nach OAuth-App-Mix; nicht zwingend für Family

### 1.2 Pro Familienmitglied (je ~15min)

- [ ] Passkey aktivieren (mindestens Phone)
- [ ] Recovery-Codes ausdrucken → an einem für sie/ihn auffindbaren Ort
- [ ] Phishing-Awareness in 2 Sätzen erklären: *"Ich (Axel) frage dich NIE per Mail/SMS nach deinem Passwort oder Recovery-Code. Wenn so eine Mail kommt: rufe mich an, bevor du klickst."*

**Verifikation:** auf `myaccount.google.com/security` muss "Passkey" unter "How you sign in to Google" aufgelistet sein.

---

## §2 — Fallback-Login-Pfade pro kritischem Dienst (~30min, 0 €)

**Warum?** Pure-Google-SSO macht den Google-Account zum konzentrierten Single-Point. Falls Google das Konto suspended (Phishing-Verdacht, Workspace-Lockout, country-block), bleibt dir ein zweiter Pfad in die Operations-Tools.

| Dienst | Aktion | Dauer |
|---|---|---|
| **GitHub** | Account-Settings → Password & Authentication → 2FA-App (TOTP) zusätzlich zur Google-Verbindung aktivieren. Recovery-Codes runterladen. | 5min |
| **Fly.io** | Account-Settings → Security → Email-Password + TOTP-Auth zusätzlich aktivieren | 5min |
| **Doppler** | Account-Settings → Security → 2FA-App aktivieren. Recovery-Codes runterladen. | 5min |
| **Cloudflare** | My Profile → Authentication → 2FA-App + Recovery-Codes | 5min |
| **Neon** | (meist GitHub-SSO) → 2FA-Pfad folgt GitHub-Pfad | 0min |
| **Resend** | Account-Settings → 2FA aktivieren (sofern Plan unterstützt) | 5min |
| **GCP** | **Reine Google-Auth** — kein Fallback möglich. Härtung läuft via §1. | 0min |

Alle Recovery-Codes (ca. 6 × 10 Codes = 60 Stück) gehen in den Safe-Brief (§5).

---

## §3 — Infrastruktur-Härtung via Terraform (~40min, 0 €)

### 3.1 GCP Billing-Budget aktivieren

Die TF-Resource existiert bereits in [terraform/environments/privat/gcp-billing-budget.tf](../../terraform/environments/privat/gcp-billing-budget.tf), ist aber `count=0` solange keine `gcp_billing_account_id` gesetzt ist.

```bash
# Billing-Account-ID herausfinden:
gcloud billing accounts list
# Format: XXXXXX-YYYYYY-ZZZZZZ (= "billingAccountName" minus "billingAccounts/")

# In Doppler eintragen (oder terraform.tfvars):
doppler secrets set --project mcp-approval2 --config terraform \
  TF_VAR_gcp_billing_account_id=XXXXXX-YYYYYY-ZZZZZZ \
  TF_VAR_gcp_billing_alert_email=axelrogg@gmail.com

# Plan + Apply:
bash scripts/doppler-run-terraform.sh plan -target=google_billing_budget.monthly_cap -out=/tmp/budget.tfplan
# Review Diff
bash scripts/doppler-run-terraform.sh apply /tmp/budget.tfplan
```

**Verifikation:**
```bash
gcloud billing budgets list --billing-account=$GCP_BILLING_ACCOUNT_ID
# Erwartete Output: "mcp-approval2 privat — monatlicher Cap" mit 20€
```

### 3.2 R2 Object-Lock + Versioning aktivieren (Out-of-Band)

**Warum nicht via TF?** Cloudflare-Provider v5 unterstützt diese R2-Features nicht als TF-Resource (Stand 2026-05-17, siehe [r2-blob.tf:8-11](../../terraform/environments/privat/r2-blob.tf#L8-L11)). Operator-Klick ist der einzige Weg.

- [ ] CF-Dashboard → R2 → `mcp-approval2-backup-eu` → Settings
  - [ ] **Object Versioning:** Enabled
  - [ ] **Object Lock:** Enabled, Mode = Compliance (oder Governance), Default Retention = 90 days
- [ ] Wiederhole für `mcp-knowledge2-backup-eu`

**Wirkung:** Ein Angreifer mit dem Backup-Token kann keine Backups mehr löschen oder mit Junk überschreiben — die alten Versionen bleiben 90d eingefroren. Ransomware-Pattern fängt ins Leere.

**Verifikation:**
```bash
aws s3api get-bucket-versioning --bucket mcp-approval2-backup-eu \
  --endpoint-url "https://${CF_ACCOUNT_ID}.eu.r2.cloudflarestorage.com" --profile r2-approval2-backup
# Erwartet: { "Status": "Enabled" }
```

### 3.3 Restore-Drill scharf fahren (~30min)

**Warum?** Der Pfad muss einmal echt gegangen sein, sonst kennt man die Sollbruchstellen nicht.

- [ ] Neon-Console → mcp-approval2 → Branches → Create branch "drill-2026-05-17" from time = "now - 5min"
- [ ] Connection-String der Branch holen
- [ ] Auf der Branch: `SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM approvals;` — Plausibilitäts-Check
- [ ] Branch verifizieren via temporärem Fly-App-Deploy ODER lokal: `DATABASE_URL=<branch-url> npm run dev`
- [ ] **Drill-Report:** Dauer von "Branch-Click" bis "DB läuft" notieren → in `runbook-incident-response.md:278` "Last-Run"-Spalte eintragen
- [ ] Branch löschen (kostet sonst Free-Tier-Quota)

---

## §4 — Code-Hardening (bereits live via Deploy)

Folgende Änderungen sind **Teil dieses Sprints** und werden mit dem nächsten `[deploy]`-Commit aktiv. Operator-Action: nur den Deploy-Commit reviewen.

| Change | File | Effekt |
|---|---|---|
| `BOOTSTRAP_ADMIN_EMAIL` fail-CLOSED in prod | [apps/server/src/auth/bootstrap.ts](../../apps/server/src/auth/bootstrap.ts) | Boot blockt mit 403 wenn Doppler-Variable fehlt + `NODE_ENV=production` |
| `securityHeaders()` Middleware | [apps/server/src/middleware/security-headers.ts](../../apps/server/src/middleware/security-headers.ts) | HSTS + X-Frame-Options:DENY + nosniff + Referrer-Policy auf allen Responses |
| `originCheck()` Middleware | [apps/server/src/middleware/origin-check.ts](../../apps/server/src/middleware/origin-check.ts) | POST/PUT/PATCH/DELETE auf `/auth/*` + `/oauth/*` mit fremdem Origin → 403 |

**Verifikation nach Deploy:**
```bash
# Security-Headers da?
curl -sI https://mcp2.ai-toolhub.org/health | grep -iE 'strict-transport|x-frame|x-content-type|referrer-policy'
# Erwartet: alle 4 Header

# Origin-Check live?
curl -sI -X POST -H 'Origin: https://evil.example' https://mcp2.ai-toolhub.org/auth/logout | head -3
# Erwartet: HTTP/2 403
```

---

## §5 — Recovery-Brief im häuslichen Safe (~30min, 0 €)

Template: [operator-recovery-brief.md](operator-recovery-brief.md) — ausdrucken, ausfüllen, in einen verschlossenen Umschlag, in den Safe.

**Inhalt:**
- Was die Plattform ist + warum sie wichtig ist
- Wer Zugriff braucht (Ehepartner als Treuhänder)
- 5 Account-Recovery-Codes-Stacks
- KMS-Master-Plaintext (verschlüsselt mit Ehepartner-bekanntem Passwort)
- "Im Notfall ruf X an" + Anweisungen

**Reminder:** Jährliche Aktualisierung (Codes rotieren manchmal, neue Dienste kommen dazu) — Erinnerung in den Kalender setzen.

---

## §6 — Verifikation Gesamt

Nach allen §-Schritten:

```bash
# 1. Family-Hardening Deploy gelandet
curl -sI https://mcp2.ai-toolhub.org/health | grep -i strict-transport
# Erwartet: strict-transport-security: max-age=15552000; ...

# 2. GCP-Budget aktiv
gcloud billing budgets list --billing-account=$GCP_BILLING_ACCOUNT_ID | grep -i mcp-approval2

# 3. R2-Object-Lock aktiv (manuell im CF-Dashboard verifizieren)

# 4. Recovery-Brief im Safe (manuell)

# 5. Passkey-Status pro Familien-Account (manuell)
```

---

## §7 — Was nicht in diesem Runbook ist

Bewusst out-of-scope für Family-Modus (siehe [THREAT-MODEL.md](../../THREAT-MODEL.md) §Deployment-Kontext):

- ❌ **Per-User-KEK** — Family-Trust deckt das Blast-Radius-Argument ab
- ❌ **HS256 → RS256 für Access-Tokens** — interner Single-Operator-Stack
- ❌ **WORM-Audit-Sink** — Family braucht keinen Auditor-Beweis
- ❌ **Related-Origin-File auf Apex `ai-toolhub.org`** — eine Origin als Default reicht
- ❌ **Multi-Recipient-Sharing-Crypto** — Family shared informell
- ❌ **Datenschutzerklärung + Sub-Prozessor-DPAs** — DSGVO Art. 2(2)c greift im Haushalt
- ❌ **mTLS zwischen Services** — Fly-Org ist Single-Trust-Boundary
- ❌ **Cross-Region-DR** — 6h Single-Region-Outage tolerierbar
- ❌ **Yubikey-Hardware-Token** — Cloud-synced Passkey ist mechanisch dasselbe gegen Phishing

Wenn die Konstellation jenseits Family wechselt (Self-Host für Freunde / Corporate-GCP-VPC), siehe [THREAT-MODEL.md](../../THREAT-MODEL.md) §Deployment-Kontext für die jeweils passende Hardening-Liste.

---

## Akzeptierte Restrisiken (kein Code löst das)

Diese drei Failure-Modi überlebt der Stack realistisch nicht. Family-Mitglieder müssen das wissen:

1. **Fly-Platform-Compromise** — Single-Vendor, kein Image-Signing-Mitigation-Pfad
2. **GCP-Account-Suspension** — KMS blocked = Boot fail = effektiver Data-Loss bis Reaktivierung
3. **KMS-Key-Destroy ohne Offline-Master-Copy** — selbst mit 90d Schutz nicht recoverable

Mitigation = der Recovery-Brief im Safe (§5) + ehrliche Tester-Kommunikation. Mehr ist im Family-Tier nicht vertretbar.
