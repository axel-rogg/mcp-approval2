/**
 * JIT-Credential-Resolver — wrappt POST /internal/v1/credentials/resolve.
 *
 * Plan-Ref: docs/migration/sub-mcp-server-migration-guide.md §1 Phase 3.
 *
 * Jeder Tool-Call, der ein Provider-Credential braucht (Google-OAuth-Token,
 * GitHub-PAT, Cloudflare-API-Key, ...), holt es JIT ueber diesen Helper.
 * Das Ergebnis ist request-scoped — NICHT cachen, NICHT loggen.
 *
 * Errors werden in `CredentialResolveError` gewrappt damit Tool-Code sie als
 * einfache try/catch behandeln kann. PRF-required (428) wird separat
 * gemeldet — der Tool-Layer kann dem User dann einen
 * "bitte erst in der PWA approven"-Hinweis zeigen, ohne den Tool-Call
 * als 5xx zu markieren.
 */
import type { Context } from 'hono';
import { getUserContext, type SubMcpBindings } from './auth.js';

export interface ResolveCredentialArgs {
  /**
   * Provider-Identifier wie in mcp-approval2's `credentials.provider`-Spalte.
   * Bekannte Werte: `google-workspace`, `github`, `cloudflare`, `gcp`.
   */
  readonly provider: string;
  /** Optional: Label/Account-Selector. Default `'default'`. */
  readonly label?: string;
  /**
   * Optional: PRF-Session-ID falls der User in der PWA approved hat. Wenn der
   * Credential PRF-locked ist und das hier fehlt → 428.
   */
  readonly prfSessionId?: string;
}

export interface ResolvedCredential {
  readonly accessToken: string;
  readonly expiresAt: number | null;
}

export class CredentialResolveError extends Error {
  public readonly status: number;
  public readonly code: 'service_auth' | 'jwt_invalid' | 'not_found' | 'prf_required' | 'upstream';
  constructor(status: number, code: CredentialResolveError['code'], message: string) {
    super(message);
    this.name = 'CredentialResolveError';
    this.status = status;
    this.code = code;
  }
}

interface ResolveResponseOk {
  readonly access_token: string;
  readonly token_type?: string;
  readonly expires_at?: number | null;
}

interface ResolveResponseErr {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
}

/**
 * Ruft `POST {MCP_APPROVAL_BASE_URL}/internal/v1/credentials/resolve`.
 *
 * Liest:
 *   c.env.SERVICE_TOKEN          (Schicht-1-Auth zu mcp-approval2)
 *   c.env.MCP_APPROVAL_BASE_URL
 *   c.env.SUB_MCP_NAME
 *   c.get('userJwt')             (von der Auth-Middleware gesetzt)
 *
 * Wirft `CredentialResolveError` bei jedem nicht-200-Pfad.
 */
export async function resolveCredential(
  c: Context<SubMcpBindings>,
  args: ResolveCredentialArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedCredential> {
  const { userJwt } = getUserContext(c);
  const env = c.env;
  const url = `${env.MCP_APPROVAL_BASE_URL.replace(/\/+$/, '')}/internal/v1/credentials/resolve`;

  const body: Record<string, unknown> = {
    user_jwt: userJwt,
    provider: args.provider,
    sub_mcp_name: env.SUB_MCP_NAME,
  };
  if (args.label) body['label'] = args.label;
  if (args.prfSessionId) body['prf_session_id'] = args.prfSessionId;

  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'X-Service-Token': env.SERVICE_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'fetch failed';
    throw new CredentialResolveError(0, 'upstream', `network error: ${msg}`);
  }

  if (resp.status === 200) {
    const data = (await resp.json()) as ResolveResponseOk;
    if (!data.access_token) {
      throw new CredentialResolveError(502, 'upstream', 'response missing access_token');
    }
    return {
      accessToken: data.access_token,
      expiresAt: data.expires_at ?? null,
    };
  }

  // Strukturierte Errors. Wir versuchen den Body zu parsen — falls fehlschlaegt
  // fallback auf Generic-Message.
  let errCode: string | undefined;
  let errMsg: string | undefined;
  try {
    const data = (await resp.json()) as ResolveResponseErr;
    errCode = data.error?.code;
    errMsg = data.error?.message;
  } catch {
    // ignore
  }

  if (resp.status === 401) {
    throw new CredentialResolveError(
      401,
      errCode === 'jwt_invalid' ? 'jwt_invalid' : 'service_auth',
      errMsg ?? 'auth to mcp-approval2 failed',
    );
  }
  if (resp.status === 404) {
    throw new CredentialResolveError(404, 'not_found', errMsg ?? 'credential not found');
  }
  if (resp.status === 428 || errCode === 'prf_required') {
    throw new CredentialResolveError(
      428,
      'prf_required',
      errMsg ?? 'credential requires WebAuthn-PRF — user must approve in PWA',
    );
  }
  throw new CredentialResolveError(
    resp.status || 502,
    'upstream',
    errMsg ?? `unexpected status ${resp.status}`,
  );
}
