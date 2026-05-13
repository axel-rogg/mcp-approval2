# Apps-Subsystem — Migration vom Single-User mcp-approval

**Status:** Initial Port (Burst 5) abgeschlossen 2026-05-13.
**Source:** `axel-rogg/mcp-approval` (Single-User, Cloudflare-Worker).
**Target:** `axel-rogg/mcp-approval2` (Multi-User, Node/Hono + Postgres + S3).

## Was uebernommen wurde

| Datei (Quelle → Ziel) | Anpassung |
|---|---|
| `src/apps/blocks/types.ts` → `apps/server/src/apps/blocks/types.ts` | Erweitert um `TemplateConfig`/`TemplateTab`, sonst 1:1. |
| `src/apps/blocks/catalog.ts` → bereits vorhanden | Idempotente Map-Registry, gleicher Shape. |
| 13 Block-Files (action_button, chart, counter, form, list, places, progress_ring, reminder, stat_card, tag_filter, text_field, timer, workout_split) → `apps/server/src/apps/blocks/<name>.ts` | Pure Block-Logik portiert — schemas, handlers, queries. `Sensitivity` Import auf lokales `BlockSensitivity` umgestellt (Tools-Layer mapped auf globale `ToolSensitivity`). Import-Pfade `./types` → `./types.js` (ESM). |
| `src/apps/blocks/index.ts` → `apps/server/src/apps/blocks/index.ts` | Auto-Boot beibehalten. 13 Blocks statt 19 (calendar_grid, custom_view, header, heatmap, media_card, segment nicht im Scope). |
| `src/apps/a2ui_adapter.ts` → `apps/server/src/apps/a2ui_adapter.ts` | 1:1 port, A2UI v0.10. State-frei. |
| `src/apps/action_router.ts` → `apps/server/src/apps/action_router.ts` | 1:1 port + `iframe_auto_approve`-Flag im Result expliziert. State-frei. |
| `src/apps/types_registry.ts` → `apps/server/src/apps/types_registry.ts` | Composable-Type inline (war separat in `types/composable/schema.ts` im Source). State-Schema-Helpers + Validation 1:1. |
| `src/apps/api.ts` → `apps/server/src/apps/api.ts` | **Komplette Umstellung auf Multi-User** — siehe unten. |
| `src/apps/jwt.ts` → `apps/server/src/apps/jwt.ts` | HS256 mit HKDF-derived secret. Claims um `sub`=userId erweitert. TTL 15 min. |
| `src/apps/routes.ts` → `apps/server/src/routes/apps.ts` | Re-implementiert auf Hono — keine WYSIWYS-Dispatch-Endpoints (`/dispatch`, `/refresh-token`, `/pin`, `/archive`, `/title`, `/restore`, `/purge`, `/auto-archive-recent`); diese Lifecycle-Operations laufen jetzt ueber die generischen `/v1/apps/:id`-Routen + Tool-Approvals. Standalone-Bridge wird mit JWT-Issue beibehalten. |
| **NEU** `apps/server/src/tools/apps-tools.ts` | 8 MCP-Tools (`apps.create`, `apps.read`, `apps.list`, `apps.delete`, `apps.update_state`, `apps.invoke`, `apps.query`, `apps.update_layout`). |
| **NEU** `apps/server/src/apps/api.test.ts` | AppsService Unit-Tests gegen In-Memory KnowledgeAdapter. |
| **NEU** `apps/server/src/tools/apps-tools.test.ts` | Tool registration + dispatch smoke tests + Block-Catalog Coverage + 1 Invoke-Test pro complex Block. |

## Was NICHT uebernommen wurde

- **6 Blocks gestrichen** (nicht im Spec-Scope): `calendar_grid`, `custom_view`, `header`, `heatmap`, `media_card`, `segment`. Wenn benoetigt, im naechsten Burst nachziehen — Source-Files unter `src/apps/blocks/`.
- **PWA-Standalone UI-HTML** (`src/apps/types/composable/ui.ts`): Iframe-Renderer (Vue/Vite) ist Burst 8 (Frontend), nicht Server-side.
- **Cron-Jobs** (`src/cron/apps_lifecycle.ts` autoArchive/purgeTrashed): kommen in einem separaten Lifecycle-Burst — abhaengig von KC2's Soft-Delete-Surface.
- **Approval-Pending-Flow** (`src/approve/pending.ts` Integration im `/dispatch`-Endpoint): das uebernimmt jetzt der globale Approval-Hook im MCP-Transport (`apps/server/src/services/approvals.ts` + Tool-Sensitivity).
- **Optimistic-UI-Hooks** (CAS-Retry-Loop im Dispatch-Endpoint): bewusst auf 1 Retry im `AppsService.invoke()` reduziert. Multi-User-Concurrency ist seltener als parallel-tab/parallel-agent im Single-User-Setup.
- **Legacy App-Types** (shopping_list/weekend_plan/skill_menu/habit_tracker/event_notes): Source-Repo hat das beim Phase-6-Cutover 2026-05-08 schon entfernt. Nur `composable` ueberlebt.

## Multi-User-Anpassungen (Kern-Aenderungen vs. Source)

### 1. Storage-Backend

