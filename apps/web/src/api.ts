/**
 * Typed fetch-Client zu mcp-approval2-API.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3 (Auth), §5 (Credentials).
 *
 * Same-origin: PWA wird unter demselben Host wie der Hono-Server ausgeliefert
 * (Custom-Domain), Cookies sind `SameSite=Lax`. Im Dev-Server proxyt Vite die
 * `/auth/*`, `/v1/*`, `/oauth/*` Pfade an :8787 (siehe vite.config.ts).
 *
 * Error-Handling: Server liefert `{ error: { code, message, details? } }` mit
 * HTTP-Status. Wir parsen das in `ApiError`.
 */

export type CredentialKind = 'oauth_refresh' | 'api_token' | 'password' | 'service_account';

export interface Session {
  readonly userId: string;
  readonly email: string;
  readonly role: 'admin' | 'member';
  readonly sessionId: string;
  readonly expiresAt: number;
}

export interface PendingApproval {
  readonly id: string;
  readonly toolName: string;
  readonly sensitivity: 'write' | 'danger';
  readonly displayTemplate?: string;
  readonly input: Record<string, unknown>;
  readonly requestedAt: number;
  readonly status: 'pending' | 'approved' | 'rejected' | 'executing' | 'completed' | 'expired';
  readonly requiresPrf?: boolean;
  readonly allowCredentialIdsB64?: ReadonlyArray<string>;
  readonly challengeB64?: string;
}

export interface CredentialMeta {
  readonly id: string;
  readonly ownerId: string;
  readonly provider: string;
  readonly kind: CredentialKind;
  readonly label: string;
  readonly prfEnabled: boolean;
  readonly prfCredentialIdB64: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly createdAt: number;
  readonly rotatedAt: number | null;
  readonly lastUsedAt: number | null;
  readonly expiresAt: number | null;
}

export interface ApiClient {
  // Auth
  getSession(): Promise<Session | null>;
  logout(): Promise<void>;

  // Approvals
  listApprovals(args?: { status?: 'pending' | 'approved' | 'rejected' }): Promise<PendingApproval[]>;
  getApproval(id: string): Promise<PendingApproval>;
  approveApproval(args: { id: string; signature: string; prfSessionId?: string }): Promise<void>;
  rejectApproval(args: { id: string; reason?: string }): Promise<void>;
  pollResult(approvalId: string): Promise<unknown>;
  getApprovalChallenge(id: string): Promise<{ challengeB64: string; allowCredentialIdsB64: string[] }>;

  // Credentials
  listCredentials(): Promise<CredentialMeta[]>;
  addCredential(args: {
    provider: string;
    kind: CredentialKind;
    label: string;
    secret: string;
    prfSessionId?: string;
  }): Promise<CredentialMeta>;
  deleteCredential(id: string): Promise<void>;
  storePrfSession(args: { prfOutput: string; ttlSec?: number }): Promise<{ sessionId: string }>;
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface ServerError {
  readonly error?: { readonly code?: string; readonly message?: string; readonly details?: unknown };
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) {
    // Empty body — some 204-style routes
    if (res.ok) return undefined as T;
    throw new ApiError(res.status, 'http_error', `HTTP ${res.status}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(res.status, 'invalid_json', `Non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const err = (body as ServerError).error;
    throw new ApiError(
      res.status,
      err?.code ?? 'http_error',
      err?.message ?? `HTTP ${res.status}`,
      err?.details,
    );
  }
  return body as T;
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  readonly body?: unknown;
  readonly query?: Record<string, string | undefined>;
}

function buildUrl(base: string, path: string, query?: Record<string, string | undefined>): string {
  const u = new URL(path, base.endsWith('/') ? base : `${base}/`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) u.searchParams.set(k, v);
    }
  }
  return u.toString();
}

export function createApiClient(baseUrl?: string): ApiClient {
  const base = baseUrl ?? (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8787');

  async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
    };
    if (opts.body !== undefined) {
      init.headers = { ...init.headers, 'content-type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(buildUrl(base, path, opts.query), init);
    return parseJson<T>(res);
  }

  return {
    async getSession() {
      try {
        // Backend has no canonical /auth/me yet — use refresh to introspect.
        // If refresh fails (no cookie / invalid), session is null.
        const res = await fetch(buildUrl(base, '/auth/refresh'), {
          method: 'POST',
          credentials: 'include',
          headers: { accept: 'application/json' },
        });
        if (res.status === 401) return null;
        if (!res.ok) return null;
        const body = (await res.json()) as {
          accessToken: string;
          expiresAt: number;
          sessionId: string;
          user?: { id: string; email: string; role: 'admin' | 'member' };
        };
        // The current /auth/refresh shape does not include user-info; derive
        // a minimal Session record. If the backend later attaches user{} we
        // surface it verbatim.
        if (body.user) {
          return {
            userId: body.user.id,
            email: body.user.email,
            role: body.user.role,
            sessionId: body.sessionId,
            expiresAt: body.expiresAt,
          };
        }
        return {
          userId: '',
          email: '',
          role: 'member' as const,
          sessionId: body.sessionId,
          expiresAt: body.expiresAt,
        };
      } catch {
        return null;
      }
    },

    async logout() {
      await request<{ ok: true }>('/auth/logout', { method: 'POST' });
    },

    async listApprovals(args) {
      const out = await request<{ items: PendingApproval[] }>('/v1/approvals/pending', {
        ...(args?.status ? { query: { status: args.status } } : {}),
      });
      return out.items;
    },

    async getApproval(id) {
      const out = await request<{ item: PendingApproval }>(`/v1/approvals/${encodeURIComponent(id)}`);
      return out.item;
    },

    async getApprovalChallenge(id) {
      return request<{ challengeB64: string; allowCredentialIdsB64: string[] }>(
        `/v1/approvals/${encodeURIComponent(id)}/challenge`,
        { method: 'POST' },
      );
    },

    async approveApproval(args) {
      await request<{ ok: true }>(`/v1/approvals/${encodeURIComponent(args.id)}/sign`, {
        method: 'POST',
        body: {
          signature: args.signature,
          ...(args.prfSessionId ? { prfSessionId: args.prfSessionId } : {}),
        },
      });
    },

    async rejectApproval(args) {
      await request<{ ok: true }>(`/v1/approvals/${encodeURIComponent(args.id)}/reject`, {
        method: 'POST',
        body: args.reason ? { reason: args.reason } : undefined,
      });
    },

    async pollResult(approvalId) {
      const out = await request<{ result?: unknown; status: string }>(
        `/v1/approvals/${encodeURIComponent(approvalId)}/result`,
      );
      return out.result;
    },

    async listCredentials() {
      const out = await request<{ credentials: CredentialMeta[] }>('/v1/credentials');
      return out.credentials;
    },

    async addCredential(args) {
      const out = await request<{ credential: CredentialMeta }>('/v1/credentials', {
        method: 'POST',
        body: {
          provider: args.provider,
          kind: args.kind,
          label: args.label,
          secret: args.secret,
          ...(args.prfSessionId ? { prfSessionId: args.prfSessionId } : {}),
        },
      });
      return out.credential;
    },

    async deleteCredential(id) {
      await request<{ ok: true }>(`/v1/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    async storePrfSession(args) {
      const out = await request<{ prfSessionId: string; ttlSec: number }>(
        '/v1/credentials/prf-session',
        {
          method: 'POST',
          body: {
            prfOutputB64: args.prfOutput,
            ...(args.ttlSec !== undefined ? { ttlSec: args.ttlSec } : {}),
          },
        },
      );
      return { sessionId: out.prfSessionId };
    },
  };
}
