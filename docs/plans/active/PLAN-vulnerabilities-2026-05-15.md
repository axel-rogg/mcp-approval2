# Vulnerability-Fix-Plan (mcp-approval2)

> **Status:** Draft 2026-05-15.
> **Trigger:** GitHub Dependabot-Warnung beim Push (3 high, 3 moderate berichtet; npm audit zeigt 9 vulns).
> **Audit-Datum:** 2026-05-15 nach Generic-Object-Model-Cutover.

## Vulnerability-Inventar

`npm audit` ergibt **9 Treffer**:

| Package | Severity | Fix | Breaking | Production? | Notiz |
|---|---|---|---|---|---|
| **drizzle-orm** | **HIGH** | 0.45.2 | ja (major) | **ja** | SQL injection via improperly escaped SQL identifiers ([GHSA-gpj5-g38j-94v9](https://github.com/advisories/GHSA-gpj5-g38j-94v9)). CVSS 7.5. |
| drizzle-kit | moderate | 0.31.10 | ja (major) | nein (dev) | transitiv via @esbuild-kit/esm-loader → esbuild |
| @esbuild-kit/core-utils | moderate | drizzle-kit@0.31.10 | ja | nein | via esbuild |
| @esbuild-kit/esm-loader | moderate | drizzle-kit@0.31.10 | ja | nein | via core-utils |
| esbuild | moderate | vite@8.0.13 | ja | nein | [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) — dev-server CORS |
| vite | moderate | 8.0.13 | ja | nein (dev/build) | [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) — path traversal in optimized deps `.map` |
| vite-node | moderate | vitest@4.1.6 | ja | nein | via vite |
| vitest | moderate | 4.1.6 | ja | nein (test) | via vite |
| @vitest/mocker | moderate | vitest@4.1.6 | ja | nein | via vite |

**1 production-runtime HIGH** (drizzle-orm) — **muss zuerst**. 8 dev-only moderate — niedrigere Dringlichkeit aber im selben Bump (drizzle-kit, vite, vitest sind major-Updates die mehrere transitive Issues mit-fixen).

## Strategy: Drei-Schritt-Update

Wir bumpen in 3 atomaren Commits, damit ein Rollback per `git revert` chirurgisch bleibt.

### Schritt 1 — drizzle-orm 0.45.2 (HIGH, production-runtime)

```bash
cd /workspaces/mcp-approval2
npm install drizzle-orm@^0.45.2 --workspace=apps/server
```

**Verify:**
- `npm run build` — kompiliert das Server-Bundle
- `npm test` — alle 473 Tests grün
- Manuell: spot-check `apps/server/src/schema/postgres/*.ts` und `apps/server/src/services/*.ts` auf API-Drift (drizzle-orm 0.x → 0.x major Bumps haben in der Vergangenheit häufig kleine Schema-API-Changes gehabt)

**Erwartete Breaking Changes** (laut drizzle-orm-changelog für 0.40+):
- `eq()`/`and()`/`or()` Imports vermutlich unverändert
- Migrations-API in `drizzle/migrate.ts` muss vermutlich angepasst werden
- `relations`-API möglicherweise erweitert

Falls Schema-Drift: anpassen, in derselben Commit.

### Schritt 2 — vite + vitest auf 8.x / 4.x (dev/test)

```bash
npm install -D vite@^8.0.13 vitest@^4.1.6 --workspaces
```

**Verify:**
- `npm run build` (vite-build)
- `npm test` (vitest)
- `npm run typecheck`
- Spot-check `vite.config.ts` und `vitest.config.ts` für API-Drift

**Erwartete Breaking Changes:**
- vite 8: vermutlich neue minimum Node-Version (≥20.x — bestätigen)
- vitest 4: API für `vi.mock()`, `expect()`, `setupFiles` möglicherweise leicht anders
- `apps/web` vite-Config (Plugin-Liste etc.) checken

### Schritt 3 — drizzle-kit 0.31.10 (dev/CLI)

```bash
npm install -D drizzle-kit@^0.31.10 --workspaces
```

**Verify:**
- `npm run db:generate` oder `npx drizzle-kit generate` läuft sauber (falls Migrations-Workflow aktiv)
- Spot-check `drizzle.config.ts`

**Erwartete Breaking Changes:**
- drizzle-kit hat von 0.20.x → 0.30.x mehrere Config-Format-Änderungen gehabt. `drizzle.config.ts` muss vermutlich angepasst werden.
- Falls Migration-Folder-Struktur sich ändert: NICHT die existierenden Migrations anfassen, nur die Config.

## Verifikations-Gates pro Schritt

Nach jedem Schritt MÜSSEN grün sein:
- [ ] `npm run lint` (workspaces)
- [ ] `npm run build` (workspaces — Server-Bundle + Web-Bundle + Adapter-Pkg)
- [ ] `npm test` (473 Tests Baseline)
- [ ] `npm run typecheck` (strict mit `noUncheckedIndexedAccess`)

Wenn ein Gate rot: **STOP, fixen oder revert**. Nicht zum nächsten Schritt.

## Rollback

Jeder Schritt ist ein eigener Commit. Rollback = `git revert <commit>`.

## Cross-Repo-Sync

mcp-knowledge2 hat eigenes [PLAN-vulnerabilities-2026-05-15.md](https://github.com/axel-rogg/mcp-knowledge2/blob/feat/as3-cutover/docs/plans/active/PLAN-vulnerabilities-2026-05-15.md) mit überschneidenden moderate dev-only vulns (vite/vitest/esbuild) plus eigenem HIGH (undici via testcontainers). Updates können parallel laufen, kein cross-repo TS-Build-Risiko.

## Out-of-scope

- Audit-Tooling automatisieren (z.B. Dependabot-Auto-PRs) — separater Folge-PR
- Lockfile-Cleanup (`npm dedupe` o.ä.) — nach den 3 Schritten als optionaler Cleanup

## Definition of Done

- 0 high + 0 moderate Vulnerabilities laut `npm audit`
- `npm test` 473/473 grün
- `npm run build` grün (Server + Web + Adapter)
- 3 atomare Commits gepusht
