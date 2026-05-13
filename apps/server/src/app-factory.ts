/**
 * createApp — voller Dependency-Wireup fuer den Hono-Server.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2 (Architektur), §11 Burst-3 (Final-Wiring).
 *
 * Verantwortung:
 *   - Middleware-Order verbindlich festziehen (request-id → error-handler →
 *     rate-limit → auth-on-protected-Routes).
 *   - Alle Route-Trees mounten (public, auth-protected, MCP-Protocol, OAuth,
 *     Approvals, Sub-MCP-Gateway-internal).
 *   - Tools registrieren via `registerCoreTools` (tools/index.ts) wenn alle
 *     noetigen Services (knowledge + credentials + prfSessions) verfuegbar
 *     sind; sonst nur die `system.*` Smoke-Tools.
 *   - Cost-Gate auf MCP-Routes, Rate-Limit auf /v1/* + /mcp/*.
 *   - Approval-Hook im MCP-Transport: ApprovalRequiredError → enqueueApproval
 *     + Resume nach Approve.
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
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { BlobAdapter, KekProvider } from '@mcp-approval2/adapters';
import type { AppBindings, ServerContext } from './lib/context.js';
import { HttpError } from './lib/errors.js';
import { requestId } from './middleware/request-id.js';
import { errorHandler } from './middleware/error-handler.js';
import {
  createRateLimitMiddleware,
  InMemoryBucketStore,
  DEFAULT_RATE_LIMIT_CONFIG,
  type BucketStore,
  type RateLimitConfig,
} from './middleware/rate-limit.js';
import { createCostGate } from './middleware/cost-gate.js';
import { auth as authMiddleware } from './middleware/auth.js';

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
import { approvalsRoutes } from './routes/approvals.js';
import { appsRoutes } from './routes/apps.js';
import { pushRoutes } from './routes/push.js';
import { writemodeRoutes, type WritemodeState } from './routes/writemode.js';
import { internalCredentialsRoutes } from './routes/internal/credentials.js';
import { internalDekRoutes } from './routes/internal/dek.js';
import { internalCronRoutes } from './routes/internal/cron.js';
import { createDekService } from './services/dek.js';
import { createAdminService } from './services/admin.js';
import { createGdprService } from './services/gdpr.js';
import { createAppsService, type AppsService } from './apps/api.js';
import { createPrefsService, type PrefsService } from './services/prefs.js';
import {
  createPushService,
  type PushService,
  type PushServiceEnv,
} from './services/push.js';
import {
  createOutputRefsService,
  type OutputRefsService,
} from './services/output-refs.js';
import {
  createCapabilitySearchService,
  type CapabilitySearchService,
} from './services/capability-search.js';
import {
  createFederatedSearchService,
  type FederatedSearchService,
} from './services/federated-search.js';

// MCP-Protocol
import { mcpProtocolRoutes, ToolRegistry } from './mcp/protocol/index.js';
import type { AuditService } from './mcp/protocol/tool.js';

// OAuth 2.1 Authorization-Server
import { oauthRoutes } from './mcp/oauth/index.js';

// Sub-MCP-Gateway
import {
  createSubMcpRegistry,
  subMcpDiscoverRoutes,
  type SubMcpRegistry,
} from './mcp/gateway/index.js';

// Services
import {
  createCredentialsService,
  type CredentialsService,
} from './services/credentials.js';
import {
  createPrfSessionService,
  type PrfSessionService,
} from './services/prf-session.js';
import {
  createApprovalService,
  type ApprovalService,
} from './services/approvals.js';
import {
  createCostTracker,
  type CostTracker,
} from './services/cost-tracker.js';
import type { KnowledgeService } from './services/knowledge.js';
import { emitAudit } from './services/audit.js';

// Tools
import {
  makeSystemEchoTool,
  makeSystemHealthTool,
  registerCoreTools,
} from './tools/index.js';

// ---------------------------------------------------------------------------
// Burst-7 service-instantiation helpers
// ---------------------------------------------------------------------------

interface BuildOptionalServicesResult {
  readonly apps: AppsService | undefined;
  readonly prefs: PrefsService | undefined;
  readonly push: PushService | undefined;
  readonly outputRefs: OutputRefsService | undefined;
  readonly capabilitySearch: CapabilitySearchService | undefined;
  readonly federatedSearch: FederatedSearchService | undefined;
}

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
  /** Override fuer ApprovalService (Tests). Default: aus services/approvals.ts gebaut. */
  readonly approvals?: ApprovalService;
  /** Override fuer CostTracker (Tests). Default: aus services/cost-tracker.ts gebaut. */
  readonly costTracker?: CostTracker;
  /** Override fuer SubMcpRegistry (Tests). */
  readonly subMcpRegistry?: SubMcpRegistry;
  /**
   * Tageslimit USD fuer das Cost-Gate. Default: aus deps.costTracker uebernommen
   * (5.00 USD/Tag). 0 → Cost-Gate disabled.
   */
  readonly dailyLimitUsd?: number;
  /**
   * Internal Service-Token fuer /internal/v1/* Routes. Wenn nicht gesetzt:
   * internal-Routes werden NICHT gemounted + Warning gelogged.
   */
  readonly internalServiceToken?: string;
  /** Rate-Limit-Config-Override (Tests). Default: DEFAULT_RATE_LIMIT_CONFIG. */
  readonly rateLimitConfig?: RateLimitConfig;
  /** Rate-Limit-Store-Override (Tests). Default: InMemoryBucketStore. */
  readonly rateLimitStore?: BucketStore;
  /** Wenn `true`, ueberspringt das Rate-Limit-Mount komplett (Tests). */
  readonly disableRateLimit?: boolean;

  // ─────────────────────────────────────────────────────────────────────
  // Burst-7 optional service overrides + dependencies
  // ─────────────────────────────────────────────────────────────────────
  /** Override fuer AppsService. Default: gebaut aus deps.knowledge. */
  readonly apps?: AppsService;
  /** Override fuer PrefsService. Default: gebaut aus server.db. */
  readonly prefs?: PrefsService;
  /** Override fuer PushService. Default: gebaut aus server.db + pushEnv. */
  readonly push?: PushService;
  /** VAPID + Subject Env fuer den PushService (sonst kein Mount). */
  readonly pushEnv?: PushServiceEnv;
  /** Override fuer OutputRefsService. Default: aus blobAdapter gebaut. */
  readonly outputRefs?: OutputRefsService;
  /** BlobAdapter fuer OutputRefs + Apps-Body-Overflow. Optional. */
  readonly blobAdapter?: BlobAdapter;
  /** Override fuer CapabilitySearchService. Default: aus toolRegistry + knowledge. */
  readonly capabilitySearch?: CapabilitySearchService;
  /** Override fuer FederatedSearchService. Default: aus knowledge. */
  readonly federatedSearch?: FederatedSearchService;
  /**
   * Master-Key fuer Apps-Standalone-JWT-Signing. Wenn nicht gesetzt,
   * `/apps/standalone/:appId` wird NICHT gemounted.
   */
  readonly appsMasterKey?: string;
  /**
   * HMAC-Pre-shared-Key fuer Smoke-Test-Writemode. Wenn nicht gesetzt
   * (Production-Default), `/writemode/*` wird NICHT gemounted (404).
   */
  readonly smokeTestKey?: string;
  /**
   * Writemode-State Override (Tests). Default: pro createApp-Aufruf frisch.
   * Caller (Approval-Service) kann denselben Container teilen, damit der
   * Smoke-Bypass cross-component sichtbar ist.
   */
  readonly writemodeState?: WritemodeState;
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

  // Rate-Limit fuer User-facing v1 + MCP. Auth-Routen + /health bleiben aussen vor.
  // Middleware skipt automatisch wenn `c.get('user')` undefined ist (anonymous).
  if (!deps.disableRateLimit) {
    const rlConfig = deps.rateLimitConfig ?? DEFAULT_RATE_LIMIT_CONFIG;
    const rlStore = deps.rateLimitStore ?? new InMemoryBucketStore();
    const rl = createRateLimitMiddleware(rlConfig, { buckets: rlStore });
    app.use('/v1/*', rl);
    app.use('/mcp', rl);
    app.use('/mcp/*', rl);
  }

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
  const approvalService =
    deps.approvals ?? createApprovalService({ db: server.db });
  const costTracker =
    deps.costTracker ??
    createCostTracker({
      db: server.db,
      ...(deps.dailyLimitUsd !== undefined ? { dailyLimitUsd: deps.dailyLimitUsd } : {}),
    });

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
  // MCP-Protocol + Tool-Registry
  // ─────────────────────────────────────────────────────────────────────
  const registry = deps.toolRegistry ?? new ToolRegistry();

  // ─────────────────────────────────────────────────────────────────────
  // Burst-7: Optional Services (Apps / Prefs / Push / OutputRefs / Search).
  // Capability-Search needs the live tool-registry, so we build services
  // AFTER the registry is allocated but BEFORE we register tools into it.
  // ─────────────────────────────────────────────────────────────────────
  const optionalServices = buildOptionalServices(server, deps, registry);

  if (!deps.skipToolRegistration) {
    populateToolRegistry(registry, {
      ...(deps.knowledge ? { knowledge: deps.knowledge } : {}),
      ...(credentialsService ? { credentials: credentialsService } : {}),
      prfSessions,
      audit: deps.audit ?? makeDefaultAudit(server),
      config: server.config,
      db: server.db,
      ...(optionalServices.apps ? { apps: optionalServices.apps } : {}),
      ...(optionalServices.prefs ? { prefs: optionalServices.prefs } : {}),
      ...(optionalServices.push ? { pushService: optionalServices.push } : {}),
      ...(deps.subMcpRegistry ? { subMcpRegistry: deps.subMcpRegistry } : {}),
      ...(optionalServices.capabilitySearch
        ? { capabilitySearch: optionalServices.capabilitySearch }
        : {}),
      ...(optionalServices.federatedSearch
        ? { federatedSearch: optionalServices.federatedSearch }
        : {}),
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Burst-7 HTTP-Route-Mounts (after registry exists so /v1/apps + push
  // can share the same service instances we just instantiated).
  // ─────────────────────────────────────────────────────────────────────
  if (optionalServices.apps) {
    app.route(
      '/',
      appsRoutes({
        server,
        apps: optionalServices.apps,
        ...(deps.appsMasterKey ? { masterKey: deps.appsMasterKey } : {}),
      }),
    );
  }

  if (optionalServices.push && deps.pushEnv?.VAPID_PUBLIC_KEY) {
    app.route(
      '/',
      pushRoutes({
        server,
        push: optionalServices.push,
        vapidEnv: { VAPID_PUBLIC_KEY: deps.pushEnv.VAPID_PUBLIC_KEY },
      }),
    );
  }

  // Smoke-test writemode — only mounted when SMOKE_TEST_KEY is set.
  // Production-default: routes return 404 (existence not leaked).
  const writemodeState: WritemodeState =
    deps.writemodeState ?? { activeUntil: 0, activatedAt: 0 };
  if (deps.smokeTestKey) {
    app.route(
      '/',
      writemodeRoutes({
        smokeTestKey: deps.smokeTestKey,
        state: writemodeState,
      }),
    );
  }

  // Approvals-Routes (Bearer-gated; pro-Route via auth-Middleware).
  app.route(
    '/',
    approvalsRoutes({
      server,
      approvals: approvalService,
      registry,
      audit: deps.audit ?? makeDefaultAudit(server),
    }),
  );

  // Cost-Gate NUR auf MCP-Tool-Dispatch (POST /mcp + GET /mcp/sse). Daily-Limit
  // 0 → Cost-Gate disabled. Wir mounten auth + cost-Gate VOR dem mcpTransport,
  // damit der Cost-Gate-Check `c.get('user')` sehen kann.
  //
  // ⚠ mcpTransport hat seinen eigenen auth(server, {required:true}) — die
  // zweite Auth-Pass ist idempotent (selbe Token-Verify), aber sie validiert
  // den principal nochmal. Performance-Kosten: 1× JWT-Verify zusaetzlich.
  const dailyLimit = deps.dailyLimitUsd;
  if (dailyLimit === undefined || dailyLimit > 0) {
    const costGate = createCostGate({
      tracker: costTracker,
      ...(dailyLimit !== undefined ? { displayLimitUsd: dailyLimit } : {}),
    });
    app.use('/mcp', authMiddleware(server, { required: true }), costGate);
    app.use('/mcp/*', authMiddleware(server, { required: true }), costGate);
  }

  // MCP-Protocol-Routes — Auth pro-Route via mcpTransport.
  app.route(
    '/',
    mcpProtocolRoutes({ server, registry, approvals: approvalService }),
  );

  // ─────────────────────────────────────────────────────────────────────
  // Sub-MCP-Gateway Internal-Routen
  // ─────────────────────────────────────────────────────────────────────
  const internalToken = deps.internalServiceToken;
  if (internalToken) {
    const subMcpReg =
      deps.subMcpRegistry ?? createSubMcpRegistry({ db: server.db });
    const internalTokenHash = hashInternalToken(internalToken);
    const serviceTokenGuard = makeServiceTokenGuard(internalTokenHash);

    // POST /internal/v1/credentials/resolve
    if (credentialsService) {
      app.use('/internal/v1/credentials/*', serviceTokenGuard);
      app.route(
        '/',
        internalCredentialsRoutes({
          server,
          credentials: credentialsService,
          registry: subMcpReg,
          prfSessions,
        }),
      );
    }

    // POST /internal/v1/sub-mcp/discover
    // discover-routes verifizieren intern via internalTokenHash; wir geben den
    // Hash mit, damit der Body nicht doppelt validiert wird.
    app.route(
      '/',
      subMcpDiscoverRoutes({
        server,
        registry: subMcpReg,
        internalTokenHash,
      }),
    );

    // POST /internal/v1/dek/resolve (Cross-Service-Bridge fuer mcp-knowledge2)
    if (deps.kekProvider) {
      app.use('/internal/v1/dek/*', serviceTokenGuard);
      const dekService = createDekService({
        db: server.db,
        kekProvider: deps.kekProvider,
      });
      app.route(
        '/',
        internalDekRoutes({
          server,
          dek: dekService,
        }),
      );
    }

    // POST /internal/v1/cron/:task — external-scheduler dispatch.
    app.use('/internal/v1/cron', serviceTokenGuard);
    app.use('/internal/v1/cron/*', serviceTokenGuard);
    const cronDeps: Omit<import('./cron/index.js').CronDeps, 'db'> = {
      approvals: approvalService,
      prfSessions,
      subMcpRegistry: subMcpReg,
      ...(optionalServices.push ? { push: optionalServices.push } : {}),
    };
    app.route(
      '/',
      internalCronRoutes({
        server,
        cronDeps,
      }),
    );
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      '[mcp-approval2] INTERNAL_SERVICE_TOKEN not set — /internal/v1/* routes not mounted',
    );
  }

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
  readonly config?: import('./lib/config.js').AppConfig;
  readonly db?: import('@mcp-approval2/adapters').DbAdapter;
  readonly apps?: AppsService;
  readonly prefs?: PrefsService;
  readonly pushService?: PushService;
  readonly subMcpRegistry?: SubMcpRegistry;
  readonly capabilitySearch?: CapabilitySearchService;
  readonly federatedSearch?: FederatedSearchService;
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
        ...(deps.config ? { config: deps.config } : {}),
        ...(deps.db ? { db: deps.db } : {}),
        ...(deps.apps ? { apps: deps.apps } : {}),
        ...(deps.prefs ? { prefs: deps.prefs } : {}),
        ...(deps.pushService ? { pushService: deps.pushService } : {}),
        ...(deps.subMcpRegistry ? { subMcpRegistry: deps.subMcpRegistry } : {}),
        ...(deps.capabilitySearch
          ? { capabilitySearch: deps.capabilitySearch }
          : {}),
        ...(deps.federatedSearch
          ? { federatedSearch: deps.federatedSearch }
          : {}),
      });
    }
    return;
  }
  // Fallback: nur Smoke-Tools.
  if (!registry.has('system.health')) registry.register(makeSystemHealthTool());
  if (!registry.has('system.echo')) registry.register(makeSystemEchoTool());
}

