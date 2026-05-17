/**
 * Typed Fetch-Client für Storage-Tab.
 *
 * Backend-Routen:
 *   GET    /v1/knowledge/objects?subtype=&q=&limit=&cursor=&embedded=
 *   GET    /v1/knowledge/objects/<id>?expand=body,refs,tags,summary
 *   DELETE /v1/knowledge/objects/<id>?force=1                  → Approval-Request
 *   PATCH  /v1/knowledge/objects/<id>     { summary: string }  → Approval-Request
 *
 * Mutating Calls antworten mit `{ approvalId: string }`; der eigentliche Write
 * passiert erst nach WebAuthn-Sign in der Approval-Queue.
 *
 * Drift-Resolution-aware: alle Felder optional, Type-Guards nicht enforced —
 * Backend kann Schema-Felder hinzufügen ohne PWA-Break.
 *
 * Generic-Object-Model (GENERIC-DATA-MODEL.md v3): `kind` ist entfernt, alles
 * läuft über free-form `subtype`. Caller-Konvention: `file`, `skill_manifest`,
 * `app:<typ>` (z.B. `app:composable`), `memo`. Storage interpretiert nichts.
 */

export type ObjectSubtype = string;
export type Visibility = 'private' | 'shared' | 'public' | string;

export interface RefView {
  readonly role: string;
  readonly id: string;
  readonly subtype: string | null;
  readonly title: string | null;
  readonly summary: string | null;
  readonly uri: string;
  /** PLAN-doc-linking §9 P9: eager-embedded body when includeRefBodies set. */
  readonly body?: string;
  readonly bodyEncoding?: 'base64';
  readonly truncatedReason?: 'oversized' | 'budget';
}

export interface KnowledgeObjectRefs {
  readonly outgoing: ReadonlyArray<RefView>;
  readonly incoming: ReadonlyArray<RefView>;
  readonly truncated: {
    readonly outgoing: boolean;
    readonly incoming: boolean;
  };
}

export interface KnowledgeObject {
  readonly id: string;
  readonly subtype?: ObjectSubtype | null;
  readonly title?: string | null;
  readonly filename?: string | null;
  readonly description?: string | null;
  readonly visibility?: Visibility;
  readonly bodySize?: number;
  readonly body?: string | null;            // base64 or text, populated when expandBody=true
  readonly bodyEncoding?: 'utf8' | 'base64' | string;
  readonly contentType?: string | null;
  readonly refcount?: number;
  readonly isSubdoc?: boolean;
  readonly metaJson?: Record<string, unknown> | null;
  readonly meta?: Record<string, unknown> | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * PLAN-document-linking §10.5 D1: Knowledge-Graph-Refs werden bei
   * GET /v1/knowledge/objects/:id (default refs_limit=5) mit ausgeliefert.
   */
  readonly refs?: KnowledgeObjectRefs;
}

export interface ListObjectsArgs {
  readonly subtype?: string;
  /**
   * Server-side prefix-match filter (`subtype LIKE 'prefix%'`). e.g.
   * `subtypePrefix: 'app:'` returns all `app:*` subtypes. Mutually
   * exclusive with `subtype` — backend rejects both.
   */
  readonly subtypePrefix?: string;
  readonly q?: string;
  readonly limit?: number;
  readonly cursor?: number;
  readonly embeddedFlag?: 'embedded' | 'not-embedded';
}

export interface ListObjectsResult {
  readonly items: ReadonlyArray<KnowledgeObject>;
  readonly nextCursor: number | null;
}

export interface ApiStorageClient {
  listObjects(args: ListObjectsArgs): Promise<ListObjectsResult>;
  getObject(id: string, opts?: { expandBody?: boolean; includeRefBodies?: ReadonlyArray<string> }): Promise<KnowledgeObject>;
  deleteObject(id: string, opts?: { force?: boolean }): Promise<{ approvalId: string }>;
  updateSummary(id: string, summary: string): Promise<{ approvalId: string }>;
}

