/**
 * HttpKnowledgeAdapter — Live-HTTP-Client gegen mcp-knowledge2.
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §2.1 + §7.1.
 *
 * Auth-Pattern:
 *   - Pro Aufruf wird ein 60s-TTL-JWT signiert (sub=userId).
 *   - JWT geht im `Authorization: Bearer`-Header an mcp-knowledge2.
 *   - mcp-knowledge2 validiert via JWKS (Caller besitzt nur Private-Key).
 *
 * Fetch-Injection:
 *   - `fetchImpl` ist injectable, damit Tests einen Mock vorschieben koennen
 *     ohne `vi.spyOn(global, 'fetch')`. Default ist das Runtime-`fetch` —
 *     Node 20+ + Bun + CF Workers haben das alle eingebaut.
 *
 * Header-Konvention:
 *   - `Authorization: Bearer <jwt>`
 *   - `X-Request-ID` — durchgereicht fuer Cross-Service-Correlation (Audit).
 *     Wenn der Caller keinen mitliefert generiert der Adapter einen frischen.
 *   - `Content-Type: application/json` bei body-tragenden Methoden.
 *
 * Error-Mapping siehe `./errors.ts`.
 */

import type {
  CreateShareArgs,
  EraseUserArgs,
  EraseUserResult,
  KnowledgeAdapter,
  ListObjectsArgs,
  ListSharesArgs,
  RevokeShareArgs,
  SearchArgs,
  UpdateObjectArgs,
} from './interface.js';
import type {
  CreateObjectArgs,
  KnowledgeObject,
  ObjectsList,
  SearchHit,
  Share,
} from './types.js';
import { errorFromResponse, ServiceError } from './errors.js';

export interface JwtSigner {
  /**
   * Signt einen kurzlebigen Service-Boundary-JWT.
   * Pflicht: sub. Optional: scope (fine-grained), ttlSec (default 60).
   */
  sign(args: { sub: string; scope?: string; ttlSec?: number }): Promise<string>;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface HttpKnowledgeAdapterOptions {
  readonly baseUrl: string;
  readonly jwtSigner: JwtSigner;
  readonly fetchImpl?: FetchLike;
  /** Default 60s. Wird an `JwtSigner.sign` durchgereicht. */
  readonly jwtTtlSec?: number;
  /** Optional fixed request-id factory (z.B. uuid-v7), default: crypto.randomUUID. */
  readonly requestIdFactory?: () => string;
}

interface AuthedFetchArgs {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly userId: string;
  readonly body?: unknown;
  readonly scope?: string;
  readonly requestId?: string;
  readonly query?: Record<string, string | number | undefined>;
}

export class HttpKnowledgeAdapter implements KnowledgeAdapter {
  private readonly baseUrl: string;
  private readonly jwtSigner: JwtSigner;
  private readonly fetchImpl: FetchLike;
  private readonly jwtTtlSec: number;
  private readonly requestIdFactory: () => string;

  constructor(opts: HttpKnowledgeAdapterOptions) {
    if (!opts.baseUrl) throw new Error('HttpKnowledgeAdapter: baseUrl required');
    // Trailing slash strip — der Adapter haengt /v1/... an.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.jwtSigner = opts.jwtSigner;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.jwtTtlSec = opts.jwtTtlSec ?? 60;
    this.requestIdFactory = opts.requestIdFactory ?? defaultRequestId;
  }

  // ---------------------------------------------------------------------------
  // Internal: signed fetch
  // ---------------------------------------------------------------------------

  private async authedFetch<T>(args: AuthedFetchArgs): Promise<T> {
    const signArgs: { sub: string; ttlSec: number; scope?: string } = {
      sub: args.userId,
      ttlSec: this.jwtTtlSec,
    };
    if (args.scope !== undefined) signArgs.scope = args.scope;
    const token = await this.jwtSigner.sign(signArgs);
    const reqId = args.requestId ?? this.requestIdFactory();
    const url = this.buildUrl(args.path, args.query);

    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'x-request-id': reqId,
      accept: 'application/json',
    };
    let bodyInit: BodyInit | undefined;
    if (args.body !== undefined) {
      headers['content-type'] = 'application/json';
      bodyInit = JSON.stringify(args.body);
    }

    const init: RequestInit = {
      method: args.method,
      headers,
    };
    if (bodyInit !== undefined) init.body = bodyInit;

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      throw new ServiceError(
        `network error calling mcp-knowledge2: ${err instanceof Error ? err.message : String(err)}`,
        502,
        reqId,
      );
    }

    if (!response.ok) {
      const text = await safeReadText(response);
      throw errorFromResponse({
        status: response.status,
        bodyText: text,
        requestId: response.headers.get('x-request-id') ?? reqId,
      });
    }

    // 204 No Content → void
    if (response.status === 204) {
      return undefined as T;
    }

