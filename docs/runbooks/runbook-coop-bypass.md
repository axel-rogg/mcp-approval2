# Runbook: Coop-Bypass via Hetzner-FQDN

> Status: Ready
> Plan-Ref: PLAN-architecture-v1.md §3.4 (Multi-Origin), PLAN-hetzner-deployment.md §1 (Architektur)
> Related: [runbook-hetzner-deploy.md](runbook-hetzner-deploy.md), [runbook-multi-instance-operations.md](runbook-multi-instance-operations.md)

## Problem

Auf der Coop-Firmen-Maschine sitzt ein Zscaler-Proxy, der `*.ai-toolhub.org`
als "newly registered domain" klassifiziert und alle Requests blockt. Damit
ist mcp-approval2 vom Buero-Geraet nicht erreichbar — weder die PWA noch
die MCP-Endpoints.

## Loesung

Hetzner gibt jeder VM automatisch eine Reverse-DNS-FQDN unter
`*.your-server.de`. Dieses TLD ist alt + grossbetriebsweit bekannt, der
Zscaler-Filter laesst es durch. Caddy holt sich fuer diese FQDN ein
Let's-Encrypt-Cert (HTTP-01 funktioniert, sofern Port 80/443 offen sind)
und proxied auf dasselbe Backend wie `mcp2.ai-toolhub.org`.

FQDN-Format Hetzner:

- IPv4 `5.75.123.45` → `static.45.123.75.5.clients.your-server.de`
  (Octets reversed, Praefix `static.`, Suffix `.clients.your-server.de`)
- IPv6 (selten) — Format variiert, manuell verifizieren.

Trade-offs:

- URL ist haesslich + IP-gebunden → wechselt die VM-IP, wechselt die FQDN
- WebAuthn ist Origin-bound → separater Passkey pro Origin
- Kein eigener DNS-Record noetig (Hetzner DNS-managed)

## Setup-Steps

### 1. FQDN aus Terraform holen

Die Outputs sind in `terraform/modules/hetzner-mcp-instance/outputs.tf` +
`terraform/environments/privat/main.tf` definiert:

```bash
cd /workspaces/mcp-approval2/terraform/environments/privat

terraform output coop_bypass_url
# "https://static.X.X.X.X.clients.your-server.de"

terraform output default_hetzner_fqdn_v4
# "static.X.X.X.X.clients.your-server.de"

terraform output allowed_origins_csv
# "https://mcp2.ai-toolhub.org,https://app2.ai-toolhub.org,https://static.X.X.X.X.clients.your-server.de"
```

### 2. .env auf der VM ergaenzen

```bash
ssh deploy@<vm-ip>
cd /opt/mcp-approval2/deploy/hetzner
nano .env
```

Beide Eintraege setzen (Werte aus Schritt 1 kopieren):

```bash
HETZNER_FQDN_V4=static.X.X.X.X.clients.your-server.de
ALLOWED_ORIGINS=https://mcp2.ai-toolhub.org,https://app2.ai-toolhub.org,https://static.X.X.X.X.clients.your-server.de
```

### 3. Caddyfile re-rendern + Caddy reloaden

```bash
bash render-config.sh
# → Rendering Caddyfile.tpl → Caddyfile

docker compose up -d --force-recreate caddy
```

Caddy holt automatisch ein neues Let's-Encrypt-Cert fuer die FQDN. Falls
das Rate-Limit greift (50 certs/week per registered domain — `your-server.de`
ist hier als public-suffix gelistet, also kein Issue), 30 min warten +
retry.

### 4. mcp-approval2 neu starten (damit ALLOWED_ORIGINS greift)

```bash
docker compose up -d --force-recreate mcp-approval2
```

### 5. Verifikation

```bash
# DNS-Lookup — Hetzner-managed, sollte VM-IP returnen
dig +short static.X.X.X.X.clients.your-server.de

# HTTPS reachable + Cert valid
curl -I https://static.X.X.X.X.clients.your-server.de/health
# HTTP/2 200

# ALLOWED_ORIGINS wurde gelesen
docker compose exec mcp-approval2 env | grep ALLOWED_ORIGINS
```

