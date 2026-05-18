# Agent-Guide: Tool-Defaults v2

> **Zielgruppe:** AI-Agents (Claude.ai-Clients, andere MCP-Clients), die gegen
> `mcp2.ai-toolhub.org` Tools aufrufen. Solo-User-Operator-Setup; primärer
> Modus ist Family im Haushalt.
>
> **Status:** Tool-Defaults v2 LIVE seit 2026-05-18 (Phasen A-F, Plan: [PLAN-tool-defaults-v2.md](../plans/active/PLAN-tool-defaults-v2.md)).
>
> **TL;DR:** Bevor du ein unbekanntes Tool aufrufst, ruf `tools.help({name})`.
> Du siehst Schema + bereits konfigurierte Defaults + Hints + Profile.
> Per-Call-Override mit `__profile: "test"` in den Args. Defaults setzen
> macht der User in der PWA; du kannst aber via `tool_defaults.hint.set`
> Hints schreiben (write+Approval).

---

## 1. Konzept in 30 Sekunden

Der User kann pro Tool **Default-Werte** für einzelne Felder speichern. Beim
Aufruf werden sie automatisch in den Tool-Input gemerged. Der User sieht in
der Approval-Karte pro Feld, woher der Wert kam (`from user-input` /
`from profile=prod`).

Defaults sind in **Profilen** organisiert — typischerweise `prod` vs `test`.
Profile sind **per User × Sub-MCP-Server** isoliert: Alice's `prod` und Bob's
`prod` sind unabhängige Rows.

**Drei Konfigurations-Schichten** für ein Feld:

| Schicht | Quelle | Wer schreibt? | Wer wendet an? |
|---|---|---|---|
| **Args** | User-Input im Tool-Call | LLM | Hub-Resolver (Args-WIN) |
| **Profile-Default** | gespeichert in `user_server_tool_defaults` | User (PWA) oder LLM (`prefs.set` deprecated, `tool_defaults.*` REST) | Hub-Resolver bei `tools/call` |
| **Hint** | Frei-Text-Doku pro Feld | User (PWA) oder LLM (`tool_defaults.hint.set`) | Du, beim Read via `tools.help` |

---

## 2. Discovery-Patterns

### 2.1 Vor unbekanntem Tool: `tools.help`

```jsonc
// Request
{ "name": "tools.help", "arguments": { "name": "gws.calendar.list" } }

// Response (gekürzt)
{
  "tool": {
    "name": "gws.calendar.list",
    "description": "...",
    "inputSchema": { "type": "object", "properties": { ... } },
    "sensitivity": "read"
  },
  "subMcpName": "gws",
  "defaults": {
    "active_profile": "prod",
    "effective": { "max_results": 25, "default_calendar": "primary" },
    "fields_with_defaults": ["max_results", "default_calendar"],
    "fields_without_defaults": ["time_zone", "calendar_id"],
    "orphan_fields": []
  },
  "hints": {
    "max_results": "höher = teurer aber weniger Pagination"
  },
  "available_profiles": [
    { "name": "prod", "description": "Produktion", "active": true },
    { "name": "test", "description": "", "active": false }
  ]
}
```

**Was du damit machst:**

- **Effective-Defaults inspizieren**: wenn `effective.max_results=25` schon
  gesetzt ist, musst du nicht `max_results: 25` im Tool-Call mitschicken.
- **Hints lesen**: User-eigene Beschreibungen. Hilft dir, sinnvolle Werte
  vorzuschlagen.
- **Profile sehen**: wenn der User `prod` + `test` hat, kannst du ihm anbieten
  per `__profile` zu wechseln.
- **Orphan-Fields melden**: wenn `orphan_fields[]` nicht leer ist, hat der
  User einen Default auf ein Field gesetzt, das es nicht mehr im Schema gibt
  — Schema-Drift. Sag's dem User.

### 2.2 `tools/list` mit `_meta.defaults_summary`

In jeder `tools/list`-Antwort kriegst du pro Tool ein zusätzliches
`annotations.defaults_summary` (wenn der User Defaults dafür hat):

```jsonc
{
  "name": "db.query",
  "description": "...",
  "inputSchema": {...},
  "annotations": {
    "sensitivity": "danger",
    "defaults_summary": {
      "active_profile": "prod",
      "fields_with_defaults": ["connection_string", "read_only"]
    }
  }
}
```

Damit siehst du im **Listing** ohne `tools.help`-Call welche Tools konfiguriert
sind. Tools ohne Defaults haben kein `defaults_summary`-Feld.

