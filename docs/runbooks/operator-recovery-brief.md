# OPERATOR-RECOVERY-BRIEF (Template — ausdrucken, ausfüllen, versiegeln, in Safe)

> **Zweck:** Wenn ich (Axel) verunfalle, im Krankenhaus liege oder das Konto verliere, kann meine Frau / mein Partner mit dieser Anleitung die Familien-Daten retten.
> **Ort:** verschlossener Umschlag im häuslichen Safe + Kopie beim Treuhänder (Anwalt / vertraute Person).
> **Aktualisieren:** jährlich (Erinnerung im Kalender). Datum unten eintragen.
>
> ⚠️ **Dieses File ist ein TEMPLATE.** Druck es aus, fülle die Lücken handschriftlich oder am Drucker, und VERWAHRE die ausgefüllte Kopie NIE im Repo. Repository = öffentlich oder semi-public; Safe = privat.

---

## Stammdaten

| Feld | Wert |
|---|---|
| Familien-Operator (Axel) | __________________________________ |
| Backup-Person (Ehepartner / Treuhänder) | __________________________________ |
| Datum dieser Version | _______ / _______ / __________ |
| Nächstes Update fällig | _______ / _______ / __________ (= +1 Jahr) |

---

## §1 — Was ist mcp-approval2 + mcp-knowledge2?

Eine Familien-Plattform für gemeinsame Notizen, Listen, Kalender-/Gmail-Anbindung. Sie läuft auf Fly.io (Cloud) und speichert Daten in Neon-Postgres + Cloudflare-R2.

**Wichtig:** ohne diese Anleitung sind die Familien-Daten ggf. nicht recoverbar, weil das Verschlüsselungs-System (Google Cloud KMS) an meinem GCP-Konto hängt.

**Public Endpoints:**
- App: https://app2.ai-toolhub.org
- API: https://mcp2.ai-toolhub.org/health
- Repo (Code, öffentlich): https://github.com/axel-rogg/mcp-approval2

---

## §2 — Was im Notfall zu tun ist

### Szenario A: Ich bin temporär weg (1-4 Wochen)
Service läuft autonom weiter, **nichts tun**. Die Familie kann normal weiternutzen. Bei Cloud-Provider-Ausfall: ein paar Tage warten, ich komme wieder.

### Szenario B: Ich bin dauerhaft weg

**Priorität 1: Daten retten** (innerhalb 90 Tage, sonst läuft die Backup-Retention ab)

1. Treuhänder/Backup-Person kontaktiert: __________________________________
2. Person folgt den Schritten unter §3 (Account-Übernahme) + §4 (KMS-Schlüssel)
3. Wenn nicht-tech-affin: einen Bekannten finden der Cloud-Software kennt
4. **Familien-Daten als JSON-Export** über die PWA → Settings → "Meine Daten exportieren"

**Priorität 2: Service abschalten** (optional, falls niemand übernimmt)
1. Fly.io: `fly apps destroy mcp-approval2; fly apps destroy mcp-knowledge2`
2. Neon: Konsole → Project → Delete
3. Cloudflare R2: Buckets → Delete
4. Domain: ai-toolhub.org bei Cloudflare Registrar nicht verlängern

---

## §3 — Account-Recovery-Codes (5 Stacks)

Wenn ich nicht mehr einloggen kann, helfen diese Codes der Backup-Person, sich in meinem Namen anzumelden.

### 3.1 Google (axelrogg@gmail.com)
Recovery-Codes (10 Stück) — kleben:

```
1. ___________________  6. ___________________
2. ___________________  7. ___________________
3. ___________________  8. ___________________
4. ___________________  9. ___________________
5. ___________________  10. ___________________
```

**Zusätzlich:** Backup-Telefon `+ __ ___________________` (SMS-Recovery)

### 3.2 GitHub (axel-rogg)
Recovery-Codes (10 Stück) — kleben:

```
1. ___________________  6. ___________________
2. ___________________  7. ___________________
3. ___________________  8. ___________________
4. ___________________  9. ___________________
5. ___________________  10. ___________________
```

### 3.3 Fly.io
Recovery-Codes — kleben:

```
1. ___________________  6. ___________________
2. ___________________  7. ___________________
3. ___________________  8. ___________________
4. ___________________  9. ___________________
5. ___________________  10. ___________________
```

