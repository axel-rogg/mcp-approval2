/**
 * Route: /v1/me/servers — per-User-Sub-MCP-Subscription-Mgmt.
 *
 * Plan-Ref: docs/plans/active/PLAN-per-user-server-store.md (Phase 1).
 *
 * Endpoints:
 *   GET   /v1/me/servers                      — Liste subscribed + available
 *   PATCH /v1/me/servers/:name/subscription   — toggle enabled
 *
 * Auth: authenticated User reicht (kein admin-only — jeder User pflegt
 * eigene Subscription). RLS auf user_sub_mcp_subscriptions sorgt fuer
 * Cross-User-Isolation.
 *
 * Phase 2+ kommen: config-GET/PUT/DELETE, POST /v1/me/servers (user-added),
 * OAuth-start/callback.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { HttpError } from '../../lib/errors.js';
import { auth } from '../../middleware/auth.js';
import { baseLogger as logger } from '../../lib/logger.js';
import type { SubMcpRegistry } from '../../mcp/gateway/registry.js';
import type { UserSubscriptionsService } from '../../services/user-subscriptions.js';
import type { UserServerConfigService } from '../../services/user-server-config.js';
import type { UserServerOAuthService } from '../../services/user-server-oauth.js';
import type { UserServerToolDefaultsService } from '../../services/user-server-tool-defaults.js';
import type { ToolDefaultProfilesService } from '../../services/tool-default-profiles.js';
import type { ToolDefaultHintsService } from '../../services/tool-default-hints.js';
import type { UserDiscoveryArgs } from '../../mcp/gateway/discovery.js';

/**
 * Post-OAuth-Hook: nach erfolgreichem callback wird Per-User-Discovery
 * getriggert. Optional damit Tests/dev ohne enricher laufen.
 */
export type RefreshUserToolCacheFn = (
  args: Pick<UserDiscoveryArgs, 'userId' | 'only'>,
) => Promise<unknown>;

export interface MyServersRouteDeps {
  readonly server: ServerContext;
  readonly registry: SubMcpRegistry;
  readonly subscriptions: UserSubscriptionsService;
  /**
   * Per-User-Server-Config Service (Phase 2). Wenn nicht gesetzt, sind die
   * config-Endpoints nicht verfuegbar (404).
   */
  readonly config?: UserServerConfigService;
  /**
   * OAuth-Authorize-Flow (Phase 3). Wenn nicht gesetzt, sind oauth/start +
   * oauth/callback nicht verfuegbar.
   */
  readonly oauth?: UserServerOAuthService;
  /**
   * Per-Tool Defaults pro Server (Phase D). Wenn nicht gesetzt, sind die
   * tool-defaults-Endpoints nicht verfuegbar.
   */
  readonly toolDefaults?: UserServerToolDefaultsService;
  /**
   * Phase C (PLAN-tool-defaults-v2.md): Profile-CRUD pro Server. Wenn nicht
   * gesetzt, sind die default-profiles-Endpoints nicht verfuegbar.
   */
  readonly toolDefaultProfiles?: ToolDefaultProfilesService;
  /**
   * Phase E (PLAN-tool-defaults-v2.md): Hint-CRUD pro Server. Wenn nicht
   * gesetzt, sind die tool-hints-Endpoints nicht verfuegbar.
   */
  readonly toolDefaultHints?: ToolDefaultHintsService;
  /**
   * Optional: nach erfolgreichem OAuth-callback per-User-Discovery
   * triggern. wired in app-factory zu refreshUserSubMcpToolCache().
   */
  readonly refreshUserToolCache?: RefreshUserToolCacheFn;
}

interface MyServerEntry {
  readonly name: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly enabled: boolean;
  readonly isCatalogDefault: boolean;
  readonly isOwnedByMe: boolean;
  /** Tool-Cache-Timestamp wenn discovered. */
  readonly toolsCachedAt: number | null;
  readonly toolsCount: number;
}