export class StorageApiError extends Error {
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

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) {
    if (res.ok) return undefined as T;
    throw new StorageApiError(res.status, 'http_error', `HTTP ${res.status}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new StorageApiError(res.status, 'invalid_json', `Non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const err = (body as ServerError).error;
    throw new StorageApiError(
      res.status,
      err?.code ?? 'http_error',
      err?.message ?? `HTTP ${res.status}`,
    );
  }
  return body as T;
}

function buildUrl(
  base: string,
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  const u = new URL(path, base.endsWith('/') ? base : `${base}/`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

import { authedFetch } from './auth-token.js';

export function createApiStorageClient(baseUrl?: string): ApiStorageClient {
  const base =
    baseUrl ?? (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8787');

  async function request<T>(
    path: string,
    opts: {
      method?: 'GET' | 'POST' | 'DELETE' | 'PATCH';
      body?: unknown;
      query?: Record<string, string | number | undefined>;
    } = {},
  ): Promise<T> {
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      // credentials: 'include' wird von authedFetch durchgereicht — nicht doppelt setzen
      headers: { accept: 'application/json' },
    };
    if (opts.body !== undefined) {
      init.headers = { ...init.headers, 'content-type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }
    // Vorher: plain fetch → 'missing bearer token' weil approval2's auth-
    // middleware Authorization-Bearer-Header verlangt (Cookie reicht nicht
    // fuer /v1/*). Siehe Doku in auth-token.ts.
    const res = await authedFetch(buildUrl(base, path, opts.query), init, base);
    return parseJson<T>(res);
  }

  return {
    async listObjects(args) {
      const query: Record<string, string | number | undefined> = {};
      if (args.subtype) query['subtype'] = args.subtype;
      if (args.subtypePrefix) query['subtype_prefix'] = args.subtypePrefix;
      if (args.q) query['q'] = args.q;
      if (args.limit !== undefined) query['limit'] = args.limit;
      if (args.cursor !== undefined) query['cursor'] = args.cursor;
      if (args.embeddedFlag === 'embedded') query['embedded'] = '1';
      else if (args.embeddedFlag === 'not-embedded') query['embedded'] = '0';

      const raw = await request<{
        items?: ReadonlyArray<KnowledgeObject>;
        nextCursor?: number | null;
      }>('/v1/knowledge/objects', { query });

      return {
        items: raw.items ?? [],
        nextCursor: raw.nextCursor ?? null,
      };
    },

    async getObject(id, opts) {
      const query: Record<string, string | undefined> = {};
      if (opts?.expandBody) query['expand'] = 'body,refs,tags,summary';
      if (opts?.includeRefBodies && opts.includeRefBodies.length > 0) {
        query['include_bodies'] = opts.includeRefBodies.join(',');
      }
      const raw = await request<{ item?: KnowledgeObject } | KnowledgeObject>(
        `/v1/knowledge/objects/${encodeURIComponent(id)}`,
        { query },
      );
      // Backend may answer with `{ item: {...} }` or `{...}` directly
      if (raw && typeof raw === 'object' && 'item' in raw && (raw as { item?: unknown }).item) {
        return (raw as { item: KnowledgeObject }).item;
      }
      return raw as KnowledgeObject;
    },

    async deleteObject(id, opts) {
      const query: Record<string, string | number | undefined> = {};
      if (opts?.force) query['force'] = '1';
      const raw = await request<{ approvalId?: string; approval_id?: string }>(
        `/v1/knowledge/objects/${encodeURIComponent(id)}`,
        { method: 'DELETE', query },
      );
      const approvalId = raw.approvalId ?? raw.approval_id ?? '';
      return { approvalId };
    },

    async updateSummary(id, summary) {
      const raw = await request<{ approvalId?: string; approval_id?: string }>(
        `/v1/knowledge/objects/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: { summary } },
      );
      const approvalId = raw.approvalId ?? raw.approval_id ?? '';
      return { approvalId };
    },
  };
}
