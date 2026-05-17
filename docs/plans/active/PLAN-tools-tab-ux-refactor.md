# PLAN: Tools-Tab UX-Refactor

> **Status:** ⚠️ Approved 2026-05-17 — Build sequenziell A→F läuft.
> **Datum:** 2026-05-17
> **Trigger:** User-Feedback: "ICh bin überfordert auf der Seite. Wo kann ich überhaupt OAUTHS hinterlegen? Tool-Defaults ist an einem falschen Platz. Auch das Setzen der Credentials ist verwirrend. Am besten alles pro Tool damit man hier nicht irgendwie raus kommt. Plan alles gründlich."
>
> **User-Entscheidungen 2026-05-17:**
> 1. Build-Strategie: **sequenziell A→F**, alle 6 Phasen in Reihenfolge, ~17h
> 2. Tool-Defaults-Storage: **neue per-Server-Tabelle `user_server_tool_defaults`** mit FK auf `sub_mcp_servers(name)` ON DELETE CASCADE. Migration + Code-Refactor in Phase D.

## 1. Ist-Zustand: was heute wo lebt

Die Bedeutung von "ein MCP-Server" ist über **vier disjunkte UI-Surfaces** verstreut:

| Aspekt eines Servers | Wo heute |
|---|---|
| Server-Liste + Tool-Inventar | `#/tools/servers` |
| Subscribe on/off | `#/tools/servers` (Card-Button "Deaktivieren") |
| Per-Server-Config-Felder (z.B. `default_calendar`) | `#/tools/servers/<name>/config` (Drawer) |
| OAuth-Setup für Server (Client-ID/Secret + Authorize) | **nirgendwo in der UI** — Backend-Endpoints da (`/v1/me/servers/:name/oauth/start/callback`), kein Entry-Point |
| User-PAT/API-Tokens (z.B. GitHub) | `#/tools/credentials` (separates Sub-Tab, free-form, slot-basiert) |
| Tool-Defaults (z.B. `gws.calendar.list default_calendar=primary`) | `#/defaults` (separates Top-Nav!) |
| Diagnostik (last-refresh, last-error) | `#/tools/servers` nur als kleiner "vor 8 min"-Text in der Card |
| User-Added-Server hinzufügen | `#/tools/servers/new` (Form) |
| User-Added-Server löschen | Card-Button "Löschen" |

**Konsequenz:** für einen einzelnen logischen Workflow ("ich will GitHub anbinden") muss der User durch 3+ Routes navigieren, ohne klare Reihenfolge.

## 2. Konkrete UX-Probleme (aus User-Screenshot 2026-05-17 14:50)

1. **"Konfigurieren" ist ein Text-Button** — sollte ein Schraubenschlüssel-Icon sein (visuelle Hierarchie + weniger Platz pro Card).
2. **"Deaktivieren" ist ein Text-Button** — sollte ein On/Off-Toggle sein (deutliches Mental-Model: "Server ist an/aus").
3. **Buttons sind rechts** in der Card-Title-Row — sollten **links** (User-Annahme: Aktion liegt am Anfang der Card).
4. **"Gateways neu entdecken" findet 0 Tools** für utils/gws/gcloud — KEIN Bug der UI, sondern Worker-side `SERVICE_TOKEN` fehlt. UI erklärt aber nicht warum.
5. **Konfigurieren-Drawer ist meistens leer** ("Server deklariert keine Config-Felder") — UI sagt "hinterlege Tokens unter Credentials", aber das ist disjunkt und ohne Kontext welcher Token für welchen Server gilt.
6. **Tool-Defaults sind disconnected** — User weiß nicht dass `#/defaults` existiert, geschweige denn dass es server-spezifische Defaults gibt.
7. **OAuth-Flow für externe Server nicht erreichbar** — User: "Im alten mcp-approval konnte ich auch bei externen tools wie github mcp server OAUTH machen. Keine Ahnung wo das jetzt gehen soll." → genau das ist der Gap.
8. **Credentials-Sub-Tab ist verwirrend** — slot-basiert ist gut, aber slots kommen nur von Catalog-Servern. Nichts wenn User eigenen Server angelegt hat.

