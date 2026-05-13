/**
 * mcp-approval2 server entry.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2, §3, §11.
 *
 * Aufbau:
 *   - loadConfig(env) — Pflicht-Vars validieren.
 *   - createDbAdapter(config) — Postgres oder SQLite.
 *   - serverContext { config, db } wird in alle Routen injiziert.
 *   - request-id + error-handler global.
 *   - Routen-Mount.
 */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { AppBindings, ServerContext } from './lib/context.js';
import { loadConfig, type AppConfig } from './lib/config.js';
import { createDbAdapter } from './lib/db.js';
import { requestId } from './middleware/request-id.js';
import { errorHandler } from './middleware/error-handler.js';
import { healthRoutes } from './routes/health.js';
import { googleAuthRoutes } from './routes/auth/google.js';
import { sessionRoutes } from './routes/auth/session.js';
import { webauthnRoutes } from './routes/auth/webauthn.js';
import { inviteRoutes } from './routes/auth/invite.js';
import { recoveryRoutes } from './routes/auth/recovery.js';
import { credentialsRoutes } from './routes/credentials.js';
import { createCredentialsService, type CredentialsService } from './services/credentials.js';
import { createPrfSessionService, type PrfSessionService } from './services/prf-session.js';
import { knowledgeProxyRoutes } from './routes/knowledge-proxy.js';
import type { KnowledgeService } from './services/knowledge.js';
import type { KekProvider } from '@mcp-approval2/adapters';

export interface CreateAppDeps {
  /**
   * KEK-Provider fuer Credential-Encrypt/Decrypt. Optional — wenn nicht
   * uebergeben, sind die `/v1/credentials/*`-Routes nicht montiert.
   */
  readonly kekProvider?: KekProvider;
  /** Optional: bestehender CredentialsService (Tests). Override gewinnt. */
  readonly credentials?: CredentialsService;
  /** Optional: bestehender PrfSessionService (Tests). */
  readonly prfSessions?: PrfSessionService;
  /**
   * Optional: KnowledgeService gegen mcp-knowledge2.
   * Wenn nicht uebergeben sind die `/v1/knowledge/*`-Routes nicht montiert.
   */
  readonly knowledge?: KnowledgeService;
}

export async function createApp(
  server: ServerContext,
  deps: CreateAppDeps = {},
): Promise<Hono<AppBindings>> {
  const app = new Hono<AppBindings>();
  app.use('*', requestId());
  app.onError(errorHandler());

  app.route('/', healthRoutes());
  app.route('/', googleAuthRoutes(server));
  app.route('/', sessionRoutes(server));
  app.route('/', webauthnRoutes(server));
  app.route('/', inviteRoutes(server));
  app.route('/', recoveryRoutes(server));

  const credentials =
    deps.credentials ??
    (deps.kekProvider
      ? createCredentialsService({ db: server.db, kekProvider: deps.kekProvider })
      : null);
  if (credentials) {
    const prfSessions = deps.prfSessions ?? createPrfSessionService();
    app.route('/', credentialsRoutes({ server, credentials, prfSessions }));
  }

  if (deps.knowledge) {
    app.route('/', knowledgeProxyRoutes(server, { knowledge: deps.knowledge }));
  }

  return app;
}

/**
 * createServerContext mit minimalem env-Subset — fuer Tests, die nicht durch
 * `process.env` gehen wollen.
 */
export async function createServerContext(env: NodeJS.ProcessEnv): Promise<ServerContext> {
  const config: AppConfig = loadConfig(env);
  const db = await createDbAdapter(config);
  return { config, db };
}

// Boot-Pfad. `main`-Wrapper nur wenn nicht im Test-Modus.
async function main(): Promise<void> {
  const server = await createServerContext(process.env);
  const app = await createApp(server);
  const port = server.config.PORT;
  // eslint-disable-next-line no-console
  console.log(`[mcp-approval2] listening on :${port}`);
  serve({ fetch: app.fetch, port });
}

// Nur starten wenn als CLI ausgefuehrt — NICHT bei Test-Import.
const isCli =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('/src/index.ts') ||
    process.argv[1].endsWith('/dist/index.js') ||
    process.argv[1].endsWith('\\src\\index.ts') ||
    process.argv[1].endsWith('\\dist\\index.js'));

if (isCli) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[mcp-approval2] startup failed', err);
    process.exit(1);
  });
}