## Coop-Browser-Setup

### Erstmaliger Login (separater Passkey-Enroll fuer Coop-Origin)

1. Coop-Browser oeffnet `https://static.X.X.X.X.clients.your-server.de`.
2. Google-OAuth-Login mit demselben Google-Account wie zuhause.
3. WebAuthn-Enrollment-Prompt erscheint — neuen Passkey erstellen.
4. **Wichtig:** Der Privat-Passkey funktioniert auf dieser Origin NICHT
   (WebAuthn ist Origin-bound). Der Coop-Browser legt einen separaten
   Passkey im OS/Browser-Vault an, der mit demselben User-Account
   verknuepft wird.

### Tools-Konfiguration im Coop-Browser

Claude-Code / Claude.ai MCP-Client-Konfig (z.B. `~/.config/claude/mcp.json`):

```jsonc
{
  "mcpServers": {
    "approval2-coop": {
      "url": "https://static.X.X.X.X.clients.your-server.de/mcp",
      "transport": "sse"
    }
  }
}
```

## Bekannte Einschraenkungen

- **URL ist haesslich** — kein Aenderung moeglich, Hetzner-Pool-FQDN ist hart.
- **WebAuthn-Origin-bound** — pro Origin separater Passkey im Vault.
- **Wenn VM-IP wechselt** (z.B. Migration, Hetzner-Maintenance), aendert sich
  die Bypass-FQDN → Caddy holt neues Cert + User muss frischen Passkey
  enrollen. Workaround: vor Migration `terraform output coop_bypass_url`
  notieren, neue FQDN nach Migration kommunizieren.
- **Let's-Encrypt-Rate-Limit** — Caddy reusable Certs over restarts, im
  Alltag kein Issue. Bei haeufigem `--force-recreate` ggf. Caddy-Storage
  (`caddy-data` Volume) persistent halten.
- **Multi-Origin-Code-Pfad** — `apps/server/src/lib/config.ts` exposed
  `ALLOWED_ORIGINS` + `resolveRpId()`/`resolveOrigin()` Helpers. Die
  Webauthn-Handler nutzen aktuell statisches `RP_ID`. Der dynamische
  Per-Request-Resolver wird in einem Follow-up integriert; bis dahin
  funktioniert der Bypass mit `WEBAUTHN_RP_ID=${DOMAIN_MCP}` und einem
  per-Origin-Passkey, der nominell unter `mcp2.ai-toolhub.org` enrolled
  wurde (Browser akzeptiert das fuer subdomains derselben eTLD+1 nicht
  — daher Coop-Browser braucht echtes Re-Enrollment unter der FQDN
  sobald der dynamische Resolver in Webauthn integriert ist).

## Pattern fuer Business-Phase (GCP Cloud Run)

Cloud Run hat keine equivalente "Default-FQDN-die-Zscaler-durchlaesst" —
die `*.run.app` ist neu, oft geblockt. Optionen:

- **Cloudflare-Worker als Reverse-Proxy** unter `*.workers.dev` (mcp-approval
  prod nutzt das seit 2026-05-07, siehe [PLAN-multidomain.md im mcp-approval-Repo](../../../mcp-approval/docs/plans/done/PLAN-multidomain.md)).
- **Eigene "established" Domain** mit Reputation > 6 Monaten — DNS-Eintrag
  auf Cloud-Run-Custom-Domain.

Konkrete Loesung fuer den Business-Cutover wird in einem separaten
Runbook beschrieben.

## Rollback

Falls der Bypass-vhost Probleme macht:

```bash
ssh deploy@<vm>
cd /opt/mcp-approval2/deploy/hetzner
# HETZNER_FQDN_V4 in .env leeren oder auskommentieren
nano .env

bash render-config.sh
# → omit Coop-Bypass vhost

docker compose up -d --force-recreate caddy mcp-approval2
```

Der bypass-vhost-Block wird vom `render-config.sh` weggelassen, wenn
`HETZNER_FQDN_V4` leer ist. Caddy startet ohne den Block, Let's-Encrypt-
Cert fuer die FQDN bleibt im Storage (kein Rate-Limit-Trigger beim
Wiedereinschalten).