## 3. Mental-Model-Wechsel: "alles pro Tool/Server"

User-Wunsch:

> "Am besten alles pro tool damit man hier nicht irgendwie raus kommt."

Übersetzt: **ein Server ist die Atomeinheit der Konfiguration**, nicht "die App-Settings-Hierarchie". Alle Aktionen die einen Server betreffen wohnen **unter dem Server**.

Daraus folgt: eine **Server-Detail-Page** als One-Stop-Shop, mit Tabs für die Aspekte.

## 4. Vorschlag — Soll-Struktur

```
#/tools                                                  ← Top-Nav, einziger Sub-Tab
└── Servers-Liste (kompakter)
    │
    │ Card (links→rechts):
    │ [○]Toggle  [⚙]Konfig-Icon  Server-Name (Pill: 5 tools)
    │            Status-Zeile: "verfügbar / aktiv · refreshed vor 8min · 3 tools"
    │
    │ [+] Server hinzufügen (Button rechts oben)
    │
    └── Klick auf Card oder ⚙ → Detail-Page

#/tools/servers/<name>                                   ← Detail-Page, full-width
├── Header: [← Zurück]  Servername  Status-Pill  [🗑 Löschen wenn isUserOwned]
│
├── Sub-Tabs:
│   ├── Übersicht
│   │   • Basics: name, baseUrl, displayName, authMode (read-only / edit für user-owned)
│   │   • Subscription [○] Toggle
│   │   • [↻ Tools neu entdecken]
│   │   • Letzter Refresh, Tool-Count
│   │
│   ├── Auth                                             ← KONSOLIDIERT: ersetzt Credentials + Drawer + OAuth
│   │   Drei Modi, server-deklariert oder user-gewählt:
│   │
│   │   A) service_bearer (für eigene Worker)
│   │      [🔑 Service-Token] ___________  [Speichern]
│   │
│   │   B) oauth (pre-registered, z.B. GitHub, Google)
│   │      [Client-ID]     ___________
│   │      [Client-Secret] ___________
│   │      [▶ Authorize]                                  ← öffnet Provider-OAuth in new-window
│   │      Status: ✓ Refresh-Token vor 3 Tagen erteilt / ⚠ Authorize nötig
│   │
│   │   C) api_token (für PAT-style, z.B. legacy)
│   │      [Token] _____________  [Speichern]
│   │
│   │   Wenn der Server `_meta.oauth` deklariert → automatisch Modus B.
│   │   Wenn der Server `_meta.api_token` → Modus C.
│   │   Sonst Default Modus A (für eigene Worker).
│   │
│   ├── Tool-Defaults                                    ← ERSETZT #/defaults
│   │   Pro Tool dieses Servers:
│   │      gws:calendar.list
│   │        default_calendar  [primary___________]  [Speichern]
│   │        default_timezone  [Europe/Zurich______]  [Speichern]
│   │      gws:calendar.create
│   │        default_calendar  [_(leer)____________]
│   │
│   │   Pro Native-Server (Hub): Defaults für native Tools.
│   │
│   └── Diagnostik                                       ← Debug + Operator
│       last-refresh-timestamp, last-error-message, raw tools_cache, [Force-Re-Discover]
```

## 5. Was wegfällt / migriert

| Heute | Soll |
|---|---|
| `#/tools/credentials` (Sub-Tab) | → entfernt. BC-Redirect: `#/tools/credentials?add=<provider>` → `#/tools/servers/<server-für-provider>` Auth-Tab |
| `#/defaults` (Top-Nav-Route) | → entfernt. BC-Redirect: `#/defaults` → `#/tools/servers/native` Tool-Defaults-Tab |
| Card-Button "Konfigurieren" (Text) | → 🔧-Icon links neben Server-Name |
| Card-Button "Deaktivieren" (Text) | → On/Off-Toggle ganz links (✓/✗ visuell klarer) |
| Card-Button "Löschen" (auf Card) | → nur noch in Detail-Page Header (zu zerstörerisch für 1-Klick) |
| `#/tools/servers/<name>/config` (Drawer) | → Auth-Tab + Tool-Defaults-Tab im Detail-View |

