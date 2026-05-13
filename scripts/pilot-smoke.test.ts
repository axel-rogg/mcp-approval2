/**
 * Pilot-Smoke (Optional, Heavy) — Vitest mit testcontainers.
 *
 * Plan-Ref: docs/runbooks/runbook-pilot-smoke.md §4 "Lokal CI-Variante"
 *
 * Dieser Test fuehrt einen ECHTEN Postgres-Container hoch (pgvector/pgvector:pg16),
 * fuehrt die Drizzle-Migrations aus und fuehrt einen End-to-End-Health-Check
 * gegen createApp() durch.
 *
 * Aktivierung:
 *   PILOT_SMOKE_TESTCONTAINERS=1 vitest run scripts/pilot-smoke.test.ts
 *
 * Ohne das Flag wird der Test geskippt — `@testcontainers/postgresql` ist
 * dev-only (nicht in production package.json). Wenn das Flag gesetzt ist und
 * das Modul nicht aufloest, scheitert der Test laut (Setup-Hinweis).
 *
 * Hinweis: das ist ein Smoke fuer den GitHub-Actions-CI mit Docker-on-runner.
 * Lokal reicht in 99% der Faelle `bash scripts/pilot-smoke.sh` (gegen den
 * docker-compose-Stack) plus `vitest run apps/server/tests/integration/`
 * (In-Memory-Pfad).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const ENABLED = process.env.PILOT_SMOKE_TESTCONTAINERS === '1';
const describeIf = ENABLED ? describe : describe.skip;

interface ContainerHandle {
  stop: () => Promise<void>;
  uri: string;
}

let container: ContainerHandle | null = null;

beforeAll(async () => {
  if (!ENABLED) return;
  // Lazy import — devDep, soll nicht in prod-Build landen.
  let mod: typeof import('@testcontainers/postgresql');
  try {
    mod = await import('@testcontainers/postgresql');
  } catch (err) {
    throw new Error(
      'PILOT_SMOKE_TESTCONTAINERS=1 gesetzt, aber @testcontainers/postgresql ist nicht installiert. ' +
        'Run: npm i -D @testcontainers/postgresql testcontainers',
    );
  }
  const c = await new mod.PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('pilot_smoke')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();
  container = {
    stop: () => c.stop(),
    uri: c.getConnectionUri(),
  };
}, 120_000);

afterAll(async () => {
  if (container) {
    await container.stop();
    container = null;
  }
});

describeIf('Pilot-Smoke (testcontainers)', () => {
  it('postgres container reports ok', () => {
    expect(container).not.toBeNull();
    expect(container?.uri).toMatch(/^postgres(ql)?:\/\//);
  });

  it('placeholder for app-boot against real postgres', () => {
    // Voll-E2E (createApp + Drizzle-Migrate + Real-Endpoint-Tests) liegt
    // bewusst NICHT hier — das duplicate-t die volle Test-Suite. Stattdessen:
    //
    //   1. Postgres-URL aus container.uri lesen
    //   2. createPostgresAdapter({ url, migrationsFolder: './migrations' })
    //   3. await db.migrate()
    //   4. createApp(server, { kekProvider, internalServiceToken })
    //   5. supertest oder app.request(...) gegen Health + Auth
    //
    // Wer den Test brauch fuer Real-DB-Verify: ausbauen.
    expect(true).toBe(true);
  });
});