/**
 * Burst-7: optionale Services aus den injizierten Deps + ServerContext bauen.
 *
 * Edge-Cases:
 *   - AppsService braucht `knowledge`. Ohne KnowledgeService → kein Apps-Mount.
 *   - PrefsService braucht nur `server.db`. Wir bauen ihn immer wenn deps.kekProvider
 *     gesetzt ist (Prefs-Rows liegen plain in der Postgres-Tabelle, aber wir wollen
 *     den Service-Build an "ist die Vault-Schicht ueberhaupt initialisiert"
 *     koppeln, sonst gibt es seltsame Mismatches im Tests-Stub-Pfad).
 *   - PushService braucht VAPID-Env. Ohne → nicht gebaut.
 *   - OutputRefs braucht `blobAdapter`. Ohne → nicht gebaut.
 *   - CapabilitySearch braucht `knowledge` + die Tool-Registry-Instanz.
 *   - FederatedSearch braucht `knowledge`.
 */
function buildOptionalServices(
  server: ServerContext,
  deps: CreateAppDeps,
  registry: ToolRegistry,
): BuildOptionalServicesResult {
  const apps: AppsService | undefined =
    deps.apps ??
    (deps.knowledge ? createAppsService({ knowledge: deps.knowledge }) : undefined);

  // Prefs-Tabelle ist owner-scoped via RLS; Service selbst braucht keinen
  // KekProvider. Wir bauen ihn IMMER wenn db verfuegbar ist — die PWA muss
  // ohne Vault auch Defaults setzen koennen.
  const prefs: PrefsService | undefined =
    deps.prefs ?? createPrefsService({ db: server.db });

  const push: PushService | undefined =
    deps.push ??
    (deps.pushEnv && deps.pushEnv.VAPID_PUBLIC_KEY && deps.pushEnv.VAPID_PRIVATE_KEY
      ? createPushService({ db: server.db, env: deps.pushEnv })
      : undefined);

  const outputRefs: OutputRefsService | undefined =
    deps.outputRefs ??
    (deps.blobAdapter
      ? createOutputRefsService({ blob: deps.blobAdapter })
      : undefined);

  const capabilitySearch: CapabilitySearchService | undefined =
    deps.capabilitySearch ??
    (deps.knowledge
      ? createCapabilitySearchService({
          toolRegistry: registry,
          knowledge: deps.knowledge,
        })
      : undefined);

  const federatedSearch: FederatedSearchService | undefined =
    deps.federatedSearch ??
    (deps.knowledge
      ? createFederatedSearchService({ knowledge: deps.knowledge })
      : undefined);

  return {
    apps,
    prefs,
    push,
    outputRefs,
    capabilitySearch,
    federatedSearch,
  };
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

function hashInternalToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Inline-Service-Token-Middleware. Wenn der parallele Subagent eine eigene
 * Middleware in `middleware/service-token.ts` liefert, kann dieser Helper
 * dann ersetzt werden (gleiche Signatur — `MiddlewareHandler`).
 *
 * Validiert `Authorization: Bearer <token>` ODER `X-Service-Token: <token>`
 * via konstant-Zeit-Hash-Vergleich. Der Hash ist beim App-Boot einmal
 * berechnet, daher kein per-Request-Cost.
 */
function makeServiceTokenGuard(expectedHash: string): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const auth = c.req.header('authorization') ?? '';
    const xServiceToken = c.req.header('x-service-token') ?? '';
    let presented: string | null = null;
    if (auth.toLowerCase().startsWith('bearer ')) {
      presented = auth.slice(7).trim();
    } else if (xServiceToken) {
      presented = xServiceToken.trim();
    }
    if (!presented) {
      throw HttpError.unauthorized('service token required');
    }
    const presentedHash = createHash('sha256').update(presented).digest('hex');
    if (!constantTimeEqualHex(presentedHash, expectedHash)) {
      throw HttpError.unauthorized('invalid service token');
    }
    await next();
  };
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Re-exports — index.ts + Tests importieren von hier zentral.
// ---------------------------------------------------------------------------

export { ToolRegistry } from './mcp/protocol/index.js';
export type { ServerContext } from './lib/context.js';
