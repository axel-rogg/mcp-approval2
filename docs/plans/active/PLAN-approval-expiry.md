## PLAN-approval-expiry — Abgelaufene Approvals werden in der PWA noch als `pending` angezeigt

⚠️ **Status: Draft v2 — Subagent-validated** (2026-05-17)

### Design-Review (2 Subagenten)

**Alternative geprüft**: SQL-side `effective_status`-Expression im SELECT statt
Lazy-Write-on-Read. Plan-Agent hat das mit drei strukturellen Argumenten
abgelehnt:

1. **Single source of truth zerfällt**. Mehrere Code-Stellen prüfen
   `status` direkt: [transport.ts:396](apps/server/src/mcp/protocol/transport.ts)
   für `status !== 'approved'`, [transport.ts:415](apps/server/src/mcp/protocol/transport.ts)
   für `resultEmittedAt`, [approvals.ts:421](apps/server/src/services/approvals.ts)
   für `existing.status !== 'pending'`. Effective_status müsste in JEDEM
   dieser Pfade nachgezogen werden — das ist SEC-018/SEC-004-Surface (Race-
   gegen Re-Dispatch). Lazy-Write hält EIN Feld autoritativ.

2. **WHERE-Filter wird hässlich + Index bricht**. PWA filtert mit
   `?status=pending` → `WHERE status='pending'`. Effective_status erzwingt
   `WHERE (status='pending' AND expires_at >= now) OR …` — der Index
   `idx_(user_id, status)` aus
   [migrations/0005_approvals.sql:58](apps/server/migrations/0005_approvals.sql)
   nutzt das nicht sauber.

3. **Audit-Konsistenz**. `expired_at`-Timestamp + `tool.approval.sweep_expired`-
   Event sind an die persistente Spalte gekoppelt. Effective_status führt zu
   Drift zwischen DB und Audit unter Last.

**Write-Amplification (das Pro-Argument für effective_status)** ist real aber
begrenzt: Postgres macht keine no-op writes — `UPDATE … WHERE status='pending'
AND expires_at < now() RETURNING id` schreibt 0 Rows wenn nichts expired ist.
Acceptable Overhead.

**Zusätzliche Findings aus v1-Deep-Dive (Explore-Agent)**:
- v1 hat einen `executing`-Status zur Race-Vermeidung bei double-execute. **v2
  hat den nicht**. Nicht Teil dieses Plans — Folge-Diskussion zu Re-Dispatch-Locking.
- v1 hat `idempotency_key` mit UNIQUE-Constraint. **v2 hat den nicht**. Bei
  Claude-Retry kann doppeltes Pending entstehen. Nicht Teil dieses Plans —
  Folge-Aufgabe.
- v1 PWA disabled Approve-Button unter 10s Rest-TTL (gegen Approve-Before-
  Expire-Race). **In Slice 4 mit aufgenommen.**
- v1 logged Lazy-Flips NICHT im Audit (cron-sweep emittiert das stattdessen
  einmal pro Sweep). v2 macht's gleich.


### Symptom