### 3.4 Doppler
Recovery-Codes — kleben:

```
1. ___________________  6. ___________________
2. ___________________  7. ___________________
3. ___________________  8. ___________________
4. ___________________  9. ___________________
5. ___________________  10. ___________________
```

### 3.5 Cloudflare
Recovery-Codes — kleben:

```
1. ___________________  6. ___________________
2. ___________________  7. ___________________
3. ___________________  8. ___________________
4. ___________________  9. ___________________
5. ___________________  10. ___________________
```

---

## §4 — KMS-Master-Schlüssel (für Backup-Decryption)

**Was ist das?** Die Datenbank-Backups in R2 sind mit einem Master-Key verschlüsselt. Ohne diesen Key sind alte Backups (>7 Tage Neon-PITR) nicht mehr lesbar.

**Wie kommt die Backup-Person dran?**

Der Master-Plaintext (32 Bytes, base64-encoded) ist hier in einem zusätzlich-verschlüsselten Block — entschlüsselbar mit einem Passwort, das nur die Backup-Person + ich kennen (z.B. "unser Hochzeitsdatum + Hund-Name", oder ein klassisches Stein-Schere-Passwort).

**Schritt 1 — Passwort eingeben:**
Passwort-Hinweis: `___________________________________________`
(Nicht das Passwort selbst! Nur einen Hinweis, den Backup-Person versteht.)

**Schritt 2 — Verschlüsselten Block entschlüsseln:**

```
$ echo '<BLOCK_BELOW>' | base64 -d | openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:'<PASSWORT>'
```

Verschlüsselter Block (mit `openssl enc -aes-256-cbc -pbkdf2 -pass pass:'<PASSWORT>' | base64` aus dem KMS-Master-Plaintext erzeugen):

```
___________________________________________________________
___________________________________________________________
___________________________________________________________
___________________________________________________________
___________________________________________________________
```

**Generierungs-Schritt für Axel (jährlich):**

```bash
# 1. Doppler-Wert holen:
doppler secrets get CLOUD_KMS_WRAPPED_MASTER_B64 --project mcp-approval2 --config privat --plain

# 2. GCP-CLI: Master-Plaintext zurückgewinnen:
echo "<WRAPPED_B64>" | base64 -d | \
  gcloud kms decrypt --location=europe-west3 --keyring=mcp-approval2-privat --key=user-dek-master --ciphertext-file=- --plaintext-file=- | \
  base64

# 3. Mit Familien-Passwort wieder verschlüsseln:
echo "<PLAINTEXT_B64>" | openssl enc -aes-256-cbc -pbkdf2 -pass pass:"$FAMILY_PWD" | base64

# 4. Den base64-Output oben in den Block kleben.
```

---

## §5 — Doppler-Recovery (alternativer Zugang)

Wenn der Google-Account dauerhaft weg ist, geht der einzige Re-Entry-Pfad über Doppler. Doppler hat alle anderen Secrets (Fly-Token, Cloudflare-Token, Neon-URL, etc.):

- Doppler-Account-Email: __________________________________
- Doppler Recovery-Codes: siehe §3.4
- Doppler-Service-Token (read-only) als Backup im Notfall:
  `dp.st.privat.___________________________________________________`
  (Mit `doppler service-token issue` erzeugen, in Doppler → Access → Service Tokens speichern.)

---

## §6 — Hilfe holen

Wenn die Backup-Person nicht weiter weiß:

- **Cloud-Vertraute:** __________________________________ (Telefon: ____________)
  Diese Person kennt sich mit Cloud-Services aus und kann technisch unterstützen.
- **Anwalt:** __________________________________ (Telefon: ____________)
  Falls rechtliche Schritte nötig sind (Account-Reaktivierung bei Anbieter via Erbschein etc.)

---

## §7 — Was NICHT in diesem Brief steht (bewusst)

- Mein Google-Passwort + Passkeys-Master → die sind via Recovery-Codes erreichbar
- Mein Privat-Laptop-Passwort → das wäre eine andere Sicherheits-Ebene und gehört zu "Erbschein-Material"

---

## §8 — Versionshistorie

| Datum | Was geändert |
|---|---|
| _______ / _______ / __________ | Erstmaliges Anlegen nach Family-Hardening-Sprint |
| _______ / _______ / __________ | __________________________________________________ |
| _______ / _______ / __________ | __________________________________________________ |
