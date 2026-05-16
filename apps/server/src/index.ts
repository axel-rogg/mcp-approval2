/**
 * mcp-approval2 server entry.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2, §3, §11 (Burst-3 Final-Wiring).
 *
 * Aufbau:
 *   - `loadConfig(env)` validiert Pflicht-Vars (zod).
 *   - `createDbAdapter(config)` waehlt Postgres oder SQLite.
 *   - `createServerContext` baut `{config, db}`.
 *   - Optional-Adapter (KEK + Knowledge) je nach Env-Var gebaut.
 *   - `createApp(server, deps)` aus `./app-factory.js` mounten.
 *
 * Re-Export von `createApp` + Typen, damit Tests via `import { createApp }
 * from './index.js'` weiterhin durchlaufen (Backward-Compat zur Burst-2-Phase).
 */
import { serve } from '@hono/node-server';
import {
  AppRoleAuth,
  CloudKmsKekProvider,
  LocalKekProvider,
  OpenBaoKekProvider,
  StaticTokenAuth,
} from '@mcp-approval2/adapters';
import { loadConfig, type AppConfig } from './lib/config.js';
import { createDbAdapter } from './lib/db.js';
import type { ServerContext } from './lib/context.js';
import { createApp, type CreateAppDeps } from './app-factory.js';
import { createKnowledgeService } from './services/knowledge.js';
import { emitAudit, type AuditEvent } from './services/audit.js';
import { getSigningKey, getJwksPublicKey } from './auth/jwt-signing.js';

// Re-exports — Tests + Burst-2-Subagents importieren von hier.
export { createApp } from './app-factory.js';
export type { CreateAppDeps } from './app-factory.js';

/**
 * Mappt die Compose-Namen aus deploy/hetzner/docker-compose.yml auf die
 * zod-Schema-Namen in lib/config.ts. Der CF-Adapter (`cf/app-factory-cf.ts`)
 * macht dasselbe mit anderen Quellnamen — der Node-Pfad hatte den Shim bisher
 * nicht, was den Boot crashte (App-Audit 2026-05-14, CRITICAL #1).
 *
 * Pflicht-Alias-Quellen:
 *   - BASE_URL              -> ORIGIN, RP_ORIGIN, (Default fuer GOOGLE_REDIRECT_URI)
 *   - WEBAUTHN_RP_ID        -> RP_ID
 *   - GOOGLE_OAUTH_CLIENT_* -> GOOGLE_CLIENT_*
 *
 * Aliasing wird nur angewendet wenn der Schema-Name NICHT bereits gesetzt ist,
 * damit lokale Tests + Dev-Setups (die schon den Schema-Namen nutzen) nicht
 * gestoert werden.
 */
function translateBootEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...env };
  const aliases: Array<[string, string]> = [
    ['ORIGIN', 'BASE_URL'],
    ['RP_ORIGIN', 'BASE_URL'],
    ['RP_ID', 'WEBAUTHN_RP_ID'],
    ['GOOGLE_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_ID'],
    ['GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_CLIENT_SECRET'],
  ];
  for (const [schemaName, composeName] of aliases) {
    if (!merged[schemaName] && merged[composeName]) {
      merged[schemaName] = merged[composeName];
    }
  }
  // GOOGLE_REDIRECT_URI ist im Schema Pflicht (url), wird aber nirgendwo in
  // compose gesetzt. Konvention: `${BASE_URL}/auth/google/callback`.
  if (!merged['GOOGLE_REDIRECT_URI'] && merged['BASE_URL']) {
    merged['GOOGLE_REDIRECT_URI'] =
      `${merged['BASE_URL'].replace(/\/$/, '')}/auth/google/callback`;
  }
  return merged;
}

/**
 * Baut den geteilten `{config, db}`-Container. Tests koennen einen Stub-Db
 * via `createApp({config, db})` direkt einsetzen, ohne `loadConfig` zu fahren.
 */