| Aspekt | Source (mcp-approval) | Target (mcp-approval2) |
|---|---|---|
| Storage | D1 `objects` Tabelle (kind='app_state'), R2-Body | mcp-knowledge2 via `KnowledgeService` (kind='app') |
| User-Scope | implicit `client_id='bearer'` (Single-User) | explicit `userId` pro Call → JWT sub → KC RLS |
| AAD/Crypto | manuell in `objects/api.ts` | KC2 verwaltet → AppsService weiss nichts davon |
| CAS | D1 `UPDATE ... WHERE current_version=?` | KC PATCH mit `expectedVersion` → HTTP 409 |
| Body-Format | `body_inline` Bytes oder R2 | KC body_b64 (base64 via wire) |

### 2. Service-Interface

Source exportierte freistehende Funktionen (`createApp`, `getApp`, `readAppState`, `updateAppState`, ...). Target hat ein **Service-Object** mit Factory:

```ts
const apps = createAppsService({ knowledge, audit });
await apps.createApp({ userId, appType, ...});
```

Vorteile:
- Dependency-Injection-friendly (Tests stubben KnowledgeService).
- Audit-Hook explizit als dependency, nicht globaler Import.
- `userId` ist in jeder Methode der erste Pflicht-Parameter — kein implicit-Singleuser-Drift moeglich.

### 3. Lifecycle-Operationen

Source hatte 14 Funktionen (`pinApp`, `archiveApp`, `setTitle`, `softDeleteObject`, `restoreObject`, etc.). Target reduziert auf 6 Core-Methods + `deleteApp` (hard via KC). Pin/Archive/Title sind **noch nicht portiert** — KC2 unterstuetzt `pinned`/`archived`-Flags im UpdateObject-Patch; das nachziehen ist 1 Stunde + 1 Tool-Hinzufuegen. Aktuell out-of-scope.

### 4. Approval-Flow

Source: `/dispatch`-Endpoint hat `createPendingApproval` direkt aufgerufen. Target: Tool-Layer (`apps.invoke`) ist `sensitivity='write'` → globaler Approval-Hook im MCP-Transport wrappt das. HTTP-Routes (`/v1/apps/:id/invoke`) sind **Bearer-only** — die laufen ohne Approval, weil:
- Caller hat schon authentifiziert (Bearer → userId).
- Approval-Konzept im Multi-User-Hub ist Tool-zentrisch (LLM-driven actions), nicht HTTP-zentrisch.
- iframe-Surface bleibt fuer User-Click-Throughs (kein Approval-Roundtrip, Trust-Delegation via App-JWT-Bridge).

### 5. App-JWT

Source: HS256 mit HKDF-derived key, claims = `{v, aid, cid='bearer', scp, iat, exp}`.
Target: Gleich — aber `sub` = real userId statt fixed `'bearer'`. Algorithm-pinning + alg-confusion-defense bleiben (jose library).

## Bekannte Lucken / Follow-up

1. **Pin/Archive/Title-Tools** fehlen. Block in Tools-Layer fuer naechsten Burst.
2. **Soft-Delete-Tooling**: KC2 hat heute kein soft-delete-Konzept (alle `deleteObject` sind hard). Wenn benoetigt → KC2-Side hinzufuegen.
3. **Cron-Jobs** (autoArchive 14d, purgeTrashed 30d): ausgelagert, kein Cron-Worker im mcp-approval2-Stack heute.
4. **Auto-Archive-Banner**: ausgelagert, keine `config`-Tabelle in KC2.
5. **`/refresh-token`-Endpoint** (App-JWT-Refresh ohne neue PWA-Session): nicht portiert. iframe muss bei Expiry den `/apps/standalone/:appId`-Endpoint neu callen (das war im Source `/open`).
6. **Templates/Tabs** (`LayoutDoc.meta.template`): Schema im `LayoutDoc`-Type vorhanden, aber `composable.validate` checkt das aktuell nicht. Folge-Pass.
7. **6 fehlende Blocks** (calendar_grid, custom_view, header, heatmap, media_card, segment): on-demand nachziehen.

## Wo aufpassen

- **Body-Encoding**: KC liefert `body_b64` (base64), wir base64-decoden + UTF-8-JSON-parsen. Wenn ein App-State binary-only ist (sollte nicht — wir schreiben immer `application/json`), faellt das auf.
- **Schema-Version-Migration**: Lazy on-read im `readApp`. Wenn ein Block sein Schema bumped, muss der App-Type `migrate(state, fromVersion)` aktualisieren. Heute nur `composable` mit `current_schema_version: 1`.
- **expectedVersion vs. currentVersion**: KC bumped die Version bei JEDEM update, inkl. meta-only updates. Caller muessen das im Hinterkopf haben — `apps.update_state` requires CAS match, nicht "any newer version okay".
- **CAS-Retry**: nur 1 Retry im `invoke()` — bei rapid-fire mehrfach-Klicks aus dem iframe kann der 3. Klick ein `CONCURRENT_UPDATE` werfen. Client muss das handlen (re-read + retry).

## Test-Inventar

- `apps/server/src/apps/api.test.ts`: 12+ Tests fuer `AppsService` (CRUD, CAS, invoke, query, multi-user isolation).
- `apps/server/src/tools/apps-tools.test.ts`: Tool-Registration (8 Tools), Schema-Validation, Block-Catalog (13 Blocks), 4 Block-Invoke-Smoke-Tests.

Run via:
```bash
cd /workspaces/mcp-approval2
npm test -- apps-tools.test.ts api.test.ts
```
