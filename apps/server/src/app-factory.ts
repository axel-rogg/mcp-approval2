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
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { MiddlewareHandler } from 'hono';
import type { BlobAdapter, KekProvider } from '@mcp-approval2/adapters';
import type { AppBindings, ServerContext } from './lib/context.js';
import { HttpError } from './lib/errors.js';
import { requestId } from './middleware/request-id.js';
import { logRequests } from './middleware/log.js';
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
import { debugRoutes } from './routes/debug.js';
import { sessionRoutes } from './routes/auth/session.js';
import { webauthnRoutes } from './routes/auth/webauthn.js';
import { inviteRoutes } from './routes/auth/invite.js';
import { recoveryRoutes } from './routes/auth/recovery.js';
import { credentialsRoutes } from './routes/credentials.js';
import { knowledgeProxyRoutes } from './routes/knowledge-proxy.js';
import { kcProxyRoutes } from './routes/kc-proxy.js';
import { adminRoutes } from './routes/admin.js';
import { inventoryRoutes } from './routes/inventory.js';
import { gdprRoutes } from './routes/gdpr.js';
import { approvalsRoutes } from './routes/approvals.js';
import { createApprovalAssertionVerifier } from './auth/webauthn/approval-verify.js';
import { appsRoutes } from './routes/apps.js';
import { pushRoutes } from './routes/push.js';
import {
  writemodeRoutes,
  writemodeUserRoutes,
  type WritemodeState,
} from './routes/writemode.js';
import { createWritemodeService } from './services/writemode.js';
import { createWritemodeActivationVerifier } from './auth/webauthn/writemode-activation-verify.js';
import { internalCredentialsRoutes } from './routes/internal/credentials.js';
import { internalDekRoutes } from './routes/internal/dek.js';
import { internalCronRoutes } from './routes/internal/cron.js';
import { internalAppsImportRoutes } from './routes/internal/apps-import.js';
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
  buildSubMcpWrapperTools,
  createSubMcpRegistry,
  refreshSubMcpToolCache,
  seedCfGateways,
  subMcpDiscoverRoutes,
  SubMcpForwarder,
  SubMcpWrappersCache,
  type SubMcpRegistry,
} from './mcp/gateway/index.js';
import { adminGatewayRoutes } from './routes/admin/gateways.js';

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
import {
  createUserSyncService,
  type UserSyncService,
} from './services/user-sync.js';