export async function createServerContext(env: NodeJS.ProcessEnv): Promise<ServerContext> {
  const config: AppConfig = loadConfig(translateBootEnv(env));
  const db = await createDbAdapter(config);
  return { config, db };
}

// ───────────────────────────────────────────────────────────────────────────
// Optional-Dependency-Build — KEK + Knowledge je nach Env-Var verfuegbar.
// ───────────────────────────────────────────────────────────────────────────

interface BootEnv {
  readonly MASTER_KEY_BASE64?: string;
  readonly VAULT_ADDR?: string;
  readonly VAULT_TOKEN?: string;
  readonly VAULT_TRANSIT_PATH?: string;
  /** AppRoleAuth credentials (production path). When both are set, takes
   *  precedence over VAULT_TOKEN (which is the Solo-Pilot static-token path). */
  readonly VAULT_APPROLE_ROLE_ID?: string;
  readonly VAULT_APPROLE_SECRET_ID?: string;
  /**
   * Cloud-KMS-KEK-Pfad (Privat-Mode Default seit 2026-05-17 — Google-Cloud-
   * Switch wegen Operator-Realismus, siehe docs/privat.md §9 + ADR-0005).
   * CLOUD_KMS_KEY_NAME ist der voll-qualifizierte Resource-Name
   * (`projects/.../cryptoKeys/...`), CLOUD_KMS_WRAPPED_MASTER_B64 ist die
   * base64-encoded ciphertext des 32-byte Master-Keys.
   */
  readonly CLOUD_KMS_KEY_NAME?: string;
  readonly CLOUD_KMS_WRAPPED_MASTER_B64?: string;
  /**
   * KC2-Base-URL. AS-3-kanonischer Name ist `MCP_KNOWLEDGE_URL`; der
   * Legacy-Name `KNOWLEDGE_URL` wird weiter akzeptiert. Boot-Code waehlt
   * den ersten gesetzten Wert (MCP_KNOWLEDGE_URL bevorzugt).
   */
  readonly KNOWLEDGE_URL?: string;
  readonly JWT_PRIVATE_KEY?: string;
  readonly JWT_RS256_PRIVATE_KEY_PEM?: string;
  readonly JWT_RS256_PUBLIC_KEY_PEM?: string;
  readonly JWT_KID?: string;
  readonly MCP_APPROVAL_INTERNAL_TOKEN?: string;
  /** AS-3: shared S2S Bearer fuer KC2-Calls (alongside OBO-JWT). */
  readonly MCP_KNOWLEDGE_SERVICE_TOKEN?: string;
  /** AS-3: `iss`-Claim in OBO-JWTs an KC2. Default Fallback: config.ORIGIN. */
  readonly SELF_OAUTH_ISSUER?: string;
}