interface MyServersResponse {
  /** Vom User aktivierte Server (enabled=TRUE). */
  readonly subscribed: ReadonlyArray<MyServerEntry>;
  /** Catalog-Defaults die der User noch nicht aktiviert hat. */
  readonly available: ReadonlyArray<MyServerEntry>;
}

const SubscriptionPatchBody = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

const ConfigPutBody = z
  .object({
    value: z.string().max(64 * 1024), // 64 KB hard-cap pro config-Wert
  })
  .strict();

const CONFIG_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const SERVER_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * Phase 4: POST /v1/me/servers — User legt eigenen MCP-Server an.
 *
 * Pre-registered OAuth-Mode (User-Decision 3 in PLAN-per-user-server-store):
 * User traegt baseUrl + display_name + service-token (optional, falls Bearer-
 * Auth genutzt wird) ein. OAuth-client_id + client_secret werden via
 * user_sub_mcp_config gesetzt nach Server-Anlage.
 *
 * auth_mode-Schema:
 *   - 'service_bearer' (Default): Shared Service-Token zwischen approval2 und
 *     Sub-MCP-Worker. Falls Token leer → forward fail's bis User Token via
 *     /v1/me/servers/:name/config/<key> mit `_`-Prefix nachpflegt.
 *   - 'oauth': Wird in Phase 3 (UserServerOAuthService) gehandelt — pre-
 *     registered Client-ID/Secret aus user_sub_mcp_config.
 */
const AddServerBody = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(
        SERVER_NAME_RE,
        'name muss lowercase alphanumerisch (+ _-) sein, mit Buchstabe anfangen',
      ),
    displayName: z.string().min(1).max(128),
    baseUrl: z
      .string()
      .url()
      .refine((v) => v.startsWith('https://'), 'baseUrl muss https:// sein'),
    authMode: z.enum(['service_bearer', 'oauth']).default('service_bearer'),
    /** Optional. Wird gehasht + in auth_config.service_token_hash gespeichert. */
    serviceTokenPlain: z.string().max(512).optional(),
    /**
     * Optional: config_fields-Hinweis fuer den Drawer. Format wie
     * tools/list._meta.config_fields. Wird auch automatisch refreshed
     * sobald der Worker live geht.
     */
    configSchema: z.record(z.unknown()).optional(),
    /** Default true — Server soll direkt nach Anlage sichtbar+aktiv sein. */
    enableSubscription: z.boolean().default(true),
  })
  .strict();

