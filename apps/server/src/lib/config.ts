/**
 * Environment-Konfiguration via Zod.
 *
 * Plan-Ref: PLAN-architecture-v1.md §13 (Tech-Stack-Confirmation).
 *
 * Beim Start einmal `loadConfig(env)` aufrufen — wirft, wenn ein Pflicht-Var
 * fehlt. Tests und CLI-Skripte koennen mit `loadConfig(process.env)` arbeiten.
 */
import { z } from 'zod';

const ConfigSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  ORIGIN: z.string().url().default('http://localhost:8787'),

  // Datenbank
  DATABASE_URL: z.string().min(1, 'DATABASE_URL required'),
  DATABASE_DIALECT: z.enum(['postgres', 'sqlite']).default('postgres'),

  // Auth / JWT
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be >= 32 chars'),
  JWT_ISSUER: z.string().default('mcp-approval2'),
  JWT_AUDIENCE: z.string().default('mcp-approval2-api'),
  SESSION_TTL_SEC: z.coerce.number().int().positive().default(30 * 60),
  REFRESH_TTL_SEC: z.coerce.number().int().positive().default(30 * 24 * 60 * 60),

  // Cookie-Domain fuer Cross-Subdomain-Sharing.
  //
  // Multi-Origin-Setup (PWA auf app2.ai-toolhub.org, API auf mcp2.ai-toolhub.org):
  // OAuth-State + Session + Refresh-Cookies muessen von beiden Subdomains
  // lesbar sein. setCookie ohne `domain` scoped sie auf den exact-host —
  // OAuth-Flow scheitert mit "missing oauth state cookie" wenn /start auf
  // app2 lief und /callback auf mcp2 ankommt.
  //
  // Setze auf `.ai-toolhub.org` in production (fuehrender Punkt!), leer
  // lassen in dev (localhost-Browser akzeptiert keine domain-Attribute).
  COOKIE_DOMAIN: z.string().default(''),

  // RS256 service-boundary keys (mcp-approval2 → mcp-knowledge2 JWTs).
  // PEM-encoded. PKCS#8 for the private half, SPKI for the public half.
  // Optional at the schema level — in dev/test we fall back to HS256 with a
  // warning; production deploys are expected to pre-flight that both are set.
  JWT_RS256_PRIVATE_KEY_PEM: z.string().optional(),
  JWT_RS256_PUBLIC_KEY_PEM: z.string().optional(),
  JWT_KID: z.string().optional(),

  // Pre-shared internal service-token used by mcp-knowledge2 (and other
  // first-party services) when calling /internal/v1/* on mcp-approval2.
  // Required when /internal/v1 routes are mounted; the bootstrap layer
  // refuses to mount them without it.
  MCP_APPROVAL_INTERNAL_TOKEN: z.string().min(32).optional(),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().url(),

  // WebAuthn / Passkey
  RP_ID: z.string().min(1).default('localhost'),
  RP_NAME: z.string().default('mcp-approval2'),
  RP_ORIGIN: z.string().url().default('http://localhost:8787'),

  // Multi-Origin Allowlist (CSV in env, parsed in-place).
  //
  // Hintergrund: derselbe Server hoert hinter mehreren Origins (z.B.
  // `https://mcp2.ai-toolhub.org` PLUS `https://static.X.X.X.X.clients.your-server.de`
  // als Coop-Zscaler-Bypass). WebAuthn ist Origin-bound — wir lesen pro Request
  // den eingehenden Origin, pruefen ihn gegen diese Allowlist, und leiten daraus
  // die RP-ID ab (siehe `resolveRpId()`/`resolveOrigin()` unten).
  //
  // Leerer Default = nur `RP_ORIGIN` ist erlaubt (Single-Domain-Setup).
  ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),

  // Invite / Recovery
  INVITE_TTL_SEC: z.coerce.number().int().positive().default(24 * 60 * 60),
  RECOVERY_TTL_SEC: z.coerce.number().int().positive().default(24 * 60 * 60),

  // ─────────────────────────────────────────────────────────────────────
  // AS-3: mcp-knowledge2 Proxy-Mode Anbindung
  // ─────────────────────────────────────────────────────────────────────
  // Plan-Ref: PLAN-as3-autonomous.md §1.7
  //
  // approval2 → KC2 ueber OBO-JWT (X-On-Behalf-Of) + statischer SERVICE_TOKEN
  // (Authorization: Bearer). Beide muessen gesetzt sein, damit der KC-Pfad
  // (kc-proxy, kc_wrappers) gemounted wird. Sonst laeuft approval2 ohne
  // KC-Anbindung (Native-Tools + Sub-MCP-Gateways verfuegbar).
  //
  // SELF_OAUTH_ISSUER ist der `iss`-Claim in den OBO-JWTs die wir an KC2
  // senden. KC2 verifiziert via JWKS-Lookup auf <SELF_OAUTH_ISSUER>/.well-known/jwks.json.
  // Default fallback: config.ORIGIN.
  MCP_KNOWLEDGE_URL: z.string().url().optional(),
  MCP_KNOWLEDGE_SERVICE_TOKEN: z.string().min(32).optional(),
  SELF_OAUTH_ISSUER: z.string().url().optional(),

  // ─────────────────────────────────────────────────────────────────────
  // AS-3: Google OIDC (Authoritative IdP)
  // ─────────────────────────────────────────────────────────────────────
  // Die existierenden GOOGLE_CLIENT_ID / _SECRET / _REDIRECT_URI sind die
  // PWA-Front-Door-OAuth-App.
  //
  // GOOGLE_ALLOWED_AUDIENCES: optional Komma-Liste zusaetzlicher Google-
  // Audiences die approval2 fuer inbound `verifyIdToken` akzeptiert (z.B.
  // KC2's eigener GOOGLE_CLIENT_ID, fuer den Fall dass eine PWA aus KC2's
  // Domain an approval2 ein Google-ID-Token weiterreicht). Default: nur
  // GOOGLE_CLIENT_ID.
  GOOGLE_ALLOWED_AUDIENCES: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),

  // ─────────────────────────────────────────────────────────────────────
  // OAuth 2.1 DCR (SEC-005)
  // ─────────────────────────────────────────────────────────────────────
  //
  // POST /oauth/register ist per Default geschlossen (fail-closed). Operator
  // muss EINEN der zwei Gating-Mechanismen oeffnen:
  //
  //   DCR_OPEN=true                       — komplett offen (NICHT empfohlen
  //                                          ausser fuer dev/test).
  //   DCR_INITIAL_ACCESS_TOKEN=<32+ chars> — Bearer-Token, das DCR-Caller im
  //                                          `Authorization`-Header mitschicken
  //                                          muessen (RFC 7591 §3).
  //
  // Wenn weder noch + kein logged-in-User-Session: 403. Wenn ein User
  // eingeloggt ist (Cookie oder Bearer) wird DCR auch ohne Token erlaubt —
  // damit Claude-Code-PWA-User selber Client registrieren kann.
  DCR_OPEN: z
    .string()
    .default('false')
    .transform((s) => s.toLowerCase() === 'true' || s === '1'),
  DCR_INITIAL_ACCESS_TOKEN: z.string().min(32).optional(),

  // Allowlist fuer redirect_uri Hosts. CSV. Leerer Default = beliebige Hosts
  // erlaubt (nur Scheme-Check via RFC). Setze auf z.B.
  // `claude.ai,localhost,127.0.0.1` um die Surface auf bekannte MCP-Clients
  // zu beschraenken.
  DCR_ALLOWED_REDIRECT_HOSTS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ),

  // SEC-008: First-Login-Bootstrap Email-Gate. Wenn gesetzt, MUSS die erste
  // Google-Login-Email exact-match (case-insensitive). Ohne diese Variable
  // gilt die alte "First-to-login wird admin"-Regel — anfaellig gegen Race-
  // Attacks zwischen Deploy-T+0 und erstem Operator-Login.
  // STRONGLY RECOMMENDED in Production zu setzen.
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Multi-Origin Helpers.
//
// Beim Multi-Domain-Setup (PLAN-architecture-v1.md §3.4 Multi-Origin) hoert
// derselbe Server unter mehreren Origins. Wir lesen pro Request den `Origin`-
// bzw. `Host`-Header, validieren ihn gegen `ALLOWED_ORIGINS` (Anti-Spoofing)
// und leiten daraus RP-ID + RP-Origin fuer WebAuthn ab.
//
// Aufruf-Pattern in Handlern:
//   const origin = resolveOrigin(request, config);
//   const rpId   = resolveRpId(origin);
//   beginRegistration({ ...config, RP_ID: rpId, RP_ORIGIN: origin }, input);
//
// Achtung: WebAuthn ist Origin-bound. Ein Passkey, der unter Origin A enrolled
// wurde, funktioniert NICHT unter Origin B. Pro Origin braucht der User einen
// separaten Passkey, die zum selben Account verlinkt sind (siehe
// docs/runbooks/runbook-coop-bypass.md).
// ---------------------------------------------------------------------------