async function buildOptionalDeps(
  server: ServerContext,
  bootEnv: BootEnv,
): Promise<CreateAppDeps> {
  const deps: Mutable<CreateAppDeps> = {};

  // ─── KEK-Provider ─────────────────────────────────────────────────────
  //
  // Selection precedence (highest first):
  //   1. CLOUD_KMS_KEY_NAME + CLOUD_KMS_WRAPPED_MASTER_B64
  //      → CloudKmsKekProvider (privat-Mode Default seit 2026-05-17 —
  //        Google-Cloud-KMS multi-region `eu`. Master wird beim Boot via
  //        KMS.decrypt entpackt, danach in-process HKDF). Auth via ADC
  //        (GOOGLE_APPLICATION_CREDENTIALS_JSON in Doppler/env).
  //   2. VAULT_ADDR + VAULT_APPROLE_ROLE_ID + VAULT_APPROLE_SECRET_ID
  //      → OpenBaoKekProvider with AppRoleAuth (selfhosted-Variante; parkt
  //        seit Cloud-KMS-Default).
  //   3. VAULT_ADDR + VAULT_TOKEN
  //      → OpenBaoKekProvider with StaticTokenAuth (Solo-Pilot Bao-Path).
  //   4. MASTER_KEY_BASE64
  //      → LocalKekProvider (dev fallback; in-process HKDF derivation,
  //        no external dependency). Multi-User-safe via per-user salt.
  //   5. (none of the above) → no kekProvider, app boots in
  //      no-credentials-mode (KekRequiredError on any path that needs it).
  if (bootEnv.CLOUD_KMS_KEY_NAME && bootEnv.CLOUD_KMS_WRAPPED_MASTER_B64) {
    deps.kekProvider = new CloudKmsKekProvider({
      keyName: bootEnv.CLOUD_KMS_KEY_NAME,
      wrappedMasterB64: bootEnv.CLOUD_KMS_WRAPPED_MASTER_B64,
    });
  }
  if (!deps.kekProvider && bootEnv.VAULT_ADDR) {
    const transitMount = bootEnv.VAULT_TRANSIT_PATH ?? 'transit';
    if (bootEnv.VAULT_APPROLE_ROLE_ID && bootEnv.VAULT_APPROLE_SECRET_ID) {
      // Production path — AppRoleAuth handles login + lease renewal.
      const auth = new AppRoleAuth({
        addr: bootEnv.VAULT_ADDR,
        roleId: bootEnv.VAULT_APPROLE_ROLE_ID,
        secretId: bootEnv.VAULT_APPROLE_SECRET_ID,
      });
      deps.kekProvider = new OpenBaoKekProvider({
        addr: bootEnv.VAULT_ADDR,
        auth,
        transitMount,
      });
    } else if (bootEnv.VAULT_TOKEN) {
      // Solo-Pilot / dev path — static token. Rotation is operator's job.
      const auth = new StaticTokenAuth(bootEnv.VAULT_TOKEN);
      deps.kekProvider = new OpenBaoKekProvider({
        addr: bootEnv.VAULT_ADDR,
        auth,
        transitMount,
      });
    } else {
      // VAULT_ADDR set but no token/approle → operator error; warn and
      // fall through to MASTER_KEY_BASE64.
      // eslint-disable-next-line no-console
      console.warn(
        '[mcp-approval2] VAULT_ADDR set but neither VAULT_TOKEN nor ' +
          'VAULT_APPROLE_ROLE_ID/SECRET_ID provided. Falling back to ' +
          'MASTER_KEY_BASE64 (LocalKekProvider).',
      );
    }
  }
  if (!deps.kekProvider && bootEnv.MASTER_KEY_BASE64) {
    const masterKey = decodeBase64(bootEnv.MASTER_KEY_BASE64);
    if (masterKey.byteLength !== 32) {
      throw new Error('MASTER_KEY_BASE64 must decode to 32 bytes');
    }
    deps.kekProvider = new LocalKekProvider({ masterKey });
  }

  // ─── KnowledgeService ────────────────────────────────────────────────
  // Nur wenn URL + Private-Key gesetzt. Audit-Sink ist der gemeinsame
  // Postgres-`audit_log`-Sink (siehe services/audit.ts).
  const knowledgePem =
    bootEnv.JWT_RS256_PRIVATE_KEY_PEM ?? bootEnv.JWT_PRIVATE_KEY;
  if (bootEnv.KNOWLEDGE_URL && knowledgePem) {
    const audit = {
      async emit(event: AuditEvent): Promise<void> {
        await emitAudit(server.db, event);
      },
    };
    const knowledgeEnv: {
      KNOWLEDGE_URL: string;
      JWT_RS256_PRIVATE_KEY_PEM: string;
      JWT_ISSUER: string;
      JWT_AUDIENCE: string;
      JWT_KID?: string;
    } = {
      KNOWLEDGE_URL: bootEnv.KNOWLEDGE_URL,
      JWT_RS256_PRIVATE_KEY_PEM: knowledgePem,
      JWT_ISSUER: server.config.JWT_ISSUER,
      JWT_AUDIENCE: 'mcp-knowledge2',
    };
    if (bootEnv.JWT_KID !== undefined) knowledgeEnv.JWT_KID = bootEnv.JWT_KID;
    deps.knowledge = await createKnowledgeService({ env: knowledgeEnv, audit });
  }

  // ─── Internal Service-Token ─────────────────────────────────────────
  // Pre-shared token fuer first-party services (mcp-knowledge2 etc.) die
  // /internal/v1/* aufrufen. Ohne den werden die internal-routes nicht
  // gemounted (app-factory loggt eine Warnung).
  if (bootEnv.MCP_APPROVAL_INTERNAL_TOKEN) {
    deps.internalServiceToken = bootEnv.MCP_APPROVAL_INTERNAL_TOKEN;
  }

  // ─── AS-3: kc-proxy ──────────────────────────────────────────────────
  // PWA-Same-Origin-Proxy zu mcp-knowledge2. Nur gemountet wenn beide
  // KC-URL + SERVICE_TOKEN gesetzt sind.
  if (bootEnv.KNOWLEDGE_URL && bootEnv.MCP_KNOWLEDGE_SERVICE_TOKEN) {
    deps.kcProxy = {
      knowledgeUrl: bootEnv.KNOWLEDGE_URL,
      serviceToken: bootEnv.MCP_KNOWLEDGE_SERVICE_TOKEN,
    };
  }

  return deps;
}

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

