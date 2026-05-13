/**
 * OpenBao / Vault authentication strategies.
 *
 * Two implementations:
 *   - StaticTokenAuth: dev/test/bootstrap path. The token is supplied by
 *     the caller and used verbatim. No renewal.
 *   - AppRoleAuth: production path. Logs in with role_id + secret_id,
 *     caches the resulting client_token, and refreshes before lease
 *     expiry. Self-renewal (POST /v1/auth/token/renew-self) is attempted
 *     when the lease is renewable; on failure we fall back to a fresh
 *     login.
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §5.2.
 */

import type {
  AppRoleLoginResponse,
  HttpFailure,
  TokenRenewResponse,
  VaultErrorBody,
} from './openbao-types.js';

/**
 * Authentication strategy. The provider calls `getToken()` before every
 * Vault request. Implementations are responsible for caching + renewal.
 */
export interface OpenBaoAuth {
  /** Returns a currently-valid Vault client token. */
  getToken(): Promise<string>;
  /**
   * Force-invalidates any cached token. Called by the provider after a
   * 403 so the next request triggers a fresh login.
   */
  invalidate(): void;
}

/**
 * Trivial pass-through: always returns the same token. Used for tests,
 * for the legacy `VAULT_TOKEN` env-var bootstrap path, and as the inner
 * helper when an upstream service already produced a token.
 */
export class StaticTokenAuth implements OpenBaoAuth {
  public constructor(private readonly token: string) {
    if (!token) {
      throw new Error('StaticTokenAuth: token must be non-empty');
    }
  }

  public async getToken(): Promise<string> {
    return this.token;
  }

  public invalidate(): void {
    // No-op — a static token cannot be refreshed.
  }
}

export interface AppRoleAuthOptions {
  readonly addr: string;
  readonly roleId: string;
  readonly secretId: string;
  /**
   * Skew applied to the lease_duration when scheduling renewal.
   * Default: 60s. We refresh before the lease elapses by this margin.
   */
  readonly renewSkewSeconds?: number;
  /**
   * Mount path of the approle auth backend. Default: `approle`.
   */
  readonly mountPath?: string;
  /** Injected fetch (tests). Default: globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Clock source. Default: `Date.now`. Tests override this to drive
   * cache-expiry deterministically.
   */
  readonly now?: () => number;
}

interface CachedToken {
  readonly token: string;
  /** Unix-ms when this cached token must be replaced. */
  readonly expiresAt: number;
  /** Whether Vault marked the lease as renewable. */
  readonly renewable: boolean;
}

/**
 * AppRole-based auth. Caches the client_token in-memory; renews via
 * `/auth/token/renew-self` before expiry. On any auth failure we drop
 * the cache and re-login.
 */
export class AppRoleAuth implements OpenBaoAuth {
  private readonly addr: string;
  private readonly roleId: string;
  private readonly secretId: string;
  private readonly renewSkewSeconds: number;
  private readonly mountPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private cached: CachedToken | null = null;
  /** De-duplicates concurrent login/renew attempts. */
  private inFlight: Promise<string> | null = null;

  public constructor(opts: AppRoleAuthOptions) {
    if (!opts.addr) throw new Error('AppRoleAuth: addr is required');
    if (!opts.roleId) throw new Error('AppRoleAuth: roleId is required');
    if (!opts.secretId) throw new Error('AppRoleAuth: secretId is required');
    this.addr = stripTrailingSlash(opts.addr);
    this.roleId = opts.roleId;
    this.secretId = opts.secretId;
    this.renewSkewSeconds = opts.renewSkewSeconds ?? 60;
    this.mountPath = opts.mountPath ?? 'approle';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  public async getToken(): Promise<string> {
    const cached = this.cached;
    if (cached && cached.expiresAt > this.now()) {
      return cached.token;
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.acquireToken().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  public invalidate(): void {
    this.cached = null;
  }

  /**
   * Acquire a fresh token. If we already have a renewable cached token,
   * try `renew-self` first; otherwise (or on renew failure) do a full
   * login.
   */
  private async acquireToken(): Promise<string> {
    const prev = this.cached;
    if (prev && prev.renewable) {
      try {
        const renewed = await this.renewSelf(prev.token);
        this.cached = renewed;
        return renewed.token;
      } catch {
        // Renew failed (token expired, network blip, lease past max_ttl).
        // Fall through to a fresh login.
        this.cached = null;
      }
    }
    const fresh = await this.login();
    this.cached = fresh;
    return fresh.token;
  }

  private async login(): Promise<CachedToken> {
    const url = `${this.addr}/v1/auth/${this.mountPath}/login`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role_id: this.roleId, secret_id: this.secretId }),
    });
    if (!res.ok) {
      const failure = await readFailure(res);
      throw new VaultAuthError(
        `AppRole login failed (${failure.status}): ${failure.errors.join('; ') || 'unknown'}`,
        failure,
      );
    }
    const body = (await res.json()) as AppRoleLoginResponse;
    if (!body?.auth?.client_token) {
      throw new VaultAuthError('AppRole login: response missing auth.client_token', {
        status: res.status,
        errors: [],
        rawBody: JSON.stringify(body),
      });
    }
    return this.toCached(body.auth.client_token, body.auth.lease_duration, body.auth.renewable);
  }

  private async renewSelf(token: string): Promise<CachedToken> {
    const url = `${this.addr}/v1/auth/token/renew-self`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vault-token': token },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const failure = await readFailure(res);
      throw new VaultAuthError(
        `Token renew-self failed (${failure.status}): ${failure.errors.join('; ') || 'unknown'}`,
        failure,
      );
    }
    const body = (await res.json()) as TokenRenewResponse;
    if (!body?.auth?.client_token) {
      throw new VaultAuthError('renew-self: response missing auth.client_token', {
        status: res.status,
        errors: [],
        rawBody: JSON.stringify(body),
      });
    }
    return this.toCached(body.auth.client_token, body.auth.lease_duration, body.auth.renewable);
  }

  private toCached(token: string, leaseDuration: number, renewable: boolean): CachedToken {
    // Apply skew but never go negative. A 0/1 second lease (some test
    // setups) gets one renewal-window of half the lease.
    const skewMs = this.renewSkewSeconds * 1000;
    const leaseMs = Math.max(0, leaseDuration * 1000);
    const usable = leaseMs > skewMs ? leaseMs - skewMs : Math.max(0, Math.floor(leaseMs / 2));
    return {
      token,
      expiresAt: this.now() + usable,
      renewable,
    };
  }
}

/** Reads a failed Vault response body and parses the standard error shape. */
async function readFailure(res: Response): Promise<HttpFailure> {
  let raw = '';
  try {
    raw = await res.text();
  } catch {
    raw = '';
  }
  let errors: readonly string[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as VaultErrorBody;
      if (Array.isArray(parsed?.errors)) {
        errors = parsed.errors.filter((e): e is string => typeof e === 'string');
      }
    } catch {
      // Not JSON — keep raw body for debugging.
    }
  }
  return { status: res.status, errors, rawBody: raw };
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * Thrown when the AppRole flow itself fails. Distinct from
 * `KekPermissionError` because the failure isn't tied to a specific
 * KEK ref.
 */
export class VaultAuthError extends Error {
  public readonly status: number;
  public readonly errors: readonly string[];
  public readonly rawBody: string;

  public constructor(message: string, failure: HttpFailure) {
    super(message);
    this.name = 'VaultAuthError';
    this.status = failure.status;
    this.errors = failure.errors;
    this.rawBody = failure.rawBody;
  }
}

// Re-export the helper for the provider so it doesn't duplicate the parser.
export { readFailure as _readFailure };
