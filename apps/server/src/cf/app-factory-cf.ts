/**
 * createCfApp — the Cloudflare-Workers analogue of `apps/server/src/index.ts`'s
 * `createServerContext + createApp` pipeline.
 *
 * Wireup:
 *   1. Build the `ServerContext` (`{ config, db }`) from CF env bindings + vars +
 *      secrets. Where `index.ts` would pull from `process.env`, we read
 *      `env.<NAME>`.
 *   2. Build adapter instances:
 *      - DB              → D1Adapter
 *      - KEK Provider    → LocalKekProvider (HKDF from MASTER_KEY secret)
 *      - AI              → CfWorkersAiAdapter (Workers AI + optional Gateway)
 *      - Vec / Blob      → CfApp-local — not part of the shared AppDeps surface
 *                          yet. Repositories that need them (KnowledgeService,
 *                          objects API) hold their own references; this factory
 *                          surfaces them through KnowledgeService construction
 *                          in a follow-up.
 *   3. Hand off to `createApp(server, deps)` for the full Hono wireup.
 *
 * Architecture differences vs Node entry — see ./README.md.
 */
import type {
  Ai,
  D1Database,
  R2Bucket,
  VectorizeIndex,
} from '@cloudflare/workers-types';
import type { Hono } from 'hono';

import type { AiAdapter } from '@mcp-approval2/adapters';
import type { AppBindings, ServerContext } from '../lib/context.js';
import type { AppConfig } from '../lib/config.js';
import { createApp, type CreateAppDeps } from '../app-factory.js';

import { createD1Adapter } from './d1-adapter.js';
import { createVectorizeAdapter, type VecAdapter } from './vectorize-adapter.js';
import { createCfLocalKekProvider } from './local-kek.js';
import { createCfWorkersAiAdapter } from './workers-ai-adapter.js';

/**
 * CF-only runtime handles that aren't part of the shared CreateAppDeps surface
 * (yet). Exposed via `globalThis.__cfRuntime` after createCfApp() so follow-up
 * KnowledgeService / capability-search wiring can pick them up without
 * rebuilding adapters.
 */
export interface CfRuntime {
  readonly ai: AiAdapter;
  readonly vec: VecAdapter;
  readonly blob: R2Bucket;
}

// ---------------------------------------------------------------------------
// CfEnv — typed shape of `env` passed by the runtime to `worker.fetch`.
// Mirrors wrangler.jsonc bindings + vars + secrets.
// ---------------------------------------------------------------------------

export interface CfEnv {
  // Bindings (from wrangler.jsonc)
  readonly DB: D1Database;
  readonly BLOB: R2Bucket;
  readonly VEC: VectorizeIndex;
  readonly AI: Ai;

  // Vars (non-secret)
  readonly NODE_ENV?: string;
  readonly LOG_LEVEL?: string;
  readonly ORIGIN?: string;
  readonly DATABASE_DIALECT?: string;
  readonly DATABASE_URL?: string;
  readonly RP_ID?: string;
  readonly RP_NAME?: string;
  readonly RP_ORIGIN?: string;
  readonly BASE_URL?: string;
  readonly WEBAUTHN_RP_ID?: string;
  readonly GOOGLE_REDIRECT_URI?: string;
  readonly JWT_ISSUER?: string;
  readonly JWT_AUDIENCE?: string;
  /** Workers AI Gateway URL — optional. Enables `gateway:<provider>:<model>` chat. */
  readonly AI_GATEWAY_URL?: string;

