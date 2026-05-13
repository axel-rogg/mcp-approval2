/**
 * Fetch-Client fuer Tool-Defaults (Prefs).
 *
 * Plan-Ref: docs/plans/done/PLAN-prefs.md (Burst 3 + 7).
 *
 * Backend-Surface (alle Routen cookie-authed, same-origin):
 *   GET    /v1/prefs                          → { defaults: ToolDefault[] }
 *   POST   /v1/prefs                          body: { toolName, field, value, scope? }
 *   DELETE /v1/prefs/:toolName/:field?scope=  → 204
 *
 * Write-Operationen (set/remove) gehen serverseitig via Approval-Gate wenn
 * sie ueber die MCP-Tools `prefs.set` / `prefs.remove` laufen. Die PWA-Surface
 * ist nach `auth/google`-Front-Door bereits authentifiziert und kann direkt
 * schreiben (analog zu mcp-approval `/admin/prefs/*`).
 *
 * Falls Backend die HTTP-Routen noch nicht montiert hat, propagiert
 * `ApiPrefsError` mit Status 404 — die UI zeigt das im Fehlerstatus.
 */
import { ApiError } from './api.js';

export type PrefScope = 'user' | 'tenant' | 'session';

export interface ToolDefault {
  readonly toolName: string;
  readonly field: string;
  readonly value: unknown;
  readonly scope: PrefScope;
}

export interface ListPrefsArgs {
  readonly toolName?: string;
  readonly field?: string;
}

export interface SetPrefArgs {
  readonly toolName: string;
  readonly field: string;
  readonly value: unknown;
  readonly scope?: PrefScope;
}

export interface RemovePrefArgs {
  readonly toolName: string;
  readonly field: string;
  readonly scope?: PrefScope;
}

export interface ApiPrefsClient {
  listPrefs(args?: ListPrefsArgs): Promise<ToolDefault[]>;
  setPref(args: SetPrefArgs): Promise<void>;
  removePref(args: RemovePrefArgs): Promise<void>;
}

interface ServerError {
  readonly error?: { readonly code?: string; readonly message?: string; readonly details?: unknown };
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

function buildUrl(base: string, path: string, query?: Record<string, string | undefined>): string {
  const u = new URL(path, base.endsWith('/') ? base : `${base}/`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) u.searchParams.set(k, v);
    }
  }
  return u.toString();
}

export function createApiPrefsClient(baseUrl?: string): ApiPrefsClient {
  const base =
    baseUrl ?? (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8787');

  async function request<T>(
    path: string,
    opts: {
      method?: 'GET' | 'POST' | 'DELETE';
      body?: unknown;
      query?: Record<string, string | undefined>;
    } = {},
  ): Promise<T> {
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
    async listPrefs(args) {
      const query: Record<string, string | undefined> = {};
      if (args?.toolName) query['toolName'] = args.toolName;
      if (args?.field) query['field'] = args.field;
      const out = await request<{ defaults: ToolDefault[] }>('/v1/prefs', { query });
      return out.defaults ?? [];
    },

    async setPref(args) {
      const body: Record<string, unknown> = {
        toolName: args.toolName,
        field: args.field,
        value: args.value,
      };
      if (args.scope) body['scope'] = args.scope;
      await request<{ ok: true }>('/v1/prefs', { method: 'POST', body });
    },

    async removePref(args) {
      const query: Record<string, string | undefined> = {};
      if (args.scope) query['scope'] = args.scope;
      const path = `/v1/prefs/${encodeURIComponent(args.toolName)}/${encodeURIComponent(args.field)}`;
      await request<{ ok: true }>(path, { method: 'DELETE', query });
    },
  };
}