## 6. OAuth-Setup-Workflow für GitHub-Style externe Server

Das ist heute **der größte Pain-Point** und der explizite User-Wunsch.

### Heutige Realität (V2)
- Backend: `POST /v1/me/servers/:name/oauth/start` (Phase 3, implementiert)
- Vorbedingung: Server muss `_meta.oauth` in `tools/list` deklarieren (provider, authorize_url, token_url, scopes)
- User muss `_oauth_client_id` + `_oauth_client_secret` per `PUT /v1/me/servers/:name/config/:key` eintragen
- Authorize-Flow: Backend redirected zu authorize_url, Provider redirected zu approval2-Callback, Backend tauscht code→refresh_token, persistiert KMS-encrypted

### Was fehlt
- Kein UI für die 3 Schritte: `_oauth_client_id` setzen, `_oauth_client_secret` setzen, Authorize-Button drücken
- Keine UI für **manuelles Editieren** von `_meta.oauth` wenn der Server es NICHT deklariert (z.B. Drittpartei-GitHub-MCP)

### Soll-Flow für GitHub anbinden

1. **Add-Server** klicken → `#/tools/servers/new`
2. Form ausfüllen:
   - name: `github`
   - displayName: `GitHub`
   - baseUrl: `https://api.githubcopilot.com/mcp/` (oder anderer GitHub-MCP-Endpoint)
   - authMode: **oauth**
   - **Wenn server `_meta.oauth` deklariert:** weiter zu Schritt 3
   - **Wenn nicht:** zusätzliche Felder zeigen: `oauth_authorize_url`, `oauth_token_url`, `oauth_scopes` (komma-getrennt) → werden als manuelles `_meta.oauth` persistiert
3. Save → Redirect auf `#/tools/servers/github` Auth-Tab
4. **Auth-Tab:**
   - Modus B (oauth) aktiv
   - User trägt GitHub-OAuth-App `Client-ID` + `Client-Secret` ein, speichert
   - Klickt **[▶ Authorize]**
5. Backend: `POST /v1/me/servers/github/oauth/start` → returns `authorizeUrl`
6. PWA: `window.open(authorizeUrl, '_blank')`
7. User: GitHub-Consent → GitHub redirects zu approval2-Callback `/auth/oauth/<name>/callback?state=...&code=...`
8. PWA-Callback-Route ruft `POST /v1/me/servers/github/oauth/callback` mit state+code
9. Backend tauscht code→refresh_token, persistiert KMS-encrypted in `user_sub_mcp_config`
10. UI: Status auf "✓ Refresh-Token vor 2 Sek erteilt"

**Voraussetzung User-Side:**
- GitHub-OAuth-App muss vom User vorher angelegt sein bei https://github.com/settings/applications/new
- Redirect-URI muss auf approval2-Callback zeigen: `https://app2.ai-toolhub.org/#/tools/servers/github/oauth/callback`

## 7. Build-Plan in Phasen

**Phase A — Card-Polish (smallest, sichtbarster Wert; ~2h)**
1. Schraubenschlüssel-Icon (SVG) ersetzt "Konfigurieren"-Text
2. On/Off-Toggle (CSS-Switch) ersetzt "Deaktivieren"-Text
3. Buttons ganz links in der Card-Title-Row (vor Server-Name)
4. Refresh-Icon klein-links (statt rechts-am-Rand)
5. Card kompakter — alle Status-Texte in eine Zeile

**Phase B — Server-Detail-Page Skeleton (~3h)**
1. Neue Route `#/tools/servers/<name>` (full-page, Header mit Back-Button)
2. 4 Sub-Tabs: Übersicht / Auth / Tool-Defaults / Diagnostik
3. Übersicht + Diagnostik trivial (reuse vorhandene Daten aus Inventory)
4. Auth-Tab + Tool-Defaults-Tab als Placeholders (in nächsten Phasen befüllen)