  // Secrets (wrangler secret put)
  readonly GOOGLE_OAUTH_CLIENT_ID?: string;
  readonly GOOGLE_OAUTH_CLIENT_SECRET?: string;
  /** 32-byte master key (base64). Required — see local-kek.ts. */
  readonly MASTER_KEY?: string;
  /** Session-JWT secret. >=32 chars. */
  readonly JWT_SECRET?: string;
  readonly JWT_RS256_PRIVATE_KEY_PEM?: string;
  readonly JWT_RS256_PUBLIC_KEY_PEM?: string;
  readonly JWT_KID?: string;
  readonly MCP_APPROVAL_INTERNAL_TOKEN?: string;
  /** Optional API key for AI Gateway fallback (Anthropic / OpenAI). */
  readonly AI_GATEWAY_API_KEY?: string;
  // ─── AS-3 (Proxy-Mode an mcp-knowledge2) ────────────────────────────
  /** KC2-Base-URL. Optional — wenn ungesetzt: kein KC-Proxy/kc_wrappers. */
  readonly MCP_KNOWLEDGE_URL?: string;
  /** S2S-Shared-Bearer fuer KC2-Calls (mit OBO-JWT in `X-On-Behalf-Of`). */
  readonly MCP_KNOWLEDGE_SERVICE_TOKEN?: string;
  /** `iss`-Claim in OBO-JWTs an KC2. Default Fallback: ORIGIN. */
  readonly SELF_OAUTH_ISSUER?: string;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export interface CreateCfAppOptions {
  /**
   * Override the adapter set. Test isolates can stub `db`, `vec`, etc. without
   * faking the whole env binding.
   */
  readonly deps?: Partial<CreateAppDeps & { vec: VecAdapter }>;
}

export async function createCfApp(
  env: CfEnv,
  opts: CreateCfAppOptions = {},
): Promise<Hono<AppBindings>> {
  // 1) ServerContext (config + db).
  const config = buildConfigFromEnv(env);
  const db = createD1Adapter(env.DB);
  const server: ServerContext = { config, db };

  // 2) Adapters.
  const kekProvider = env.MASTER_KEY
    ? createCfLocalKekProvider(env.MASTER_KEY)
    : undefined;

  // AI + Vec adapters are *available* but not part of the shared
  // `CreateAppDeps` surface today — the Node deploy injects them via
  // `createKnowledgeService` instead. They're exported via `cfRuntime`
  // (returned alongside the app) so callers wiring up a CF-side KnowledgeService
  // or capability-search can pick them up without rebuilding adapters.
  const ai = createCfWorkersAiAdapter({
    ai: env.AI,
    ...(env.AI_GATEWAY_URL !== undefined ? { gatewayUrl: env.AI_GATEWAY_URL } : {}),
    ...(env.AI_GATEWAY_API_KEY !== undefined
      ? { fallbackApiKey: env.AI_GATEWAY_API_KEY }
      : {}),
  });
  const vec = createVectorizeAdapter(env.VEC);

  // Expose the constructed CF-only adapters on the Worker's global so
  // follow-up wiring (KnowledgeService against Vectorize/BLOB) can pick them
  // up by-reference instead of re-deriving from env. Test code can read
  // `(globalThis as any).__cfRuntime` after `createCfApp(env)`.
  (globalThis as { __cfRuntime?: CfRuntime }).__cfRuntime = { ai, vec, blob: env.BLOB };

  // 3) Build deps surface for the shared `createApp`.
  const deps: CreateAppDeps = {
    ...(kekProvider ? { kekProvider } : {}),
    ...(env.MCP_APPROVAL_INTERNAL_TOKEN
      ? { internalServiceToken: env.MCP_APPROVAL_INTERNAL_TOKEN }
      : {}),
    // CF deploy is metered by Workers AI neurons + KV reads; the application-
    // level cost gate isn't needed for the single-operator setup. Operators
    // who want it can flip this back on by setting `daily_limit_usd` in
    // wrangler.jsonc vars and parsing it here.
    dailyLimitUsd: 0,
    ...(opts.deps ?? {}),
  };

  // 4) Standard Hono wireup.
  return createApp(server, deps);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map CF env (vars + secrets) into the same `AppConfig` shape `loadConfig()`
 * produces from `process.env`. We don't call `loadConfig` directly because
 * the Node side validates with zod on `NodeJS.ProcessEnv` semantics and a
 * few fields don't exist on a CF Worker (e.g. PORT). Manual mapping is more
 * honest than faking process.env.
 */
function buildConfigFromEnv(env: CfEnv): AppConfig {
  const required = (name: keyof CfEnv): string => {
    const v = env[name];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(
        `mcp-approval2/cf: required env var "${String(name)}" is missing. Set it ` +
          `as a var (wrangler.jsonc) or secret (wrangler secret put).`,
      );
    }
    return v;
  };

  const origin = env.ORIGIN ?? env.BASE_URL ?? 'http://localhost:8787';
  const rpOrigin = env.RP_ORIGIN ?? origin;
  const googleRedirect =
    env.GOOGLE_REDIRECT_URI ?? `${origin.replace(/\/$/, '')}/auth/google/callback`;

  const cfg: AppConfig = {
    NODE_ENV: (env.NODE_ENV === 'development' || env.NODE_ENV === 'test'
      ? env.NODE_ENV
      : 'production'),
    PORT: 8787, // unused under workers — kept to satisfy AppConfig shape
    ORIGIN: origin,
    DATABASE_URL: env.DATABASE_URL ?? 'd1:DB',
    DATABASE_DIALECT: 'sqlite',
    JWT_SECRET: required('JWT_SECRET'),
    JWT_ISSUER: env.JWT_ISSUER ?? 'mcp-approval2',
    JWT_AUDIENCE: env.JWT_AUDIENCE ?? 'mcp-approval2-api',
    SESSION_TTL_SEC: 30 * 60,
    REFRESH_TTL_SEC: 30 * 24 * 60 * 60,
    GOOGLE_CLIENT_ID: required('GOOGLE_OAUTH_CLIENT_ID'),
    GOOGLE_CLIENT_SECRET: required('GOOGLE_OAUTH_CLIENT_SECRET'),
    GOOGLE_REDIRECT_URI: googleRedirect,
    RP_ID: env.RP_ID ?? env.WEBAUTHN_RP_ID ?? 'localhost',
    RP_NAME: env.RP_NAME ?? 'mcp-approval2',
    RP_ORIGIN: rpOrigin,
    // Multi-Origin Allowlist — auf CF Workers selten benutzt (eigene
    // Custom-Domain), Default leer = nur RP_ORIGIN ist erlaubt. Hetzner-
    // Path nutzt die env-CSV-Variante (siehe lib/config.ts schema).
    ALLOWED_ORIGINS: [],
    INVITE_TTL_SEC: 24 * 60 * 60,
    RECOVERY_TTL_SEC: 24 * 60 * 60,
    // AS-3 Multi-Audience-Default fuer Google-IdP-Verify; CF-Path setzt
    // den Wert sonst nicht. Default-leer = nur eigene GOOGLE_CLIENT_ID.
    GOOGLE_ALLOWED_AUDIENCES: [],
  };

  // Optional RS256 keys — only attach if present, to honor
  // `exactOptionalPropertyTypes`.
  if (env.JWT_RS256_PRIVATE_KEY_PEM !== undefined) {
    (cfg as { JWT_RS256_PRIVATE_KEY_PEM?: string }).JWT_RS256_PRIVATE_KEY_PEM =
      env.JWT_RS256_PRIVATE_KEY_PEM;
  }
  if (env.JWT_RS256_PUBLIC_KEY_PEM !== undefined) {
    (cfg as { JWT_RS256_PUBLIC_KEY_PEM?: string }).JWT_RS256_PUBLIC_KEY_PEM =
      env.JWT_RS256_PUBLIC_KEY_PEM;
  }
  if (env.JWT_KID !== undefined) {
    (cfg as { JWT_KID?: string }).JWT_KID = env.JWT_KID;
  }
  if (env.MCP_APPROVAL_INTERNAL_TOKEN !== undefined) {
    (cfg as { MCP_APPROVAL_INTERNAL_TOKEN?: string }).MCP_APPROVAL_INTERNAL_TOKEN =
      env.MCP_APPROVAL_INTERNAL_TOKEN;
  }
  // AS-3: optional KC-Anbindung + Self-Issuer (lib/config.ts schema).
  if (env.MCP_KNOWLEDGE_URL !== undefined) {
    (cfg as { MCP_KNOWLEDGE_URL?: string }).MCP_KNOWLEDGE_URL = env.MCP_KNOWLEDGE_URL;
  }
  if (env.MCP_KNOWLEDGE_SERVICE_TOKEN !== undefined) {
    (cfg as { MCP_KNOWLEDGE_SERVICE_TOKEN?: string }).MCP_KNOWLEDGE_SERVICE_TOKEN =
      env.MCP_KNOWLEDGE_SERVICE_TOKEN;
  }
  if (env.SELF_OAUTH_ISSUER !== undefined) {
    (cfg as { SELF_OAUTH_ISSUER?: string }).SELF_OAUTH_ISSUER = env.SELF_OAUTH_ISSUER;
  }
  return cfg;
}