export function myServersRoutes(deps: MyServersRouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const guard = auth(deps.server);

  app.get('/v1/me/servers', guard, async (c) => {
    const user = c.get('user');
    if (!user) throw HttpError.unauthorized('authentication required');

    // 1. Lazy-Seed: alle catalog-defaults die der User noch nie gesehen hat
    //    bekommen eine subscription-Row mit enabled=FALSE. Idempotent.
    await deps.subscriptions.ensureCatalogRows(user.userId);

    // 2. Subscription-Rows + Server-Details kombinieren.
    const subs = await deps.subscriptions.list(user.userId);
    const enabledNames = new Set(subs.filter((s) => s.enabled).map((s) => s.subMcpName));
    const knownNames = new Set(subs.map((s) => s.subMcpName));

    // 3. Server-Configs holen (bypass scoped — wir wollen sowohl catalog
    //    als auch user-added). RLS-Policy auf sub_mcp_servers liefert
    //    nur die fuer den User sichtbaren (catalog OR owned).
    const all = await deps.registry.listAll();
    const subscribed: MyServerEntry[] = [];
    const available: MyServerEntry[] = [];
    for (const cfg of all) {
      // Filter: nur catalog-defaults oder user-owned. RLS-Policy auf
      // sub_mcp_servers macht das auf der DB-Seite — die Registry sieht aber
      // alles (unsafe-handle). Wir filtern hier app-side via ownerUserId.
      if (cfg.ownerUserId !== null && cfg.ownerUserId !== user.userId) continue;
      const entry: MyServerEntry = {
        name: cfg.name,
        displayName: cfg.displayName,
        baseUrl: cfg.baseUrl,
        enabled: enabledNames.has(cfg.name),
        isCatalogDefault: cfg.isCatalogDefault,
        isOwnedByMe: cfg.ownerUserId === user.userId,
        toolsCachedAt: cfg.toolsCachedAt,
        toolsCount: cfg.toolsCache?.length ?? 0,
      };
      if (enabledNames.has(cfg.name)) {
        subscribed.push(entry);
      } else if (knownNames.has(cfg.name)) {
        available.push(entry);
      } else {
        // Catalog-Server der nicht in der Sub-Tabelle ist (sollte nach
        // ensureCatalogRows nicht passieren — defensive Pfad).
        available.push(entry);
      }
    }

    subscribed.sort((a, b) => a.name.localeCompare(b.name));
    available.sort((a, b) => a.name.localeCompare(b.name));

    const body: MyServersResponse = { subscribed, available };
    return c.json(body);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Phase 4: User-Added-Server (own MCP-Server hinzufuegen / loeschen)
  // ─────────────────────────────────────────────────────────────────────
  // POST   /v1/me/servers           — eigenen Sub-MCP-Server registrieren
  // DELETE /v1/me/servers/:name     — eigenen Server entfernen
  //
  // Catalog-Defaults (operator-managed via Doppler/TF) sind hier nicht
  // erreichbar — DELETE matched nur owner_user_id = userId.
  app.post('/v1/me/servers', guard, zValidator('json', AddServerBody), async (c) => {
    const user = c.get('user');
    if (!user) throw HttpError.unauthorized('authentication required');
    const body = c.req.valid('json');

    // Name-Konflikt-Check (global-uniq via idx_sub_mcp_name aus Mig 0003).
    const existing = await deps.registry.getByName(body.name).catch(() => null);
    if (existing) {
      throw HttpError.badRequest(
        'invalid_request',
        `server name '${body.name}' bereits vergeben (catalog oder anderer User)`,
      );
    }

    // Registrieren mit owner_user_id = user.userId. is_catalog_default
    // automatisch FALSE (siehe registry.register).
    const cfg = await deps.registry.register({
      name: body.name,
      displayName: body.displayName,
      baseUrl: body.baseUrl,
      authMode: body.authMode,
      authConfig: {},
      enabled: true,
      ownerUserId: user.userId,
      ...(body.serviceTokenPlain ? { serviceTokenPlain: body.serviceTokenPlain } : {}),
    });

    // Optional: configSchema persistieren falls vom User mitgegeben.
    if (body.configSchema && deps.registry.updateConfigSchema) {
      await deps.registry.updateConfigSchema(cfg.id, body.configSchema);
    }

    // Subscription direkt aktiv setzen damit der User die Tools sofort
    // sieht (default true).
    if (body.enableSubscription) {
      await deps.subscriptions.setEnabled(user.userId, body.name, true);
    }

    return c.json({
      name: cfg.name,
      displayName: cfg.displayName,
      baseUrl: cfg.baseUrl,
      authMode: cfg.authMode,
      ownerUserId: user.userId,
      subscribed: body.enableSubscription,
    });
  });

  app.delete('/v1/me/servers/:name', guard, async (c) => {
    const user = c.get('user');
    if (!user) throw HttpError.unauthorized('authentication required');
    const name = c.req.param('name');

    if (!deps.registry.unregisterByOwner) {
      throw new HttpError(500, 'internal', 'registry does not support unregisterByOwner');
    }
    const deleted = await deps.registry.unregisterByOwner(name, user.userId);
    if (!deleted) {
      throw HttpError.notFound(
        `server '${name}' not found or not owned by you (catalog defaults sind nicht loeschbar)`,
      );
    }
    return c.body(null, 204);
  });

  app.patch(
    '/v1/me/servers/:name/subscription',
    guard,
    zValidator('json', SubscriptionPatchBody),
    async (c) => {
      const user = c.get('user');
      if (!user) throw HttpError.unauthorized('authentication required');
      const name = c.req.param('name');
      const body = c.req.valid('json');

      // Server muss in der Registry sein (RLS-gefiltert: user sieht catalog
      // + own).
      const cfg = await deps.registry.getByName(name).catch(() => null);
      if (!cfg) {
        throw HttpError.notFound(`server '${name}' not found`);
      }

      await deps.subscriptions.setEnabled(user.userId, name, body.enabled);
      return c.json({ name, enabled: body.enabled });
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // Phase 2: Per-User-Server-Config (KMS-encrypted)
  // ─────────────────────────────────────────────────────────────────────
  // GET    /v1/me/servers/:name/config        — alle keys + non-secret values
  // PUT    /v1/me/servers/:name/config/:key   — set encrypted value
  // DELETE /v1/me/servers/:name/config/:key   — entfernen
  //
  // Konvention: keys mit `_`-Prefix sind secret (Server returnt nur metadata,
  // value als '***'). Plain-keys liefern den decrypted Wert.
  if (deps.config) {
    const cfgSvc = deps.config;

    app.get('/v1/me/servers/:name/config', guard, async (c) => {
      const user = c.get('user');
      if (!user) throw HttpError.unauthorized('authentication required');
      const name = c.req.param('name');
      const keys = await cfgSvc.listKeys(user.userId, name);
      // Plain-Werte fetchen, secrets als '***' maskieren.
      const fields: Record<string, { value: string; isSecret: boolean; updatedAt: number }> = {};
      for (const k of keys) {
        if (k.isSecret) {
          fields[k.configKey] = { value: '***', isSecret: true, updatedAt: k.updatedAt };
        } else {
          const full = await cfgSvc.get(user.userId, name, k.configKey);
          fields[k.configKey] = { value: full.value, isSecret: false, updatedAt: k.updatedAt };
        }
      }
      return c.json({ fields });
    });

    app.put(
      '/v1/me/servers/:name/config/:key',
      guard,
      zValidator('json', ConfigPutBody),
      async (c) => {
        const user = c.get('user');
        if (!user) throw HttpError.unauthorized('authentication required');
        const name = c.req.param('name');
        const key = c.req.param('key');
        if (!CONFIG_KEY_RE.test(key)) {
          throw HttpError.badRequest('invalid_request', `invalid config key '${key}'`);
        }
        const body = c.req.valid('json');
        const entry = await cfgSvc.set(user.userId, name, key, body.value);
        return c.json({
          configKey: entry.configKey,
          isSecret: entry.isSecret,
          updatedAt: entry.updatedAt,
        });
      },
    );

    app.delete('/v1/me/servers/:name/config/:key', guard, async (c) => {
      const user = c.get('user');
      if (!user) throw HttpError.unauthorized('authentication required');
      const name = c.req.param('name');
      const key = c.req.param('key');
      if (!CONFIG_KEY_RE.test(key)) {
        throw HttpError.badRequest('invalid_request', `invalid config key '${key}'`);
      }
      await cfgSvc.delete(user.userId, name, key);
      return c.body(null, 204);
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Phase 3: OAuth-Authorize-Flow (pre-registered)
  // ─────────────────────────────────────────────────────────────────────
  // POST /v1/me/servers/:name/oauth/start    → { authorizeUrl, state }
  // POST /v1/me/servers/:name/oauth/callback → 204
  if (deps.oauth) {
    const oauthSvc = deps.oauth;

    const OAuthStartBody = z
      .object({
        redirectUri: z.string().url(),
      })
      .strict();

    const OAuthCallbackBody = z
      .object({
        state: z.string().min(8).max(256),
        code: z.string().min(1).max(2048),
      })
      .strict();

    app.post(
      '/v1/me/servers/:name/oauth/start',
      guard,
      zValidator('json', OAuthStartBody),
      async (c) => {
        const user = c.get('user');
        if (!user) throw HttpError.unauthorized('authentication required');
        const name = c.req.param('name');
        const body = c.req.valid('json');
        // SERVER-SIDE redirectUri: ignoriert was der PWA-Bundle schickt und
        // baut die kanonische Bridge-URL aus den Request-Origin-Headern.
        //
        // Warum: ein veralteter SW-Cache im User-Browser sendet sonst ggf.
        // einen Hash-Pfad (RFC-incompliant), GitHub-OAuth rejected →
        // 'redirect_uri not associated'. Mit Server-Seitig-Bau ist es egal
        // was der Client liefert; Bridge-URL ist immer korrekt.
        //
        // Body-redirectUri bleibt aus Schema-Compat-Gruenden im Schema —
        // wir loggen ihn als Diagnostic, nutzen ihn aber nicht.
        const fwdProto = c.req.header('x-forwarded-proto') ?? 'https';
        const fwdHost = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? '';
        const origin = `${fwdProto}://${fwdHost}`;
        // Kein Query-Param mehr — sub_mcp_name wird vom Bridge-Endpoint
        // via state-Lookup aus user_sub_mcp_oauth_state geholt. Damit ist
        // die redirect_uri ein konstanter String pro Origin, was strict-
        // string-Match in GitHub-Apps + anderen Providers garantiert klappt.
        const canonicalRedirectUri = `${origin}/oauth/sub-mcp-callback`;
        logger.info(
          {
            event: 'oauth.start',
            server: name,
            userId: user.userId,
            clientRedirectUri: body.redirectUri,
            clientHadHashFragment: body.redirectUri.includes('#'),
            canonicalRedirectUri,
            overrode: body.redirectUri !== canonicalRedirectUri,
          },
          'sub-mcp oauth-start',
        );
        const result = await oauthSvc.start(user.userId, name, canonicalRedirectUri);
        return c.json(result);
      },
    );

    app.post(
      '/v1/me/servers/:name/oauth/callback',
      guard,
      zValidator('json', OAuthCallbackBody),
      async (c) => {
        const user = c.get('user');
        if (!user) throw HttpError.unauthorized('authentication required');
        const name = c.req.param('name');
        const body = c.req.valid('json');
        await oauthSvc.callback(user.userId, name, body.state, body.code);

        // Post-OAuth-Hook: per-User-Discovery triggern damit der User
        // direkt Tools sieht. Non-fatal — wenn discovery scheitert, kann
        // der User spaeter manuell rediscover triggern.
        if (deps.refreshUserToolCache) {
          try {
            await deps.refreshUserToolCache({ userId: user.userId, only: [name] });
          } catch (err) {
            logger.warn(
              {
                event: 'oauth.callback.discovery_failed',
                server: name,
                userId: user.userId,
                err: err instanceof Error ? err.message : String(err),
              },
              'sub-mcp post-oauth discovery failed',
            );
          }
        }
        return c.body(null, 204);
      },
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // Phase D: Per-Tool Defaults
  // ─────────────────────────────────────────────────────────────────────
  // GET    /v1/me/servers/:name/tool-defaults                         → list all
  // PUT    /v1/me/servers/:name/tool-defaults/:tool/:field            → upsert
  // DELETE /v1/me/servers/:name/tool-defaults/:tool/:field            → remove
  if (deps.toolDefaults) {
    const tdSvc = deps.toolDefaults;
    const TOOL_RE = /^[a-zA-Z_][a-zA-Z0-9_.:-]{0,127}$/;
    const FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
    const PROFILE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
    // Phase B (PLAN-tool-defaults-v2.md): typed value + profile + valueKind.
    // value ist `unknown` damit Caller jeden JSON-Type schicken kann; der
    // Service validiert gegen valueKind.
    const ToolDefaultPutBody = z
      .object({
        value: z.unknown(),
        valueKind: z
          .enum(['text', 'json', 'number', 'boolean', 'enum'])
          .optional(),
        profile: z.string().regex(PROFILE_RE).default('default'),
        isSecret: z.boolean().optional(),
      })
      .strict();

    app.get('/v1/me/servers/:name/tool-defaults', guard, async (c) => {
      const user = c.get('user');
      if (!user) throw HttpError.unauthorized('authentication required');
      const name = c.req.param('name');
      const rows = await tdSvc.listByServer(user.userId, name);
      return c.json({ defaults: rows });
    });

    app.put(
      '/v1/me/servers/:name/tool-defaults/:tool/:field',
      guard,
      zValidator('json', ToolDefaultPutBody),
      async (c) => {
        const user = c.get('user');
        if (!user) throw HttpError.unauthorized('authentication required');
        const name = c.req.param('name');
        const tool = c.req.param('tool');
        const field = c.req.param('field');
        if (!TOOL_RE.test(tool)) {
          throw HttpError.badRequest('invalid_request', `invalid tool name '${tool}'`);
        }
        if (!FIELD_RE.test(field)) {
          throw HttpError.badRequest('invalid_request', `invalid field name '${field}'`);
        }
        const body = c.req.valid('json');
        const entry = await tdSvc.set({
          userId: user.userId,
          subMcpName: name,
          profileName: body.profile,
          toolName: tool,
          fieldName: field,
          value: body.value,
          ...(body.valueKind ? { valueKind: body.valueKind } : {}),
          ...(body.isSecret !== undefined ? { isSecret: body.isSecret } : {}),
        });
        return c.json(entry);
      },
    );

    app.delete('/v1/me/servers/:name/tool-defaults/:tool/:field', guard, async (c) => {
      const user = c.get('user');
      if (!user) throw HttpError.unauthorized('authentication required');
      const name = c.req.param('name');
      const tool = c.req.param('tool');
      const field = c.req.param('field');
      if (!TOOL_RE.test(tool)) {
        throw HttpError.badRequest('invalid_request', `invalid tool name '${tool}'`);
      }
      if (!FIELD_RE.test(field)) {
        throw HttpError.badRequest('invalid_request', `invalid field name '${field}'`);
      }
      const profileRaw = c.req.query('profile');
      const profile = profileRaw && PROFILE_RE.test(profileRaw) ? profileRaw : 'default';
      await tdSvc.remove(user.userId, name, tool, field, profile);
      return c.body(null, 204);
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Phase C (PLAN-tool-defaults-v2.md): Default-Profile-CRUD
  // ─────────────────────────────────────────────────────────────────────
  // GET    /v1/me/servers/:srv/default-profiles
  // POST   /v1/me/servers/:srv/default-profiles            body: {name, description?, copyFrom?, activate?}
  // POST   /v1/me/servers/:srv/default-profiles/:name/activate
  // DELETE /v1/me/servers/:srv/default-profiles/:name
  if (deps.toolDefaultProfiles) {
    const profilesSvc = deps.toolDefaultProfiles;
    const PROFILE_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
    const ProfileCreateBody = z
      .object({
        name: z.string().regex(PROFILE_NAME_RE),
        description: z.string().max(256).optional(),
        copyFrom: z.string().regex(PROFILE_NAME_RE).optional(),
        activate: z.boolean().optional(),
      })
      .strict();

    app.get('/v1/me/servers/:name/default-profiles', guard, async (c) => {
      const user = c.get('user');
      if (!user) throw HttpError.unauthorized('authentication required');
      const name = c.req.param('name');
      const profiles = await profilesSvc.list(user.userId, name);
      return c.json({ profiles });
    });

    app.post(
      '/v1/me/servers/:name/default-profiles',
      guard,
      zValidator('json', ProfileCreateBody),
      async (c) => {
        const user = c.get('user');
        if (!user) throw HttpError.unauthorized('authentication required');
        const name = c.req.param('name');
        const body = c.req.valid('json');
        const profile = await profilesSvc.create({
          userId: user.userId,
          subMcpName: name,
          profileName: body.name,
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.copyFrom !== undefined ? { copyFrom: body.copyFrom } : {}),
          ...(body.activate !== undefined ? { activate: body.activate } : {}),
        });
        return c.json(profile, 201);
      },
    );

    app.post(
      '/v1/me/servers/:name/default-profiles/:profile/activate',
      guard,
      async (c) => {
        const user = c.get('user');
        if (!user) throw HttpError.unauthorized('authentication required');
        const name = c.req.param('name');
        const profile = c.req.param('profile');
        if (!PROFILE_NAME_RE.test(profile)) {
          throw HttpError.badRequest('invalid_request', `invalid profile name '${profile}'`);
        }
        await profilesSvc.activate(user.userId, name, profile);
        return c.json({ name, profile, activated: true });
      },
    );

    app.delete('/v1/me/servers/:name/default-profiles/:profile', guard, async (c) => {
      const user = c.get('user');
      if (!user) throw HttpError.unauthorized('authentication required');
      const name = c.req.param('name');
      const profile = c.req.param('profile');
      if (!PROFILE_NAME_RE.test(profile)) {
        throw HttpError.badRequest('invalid_request', `invalid profile name '${profile}'`);
      }
      await profilesSvc.delete(user.userId, name, profile);
      return c.body(null, 204);
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Phase E (PLAN-tool-defaults-v2.md): Tool-Hints (frei-Text)
  // ─────────────────────────────────────────────────────────────────────
  // GET    /v1/me/servers/:srv/tool-hints
  // PUT    /v1/me/servers/:srv/tool-hints/:tool/:field   body: {hintText}
  // DELETE /v1/me/servers/:srv/tool-hints/:tool/:field
  if (deps.toolDefaultHints) {
    const hintsSvc = deps.toolDefaultHints;
    const HINT_TOOL_RE = /^[a-zA-Z_][a-zA-Z0-9_.:-]{0,127}$/;
    const HINT_FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
    const HintPutBody = z
      .object({
        hintText: z.string().max(500),
      })
      .strict();

    app.get('/v1/me/servers/:name/tool-hints', guard, async (c) => {
      const user = c.get('user');
      if (!user) throw HttpError.unauthorized('authentication required');
      const name = c.req.param('name');
      const hints = await hintsSvc.listByServer(user.userId, name);
      return c.json({ hints });
    });

    app.put(
      '/v1/me/servers/:name/tool-hints/:tool/:field',
      guard,
      zValidator('json', HintPutBody),
      async (c) => {
        const user = c.get('user');
        if (!user) throw HttpError.unauthorized('authentication required');
        const name = c.req.param('name');
        const tool = c.req.param('tool');
        const field = c.req.param('field');
        if (!HINT_TOOL_RE.test(tool)) {
          throw HttpError.badRequest('invalid_request', `invalid tool name '${tool}'`);
        }
        if (!HINT_FIELD_RE.test(field)) {
          throw HttpError.badRequest('invalid_request', `invalid field name '${field}'`);
        }
        const body = c.req.valid('json');
        // Empty-String-Convention: PUT mit hintText='' = remove.
        if (body.hintText === '') {
          await hintsSvc.remove(user.userId, name, tool, field);
          return c.body(null, 204);
        }
        const entry = await hintsSvc.set({
          userId: user.userId,
          subMcpName: name,
          toolName: tool,
          fieldName: field,
          hintText: body.hintText,
        });
        return c.json(entry);
      },
    );

    app.delete('/v1/me/servers/:name/tool-hints/:tool/:field', guard, async (c) => {
      const user = c.get('user');
      if (!user) throw HttpError.unauthorized('authentication required');
      const name = c.req.param('name');
      const tool = c.req.param('tool');
      const field = c.req.param('field');
      if (!HINT_TOOL_RE.test(tool)) {
        throw HttpError.badRequest('invalid_request', `invalid tool name '${tool}'`);
      }
      if (!HINT_FIELD_RE.test(field)) {
        throw HttpError.badRequest('invalid_request', `invalid field name '${field}'`);
      }
      await hintsSvc.remove(user.userId, name, tool, field);
      return c.body(null, 204);
    });
  }

  return app;
}