**Phase C — Auth-Tab konsolidiert (~5h, das schwierigste)**
1. Auth-Mode-Detection aus `_meta.oauth` / `_meta.api_token` / authMode
2. **Modus A (service_bearer):** einfache Token-Eingabe + Save → schreibt in `user_sub_mcp_config[_bearer_token]` (oder am Worker-side `SERVICE_TOKEN` für eigene Server-Anbindung)
3. **Modus B (oauth):** Client-ID + Client-Secret-Eingabe + Authorize-Button
   - Authorize-Button öffnet `POST /v1/me/servers/<name>/oauth/start` → opens authorizeUrl in same-window oder popup
   - Callback-Route `#/tools/servers/<name>/oauth/callback?state=...&code=...` (gibt's schon!) finalisiert via `POST .../oauth/callback`
   - Status-Anzeige: existiert `_oauth_refresh_token` in der Config? Wenn ja "✓ verbunden", sonst "⚠ Authorize"
4. **Modus C (api_token):** trivial

**Phase D — Tool-Defaults integriert (~3h)**
1. Detail-View ruft `prefs.get` (oder direkter REST-Call falls separate API) gefiltert auf `gateway.<name>.<tool>`
2. UI: pro Tool-Card eine kleine Form mit den declared default-fields (aus tool.inputSchema)
3. Save schreibt `prefs.set` mit Tool-Namen + Field-Name
4. Migration: `#/defaults`-Route bleibt als Redirect zu `#/tools/servers/native#tool-defaults`

**Phase E — Cleanup (~1h)**
1. Credentials-Sub-Tab UI entfernt (Backend-Route `/v1/credentials` bleibt für externe MCP-Clients)
2. `#/defaults` Top-Nav-Eintrag entfernt
3. BC-Redirects in main.ts

**Phase F — OAuth-Setup-Flow für GitHub konkret (~3h)**
1. Add-Server-Form um `authMode=oauth` erweitern (Felder oauth_authorize_url, oauth_token_url, oauth_scopes wenn server `_meta.oauth` NICHT vorhanden)
2. Backend: `_meta.oauth` aus user-input persistieren in `sub_mcp_servers.config_schema._meta.oauth` (Phase 4 macht das schon halb)
3. Dokumentation: "Wie GitHub anbinden" als Skill / Runbook

**Total: ~17h Build. Kann auf 2-3 Sessions verteilt werden.**

## 8. Open Questions vor Build-Start

1. **Auth-Tab Persistence-Layer für Modus A (service_bearer):**
   - Aktuell: Service-Token ist `wrangler secret put` Worker-side. User trägt das auf approval2-Seite NICHT ein.
   - Sollen wir Modus A ganz aus der UI entfernen (Service-Token ist Operator-Sache, kein User-Setup)?
   - Oder: für **user-added** Server (Phase 4) ist Modus A user-input?
2. **Tool-Defaults-Storage:** heute in `user_profile.tool_defaults` (Phase prefs). Behalten oder umziehen?
3. **OAuth-Callback-Route:** heute `#/tools/servers/<name>/oauth/callback` (PWA-side). Behalten oder zu `/auth/oauth/<name>/callback` (Backend-side) verschieben damit GitHub direkt landet?
4. **Welche Phasen JETZT, welche später?** A+B+F (Quick-Wins) zuerst, oder A→F sequenziell?

## 9. Risiken / Tradeoffs

- **Risiko:** Phase E (Credentials-Tab entfernen) bricht bestehende User-Bookmarks. Mitigation: BC-Redirect.
- **Risiko:** Tool-Defaults pro Server (Phase D) hat im Storage keine Server-Discriminator-Spalte heute. Mitigation: prefs.toolName ist bereits server-qualified (`gws:calendar.list`), filtern reicht.
- **Tradeoff:** Detail-Page = mehr Klicks für simple Actions (Server an/aus). Mitigation: Toggle auf der Card lassen für die Aktion, Detail nur für komplexere Setup-Schritte.

## 10. Nicht-Ziel

- Tools-Discovery-Bug-Fix (utils/gws/gcloud 403). Das ist Worker-side `wrangler secret put` und kein UI-Thema.
- Multi-User-Tooling (Admin sieht andere User-Tools). Nicht jetzt.
- Skills / Memos / Apps-Surfaces. Anderes Sub-System, anderer Plan.