---

## 3. Per-Call-Profile-Override

### 3.1 Das `__profile`-Argument

Reservierter Schlüssel `__profile` in den Tool-Args. Wenn gesetzt, nutzt der
Hub-Resolver dieses Profil statt des aktiven. Wert wird **vor** dispatch aus
den Args gestripped — der Worker sieht ihn nie.

```jsonc
// Standard: nimm das aktive Profil (prod)
{ "name": "db.query", "arguments": { "sql": "SELECT 1" } }
// → resolved: { connection_string: "postgres://prod-host/...", read_only: true, sql: "..." }

// Override auf test
{ "name": "db.query", "arguments": { "__profile": "test", "sql": "SELECT 1" } }
// → resolved: { connection_string: "postgres://localhost/...", read_only: false, sql: "..." }
```

**Regeln:**
- Wert muss Slug-Pattern matchen: `^[a-z][a-z0-9_-]{0,63}$`.
- Profile muss existieren (sonst 400). Liste mit `tools.help`.
- Ungültiges `__profile` wird ignoriert + trotzdem aus Args entfernt (Defense).
- In der Approval-Karte erscheint ein Override-Banner: `__profile override: test (per-call, statt aktivem Profil)`.

### 3.2 Wann lohnt sich der Override?

- **Cross-Environment-Calls**: User redet von "prod-DB" oder "test-DB" — du
  setzt explizit `__profile` statt die Args zu kopieren.
- **Demonstration / Dry-Run**: User will sehen "wie würde das gegen test
  laufen", ohne sein active-Profil umzuschalten.

**Anti-Pattern:** Profile-Switch im Active-State über das LLM ändern. Das
gehört in die PWA — Profile-Switching ist eine Setup-Aktion, kein Per-Call.

---

## 4. Schreiben — was kannst du als LLM?

### 4.1 Hints setzen (write+Approval)

```jsonc
// Hint setzen
{
  "name": "tool_defaults.hint.set",
  "arguments": {
    "toolName": "llm.ask",
    "fieldName": "temperature",
    "hintText": "0.0 deterministisch .. 2.0 wild"
  }
}
// → write-Approval; User sieht den vollen Hint-Text im PWA-Modal
```

```jsonc
// Hint entfernen
{
  "name": "tool_defaults.hint.remove",
  "arguments": { "toolName": "llm.ask", "fieldName": "temperature" }
}
```

**Hints sind profile-übergreifend** — sie beschreiben Bedeutung, nicht Wert.

### 4.2 Defaults setzen — **nicht direkt vom LLM**

Es gibt **keine MCP-Tools** für `tool_defaults.set/remove`. Das ist
Absicht: Defaults sind UI-driven, weil typed-Validation gegen das Schema +
Field-Picker im Browser besser passen als JSON-Args.

**Wenn User sagt "merk dir X als Default":**

1. Sage dem User: "Öffne `#/tools/servers/<srv>/defaults` in der PWA — dort
   kannst du den Default typsicher setzen."
2. Optional: schreibe einen Hint via `tool_defaults.hint.set` damit der User
   später daran erinnert wird, warum er den Wert wählte.

**Tote Surface:** `prefs.set` / `prefs.get` / `prefs.remove` haben
Deprecated-Banner. Sie schreiben in eine alte Tabelle, die der Resolver
**nicht liest** — Werte landen ins Nirvana. Nicht nutzen, auch nicht für
"BC-Tests".

---

## 5. WYSIWYS in der Approval-Karte

Bei DANGER/Write-Tools sieht der User pro Feld eine Source-Attribution. Das
ist load-bearing — der User signed mit Touch-ID was er sieht.

```
┌─ db.query ─────────────────────────────────────────┐
│ sql:               SELECT * FROM users             │
│                    (from user-input)               │
│ connection_string: postgres://prod-host/main       │
│                    (from profile=prod)             │
│ read_only:         true (from profile=prod)        │
└────────────────────────────────────────────────────┘
```

Wenn du `__profile: "test"` sendest, erscheint zusätzlich ein Warn-Banner
`__profile override: test (per-call, statt aktivem Profil)`. Das macht dem
User klar, dass dieser Call **nicht** das normale aktive Profil nutzt.

**Konsequenz für dich:** sei sparsam mit `__profile`-Overrides bei DANGER-
Tools. Frag den User explizit ob er den Override will, bevor du es im Args
mitschickst — der Override-Banner schreckt sonst ab und der Approval-Click
verzögert sich.