    const text = await safeReadText(response);
    if (text === '') return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new ServiceError(
        `invalid JSON from mcp-knowledge2: ${err instanceof Error ? err.message : String(err)}`,
        502,
        reqId,
      );
    }
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== '') {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return url.toString();
  }

  // ---------------------------------------------------------------------------
  // Objects
  // ---------------------------------------------------------------------------

  async createObject(args: CreateObjectArgs): Promise<KnowledgeObject> {
    const body: Record<string, unknown> = { kind: args.kind };
    if (args.subtype !== undefined) body['subtype'] = args.subtype;
    if (args.title !== undefined) body['title'] = args.title;
    if (args.description !== undefined) body['description'] = args.description;
    if (args.keywords !== undefined) body['keywords'] = args.keywords;
    if (args.body !== undefined) body['body'] = args.body;
    if (args.visibility !== undefined) body['visibility'] = args.visibility;
    return this.authedFetch<KnowledgeObject>({
      method: 'POST',
      path: '/v1/objects',
      userId: args.userId,
      body,
      scope: `${args.kind}:write`,
    });
  }

  async getObject(args: { id: string; userId: string }): Promise<KnowledgeObject> {
    return this.authedFetch<KnowledgeObject>({
      method: 'GET',
      path: `/v1/objects/${encodeURIComponent(args.id)}`,
      userId: args.userId,
      scope: 'objects:read',
    });
  }

  async listObjects(args: ListObjectsArgs): Promise<ObjectsList> {
    const query: Record<string, string | number | undefined> = {};
    if (args.kind !== undefined) query['kind'] = args.kind;
    if (args.limit !== undefined) query['limit'] = args.limit;
    if (args.cursor !== undefined) query['cursor'] = args.cursor;
    return this.authedFetch<ObjectsList>({
      method: 'GET',
      path: '/v1/objects',
      userId: args.userId,
      query,
      scope: 'objects:read',
    });
  }

  async updateObject(args: UpdateObjectArgs): Promise<KnowledgeObject> {
    return this.authedFetch<KnowledgeObject>({
      method: 'PATCH',
      path: `/v1/objects/${encodeURIComponent(args.id)}`,
      userId: args.userId,
      body: args.patch,
      scope: 'objects:write',
    });
  }

  async deleteObject(args: { id: string; userId: string }): Promise<void> {
    await this.authedFetch<void>({
      method: 'DELETE',
      path: `/v1/objects/${encodeURIComponent(args.id)}`,
      userId: args.userId,
      scope: 'objects:write',
    });
  }

  // ---------------------------------------------------------------------------
  // Sharing
  // ---------------------------------------------------------------------------

  async createShare(args: CreateShareArgs): Promise<Share> {
    return this.authedFetch<Share>({
      method: 'POST',
      path: `/v1/objects/${encodeURIComponent(args.resourceId)}/shares`,
      userId: args.userId,
      body: {
        resourceKind: args.resourceKind,
        grantedTo: args.grantedTo,
        scope: args.scope,
      },
      scope: 'shares:write',
    });
  }

  async listShares(args: ListSharesArgs): Promise<ReadonlyArray<Share>> {
    return this.authedFetch<ReadonlyArray<Share>>({
      method: 'GET',
      path: `/v1/objects/${encodeURIComponent(args.resourceId)}/shares`,
      userId: args.userId,
      scope: 'shares:read',
    });
  }

  async revokeShare(args: RevokeShareArgs): Promise<void> {
    await this.authedFetch<void>({
      method: 'DELETE',
      path: `/v1/shares/${encodeURIComponent(args.shareId)}`,
      userId: args.userId,
      scope: 'shares:write',
    });
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  async search(args: SearchArgs): Promise<ReadonlyArray<SearchHit>> {
    const body: Record<string, unknown> = { query: args.query };
    if (args.kinds !== undefined) body['kinds'] = args.kinds;
    if (args.limit !== undefined) body['limit'] = args.limit;
    const res = await this.authedFetch<{ items: ReadonlyArray<SearchHit> } | ReadonlyArray<SearchHit>>({
      method: 'POST',
      path: '/v1/search',
      userId: args.userId,
      body,
      scope: 'search:read',
    });
    if (Array.isArray(res)) return res;
    return (res as { items: ReadonlyArray<SearchHit> }).items;
  }

  // ---------------------------------------------------------------------------
  // Internal (admin)
  // ---------------------------------------------------------------------------

  async eraseUser(args: EraseUserArgs): Promise<EraseUserResult> {
    return this.authedFetch<EraseUserResult>({
      method: 'POST',
      path: '/v1/internal/erase-user',
      userId: args.userId,
      body: { confirmationToken: args.confirmationToken },
      scope: 'admin:erase',
    });
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function defaultRequestId(): string {
  // crypto.randomUUID is available in Node 20+ + CF Workers; fallback ist
  // ein Math.random-Hash falls jemand das in einer alten Runtime nutzt.
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  const rand = () => Math.floor(Math.random() * 0xffff_ffff).toString(16);
  return `req-${Date.now().toString(16)}-${rand()}${rand()}`;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
