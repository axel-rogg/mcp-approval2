/**
 * Typed fetch-Client fuer die Apps-API (/v1/apps/*).
 *
 * Separate Datei statt Erweiterung von api.ts: api.ts ist der "Stable Core"
 * (Auth + Approvals + Credentials), Apps-API ist Feature-spezifisch.
 *
 * Backend-Routen (apps/server/src/routes/apps.ts):
 *   POST   /v1/apps                 — create
 *   GET    /v1/apps                 — list
 *   GET    /v1/apps/:id             — read (state + layout)
 *   PATCH  /v1/apps/:id/state       — update_state (CAS via expectedVersion)
 *   DELETE /v1/apps/:id             — delete
 *   POST   /v1/apps/:id/invoke      — invoke block action
 *   POST   /v1/apps/:id/query       — read-only query
 *   PATCH  /v1/apps/:id/layout      — update_layout
 */
import { ApiError } from './api.js';
import { authedFetch } from './auth-token.js';

export interface LayoutComponent {
  readonly id: string;
  readonly block: string;
  readonly config?: Record<string, unknown>;
}

export interface LayoutDoc {
  readonly version: 'v0.10';
  readonly components: ReadonlyArray<LayoutComponent>;
  readonly state: Record<string, unknown>;
  readonly meta?: Record<string, unknown>;
}

export interface AppInstance {
  readonly id: string;
  readonly userId: string;
  readonly type: string;
  readonly title: string;
  readonly state_version: number;
  readonly schema_version: number;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly created_at: number;
  readonly updated_at: number;
  readonly last_used_at: number | null;
}

export interface AppRead {
  readonly app: AppInstance;
  readonly state: unknown;
}

export interface InvokeResult {
  readonly app: AppInstance;
  readonly new_version: number;
  readonly result: unknown;
  readonly patches: ReadonlyArray<{ readonly path: string; readonly value: unknown }>;
}

export interface ApiAppsClient {
  listApps(args?: { type?: string; limit?: number }): Promise<AppInstance[]>;
  getApp(id: string): Promise<AppRead>;
  createApp(args: {
    appType: string;
    slug?: string;
    title?: string;
    initialState?: unknown;
    summary?: string;
  }): Promise<AppInstance>;
  deleteApp(id: string): Promise<void>;
  invoke(args: {
    id: string;
    block_id: string;
    action: string;
    payload?: Record<string, unknown>;
  }): Promise<InvokeResult>;
  query(args: {
    id: string;
    block_id: string;
    query: string;
    args?: Record<string, unknown>;
  }): Promise<unknown>;
  updateState(args: {
    id: string;
    expectedVersion: number;
    newState: unknown;
  }): Promise<AppInstance>;
  updateLayout(args: {
    id: string;
    expectedVersion: number;
    layoutDoc: LayoutDoc;
  }): Promise<AppInstance>;
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) {
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
    const err = (body as { error?: { code?: string; message?: string; details?: unknown } }).error;
    throw new ApiError(
      res.status,
      err?.code ?? 'http_error',
      err?.message ?? `HTTP ${res.status}`,
      err?.details,
    );
  }
  return body as T;
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

export function createApiAppsClient(baseUrl?: string): ApiAppsClient {
  const base =
    baseUrl ?? (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8787');

  async function request<T>(
    path: string,
    opts: {
      method?: 'GET' | 'POST' | 'DELETE' | 'PATCH';
      body?: unknown;
      query?: Record<string, string | undefined>;
    } = {},
  ): Promise<T> {
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      headers: { accept: 'application/json' },
    };
    if (opts.body !== undefined) {
      init.headers = { ...init.headers, 'content-type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }
    // authedFetch haengt Authorization: Bearer <token> dran, macht bei 401
    // einen Refresh-Versuch + Retry. Token kommt aus shared auth-token-store
    // (befuellt von api.ts beim ersten /auth/refresh).
    const res = await authedFetch(buildUrl(base, path, opts.query), init, base);
    return parseJson<T>(res);
  }

  return {
    async listApps(args) {
      const query: Record<string, string | undefined> = {};
      if (args?.type !== undefined) query['type'] = args.type;
      if (args?.limit !== undefined) query['limit'] = String(args.limit);
      const out = await request<{ items: AppInstance[]; count: number }>('/v1/apps', { query });
      return out.items;
    },

    async getApp(id) {
      return request<AppRead>(`/v1/apps/${encodeURIComponent(id)}`);
    },

    async createApp(args) {
      const body: Record<string, unknown> = { appType: args.appType };
      if (args.slug !== undefined) body['slug'] = args.slug;
      if (args.title !== undefined) body['title'] = args.title;
      if (args.initialState !== undefined) body['initialState'] = args.initialState;
      if (args.summary !== undefined) body['summary'] = args.summary;
      const out = await request<{ app: AppInstance }>('/v1/apps', { method: 'POST', body });
      return out.app;
    },

    async deleteApp(id) {
      await request<{ ok: true; deleted: string }>(`/v1/apps/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },

    async invoke(args) {
      return request<InvokeResult>(`/v1/apps/${encodeURIComponent(args.id)}/invoke`, {
        method: 'POST',
        body: {
          block_id: args.block_id,
          action: args.action,
          payload: args.payload ?? {},
        },
      });
    },

    async query(args) {
      const out = await request<{ value: unknown }>(
        `/v1/apps/${encodeURIComponent(args.id)}/query`,
        {
          method: 'POST',
          body: {
            block_id: args.block_id,
            query: args.query,
            ...(args.args !== undefined ? { args: args.args } : {}),
          },
        },
      );
      return out.value;
    },

    async updateState(args) {
      const out = await request<{ app: AppInstance; new_version: number }>(
        `/v1/apps/${encodeURIComponent(args.id)}/state`,
        {
          method: 'PATCH',
          body: { expectedVersion: args.expectedVersion, newState: args.newState },
        },
      );
      return out.app;
    },

    async updateLayout(args) {
      const out = await request<{ app: AppInstance; new_version: number }>(
        `/v1/apps/${encodeURIComponent(args.id)}/layout`,
        {
          method: 'PATCH',
          body: { expectedVersion: args.expectedVersion, layoutDoc: args.layoutDoc },
        },
      );
      return out.app;
    },
  };
}
