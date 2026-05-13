# Watchtower Notifications

Watchtower kann nach jedem Update-Event (Container gestoppt, neues Image
gepullt, Container neu gestartet) eine Notification schicken. Backend:
[shoutrrr](https://containrrr.dev/shoutrrr/) — eine Library, die mit
einer URL-DSL eine Vielzahl von Services anspricht.

Konfiguration läuft komplett über drei `.env`-Variablen:

```bash
WATCHTOWER_NOTIFICATIONS=shoutrrr
WATCHTOWER_NOTIFICATION_URL=<shoutrrr-url>
WATCHTOWER_NOTIFICATIONS_LEVEL=info       # info | warn | error | debug
```

Nach Änderung:
```bash
docker compose up -d watchtower
docker compose logs -f watchtower
```

Wenn `WATCHTOWER_NOTIFICATIONS` leer bleibt, schickt Watchtower nichts —
das ist der Default. Stack läuft auch ohne Notifications problemlos.

---

## Slack (Bot-Token)

1. App anlegen unter <https://api.slack.com/apps> → "From scratch"
2. "OAuth & Permissions" → Bot Token Scopes: `chat:write`
3. App im Workspace installieren → "Bot User OAuth Token" (`xoxb-…`) kopieren
4. Bot in den Ziel-Channel einladen: `/invite @<bot-name>`
5. Channel-ID kopieren (Slack-UI → Channel-Details → unten "Channel ID")

```bash
WATCHTOWER_NOTIFICATIONS=shoutrrr
WATCHTOWER_NOTIFICATION_URL=slack://xoxb-1234-5678-abcdef@C01ABC2D3EF
```

Format: `slack://<token>@<channel_id>` (Token OHNE `xoxb-`-Prefix
funktioniert auch, mit ist robuster).

---

## Discord (Incoming Webhook)

1. Channel-Settings → Integrations → "Create Webhook"
2. Webhook-URL kopieren — Format:
   `https://discord.com/api/webhooks/<webhook_id>/<webhook_token>`

```bash
WATCHTOWER_NOTIFICATIONS=shoutrrr
WATCHTOWER_NOTIFICATION_URL=discord://<webhook_token>@<webhook_id>
```

Direkt aus der Webhook-URL: alles nach `/webhooks/` ist `<webhook_id>`,
alles danach ist `<webhook_token>`.

---

## Email (SMTP)

Beispiel für SMTP mit STARTTLS (z.B. Mailgun, Postmark, AWS SES, eigener
Mailserver):

```bash
WATCHTOWER_NOTIFICATIONS=shoutrrr
WATCHTOWER_NOTIFICATION_URL=smtp://user:password@smtp.example.com:587/?from=watchtower@ai-toolhub.org&to=admin@ai-toolhub.org&starttls=Always&auth=Plain
```

Wichtige Query-Parameter:
- `from` — Absender (muss vom SMTP-Provider zugelassen sein)
- `to` — Empfänger (komma-separiert für mehrere)
- `starttls` — `Always` (Port 587) oder `None` (Port 25, internes Relay)
- `auth` — `Plain` / `CRAMMD5` / `None`
- `subject` — optional, sonst Watchtower-Default

Für Gmail SMTP: App-Password erzeugen (nicht das normale Passwort) und
`smtp.gmail.com:587`.

---

## Generic Webhook (eigener Bot / Bridge)

Für einen eigenen HTTP-Endpoint (z.B. n8n, eigene API, ntfy.sh):

```bash
WATCHTOWER_NOTIFICATIONS=shoutrrr
WATCHTOWER_NOTIFICATION_URL=generic://hooks.example.com/watchtower?@authorization=Bearer+<token>
```

Pattern:
- `generic://` für HTTP
- `generic+https://` für TLS
- `@<header>=<value>` setzt einen Request-Header (URL-encoded, `+` = Space)
- Query-Parameter `template` / `json` steuern das Body-Format

Für `ntfy.sh`:
```bash
WATCHTOWER_NOTIFICATION_URL=generic+https://ntfy.sh/your-topic?@title=Watchtower
```

---

## Telegram (Bot-Token)

1. Bot via [@BotFather](https://t.me/BotFather) erzeugen → Token kopieren
2. Bot in einer Chat anschreiben oder zu einer Gruppe hinzufügen
3. `chat_id` ermitteln:
   `curl "https://api.telegram.org/bot<TOKEN>/getUpdates"`

```bash
WATCHTOWER_NOTIFICATIONS=shoutrrr
WATCHTOWER_NOTIFICATION_URL=telegram://<bot_token>@telegram?chats=<chat_id>
```

Für mehrere Chats: `chats=<id1>,<id2>`.

---

## Notification-Template anpassen

Watchtower kann das Notification-Format via Go-Template anpassen. Default
ist eine kompakte Plain-Text-Liste. Für custom Templates:

```bash
WATCHTOWER_NOTIFICATIONS=shoutrrr
WATCHTOWER_NOTIFICATION_URL=slack://…
WATCHTOWER_NOTIFICATION_TEMPLATE='{{- if .Report -}}
  {{- with .Report -}}
    {{ len .Updated }}/{{ len .Scanned }} Container aktualisiert auf {{ getenv "HOSTNAME" }}
    {{- range .Updated }}
    - {{ .Name }} ({{ .ImageName }})
    {{- end -}}
  {{- end -}}
{{- else -}}
  {{ range . -}}{{ .Message }}{{ "\n" }}{{- end -}}
{{- end -}}'
```

Variablen aus dem `Report`-Objekt:
- `.Scanned` — alle gecheckten Container
- `.Updated` — wirklich aktualisierte
- `.Failed` — Fehler beim Update
- `.Stale` — Container die einen restart bräuchten aber von Watchtower
  übersprungen wurden

Hinweis: Multi-Line-Strings sind in `.env`-Files heikel. Wenn das Template
länger wird, lieber als File mounten und über `WATCHTOWER_NOTIFICATION_TEMPLATE_FILE`
referenzieren (Volume + Path im Compose-Service ergänzen).

---

## Notification-Level

| Level | Was geschickt wird |
|---|---|
| `debug` | Jeder Poll-Cycle (laut, nur fürs Setup) |
| `info` | Nur erfolgreiche Updates + Skips (Default-Empfehlung) |
| `warn` | Updates mit Warnings oder fehlgeschlagene Pulls |
| `error` | Nur harte Fehler (keine routine-Updates) |

`error` empfiehlt sich, wenn die Notifications für Monitoring/On-Call
dienen — `info` wenn man jeden Roll-out sehen will.

---

## Smoke-Test

Nach Setup:

```bash
docker compose up -d watchtower

# Force run, ignore polling-interval:
docker compose exec watchtower /watchtower --run-once \
  --label-enable \
  --notifications=shoutrrr \
  --notification-url="$WATCHTOWER_NOTIFICATION_URL"
```

Wenn die Notification ankommt → ready für production. Falls nicht:
`docker compose logs watchtower | grep -i notif` zeigt shoutrrr-Errors.
