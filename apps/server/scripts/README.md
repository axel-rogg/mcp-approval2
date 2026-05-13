# apps/server/scripts

Operational CLIs fuer mcp-approval2. Alle Scripts laufen via `tsx`, exit
mit dokumentierten Codes, schreiben strukturierten Output und sind
idempotent wo immer moeglich.

Plan-Ref: [PLAN-architecture-v1.md §12](../../../docs/plans/active/PLAN-architecture-v1.md)
(Migration-Pipeline) und §5.2 (OpenBao-Setup).

## Uebersicht

| Script | npm-Alias | Zweck |
|---|---|---|
| `migrate.ts` | `npm run db:migrate` | Apply pending SQL-Migrations in Reihenfolge |
| `migrate-status.ts` | `npm run db:status` | Zeigt applied/pending/drift pro Migration |
| `seed.ts` | `npm run db:seed` | Erster Admin-User fuer Bootstrap-Phase |
| `vault-bootstrap.ts` | `npm run vault:bootstrap` | OpenBao Transit + AppRole-Setup |
| `health-check.ts` | `npm run health-check` | Live-Reachability DB/Vault/KC2/Vertex |

---

## migrate.ts

Production-DB-Migrate-CLI. Liest `apps/server/migrations/NNNN_*.sql` in
Filename-Order, fuehrt jede unapplied Migration in einer eigenen
Transaction aus, schreibt einen Eintrag in `_migrations(version, name,
applied_at, checksum)`.

**Tracking-Table** `_migrations` wird vor dem ersten Run idempotent aus
`migrations/_meta_meta.sql` angelegt.

**Drift-Detection:** wenn eine bereits applied Migration auf der Disk
einen abweichenden sha256-Checksum hat → exit 1, keine weiteren Aktionen.
Fix: neue Forward-Migration `000N_<patch>.sql` schreiben, nie alte Files
mutieren.

**Usage:**

```bash
npm run db:migrate                        # alle pending applien
tsx scripts/migrate.ts --dry-run          # nur listen, nichts schreiben
tsx scripts/migrate.ts --target=0003      # bis (inkl.) 0003 applien
```

**Env:** `DATABASE_URL` (required).

**Exit-Codes:** 0 ok / 1 op-error oder drift / 2 bad invocation.

---

## migrate-status.ts

Read-only Status-Report. Listet jede `NNNN_*.sql` mit Status `applied`,
`pending` oder `DRIFT` plus `applied_at`-Timestamp.

```bash
npm run db:status                       # tabellarisch
tsx scripts/migrate-status.ts --json    # JSON fuer CI
```

**Env:** `DATABASE_URL` (required).

**Exit-Codes:** 0 ok / 1 DB unreachable / 2 bad invocation.

---

## seed.ts

Erstellt einen ersten Admin-User wenn die `users`-Tabelle leer ist.
Skippt automatisch wenn schon Active-User existieren — `--force` ueberschreibt
den Skip (mit Warnung). Schreibt einen `admin.bootstrap.seed`-Eintrag ins
`audit_log` (best-effort, soft-skip wenn das Schema noch fehlt).

```bash
npm run db:seed -- --email=admin@firma.de
tsx scripts/seed.ts --email=admin@firma.de --name="Admin"
tsx scripts/seed.ts --email=admin@firma.de --force
```

**Env:** `DATABASE_URL` (required).

**Exit-Codes:** 0 success oder skip / 1 DB-error / 2 bad invocation.

**Production-Hinweis:** Im Pilot-Setup gewinnt der echte
First-Login-First-Admin-Pfad (PLAN §3.3). Das Seed-Script ist nur fuer
Dev-Setups + Smoke-Tests gedacht, wo kein Google-OAuth verfuegbar ist.

---

## vault-bootstrap.ts

Konfiguriert eine frische OpenBao-Instanz nach `vault operator init &&
vault operator unseal` so, dass mcp-approval2 sie via AppRole nutzen kann.

Schritte (alle idempotent):

1. `transit` Secret-Engine aktivieren
2. Policy `mcp-approval2` schreiben (`encrypt/decrypt/rewrap` auf
   `transit/keys/user-*`, `create/update` der Keys selbst — KEIN Destroy,
   KEIN Read fuer Key-Material)
3. `approle` Auth-Method aktivieren
4. AppRole `mcp-approval2` mit der Policy verknuepfen
5. `role_id` lesen + neue `secret_id` generieren
6. Beide auf stdout printen (fuer `.env`-Eintrag)

```bash
VAULT_ADDR=http://127.0.0.1:8200 \
VAULT_TOKEN=<root-or-bootstrap-token> \
  npm run vault:bootstrap
```

**Output:**

```
VAULT_ADDR=...
VAULT_ROLE_ID=...
VAULT_SECRET_ID=...
```

**Env:** `VAULT_TOKEN` (required, Root- oder privilegierter
Bootstrap-Token), `VAULT_ADDR` (default `http://127.0.0.1:8200`).

**Exit-Codes:** 0 ok / 1 vault unreachable oder step failed / 2 token missing.

**Production-Hinweis:** Bootstrap-Token nach diesem Schritt revoken — die
mcp-approval2-App nutzt nur noch AppRole, niemals den Root-Token.

---

## health-check.ts

Probe-Endpoint-Check gegen alle Service-Dependencies. Parallel ausgefuehrt,
strukturierter JSON-Output, CI-tauglich.

```bash
npm run health-check
```

Checks:

- **db** — `SELECT 1` auf `DATABASE_URL` (skipped wenn nicht gesetzt)
- **vault** — `GET /v1/sys/health` auf `VAULT_ADDR` (Status 200/429/501 = ok)
- **kc2** — `GET /health` auf `KC2_URL` (default `http://127.0.0.1:8787`)
- **vertex** — TLS-Reachability `https://{location}-aiplatform.googleapis.com`
  (nur wenn `VERTEX_AI_PROJECT_ID` gesetzt — voller API-Call braucht
  Service-Account-Auth, ausserhalb dieses Scopes)

**Env:** `DATABASE_URL`, `VAULT_ADDR`, `KC2_URL`, `VERTEX_AI_PROJECT_ID`,
`VERTEX_AI_LOCATION` (default `europe-west4`).

**Exit-Codes:** 0 alle ok / 1 mindestens ein Check failed.

**Output-Schema:**

```json
{
  "ok": true,
  "checks": [
    { "name": "db", "ok": true, "ms": 12 },
    { "name": "vault", "ok": true, "ms": 18, "detail": "status=200" },
    { "name": "kc2", "ok": true, "ms": 9, "detail": "status=200" },
    { "name": "vertex", "ok": true, "ms": 0, "skipped": true, "detail": "VERTEX_AI_PROJECT_ID not set" }
  ]
}
```

---

## Konventionen

- **Strict TypeScript** (`tsconfig.json` `strict + noUncheckedIndexedAccess`).
  Scripts laufen ohne separate Build-Phase via `tsx`.
- **Keine externen Deps ausserhalb `package.json`** — Scripts nutzen nur
  Built-Ins (`node:crypto`, `node:fs`, `node:path`, `fetch`) plus `postgres`.
- **Idempotent default** — Re-Run darf nie kaputt machen. Exception: `seed.ts
  --force`, das ist eine bewusste Override.
- **Exit-Codes** sind dokumentiert und stabil — CI darf sich drauf
  verlassen.
- **Kein Live-Vault-Call in Tests** — Vitest-Suites stubben die `fetch`-Calls
  bzw. ueberspringen Vault-pfade hinter Env-Gates.