Approvals deren `expires_at < now` sollten in der PWA als **abgelaufen** dargestellt
werden (oder gar nicht in der Pending-Liste auftauchen). Aktuell bleiben sie als
`pending` mit kaputt-leuchtendem Approve-Button stehen, bis der User sie versucht
zu approven — dann erst meldet der Server `409 conflict (expired)` (Service-Code
in [services/approvals.ts:424-431](apps/server/src/services/approvals.ts#L424-L431)).

### Wie v1 (mcp-approval) das löst

Zwei Mechanismen kombiniert in [src/approve/pending_route.ts](https://github.com/axel-rogg/mcp-approval/blob/main/src/approve/pending_route.ts):

1. **Lazy Expiry on Read** (pending_route.ts:84-94, 183-187)
   - **Single-GET**: `if (status === 'pending' && now > row.expires_at)` →
     atomic `UPDATE … SET status='expired' WHERE id=? AND status='pending'`
     bevor die Row an die PWA gegeben wird.
   - **List-GET**: Bulk-Update vorab `UPDATE … SET status='expired' WHERE
     status='pending' AND expires_at < ?` damit beide Sections (pending +
     history) ohne Race richtig rendern.
   - **Vorteil**: kein Cron nötig für den happy path; PWA sieht IMMER konsistente
     States, weil Lesen + Flip in einer Transaction stecken.
   - **Nachteil**: Nur sichtbar wenn jemand liest. Approvals die niemals gelesen
     werden bleiben in DB-pending bis sweep-Cron sie aufräumt.

2. **Cron-Sweep** (cron/sweep_executing.ts)
   - Läuft `*/5 * * * *` via Cloudflare-Workers-Cron-Trigger.
   - UPDATE alle Stuck-pending → expired. Schließt die Lazy-Lücke für ungelesene
     Rows.

### Wie v2 (mcp-approval2) das aktuell handhabt

`ApprovalService.sweepExpired()` ist in [services/approvals.ts:519-538](apps/server/src/services/approvals.ts#L519-L538) **implementiert**, wird vom Cron-Task `sweep-executing-approvals`
([cron/sweep-executing-approvals.ts](apps/server/src/cron/sweep-executing-approvals.ts))
aufgerufen — der wiederum **nur dann läuft wenn ein externer Scheduler**
`POST /internal/v1/cron/sweep-executing-approvals` triggert.

**Aktuell läuft nichts**: weder Fly-cron noch GH-Actions-cron noch eine andere
Maschine pingt diesen Endpoint. Bestätigt durch grep:

```
$ grep -rn "internal/v1/cron" fly.toml .github/workflows/ scripts/
(no matches)
```

**Zusätzlich fehlt der Lazy-Expiry-Pfad**: `list()` + `get()` in `ApprovalService`
geben einfach `SELECT * FROM pending_approvals` zurück, ohne vorher zu flippen.

### Gap-Analyse

| | v1 | v2 |
|---|---|---|
| Lazy-expire bei `GET /:id` | ✅ | ❌ fehlt |
| Lazy-expire bei `GET /` (list) | ✅ | ❌ fehlt |
| Cron-Sweep verfügbar | ✅ | ⚠️ vorhanden aber **nicht getriggert** |
| Atomic 409 bei expire-during-approve | ✅ | ✅ existiert ([approvals.ts:424-431](apps/server/src/services/approvals.ts#L424-L431)) |
| PWA-Filtering nach `status='pending'` | ✅ | ✅ (`status: 'pending'` Query) |

### Plan — 3 Slices

#### Slice 1: Lazy-Expiry in `ApprovalService` (Quick-Fix, deckt 95% der Fälle)

**Why first**: kein Infrastruktur-Setup nötig, fixt das User-sichtbare Symptom
sofort. Cron-Setup (Slice 3) ist Defense-in-Depth.

**Files**:
- `apps/server/src/services/approvals.ts`
- `apps/server/src/services/approvals.test.ts`

**Code**:

```ts
// in createApprovalService — Helper:
async function lazyExpireOne(scoped: ScopedDb, id: string, userId: string): Promise<void> {
  const ts = now();
  await scoped.query(
    `UPDATE pending_approvals
        SET status = 'expired', expired_at = $1
      WHERE id = $2 AND user_id = $3
        AND status = 'pending' AND expires_at < $1`,
    [ts, id, userId],
  );
}

async function lazyExpireUser(scoped: ScopedDb, userId: string): Promise<number> {
  const ts = now();
  const rows = await scoped.query<{ id: string }>(
    `UPDATE pending_approvals
        SET status = 'expired', expired_at = $1
      WHERE user_id = $2 AND status = 'pending' AND expires_at < $1
      RETURNING id`,
    [ts, userId],
  );
  return rows.length;
}
```

- `get()`: vor dem SELECT `lazyExpireOne()` aufrufen.
- `list()`: vor dem SELECT `lazyExpireUser()` aufrufen.

**Tests** (extend approvals.test.ts):
- expired row wird beim ersten `get(id)` zu `status='expired'` geflippt
- list() retourniert die geflippte row als `expired` (nicht als `pending`)
- bereits-expired Rows werden NICHT erneut updated (`expired_at` bleibt)
- approve() auf bereits-expired wirft 409 (existiert schon, regress-fixiert)

#### Slice 2: PWA UX — Expired-Approval-Badge

**Files**:
- `apps/web/src/approval.ts` (Liste)
- `apps/web/src/approval-detail.ts` (Detail-View)

Aktuell zeigt die Liste alle nicht-abgelaufenen wenn `status='pending'`-Filter
aktiv ist. Nach Slice 1 verschwinden expired aus der Liste automatisch. Aber:
**das v1 hat zusätzlich ein "expired"-Badge im History-Tab und Sortier-Ordnung
zeigt: Pending > Approved > Rejected > Expired**.

Minimum-Variante: nichts in der PWA tun, Service-Layer-Fix ist ausreichend.
Optional: separate "expired" Status-Filter-Option in der PWA.

**Akzeptanz**:
- [x] Nach Slice 1 zeigt die Pending-Liste keine abgelaufenen mehr (sie werden
      vor dem SELECT auf 'expired' geflippt → fallen aus dem `WHERE status='pending'`-Filter)
- Optional [ ] Expired-Badge im History-Tab

#### Slice 3: External-Scheduler für `sweepExpired` (Defense-in-Depth)

**Why**: Lazy-Expiry fängt 95% ab — aber Approvals die niemals geladen werden
(z.B. abandoned Sessions, vergessene Browser-Tabs) bleiben DB-pending bis
jemand `service.list()` ruft. Ein periodischer Sweep räumt das im Hintergrund.

**Optionen** (eine wählen):

A. **GitHub Actions cron** (am einfachsten, kein Fly-Hosting-Aufwand):
   - Neue Datei `.github/workflows/cron-sweep.yml`
   - `schedule: cron: '*/5 * * * *'`
   - Jobs hitten alle relevanten cron-tasks via curl mit `SERVICE_TOKEN` aus GH-Secrets
   - Vorteile: kostenlos, einfach, sichtbar in GH-Actions-UI
   - Nachteile: GH-Cron-Latenz kann 15min sein, nicht harte 5min

B. **Fly-Machine-Schedule** (in-cluster, präziser):
   - `flyctl machine run --schedule cron --cron '*/5 * * * *' …` startet eine
     Mini-Machine die curl macht
   - Nachteile: separates Setup, +Kosten (~1¢/Tag)

C. **In-Process Cron** (z.B. node-cron-Lib):
   - Setup im app-factory beim Boot
   - Nachteile: bei 2 Machines doppelt-getriggert (race-OK aber Spam-Log).
     Plan-Architektur hat external-scheduler-Pattern explizit gewählt
     (CLAUDE.md cross-repo): "Mehrere App-Instanzen können sich nicht doppelt triggern"

**Empfehlung: A (GH-Actions-cron)**. Niedrigste Komplexität, sichtbar im Repo,
gratis. Latenz egal weil Slice 1 schon den happy path abdeckt.

**Sketch GH-Workflow**:

```yaml
# .github/workflows/cron-sweep.yml
name: Cron sweep tasks
on:
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch:
jobs:
  sweep:
    runs-on: ubuntu-latest
    steps:
      - name: sweep-executing-approvals
        run: |
          curl -fsS -X POST \
            -H "Authorization: Bearer ${{ secrets.MCP_INTERNAL_SERVICE_TOKEN }}" \
            -H "Content-Type: application/json" -d '{}' \
            https://mcp-approval2.fly.dev/internal/v1/cron/sweep-executing-approvals
      - name: sweep-output-refs
        run: |
          curl -fsS -X POST \
            -H "Authorization: Bearer ${{ secrets.MCP_INTERNAL_SERVICE_TOKEN }}" \
            -H "Content-Type: application/json" -d '{}' \
            https://mcp-approval2.fly.dev/internal/v1/cron/sweep-output-refs
```

Plus GH-Secret `MCP_INTERNAL_SERVICE_TOKEN` setzen (gleicher Wert wie
SERVICE_TOKEN in Fly Doppler).

### Reihenfolge + Aufwand

| # | Slice | Files | Aufwand | Risiko |
|---|---|---|---|---|
| 1 | Lazy-Expiry in get/list | 2 (service + test) | ~20 min | gering — additive query |
| 2 | (Optional) PWA expired-Badge | 2 | ~30 min | gering, kosmetisch |
| 3 | GH-Actions-cron | 1 neu | ~10 min + GH-Secret | gering — read-only-trigger |

### Akzeptanzkriterien (final)

- [ ] Slice 1 deployed → wenn ich eine pending-Approval >5min liegen lasse und
      PWA reload, ist sie NICHT mehr in der Pending-Liste
- [ ] approve() auf already-expired wirft 409 (regression-fix, war schon da)
- [ ] Slice 3 deployed → GH-Actions-cron pingt sweep-Endpoint, Audit-Log zeigt
      regelmäßige `tool.approval.sweep_expired`-Events
- [ ] Optional: PWA History-Tab zeigt expired-Badge
