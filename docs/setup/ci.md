# CI Setup

Dieser Guide erklaert die CI-Pipeline (`.github/workflows/ci.yml`), wie man
die einzelnen Steps lokal nachstellt, und was im Failure-Fall zu tun ist.

## Workflows-Ueberblick

| Workflow | Trigger | Zweck |
|---|---|---|
| `ci.yml` | push (alle Branches), PR auf `main` | typecheck + lint + test gegen Node 20 + Node 22 |
| `deploy.yml` | `workflow_dispatch` (Stub) | Deploy-Pipeline — noch nicht aktiv, siehe TODOs im File |

`ci.yml` startet zwei parallele Matrix-Jobs (Node 20.x, Node 22.x). Beide
booten zusaetzlich zwei Service-Container fuer Integration-Tests in
Phase 2+:

- **`pgvector/pgvector:pg16`** — Postgres 16 mit `pgvector` Extension
  fuer Embeddings. Exposed auf `localhost:5432`.
- **`openbao/openbao:latest`** — Self-Hosted KEK-Provider (Transit-Engine).
  Dev-Mode mit Root-Token `dev-root-token` auf `localhost:8200`.

Beide Container haben healthchecks; CI wartet bis sie healthy sind bevor
Tests starten.

## Lokal die CI-Steps nachstellen

```bash
# 1) Dependencies (sauberer Stand wie CI)
npm ci

# 2) Typecheck — alle Workspaces (packages/* + apps/*)
npm run typecheck

# 3) Lint — alle Workspaces, plus Biome als Root-Linter
npm run lint
npx biome check .

# 4) Test — alle Workspaces (vitest workspace config)
npm run test
```

Die Service-Container (Postgres, OpenBao) brauchst du lokal nur fuer
Integration-Tests, die Postgres/OpenBao tatsaechlich anfassen. Phase 0
Unit-Tests laufen ohne. Fuer den vollen CI-Spiegel:

```bash
npm run docker:up   # bringt Postgres + OpenBao via docker-compose hoch
npm run docker:logs # streamt logs zur Diagnose
npm run docker:down # stoppt + raeumt auf
```

(Setzt voraus, dass `docker-compose.yml` existiert — wird in Phase 0
parallel angelegt.)

## Lint-Fehler fixen

Biome hat einen Auto-Fix-Modus:

```bash
# Auto-Fix fuer Format + sichere Lint-Rules
npx biome check . --write

# Inklusive "unsafe" Fixes (z.B. import-Sortierung kann Verhalten
# minimal aendern; review die Diff)
npx biome check . --write --unsafe
```

Per Workspace:

```bash
npm run lint:fix --workspaces --if-present
```

(Voraussetzung: das jeweilige Workspace-Package hat ein `lint:fix`-Script
in `package.json`. Falls nicht, faellt der globale `npx biome check .` ein.)

## Was tun bei CI-Fail

1. **Welcher Step ist rot?**
   - `typecheck` → TS-Fehler. Lokal `npm run typecheck` und der gleichen
     Node-Version (`nvm use 20` oder `nvm use 22`) reproduzieren.
   - `lint` → Biome-Output liest sich gut, oft per `--write` fixbar.
     CI ist fail-closed, also keine Warnings ignorieren.
   - `test` → vitest-Failure. Lokal `npm run test` reproduzieren.
     Bei Integration-Tests Service-Container hochfahren.

2. **Nur eine Node-Version rot?**
   - Wahrscheinlich Node-API-Inkompatibilitaet (z.B. neue stable APIs
     in Node 22). Welche `engines.node` im Code? Workaround oder Bump.

3. **Service-Container failed health?**
   - Postgres: Logs zeigen oft Port-Konflikt oder OOM. Re-run reicht meist.
   - OpenBao: Dev-Mode ist instabil bei Cold-Cache. Re-run.

4. **Flaky?**
   - Re-run zuerst. Wenn nach 2 Re-Runs noch rot → echter Bug, nicht Flake.
     Issue eroeffnen mit Label `flaky`.

## Caching-Strategie

`ci.yml` cached zwei Layer fuer kalte Builds:

1. **npm cache (`~/.npm`)** — via `actions/setup-node@v4` mit `cache: npm`.
   Key: Lockfile-Hash. Beschleunigt `npm ci` von ~60s auf ~10s.
2. **`node_modules` + Workspace-Module** — via `actions/cache@v4`.
   Key: `nm-<os>-node<version>-<lockfile-hash>`. Bei Cache-Hit
   ueberspringt `npm ci` quasi den Install (Modul-Tree bereits da,
   `npm ci` validiert nur).

Bei haengenden Caches: in GH-UI unter `Actions → Caches` manuell loeschen.

## Secrets

CI verwendet aktuell KEINE Secrets — alle Service-Container laufen mit
Dev-Defaults. Sobald Deploy aktiv wird (`.github/workflows/deploy.yml`),
kommen pro Environment Secrets dazu. Konvention:

- Repo-Secrets fuer Workflow-uebergreifende Tokens (z.B. `CF_API_TOKEN`).
- Environment-Secrets (`production`, `staging`) fuer environment-spezifisches
  (`DATABASE_URL_PROD`, `OPENBAO_TOKEN_PROD`).
- NIE Secrets in Workflow-Files committen — auch nicht "voruebergehend".

## Dependabot

`.github/dependabot.yml` schickt jeden Montag 06:00 Europe/Berlin
gruppierte Update-PRs:

- `drizzle` — alle drizzle-* Pakete zusammen
- `typescript` — `typescript` + `@types/*`
- `hono` — alle hono-* Pakete
- `crypto` — `jose` + `@noble/*`
- plus GitHub-Actions-Updates separat

Max 5 offene PRs pro Ecosystem, damit kein Backlog entsteht.

## Weiterfuehrend

- `biome.json` — Linter/Formatter-Config
- `vitest.workspace.ts` — Test-Workspace
- `docs/plans/active/PLAN-architecture-v1.md` — Architektur-Baseline