/**
 * Liest den Origin aus einem HTTP-Request (Hono / Fetch-Request kompatibel)
 * und prueft ihn gegen `config.ALLOWED_ORIGINS`. Fallback auf `config.RP_ORIGIN`
 * wenn:
 *   - der Header fehlt,
 *   - der Origin nicht in der Allowlist ist (Anti-Host-Header-Spoofing),
 *   - `ALLOWED_ORIGINS` leer ist (Single-Domain-Setup).
 */
export function resolveOrigin(
  request: { headers: { get(name: string): string | null } },
  config: AppConfig,
): string {
  const allow = config.ALLOWED_ORIGINS;
  // Bevorzugt `Origin` (browser-set, von WebAuthn benutzt); Fallback auf
  // `Host` + Protokoll-Annahme. Wir greifen NICHT auf `request.url` zurueck —
  // hinter Caddy zeigt das auf den internen Container-Port.
  const originHdr = request.headers.get('origin');
  if (originHdr && (allow.length === 0 || allow.includes(originHdr))) {
    return originHdr;
  }
  const host = request.headers.get('host');
  if (host) {
    const candidate = `https://${host}`;
    if (allow.includes(candidate)) {
      return candidate;
    }
  }
  return config.RP_ORIGIN;
}

/**
 * Extrahiert die WebAuthn-RP-ID (eTLD+1-Host) aus einem Origin-URL-String.
 * Beispiel: `https://mcp2.ai-toolhub.org` -> `mcp2.ai-toolhub.org`.
 */
export function resolveRpId(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    // Kein gueltiger URL -> behandle als Hostname-String direkt.
    return origin;
  }
}