// Tools
import {
  makeSystemEchoTool,
  makeSystemHealthTool,
  registerCoreTools,
} from './tools/index.js';
import {
  buildKcWrappers,
  type BuildKcWrappersOpts,
} from './tools/kc_wrappers/index.js';
import { makeRs256Signer } from './services/knowledge.js';
import { getSigningKey } from './auth/jwt-signing.js';
import { effectiveOauthIssuer } from './schema/env.js';

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
   * AS-3: KC-Proxy-Konfiguration fuer `/admin/kc-proxy/*` PWA-Pfad.
   * Erfordert `MCP_KNOWLEDGE_URL` + `MCP_KNOWLEDGE_SERVICE_TOKEN`.
   * Wenn nicht gesetzt, wird die Route NICHT gemountet → 404.
   */
  readonly kcProxy?: import('./routes/kc-proxy.js').KcProxyDeps;
  /**
   * AS-3 (Tests): fetchImpl-Override fuer kc_wrappers/* boot-time
   * Manifest-Fetch. Tests injizieren hier einen Stub, der das
   * `POST /mcp tools/list` ohne Network beantwortet.
   */
  readonly kcWrappersFetchOverride?: typeof fetch;
  /**
   * AS-3 (A11): UserSyncService — push approval2-User-State an KC2.
   * Wenn nicht gesetzt: User-State-Aenderungen werden NICHT in KC2
   * propagiert (Single-Service-Setup ohne KC).
   */
  readonly userSync?: UserSyncService;
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
  // Per-Request-Log (method/path/status/duration). Health-Probes geskipped.
  app.use('*', logRequests());
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
  // Debug-Diagnostics — `/debug/whoami` etc. Auth-frei, keine Secrets.
  app.route('/', debugRoutes(server));

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

  // AS-3 (A11): UserSyncService — push approval2-User-State an KC2.
  // Lazy gebaut wenn nicht uebergeben + knowledge da ist.
  const userSyncService: UserSyncService | undefined =
    deps.userSync ??
    (deps.knowledge
      ? createUserSyncService({ adapter: deps.knowledge.adapter, db: server.db })
      : undefined);
  // Wir mounten hier keinen HTTP-Endpunkt fuer userSync — der Service
  // wird intern aus admin.ts / gdpr.ts / bootstrap.ts aufgerufen.
  // Stash auf den server-Container damit downstream routes/services
  // ihn aufrufen koennen (alternativ: explizite Pass-Down — heute haben
  // wir aber keinen sauberen Pfad fuer "alle bestehenden Routes kriegen
  // den Service mit". Folge-Refactor.).
  if (userSyncService) {
    (server as { userSync?: UserSyncService }).userSync = userSyncService;
  }

  // AS-3 (§1.3): /admin/kc-proxy/* — PWA-Same-Origin-Proxy zu KC2.
  // Nur gemountet wenn beide Felder gesetzt sind (graceful ohne KC-Anbindung).
  if (deps.kcProxy) {
    app.route('/', kcProxyRoutes(server, deps.kcProxy));
  }

  // Admin-Routes (role='admin' check intern in adminOnly-middleware).
  //
  // SEC-NEW-106-Fix (2026-05-17): `adminRoutes` hat ein `app.use('*',
  // adminOnly())` das `c.get('user')` checkt. Ohne vorgelagertes
  // authMiddleware ist `user` undefined → adminOnly throws 401 fuer
  // JEDEN Pfad unter /v1/admin/* (auch nicht-existente). Wir mounten
  // hier `authMiddleware(required: true)` vor dem Subtree damit:
  //   - bekannte admin-Paths: 200 fuer admins, 403 fuer members, 401 ohne Token
  //   - unbekannte admin-Paths: 404 (nach auth-pass) statt 401
  app.use('/v1/admin/*', authMiddleware(server, { required: true }));
  if (server.db) {
    const adminService = createAdminService({
      db: server.db,
      ...(userSyncService ? { userSync: userSyncService } : {}),
    });
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
  // Writemode-Service — pro-User Auto-Approve-Window (PLAN-writemode).
  // ─────────────────────────────────────────────────────────────────────
  const writemodeService = createWritemodeService({ db: server.db });

  // ─────────────────────────────────────────────────────────────────────
  // MCP-Protocol + Tool-Registry
  // ─────────────────────────────────────────────────────────────────────
  // writemodeChecker: pro Tool-Call ein DB-Lookup. Bei write-sensitivity
  // erlaubt aktive Session den Auto-Bypass. danger bleibt immer approval-
  // pflichtig (registry.ts enforct das).
  const registry =
    deps.toolRegistry ??
    new ToolRegistry({
      writemodeChecker: async (userId: string) =>
        writemodeService.isActive({ userId }),
    });

  // ─────────────────────────────────────────────────────────────────────
  // Sub-MCP-Registry + Forwarder werden HIER zentral instanziert, damit
  // die Boot-Sequenz, der Cron-Task, das gateway_server_rediscover-Tool
  // und die Admin-HTTP-Route alle denselben Cache + Forwarder teilen.
  // ─────────────────────────────────────────────────────────────────────
  const subMcpReg: SubMcpRegistry =
    deps.subMcpRegistry ?? createSubMcpRegistry({ db: server.db });
  const subMcpForwarder = new SubMcpForwarder({ registry: subMcpReg });

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
      subMcpRegistry: subMcpReg,
      subMcpLiveRefresh: {
        toolRegistry: registry,
        forwarder: subMcpForwarder,
        config: server.config,
        cache: subMcpWrappersCache,
      },
      ...(optionalServices.capabilitySearch
        ? { capabilitySearch: optionalServices.capabilitySearch }
        : {}),
      ...(optionalServices.federatedSearch
        ? { federatedSearch: optionalServices.federatedSearch }
        : {}),
    });

    // AS-3 (§1.4 + A8): KC-Wrapper-Tools aus KC2's tools/list-Manifest
    // generieren und registrieren. Graceful — bei KC2-Unreach laufen
    // approval2 + Native-Tools weiter.
    if (deps.kcProxy) {
      try {
        const signer = await buildBootKcSigner(server);
        const wrapperArgs: BuildKcWrappersOpts = {
          knowledgeUrl: deps.kcProxy.knowledgeUrl,
          serviceToken: deps.kcProxy.serviceToken,
          signer,
          ...(deps.kcWrappersFetchOverride !== undefined
            ? { fetchImpl: deps.kcWrappersFetchOverride }
            : {}),
        };
        const { tools: kcTools, manifest } = await buildKcWrappers(wrapperArgs);
        for (const t of kcTools) {
          if (!registry.has(t.name)) {
            registry.register(t);
          }
        }
        // Manifest in einer module-scoped Cache-Reference ablegen — der
        // refresh-Cron (A9) kann es lesen und neu builden.
        kcWrappersCache.set(server, { tools: kcTools, manifest, opts: wrapperArgs });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[mcp-approval2] kc_wrappers boot-build failed: ${
            err instanceof Error ? err.message : String(err)
          }. KC-Wrappers not mounted; native + gateway tools remain.`,
        );
      }
    }

    // Sub-MCP-Gateway-Wrapper-Tools (utils / gws / gcloud auf Cloudflare).
    //
    // Pflicht-Voraussetzung: SUB_MCP_TOKEN_<NAME> env-vars (per Gateway) im
    // Doppler/Fly-Secret-Store. Kein Token → Sub-MCP wird nicht registriert.
    // Damit ist die ganze Phase opt-in pro Gateway und ohne Token harmless.
    //
    // Ablauf:
    //   1. seedCfGateways — INSERT/UPDATE der drei sub_mcp_servers-Rows
    //      idempotent. Token-Hash aus env, base_url/display_name aus
    //      DEFAULT_CF_GATEWAYS. Wenn kein Token → skip.
    //   2. refreshSubMcpToolCache — initialer tools/list-Roundtrip pro
    //      enabled Sub-MCP, damit tools_cache befuellt ist. Discovery-Cron
    //      laeuft danach periodisch (siehe internal/v1/cron-Pfad).
    //   3. buildSubMcpWrapperTools — pro gecachten Tool ein
    //      ForwardingTool, das SubMcpForwarder ruft. User-JWT wird pro
    //      execute() kurzlebig signed (60s, aud=<subMcpName>).
    //
    // Errors pro Phase werden geloggt + non-fatal — ein nicht-erreichbarer
    // gws darf approval2-Boot nicht stoppen.
    try {
      const seedResult = await seedCfGateways({ db: server.db });
      if (
        seedResult.registered.length > 0 ||
        seedResult.updated.length > 0 ||
        seedResult.skipped.length > 0
      ) {
        // eslint-disable-next-line no-console
        console.info(
          `[mcp-approval2] sub-mcp seed: registered=${seedResult.registered.join(',') || '-'} ` +
            `updated=${seedResult.updated.join(',') || '-'} ` +
            `skipped(no-token)=${seedResult.skipped.map((s) => s.name).join(',') || '-'}`,
        );
      }
      subMcpReg.invalidate();

      // Initialer Discovery-Pass — sonst sind tools_cache=NULL und wrapper-build
      // ergibt 0 Tools. Pro-Server fail-soft: ein offline-gws blockt nicht den
      // ganzen Boot.
      const discoverResults = await refreshSubMcpToolCache({
        registry: subMcpReg,
      });
      for (const r of discoverResults) {
        if (r.error) {
          // eslint-disable-next-line no-console
          console.warn(
            `[mcp-approval2] sub-mcp discovery '${r.subMcpName}' failed: ${r.error}`,
          );
        } else {
          // eslint-disable-next-line no-console
          console.info(
            `[mcp-approval2] sub-mcp discovery '${r.subMcpName}' ok: ${r.count} tools`,
          );
        }
      }

      // Wrapper-Tools registrieren + Cache befuellen (per-server Tool-Namen
      // damit applyGatewayDiscovery spaeter de-/re-registern kann).
      const wrappers = await buildSubMcpWrapperTools({
        registry: subMcpReg,
        forwarder: subMcpForwarder,
        config: server.config,
      });
      let registered = 0;
      const perServerToolNames = new Map<string, string[]>();
      for (const t of wrappers.tools) {
        if (!registry.has(t.name)) {
          registry.register(t);
          registered += 1;
        }
        // Tool-Name follows pattern `<subMcpName>.<remoteName>`.
        const dotIdx = t.name.indexOf('.');
        const srvName = dotIdx > 0 ? t.name.slice(0, dotIdx) : t.name;
        const arr = perServerToolNames.get(srvName) ?? [];
        arr.push(t.name);
        perServerToolNames.set(srvName, arr);
      }
      for (const [srvName, names] of perServerToolNames) {
        subMcpWrappersCache.setForServer(srvName, names);
      }
      if (wrappers.skipped.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[mcp-approval2] sub-mcp wrapper-tools skipped (invalid name): ${wrappers.skipped.join(', ')}`,
        );
      }
      // eslint-disable-next-line no-console
      console.info(
        `[mcp-approval2] sub-mcp wrapper-tools registered: ${registered} ` +
          `(per-server: ${[...wrappers.perSubMcp.entries()].map(([n, c]) => `${n}=${c}`).join(', ') || 'none'})`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[mcp-approval2] sub-mcp gateway boot-build failed: ${
          err instanceof Error ? err.message : String(err)
        }. Native + kc_wrappers tools remain available.`,
      );
    }
  }

  // Admin-HTTP-Route fuer PWA-Tools-Tab Refresh-Button. Re-registriert
  // Sub-MCP-Wrapper-Tools live ohne approval2-Restart.
  app.route(
    '/',
    adminGatewayRoutes({
      server,
      registry: subMcpReg,
      toolRegistry: registry,
      forwarder: subMcpForwarder,
      cache: subMcpWrappersCache,
      config: server.config,
    }),
  );

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

  // User-facing writemode routes — Bearer-gated, immer gemountet.
  // Plan-Ref: docs/plans/active/PLAN-writemode.md (Slice 5).
  app.route(
    '/',
    writemodeUserRoutes({
      server,
      writemode: writemodeService,
      verifyActivation: createWritemodeActivationVerifier({ db: server.db }),
    }),
  );

  // Approvals-Routes (Bearer-gated; pro-Route via auth-Middleware).
  // SEC-001: WebAuthn-Assertion-Verifier ist in Production immer gesetzt —
  // ohne ihn wuerden approvals.approve() opaque signature-bytes ohne Verify
  // durchwinken. Wir bauen ihn hier mit der server-DB.
  app.route(
    '/',
    approvalsRoutes({
      server,
      approvals: approvalService,
      registry,
      audit: deps.audit ?? makeDefaultAudit(server),
      verifyAssertion: createApprovalAssertionVerifier({ db: server.db }),
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

  // PWA-Tools-View: GET /v1/inventory — authenticated, read-only Liste der
  // registrierten Tools + Sub-MCP-Gateways (mit cached tools/list).
  //
  // knowledge2-Snapshot wird per-Request aus dem module-scoped
  // `kcWrappersCache` gelesen — kc-manifest-refresh updated den Cache, der
  // Inventory-Endpoint sieht das ohne Re-Mount.
  app.route(
    '/',
    inventoryRoutes({
      server,
      registry,
      subMcpRegistry: subMcpReg,
      kcSnapshot: () => {
        const cached = kcWrappersCache.get(server);
        if (!cached) {
          return { toolNames: new Set<string>(), refreshedAt: null };
        }
        return {
          toolNames: new Set(cached.tools.map((t) => t.name)),
          refreshedAt: cached.manifest.fetchedAt ?? null,
          displayName: 'Knowledge Core (mcp-knowledge2)',
        };
      },
    }),
  );

  // ─────────────────────────────────────────────────────────────────────
  // Sub-MCP-Gateway Internal-Routen
  // ─────────────────────────────────────────────────────────────────────
  const internalToken = deps.internalServiceToken;
  if (internalToken) {
    // subMcpReg + subMcpForwarder werden oben (vor populateToolRegistry)
    // bereits zentral instanziiert — wir reuse sie hier statt eine zweite
    // Instanz mit eigenem Cache anzulegen.
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
      subMcpWrappers: {
        toolRegistry: registry,
        forwarder: subMcpForwarder,
        config: server.config,
        cache: subMcpWrappersCache,
      },
      ...(optionalServices.push ? { push: optionalServices.push } : {}),
      // AS-3 (A9): kc-manifest-refresh erhaelt registry + previous-snapshot
      // wenn das Boot-Build erfolgreich war. Cache-getter laeuft jedes Mal —
      // sodass Folge-Refreshs den jeweils aktuellsten Stand sehen.
      ...(() => {
        const cached = kcWrappersCache.get(server);
        if (!cached) return {};
        return {
          kcManifest: {
            registry,
            previousOpts: cached.opts,
            previousTools: cached.tools,
            onUpdated: (entry) => {
              kcWrappersCache.set(server, {
                tools: entry.tools,
                manifest: entry.manifest,
                opts: cached.opts,
              });
            },
          },
        };
      })(),
    };
    app.route(
      '/',
      internalCronRoutes({
        server,
        cronDeps,
      }),
    );

    // POST /internal/v1/apps/import — One-Shot v1→v2 App-Migration
    if (optionalServices.apps) {
      app.use('/internal/v1/apps/*', serviceTokenGuard);
      app.route(
        '/',
        internalAppsImportRoutes({
          server,
          apps: optionalServices.apps,
        }),
      );
    }
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      '[mcp-approval2] INTERNAL_SERVICE_TOKEN not set — /internal/v1/* routes not mounted',
    );
  }

  // ─── Static PWA catch-all (MUST be last) ─────────────────────────────
  // Caddy proxies ${DOMAIN_APP} (app2.ai-toolhub.org) to :8787. We serve the
  // built PWA from apps/web/dist as a SPA — any non-API path falls through to
  // index.html so the client-side router takes over. API routes registered
  // above match first (Hono trie-routes /v1/*, /mcp/*, /internal/*, /auth/*).
  //
  // Test isolation: skip in NODE_ENV=test — the test-suite asserts that
  // unmounted routes return 404, which the static catch-all would mask.
  if (server.config.NODE_ENV !== 'test') {
    mountPwaIfBuilt(app);
  }

  return app;
}

function mountPwaIfBuilt(app: Hono<AppBindings>): void {
  // Dockerfile.server copies the bundle to /app/apps/web/dist; the server
  // process WORKDIR is /app/apps/server, so the relative path is `../web/dist`.
  // For ts-node / dev (apps/server/src/), resolve via import.meta.url.
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    resolvePath(here, '../../../web/dist'), // dist build (apps/server/dist/app-factory.js)
    resolvePath(here, '../../../../web/dist'), // src build (apps/server/src/app-factory.ts)
    resolvePath(process.cwd(), '../web/dist'),
    resolvePath(process.cwd(), 'apps/web/dist'),
  ];
  const root = candidates.find((p) => existsSync(p));
  if (!root) {
    // eslint-disable-next-line no-console
    console.warn('[mcp-approval2] apps/web/dist not found — PWA catch-all skipped');
    return;
  }
  // Serve assets first (cache-busted file names get long max-age headers from
  // Caddy). SPA fallback: any unknown path returns index.html so the client
  // router can resolve it.
  app.use('/*', serveStatic({ root }));
  app.get('*', serveStatic({ path: 'index.html', root }));
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
  readonly subMcpLiveRefresh?: {
    readonly toolRegistry: ToolRegistry;
    readonly forwarder: SubMcpForwarder;
    readonly config: Pick<import('./lib/config.js').AppConfig, 'JWT_SECRET' | 'JWT_ISSUER'>;
    readonly cache: SubMcpWrappersCache;
  };
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
        ...(deps.subMcpLiveRefresh ? { subMcpLiveRefresh: deps.subMcpLiveRefresh } : {}),
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
// AS-3 (§1.4): KC-Wrappers boot helpers + cache
// ---------------------------------------------------------------------------

/**
 * Module-scoped Cache fuer den Wrapper-Bauplan. Der Refresh-Cron (A9)
 * liest hier `opts` + alte `tools`-Liste, baut neu, und ersetzt im
 * registry.
 */
export interface KcWrappersCacheEntry {
  readonly tools: ReadonlyArray<import('./mcp/protocol/tool.js').Tool<unknown, unknown>>;
  readonly manifest: import('./tools/kc_wrappers/index.js').KcManifest;
  readonly opts: import('./tools/kc_wrappers/index.js').BuildKcWrappersOpts;
}

class KcWrappersCache {
  private map = new WeakMap<ServerContext, KcWrappersCacheEntry>();
  set(srv: ServerContext, e: KcWrappersCacheEntry): void {
    this.map.set(srv, e);
  }
  get(srv: ServerContext): KcWrappersCacheEntry | undefined {
    return this.map.get(srv);
  }
}

export const kcWrappersCache = new KcWrappersCache();

/**
 * Module-scoped Sub-MCP-Wrapper-Cache. Haelt pro registriertem Sub-MCP die
 * Set der in-memory ToolRegistry-Eintraege. Wird bei Boot durch buildSubMcp-
 * WrapperTools gefuellt und bei `applyGatewayDiscovery` (Cron + admin tool +
 * admin HTTP-route) mutiert.
 */
export const subMcpWrappersCache = new SubMcpWrappersCache();

async function buildBootKcSigner(
  server: ServerContext,
): Promise<import('@mcp-approval2/adapters').JwtSigner> {
  const pem =
    process.env['JWT_RS256_PRIVATE_KEY_PEM'] ?? process.env['JWT_PRIVATE_KEY'];
  if (!pem) {
    throw new Error(
      'kc_wrappers: JWT_RS256_PRIVATE_KEY_PEM not configured — cannot sign OBO-JWTs',
    );
  }
  const signingEnv: { JWT_RS256_PRIVATE_KEY_PEM: string; JWT_KID?: string } = {
    JWT_RS256_PRIVATE_KEY_PEM: pem,
  };
  if (process.env['JWT_KID']) signingEnv.JWT_KID = process.env['JWT_KID'];
  const privateKey = await getSigningKey(signingEnv);
  if (!privateKey) {
    throw new Error('kc_wrappers: failed to load private key');
  }
  const issuer = effectiveOauthIssuer({
    ORIGIN: server.config.ORIGIN,
    ...(server.config.SELF_OAUTH_ISSUER !== undefined
      ? { SELF_OAUTH_ISSUER: server.config.SELF_OAUTH_ISSUER }
      : {}),
  });
  const kid = process.env['JWT_KID'];
  return makeRs256Signer({
    privateKey,
    issuer,
    audience: 'mcp-knowledge2',
    ...(kid ? { kid } : {}),
  });
}

// ---------------------------------------------------------------------------
// Re-exports — index.ts + Tests importieren von hier zentral.
// ---------------------------------------------------------------------------

export { ToolRegistry } from './mcp/protocol/index.js';
export type { ServerContext } from './lib/context.js';