function decodeBase64(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(b64, 'base64');
    return new Uint8Array(buf);
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pickBootEnv(env: NodeJS.ProcessEnv): BootEnv {
  const out: Mutable<BootEnv> = {};
  if (env['MASTER_KEY_BASE64']) out.MASTER_KEY_BASE64 = env['MASTER_KEY_BASE64'];
  if (env['VAULT_ADDR']) out.VAULT_ADDR = env['VAULT_ADDR'];
  if (env['VAULT_TOKEN']) out.VAULT_TOKEN = env['VAULT_TOKEN'];
  if (env['VAULT_TRANSIT_PATH']) out.VAULT_TRANSIT_PATH = env['VAULT_TRANSIT_PATH'];
  if (env['VAULT_APPROLE_ROLE_ID']) out.VAULT_APPROLE_ROLE_ID = env['VAULT_APPROLE_ROLE_ID'];
  if (env['VAULT_APPROLE_SECRET_ID']) out.VAULT_APPROLE_SECRET_ID = env['VAULT_APPROLE_SECRET_ID'];
  // AS-3-naming bevorzugt; Legacy-Fallback.
  const kcUrl = env['MCP_KNOWLEDGE_URL'] ?? env['KNOWLEDGE_URL'];
  if (kcUrl) out.KNOWLEDGE_URL = kcUrl;
  if (env['JWT_PRIVATE_KEY']) out.JWT_PRIVATE_KEY = env['JWT_PRIVATE_KEY'];
  if (env['JWT_RS256_PRIVATE_KEY_PEM']) {
    out.JWT_RS256_PRIVATE_KEY_PEM = env['JWT_RS256_PRIVATE_KEY_PEM'];
  }
  if (env['JWT_RS256_PUBLIC_KEY_PEM']) {
    out.JWT_RS256_PUBLIC_KEY_PEM = env['JWT_RS256_PUBLIC_KEY_PEM'];
  }
  if (env['JWT_KID']) out.JWT_KID = env['JWT_KID'];
  if (env['MCP_APPROVAL_INTERNAL_TOKEN']) {
    out.MCP_APPROVAL_INTERNAL_TOKEN = env['MCP_APPROVAL_INTERNAL_TOKEN'];
  }
  if (env['MCP_KNOWLEDGE_SERVICE_TOKEN']) {
    out.MCP_KNOWLEDGE_SERVICE_TOKEN = env['MCP_KNOWLEDGE_SERVICE_TOKEN'];
  }
  if (env['SELF_OAUTH_ISSUER']) out.SELF_OAUTH_ISSUER = env['SELF_OAUTH_ISSUER'];
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// CLI-Boot
// ───────────────────────────────────────────────────────────────────────────

/**
 * Wartet darauf dass der DB-Adapter ueberhaupt `SELECT 1` beantworten kann.
 *
 * Hintergrund: Postgres ist beim Compose-Boot via `depends_on:
 * condition: service_healthy` geschuetzt — aber bei einem Hetzner-VM-Reboot
 * starten alle Container parallel. postgres-js verbindet lazy beim ersten
 * Query, ein Race-Window von einigen Sekunden ist realistisch.
 *
 * Exponential-Backoff, ~30s Gesamt-Budget. Wir loggen jeden Retry damit ein
 * Reboot-Race in den Logs sichtbar bleibt.
 */
async function waitForDb(server: ServerContext): Promise<void> {
  const raw = server.db.unsafe('boot-preflight DB-ping waitForDb()');
  const start = Date.now();
  const deadline = start + 30_000;
  let attempt = 0;
  let delay = 250;
  for (;;) {
    attempt += 1;
    try {
      await raw.query('SELECT 1');
      if (attempt > 1) {
        // eslint-disable-next-line no-console
        console.log(`[mcp-approval2] DB ready after ${attempt} attempts`);
      }
      return;
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new Error(
          `DB did not accept SELECT 1 within 30s (last error: ${(err as Error).message})`,
        );
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[mcp-approval2] DB not ready (attempt ${attempt}): ${(err as Error).message}. Retry in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 4_000);
    }
  }
}

/**
 * Parst RS256-PEM-Schluessel beim Boot statt erst beim ersten Sign/Verify.
 *
 * Warum schon hier: PEM-Newline-Round-Trip (env -> Doppler -> .env -> compose)
 * kann unbemerkt brechen. Ein Pre-Flight-Parse macht den Fehler beim Boot
 * sichtbar, nicht erst stunden spaeter beim ersten JWKS-Sign. Bei nicht
 * gesetzten Keys (Dev-Fallback HS256) ueberspringen wir die Pruefung.
 */
async function preflightJwtKeys(env: NodeJS.ProcessEnv): Promise<void> {
  const priv = env['JWT_RS256_PRIVATE_KEY_PEM'];
  const pub = env['JWT_RS256_PUBLIC_KEY_PEM'];
  if (!priv && !pub) return; // dev/test fallback path (HS256 via JWT_SECRET)
  if (priv && !pub) {
    throw new Error(
      'JWT_RS256_PRIVATE_KEY_PEM set but JWT_RS256_PUBLIC_KEY_PEM missing — both required',
    );
  }
  if (pub && !priv) {
    throw new Error(
      'JWT_RS256_PUBLIC_KEY_PEM set but JWT_RS256_PRIVATE_KEY_PEM missing — both required',
    );
  }
  // getSigningKey + getJwksPublicKey both parse via `jose` (importPKCS8 / importSPKI).
  // A bad PEM throws synchronously here. Guard the env-shape against zod
  // exactOptionalPropertyTypes (priv/pub are already string after the guards
  // above, but tsc can't see that through the env-index narrowing).
  await getSigningKey({ JWT_RS256_PRIVATE_KEY_PEM: priv as string });
  await getJwksPublicKey({ JWT_RS256_PUBLIC_KEY_PEM: pub as string });
}

async function main(): Promise<void> {
  const server = await createServerContext(process.env);
  await waitForDb(server);
  await preflightJwtKeys(process.env);
  const deps = await buildOptionalDeps(server, pickBootEnv(process.env));
  const app = await createApp(server, deps);
  const port = server.config.PORT;
  // eslint-disable-next-line no-console
  console.log(`[mcp-approval2] listening on :${port}`);
  // eslint-disable-next-line no-console
  console.log(
    `[mcp-approval2] credentials=${deps.kekProvider ? 'on' : 'off'} knowledge=${deps.knowledge ? 'on' : 'off'}`,
  );
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
