/**
 * createApp — voller Dependency-Wireup fuer den Hono-Server.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2 (Architektur), §11 Burst-3 (Final-Wiring).
 *
 * Verantwortung:
 *   - Middleware-Order verbindlich festziehen (request-id → error-handler →
 *     auth-on-protected-Routes).
 *   - Alle Route-Trees mounten (public, auth-protected, MCP-Protocol, OAuth).
 *   - Tools registrieren via `registerCoreTools` (tools/index.ts) wenn alle
 *     noetigen Services (knowledge + credentials + prfSessions) verfuegbar
 *     sind; sonst nur die `system.*` Smoke-Tools.
 *
 * Diese Factory ist injection-friendly: alle Services / Adapter koennen ueber
 * `CreateAppDeps` ueberschrieben werden — Test-Suites bauen Stubs, Production
 * uebergibt echte OpenBao/Postgres/Knowledge-Adapter via `apps/server/src/
 * index.ts`.
 *
 * Was hier NICHT passiert:
 *   - Kein Process-Boot (siehe index.ts).
 *   - Keine DB-Connection-Lifecycle (Caller besitzt + close-d das).
 *   - Keine Migration-Runs.
 */
import { Hono } from 'hono';
import type { KekProvider } from '@mcp-approval2/adapters';
import type { AppBindings, ServerContext } from './lib/context.js';
import { requestId } from './middleware/request-id.js';
import { errorHandler } from './middleware/error-handler.js';

// Public + auth-protected routes
import { healthRoutes } from './routes/health.js';
import { googleAuthRoutes } from './routes/auth/google.js';
import { sessionRoutes } from './routes/auth/session.js';
import { webauthnRoutes } from './routes/auth/webauthn.js';
import { inviteRoutes } from './routes/auth/invite.js';
import { recoveryRoutes } from './routes/auth/recovery.js';
import { credentialsRoutes } from './routes/credentials.js';
import { knowledgeProxyRoutes } from './routes/knowledge-proxy.js';
import { adminRoutes } from './routes/admin.js';
import { gdprRoutes } from './routes/gdpr.js';
import { createAdminService } from './services/admin.js';
import { createGdprService } from './services/gdpr.js';

// MCP-Protocol
import { mcpProtocolRoutes, ToolRegistry } from './mcp/protocol/index.js';
import type { AuditService } from './mcp/protocol/tool.js';

// OAuth 2.1 Authorization-Server
import { oauthRoutes } from './mcp/oauth/index.js';

// Services
import {
  createCredentialsService,
  type CredentialsService,
} from './services/credentials.js';
import {
  createPrfSessionService,
  type PrfSessionService,
} from './services/prf-session.js';
import type { KnowledgeService } from './services/knowledge.js';
import { emitAudit } from './services/audit.js';

// Tools
import {
  makeSystemEchoTool,
  makeSystemHealthTool,
  registerCoreTools,
} from './tools/index.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateAppDeps {
  /**
   * KEK-Provider fuer Credential-Encrypt/Decrypt. Wenn nicht uebergeben werden
   * die `/v1/credentials/*`-Routen NICHT montiert (Bootstrap-mode ohne Vault).
   */
  readonly kekProvider?: KekProvider;
  /** Override fuer den vorgebauten CredentialsService (Tests). */
  readonly credentials?: CredentialsService;
  /** Override fuer den vorgebauten PrfSessionService (Tests). */
  readonly prfSessions?: PrfSessionService;
  /**
   * KnowledgeService gegen mcp-knowledge2. Ohne diesen werden die
   * `/v1/knowledge/*`-Proxy-Routen NICHT montiert.
   */
  readonly knowledge?: KnowledgeService;
  /**
   * Tool-Registry-Override fuer Tests. Default: frische Registry; bei vollem
   * Service-Set wird via `registerCoreTools(...)` befuellt, sonst nur mit den
   * `system.*` Smoke-Tools.
   */
  readonly toolRegistry?: ToolRegistry;
  /**
   * Audit-Sink fuer Tool-Calls + KnowledgeService. Default: Postgres-Sink via
   * `services/audit.ts` (`emitAudit(server.db, ...)`).
   */
  readonly audit?: AuditService;
  /**
   * Wenn `true`, werden GAR keine Tools registriert (Tests, die nur Stubs
   * wollen). Default `false`.
   */
  readonly skipToolRegistration?: boolean;
}

/**
 * Mounten der App. Reihenfolge der Routes ist wichtig — Hono matched in
 * Registrierungs-Reihenfolge, und auth-protected Pfade muessen ihre eigene
 * `auth(server)`-Middleware mitbringen (Auth ist NICHT global).
 */
