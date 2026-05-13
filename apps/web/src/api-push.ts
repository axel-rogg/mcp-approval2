/**
 * Typed fetch-Client fuer das /v1/push/* Subset.
 *
 * Plan-Ref: PLAN-architecture-v1.md §7 (Notification-Surface) + Burst 7 (PWA).
 *
 * Same-origin: identisch zu api.ts — credentials: 'include' fuer die
 * Session-Cookie, base auf `window.location.origin`.
 */

export interface VapidPublicKey {
  readonly publicKey: string;
}

export interface SubscribePushArgs {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly userAgent?: string;
}

export interface PushSubscriptionMeta {
  readonly id: string;
  readonly endpoint_prefix: string;
  readonly user_agent: string | null;
  readonly created_at: number;
  readonly last_used_at: number | null;
}

export interface ApiPushClient {
  getVapidPublicKey(): Promise<VapidPublicKey>;
  subscribePush(args: SubscribePushArgs): Promise<{ id: string }>;
  unsubscribePush(subscriptionId: string): Promise<void>;
  listSubscriptions(): Promise<PushSubscriptionMeta[]>;
  testPush(args?: { title?: string; body?: string }): Promise<{ sent: number; failed: number }>;
}

export class ApiPushError extends Error {
  public readonly status: number;
  public readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface ServerError {
  readonly error?: { readonly code?: string; readonly message?: string };
}

function buildUrl(base: string, path: string): string {
  return new URL(path, base.endsWith('/') ? base : `${base}/`).toString();
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) {
    if (res.ok) return undefined as T;
    throw new ApiPushError(res.status, 'http_error', `HTTP ${res.status}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiPushError(res.status, 'invalid_json', `Non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const err = (body as ServerError).error;
    throw new ApiPushError(
      res.status,
      err?.code ?? 'http_error',
      err?.message ?? `HTTP ${res.status}`,
    );
  }
  return body as T;
}

export function createApiPushClient(baseUrl?: string): ApiPushClient {
  const base =
    baseUrl ?? (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8787');

  async function request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    const res = await fetch(buildUrl(base, path), {
      ...init,
      credentials: 'include',
      headers,
    });
    return parseJson<T>(res);
  }

  return {
    async getVapidPublicKey() {
      return request<VapidPublicKey>('/v1/push/vapid');
    },

    async subscribePush(args) {
      const body: Record<string, unknown> = {
        endpoint: args.endpoint,
        keys: { p256dh: args.p256dh, auth: args.auth },
      };
      if (args.userAgent !== undefined) body['userAgent'] = args.userAgent;
      return request<{ id: string }>('/v1/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    },

    async unsubscribePush(subscriptionId) {
      await request<{ ok: true }>('/v1/push/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscriptionId }),
      });
    },

    async listSubscriptions() {
      const out = await request<{ subscriptions: PushSubscriptionMeta[] }>(
        '/v1/push/subscriptions',
      );
      return out.subscriptions;
    },

    async testPush(args) {
      return request<{ sent: number; failed: number }>('/v1/push/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args ?? {}),
      });
    },
  };
}