---

## 6. Orphan-Detection (Schema-Drift)

Wenn der User einen Default auf ein Field gesetzt hat, das im aktuellen
Tool-Schema **nicht mehr existiert** (z.B. Worker hat `max_results` zu
`limit` umbenannt), wird die DB-Row als orphan markiert:

- Resolver **mergt sie nicht** → Worker sieht keinen unknown-property-Error.
- `tools.help` zeigt das Feld in `defaults.orphan_fields[]`.
- PWA-Defaults-Tab zeigt rote Pill `orphan` mit Tooltip.

**Was du tun sollst, wenn du orphan_fields findest:**

1. Dem User es melden: "Du hast Default für `xyz` aber das Tool kennt das
   Field nicht mehr — willst du es löschen?"
2. Den Default als Feld nicht referenzieren (du kannst es eh nicht senden,
   weil das Tool-Schema es nicht akzeptiert).

---

## 7. Elicitation-Hook (optional, default OFF)

Wenn der User in den Settings `elicit_on_missing_defaults=true` aktiviert
und du im `tools/call` Args ein `_meta.elicit_capability: true` mitschickst,
kann der Hub bei DANGER-Tools ohne Default + mit Hints einen
`elicitation_required`-Response statt einer Approval-Karte zurückgeben:

```jsonc
// Response statt dispatch
{
  "elicitation_required": true,
  "tool_name": "llm.ask",
  "hints": { "temperature": "0.0 deterministisch .. 2.0 wild" },
  "active_profile": "default",
  "available_profiles": []
}
```

**Capability-Check:** wenn dein Client das nicht versteht, schick
`_meta.elicit_capability` nicht mit. Default OFF heißt: für die meisten
Sessions passiert nichts; der klassische Approval-Pfad läuft.

---

## 8. Per-User-Isolation — was du voraussetzen kannst

- Alles ist **per-User isoliert** via RLS. Du siehst nur die Daten des
  authenticated Users (= dein OAuth-Token).
- Profile-Namen kollidieren zwischen Usern unabhängig. Alice's `prod` und
  Bob's `prod` sind getrennt.
- Es gibt **keine Group/Tenant/Shared-Defaults**. Family-Mode = jeder User
  managed seine eigenen Defaults.
- Wenn `tools.help` für einen frischen User leer ist (`fields_with_defaults: []`,
  nur `default`-Profil): das ist normal. User muss zuerst in die PWA.

---

## 9. Konkrete Patterns (Cheat-Sheet)

### Pattern A: Unbekanntes Tool

```
1. tools.help({name})
2. Lies effective[] + fields_without_defaults[] + hints
3. Konstruiere args: für fields_without_defaults musst du Werte liefern;
   für fields_with_defaults ist es optional.
4. Tool-Call dispatchen.
```

### Pattern B: User möchte temporär gegen test-DB

```
1. tools.help({name: 'db.query'})
2. Prüfe available_profiles. Wenn 'test' existiert:
3. tools/call db.query { __profile: 'test', sql: '...' }
4. Approval-Karte zeigt den Override-Banner, User akzeptiert bewusst.
```

### Pattern C: User sagt "merk dir das"

```
1. NIEMALS prefs.set (deprecated, wirkungslos).
2. Verweise auf PWA: '#/tools/servers/<srv>/defaults'.
3. Optional: tool_defaults.hint.set für die Bedeutung des Feldes.
```

### Pattern D: Schema-Drift entdeckt

```
1. tools.help liefert orphan_fields=['gone_field']
2. Sag dem User: "Default 'gone_field' ist orphan."
3. User kann in PWA per × löschen.
4. Du selbst kannst es nicht löschen (kein MCP-Tool dafür).
```

### Pattern E: tools/list filtern

```
1. tools/list →  alle subscribed Tools
2. Tools mit annotations.defaults_summary haben Setup.
3. Für jedes davon: User hat schon Profile + Defaults; respektiere active_profile.
```

---

## 10. Anti-Patterns

❌ **`prefs.set` / `prefs.get` / `prefs.remove` nutzen** — deprecated seit
2026-06-15. Werte landen in toter Tabelle.

❌ **`__profile` ohne `tools.help`-Check** — wenn das Profil nicht existiert,
kriegst du 400. Erst available_profiles lesen.

❌ **Defaults mit `tool_defaults.set` schreiben wollen** — gibt's nicht. Es
gibt nur `tool_defaults.hint.set/remove`. Defaults setzt der User in der PWA.