export async function createApp(
  server: ServerContext,
  deps: CreateAppDeps = {},
): Promise<Hono<AppBindings>> {
  const app = new Hono<AppBindings>();

  // ─────────────────────────────────────────────────────────────────────
  // Globale Middleware (in order)
  // ─────────────────────────────────────────────────────────────────────
  app.use('*', requestId());
  app.onError(errorHandler());

  // ─────────────────────────────────────────────────────────────────────
  // Public routes (kein Bearer-Token noetig)
  // ─────────────────────────────────────────────────────────────────────
  app.route('/', healthRoutes());

  // OAuth 2.1 Authorization-Server (Discovery + JWKS sind public; Authorize/
  // Token/Register/Revoke regeln Auth intern).
  app.route('/', oauthRoutes(server));

  // ─────────────────────────────────────────────────────────────────────
  // Auth-Front-Door + Session + WebAuthn + Invite/Recovery
  // (Inner-Middleware in den Route-Files regelt welche Routen Bearer-
  //  pflichtig sind.)
  // ─────────────────────────────────────────────────────────────────────
  app.route('/', googleAuthRoutes(server));
  app.route('/', sessionRoutes(server));
  app.route('/', webauthnRoutes(server));
  app.route('/', inviteRoutes(server));
  app.route('/', recoveryRoutes(server));

  // ─────────────────────────────────────────────────────────────────────
  // Services + Routen-Mount nach Service-Verfuegbarkeit
  // ─────────────────────────────────────────────────────────────────────
  const credentialsService = resolveCredentialsService(server, deps);
  const prfSessions = deps.prfSessions ?? createPrfSessionService();

  if (credentialsService) {
    app.route(
      '/',
      credentialsRoutes({ server, credentials: credentialsService, prfSessions }),
    );
  }

  if (deps.knowledge) {
    app.route('/', knowledgeProxyRoutes(server, { knowledge: deps.knowledge }));
  }

  // Admin-Routes (role='admin' check intern in adminOnly-middleware)
  if (server.db) {
    const adminService = createAdminService({ db: server.db });
    app.route('/v1/admin', adminRoutes({ admin: adminService }));
  }

  // GDPR self-service (export + erase)
  if (server.db && deps.kekProvider) {
    const gdprService = createGdprService({
      db: server.db,
      kekProvider: deps.kekProvider,
      ...(deps.knowledge ? { knowledge: deps.knowledge } : {}),
    });
    app.route('/v1/gdpr', gdprRoutes({ gdpr: gdprService }));
  }

  // ─────────────────────────────────────────────────────────────────────
  // MCP-Protocol (POST /mcp, GET /mcp/sse) — Auth pro-Route via mcpTransport
  // ─────────────────────────────────────────────────────────────────────
  const registry = deps.toolRegistry ?? new ToolRegistry();
  if (!deps.skipToolRegistration) {
    populateToolRegistry(registry, {
      ...(deps.knowledge ? { knowledge: deps.knowledge } : {}),
      ...(credentialsService ? { credentials: credentialsService } : {}),
      prfSessions,
      audit: deps.audit ?? makeDefaultAudit(server),
    });
  }
  app.route('/', mcpProtocolRoutes({ server, registry }));

  return app;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function resolveCredentialsService(
  server: ServerContext,
  deps: CreateAppDeps,
): CredentialsService | null {
  if (deps.credentials) return deps.credentials;
  if (deps.kekProvider) {
    return createCredentialsService({ db: server.db, kekProvider: deps.kekProvider });
  }
  return null;
}

interface PopulateDeps {
  readonly knowledge?: KnowledgeService;
  readonly credentials?: CredentialsService;
  readonly prfSessions: PrfSessionService;
  readonly audit: AuditService;
}

/**
 * Volles `registerCoreTools` wenn alle Services da; sonst nur system.* —
 * damit der MCP-Endpoint immer auf `tools/list` mindestens ein Lebenszeichen
 * liefert.
 *
 * Idempotent: ueberspringt bereits registrierte Tool-Namen, damit Tests die
 * dieselbe Registry zweimal durch createApp jagen nicht crashen.
 */
function populateToolRegistry(registry: ToolRegistry, deps: PopulateDeps): void {
  if (deps.knowledge && deps.credentials) {
    // Volles Set. registerCoreTools wirft bei doppel-register — daher nur
    // ausfuehren wenn die Registry leer ist.
    if (registry.size() === 0) {
      registerCoreTools(registry, {
        knowledge: deps.knowledge,
        credentials: deps.credentials,
        prfSessions: deps.prfSessions,
        audit: deps.audit,
      });
    }
    return;
  }
  // Fallback: nur Smoke-Tools.
  if (!registry.has('system.health')) registry.register(makeSystemHealthTool());
  if (!registry.has('system.echo')) registry.register(makeSystemEchoTool());
}

function makeDefaultAudit(server: ServerContext): AuditService {
  return {
    emit: async (event) => {
      await emitAudit(server.db, {
        action: event.action,
        actorUserId: event.actorUserId,
        result: event.result,
        ...(event.requestId ? { requestId: event.requestId } : {}),
        details: {
          ...(event.resourceKind ? { resource_kind: event.resourceKind } : {}),
          ...(event.resourceId ? { resource_id: event.resourceId } : {}),
          ...(event.details ?? {}),
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Re-exports — index.ts + Tests importieren von hier zentral.
// ---------------------------------------------------------------------------

export { ToolRegistry } from './mcp/protocol/index.js';
export type { ServerContext } from './lib/context.js';