❌ **Bei DANGER-Tool jedes Mal `__profile` override mitschicken** — User
muss jedes Mal den Warn-Banner überlesen. Stattdessen: einmal den User
fragen, dann konsistent ohne Override (= aktives Profil) oder konsistent
mit Override.

❌ **Orphan-Fields ignorieren** — wenn `tools.help` orphan_fields liefert,
ist das ein Schema-Drift-Signal. Dem User melden statt silent weiter.

❌ **Profile cross-user mappen** — Alice's `prod` ist nicht Bob's `prod`.
Wenn ein User dir sein Profil per Name nennt, gilt es nur in seiner Session.

---

## 11. Reference

### Tool-Surface (User-relevant)

| Tool | Sensitivity | Zweck |
|---|---|---|
| `tools.help` | read | Schema + Defaults + Hints + Profile inspizieren |
| `tool_defaults.hint.set` | write | Hint-Text für Field setzen (≤500 chars) |
| `tool_defaults.hint.remove` | write | Hint entfernen |
| `prefs.get` / `prefs.set` / `prefs.remove` | — | **DEPRECATED**, nicht nutzen |

### REST-Surface (User in der PWA, für dich nur Bezug)

| Endpoint | Zweck |
|---|---|
| `GET    /v1/me/servers/:srv/default-profiles` | Profile listen |
| `POST   /v1/me/servers/:srv/default-profiles` | Profil anlegen (+ copyFrom) |
| `POST   /v1/me/servers/:srv/default-profiles/:name/activate` | Profil aktivieren |
| `DELETE /v1/me/servers/:srv/default-profiles/:name` | Profil löschen |
| `GET    /v1/me/servers/:srv/tool-defaults` | Defaults listen |
| `PUT    /v1/me/servers/:srv/tool-defaults/:tool/:field` | Default setzen |
| `DELETE /v1/me/servers/:srv/tool-defaults/:tool/:field` | Default löschen |
| `GET    /v1/me/servers/:srv/tool-hints` | Hints listen |
| `PUT    /v1/me/servers/:srv/tool-hints/:tool/:field` | Hint setzen |
| `DELETE /v1/me/servers/:srv/tool-hints/:tool/:field` | Hint löschen |
| `GET/PUT/DELETE /v1/me/settings/:key` | User-Settings (z.B. elicit_on_missing_defaults) |

### Plan + Migrations

- Plan: [PLAN-tool-defaults-v2.md](../plans/active/PLAN-tool-defaults-v2.md) (Status ✅ COMPLETE)
- Mig 0027: `pending_approvals.defaults_applied` (WYSIWYS-Attribution)
- Mig 0028: `user_server_tool_defaults` typed + 3 neue Tabellen (Profile, Hints, Active-Profile)
- Mig 0029: `user_settings` (key/value-Store)
- Mig 0030: **deferred** — DROP der Legacy `user_tool_prefs` + `user_prefs`
  (apply ab 2026-06-17 nach 30-Tage-Beobachtung)

### Verwandte Plan-Files

- [PLAN-tools-tab-ux-refactor.md](../plans/active/PLAN-tools-tab-ux-refactor.md) — der UX-Refactor der die PWA-Defaults-Tab gebaut hat
- [PLAN-prefs.md (v1)](https://github.com/axel-rogg/mcp-approval/blob/main/docs/plans/done/PLAN-prefs.md) — Vorgänger-Konzept im v1-Repo

---

## 12. Was tun wenn du als Agent etwas nicht findest?

- **Tool-Liste leer?** → User muss in PWA Sub-MCP-Server aktivieren (Subscription-Toggle).
- **`tools.help` returnt `tool: null`?** → Tool-Name falsch geschrieben. Prüfe `tools/list`.
- **`fields_with_defaults` immer leer?** → User hat keine Defaults gesetzt — kein Bug, kein Setup.
- **`available_profiles` zeigt nur `default`?** → User hat kein Profile angelegt. Implicit-default reicht für Single-Env-Setups.
- **`orphan_fields` wachsen mit der Zeit?** → Sub-MCP-Worker hat Schema umgebaut. Cleanup-Job für den User in der PWA.
- **Approval-Karte zeigt kein "Defaults applied"-Card?** → Entweder keine Defaults konfiguriert, oder das Tool ist read-only (kein Approval-Pfad → kein Display).

Wenn etwas trotzdem nicht passt: dem User die genaue Fehlermeldung melden,
nicht raten. Falsche Vermutungen über Tool-Defaults sind User-Frustration.
