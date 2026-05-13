/**
 * HttpKnowledgeAdapter — Live-HTTP-Client gegen mcp-knowledge2.
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §2.1 + §7.1.
 * Wire-Reference: /workspaces/mcp-knowledge2/docs/CROSS-SERVICE-CONTRACT.md
 *                 + /workspaces/mcp-knowledge2/docs/openapi.yaml
 *
 * Auth-Pattern:
 *   - User-Routes: pro Aufruf wird ein 60s-TTL-JWT signiert (sub=userId).
 *     JWT geht im `Authorization: Bearer`-Header; Server validiert via JWKS.
 *   - Internal-Route (`/v1/internal/erase-user`, D-10): statischer Service-
 *     Bearer-Token (NICHT JWT). Adapter braucht `serviceToken: string`-Option.
 *
 * Fetch-Injection:
 *   - `fetchImpl` injectable fuer Tests. Default ist Runtime-`fetch`.
 *
 * Header-Konvention:
 *   - `Authorization: Bearer <jwt|service-token>`
 *   - `X-Request-ID` — fuer Cross-Service-Correlation (Audit).
 *   - `Content-Type: application/json` bei body-tragenden Methoden.
 *
 * Error-Mapping siehe `./errors.ts` (RFC 7807 Problem Details).
 */

import type {
  CreateShareArgs,
  EraseUserArgs,
  EraseUserResult,
  GetObjectArgs,
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
  /**
   * D-10: Statischer Service-Token (Bearer) fuer Internal-Routes wie
   * `/v1/internal/erase-user`. Wenn nicht gesetzt: `eraseUser` wirft beim
   * Aufruf (statt unsicher mit User-JWT zu probieren).
   */
  readonly serviceToken?: string;
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

interface ServiceFetchArgs {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
  readonly requestId?: string;
  readonly query?: Record<string, string | number | undefined>;
}

export class HttpKnowledgeAdapter implements KnowledgeAdapter {
  private readonly baseUrl: string;
  private readonly jwtSigner: JwtSigner;
  private readonly fetchImpl: FetchLike;
  private readonly jwtTtlSec: number;
  private readonly requestIdFactory: () => string;
  private readonly serviceToken: string | undefined;

  constructor(opts: HttpKnowledgeAdapterOptions) {
    if (!opts.baseUrl) throw new Error('HttpKnowledgeAdapter: baseUrl required');
    // Trailing slash strip — der Adapter haengt /v1/... an.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.jwtSigner = opts.jwtSigner;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.jwtTtlSec = opts.jwtTtlSec ?? 60;
    this.requestIdFactory = opts.requestIdFactory ?? defaultRequestId;
    this.serviceToken = opts.serviceToken;
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
    return this.doFetch<T>({ method: args.method, url, token, body: args.body, reqId });
  }

  private async serviceFetch<T>(args: ServiceFetchArgs): Promise<T> {
    if (!this.serviceToken) {
      throw new ServiceError(
        'HttpKnowledgeAdapter: serviceToken not configured — cannot call internal route',
        500,
      );
    }
    const reqId = args.requestId ?? this.requestIdFactory();
    const url = this.buildUrl(args.path, args.query);
    return this.doFetch<T>({
      method: args.method,
      url,
      token: this.serviceToken,
      body: args.body,
      reqId,
    });
  }

  private async doFetch<T>(opts: {
    readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    readonly url: string;
    readonly token: string;
    readonly body?: unknown;
    readonly reqId: string;
  }): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.token}`,
      'x-request-id': opts.reqId,
      accept: 'application/json',
    };
    let bodyInit: BodyInit | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      bodyInit = JSON.stringify(opts.body);
    }

    const init: RequestInit = {
      method: opts.method,
      headers,
    };
    if (bodyInit !== undefined) init.body = bodyInit;

    let response: Response;
    try {
      response = await this.fetchImpl(opts.url, init);
    } catch (err) {
      throw new ServiceError(
        `network error calling mcp-knowledge2: ${err instanceof Error ? err.message : String(err)}`,
        502,
        opts.reqId,
      );
    }

    if (!response.ok) {
      const text = await safeReadText(response);
      throw errorFromResponse({
        status: response.status,
        bodyText: text,
        requestId: response.headers.get('x-request-id') ?? opts.reqId,
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
        opts.reqId,
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
    // D-2 + D-3: body als base64 unter `body_b64`, plus mime_type/filename/embed.
    const body: Record<string, unknown> = { kind: args.kind };
    if (args.subtype !== undefined) body['subtype'] = args.subtype;
    if (args.title !== undefined) body['title'] = args.title;
    if (args.description !== undefined) body['description'] = args.description;
    if (args.keywords !== undefined) body['keywords'] = args.keywords;
    if (args.triggerHints !== undefined) body['trigger_hints'] = args.triggerHints;
    if (args.meta !== undefined) body['meta'] = args.meta;
    if (args.body !== undefined) body['body_b64'] = encodeBodyB64(args.body);
    if (args.mimeType !== undefined) body['mime_type'] = args.mimeType;
    if (args.filename !== undefined) body['filename'] = args.filename;
    if (args.embed !== undefined) body['embed'] = args.embed;
    if (args.visibility !== undefined) body['visibility'] = args.visibility;
    return this.authedFetch<KnowledgeObject>({
      method: 'POST',
      path: '/v1/objects',
      userId: args.userId,
      body,
      scope: `${args.kind}:write`,
    });
  }

  async getObject(args: GetObjectArgs): Promise<KnowledgeObject> {
    // D-11: optional ?expand=body → server returnt body_b64. Wir mappen das
    // hier in das `body`-Field der KnowledgeObject.
    const query: Record<string, string | number | undefined> = {};
    if (args.expandBody) query['expand'] = 'body';
    const raw = await this.authedFetch<KnowledgeObject & { body_b64?: string | null }>({
      method: 'GET',
      path: `/v1/objects/${encodeURIComponent(args.id)}`,
      userId: args.userId,
      query,
      scope: 'objects:read',
    });
    return normaliseObjectView(raw);
  }

  async listObjects(args: ListObjectsArgs): Promise<ObjectsList> {
    // D-4 + D-5: server liefert `{items, next_cursor}` mit number-cursor.
    const query: Record<string, string | number | undefined> = {};
    if (args.kind !== undefined) query['kind'] = args.kind;
    if (args.subtype !== undefined) query['subtype'] = args.subtype;
    if (args.limit !== undefined) query['limit'] = args.limit;
    if (args.cursor !== undefined && args.cursor !== null) query['cursor'] = args.cursor;
    const raw = await this.authedFetch<{
      items: ReadonlyArray<KnowledgeObject & { body_b64?: string | null }>;
      next_cursor: number | null;
    }>({
      method: 'GET',
      path: '/v1/objects',
      userId: args.userId,
      query,
      scope: 'objects:read',
    });
    return {
      items: raw.items.map(normaliseObjectView),
      nextCursor: raw.next_cursor ?? null,
    };
  }

  async updateObject(args: UpdateObjectArgs): Promise<KnowledgeObject> {
    // Mappe internal patch-Felder (camelCase) → server-side snake_case.
    const body: Record<string, unknown> = {};
    const p = args.patch;
    if (p.title !== undefined) body['title'] = p.title;
    if (p.description !== undefined) body['description'] = p.description;
    if (p.keywords !== undefined) body['keywords'] = p.keywords;
    if (p.triggerHints !== undefined) body['trigger_hints'] = p.triggerHints;
    if (p.meta !== undefined) body['meta'] = p.meta;
    if (p.body !== undefined) body['body_b64'] = encodeBodyB64(p.body);
    if (p.pinned !== undefined) body['pinned'] = p.pinned;
    if (p.archived !== undefined) body['archived'] = p.archived;
    if (p.expiresAt !== undefined) body['expires_at'] = p.expiresAt;
    if (p.expectedVersion !== undefined) body['expected_version'] = p.expectedVersion;
    if (p.reEmbed !== undefined) body['re_embed'] = p.reEmbed;
    const raw = await this.authedFetch<KnowledgeObject & { body_b64?: string | null }>({
      method: 'PATCH',
      path: `/v1/objects/${encodeURIComponent(args.id)}`,
      userId: args.userId,
      body,
      scope: 'objects:write',
    });
    return normaliseObjectView(raw);
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
    // D-6: server-Body ist `{granted_to, scope, expires_at?}` snake_case.
    //       `resourceKind` wird server-seitig aus dem Object abgeleitet.
    const body: Record<string, unknown> = {
      granted_to: args.grantedTo,
      scope: args.scope,
    };
    if (args.expiresAt !== undefined) body['expires_at'] = args.expiresAt;
    return this.authedFetch<Share>({
      method: 'POST',
      path: `/v1/objects/${encodeURIComponent(args.resourceId)}/shares`,
      userId: args.userId,
      body,
      scope: 'shares:write',
    });
  }

  async listShares(args: ListSharesArgs): Promise<ReadonlyArray<Share>> {
    // D-8: server liefert `{items: [...]}`.
    const res = await this.authedFetch<{ items: ReadonlyArray<Share> }>({
      method: 'GET',
      path: `/v1/objects/${encodeURIComponent(args.resourceId)}/shares`,
      userId: args.userId,
      scope: 'shares:read',
    });
    return res.items;
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
    // D-9 (joint): server akzeptiert single `kind` heute. Multi-kind wird
    // server-seitig nachgereicht — Adapter ist forward-compatible:
    //   - kinds=[] / undefined → kein kind-filter
    //   - kinds.length === 1   → server `kind: ObjectKind`
    //   - kinds.length > 1     → server `kind: ObjectKind[]` (Server-Side wird
    //                            das heute silently ignoriert; sobald die
    //                            Server-Erweiterung live ist, filtern beide
    //                            Seiten konsistent).
    const body: Record<string, unknown> = { query: args.query };
    if (args.kinds !== undefined && args.kinds.length > 0) {
      body['kind'] = args.kinds.length === 1 ? args.kinds[0] : args.kinds;
    }
    if (args.limit !== undefined) body['limit'] = args.limit;
    const res = await this.authedFetch<{ items: ReadonlyArray<SearchHit> }>({
      method: 'POST',
      path: '/v1/search',
      userId: args.userId,
      body,
      scope: 'search:read',
    });
    return res.items;
  }

  // ---------------------------------------------------------------------------
  // Internal (admin) — D-10: Service-Token, NICHT User-JWT.
  // ---------------------------------------------------------------------------

  async eraseUser(args: EraseUserArgs): Promise<EraseUserResult> {
    const raw = await this.serviceFetch<{
      status: 'ok' | 'partial';
      deleted: {
        objects: number;
        shares: number;
        idempotency: number;
        uploads: number;
        audit_pseudonymised: number;
        blobs_deleted: number;
        blobs_pending: number;
      };
    }>({
      method: 'POST',
      path: '/v1/internal/erase-user',
      body: {
        user_id: args.userId,
        confirmation_token: args.confirmationToken,
      },
    });
    return {
      status: raw.status,
      deleted: {
        objects: raw.deleted.objects,
        shares: raw.deleted.shares,
        idempotency: raw.deleted.idempotency,
        uploads: raw.deleted.uploads,
        auditPseudonymised: raw.deleted.audit_pseudonymised,
        blobsDeleted: raw.deleted.blobs_deleted,
        blobsPending: raw.deleted.blobs_pending,
      },
      // Backwards-compat-Alias: existierende Caller (gdpr.ts) lesen
      // `result.deletedRows` als "Anzahl geloeschter object-rows".
      deletedRows: raw.deleted.objects,
    };
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

/**
 * Encodes either a Uint8Array or string into a base64 ASCII-string for the
 * `body_b64` wire-field (D-2). Strings get UTF-8-encoded first.
 */
function encodeBodyB64(body: Uint8Array | string): string {
  if (typeof body === 'string') {
    return Buffer.from(body, 'utf-8').toString('base64');
  }
  // Uint8Array → Buffer (zero-copy on Node) → base64.
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('base64');
}

/**
 * Lift the server's `body_b64`-field (only present with `?expand=body`) into
 * KnowledgeObject.body. We keep both the base64-string and `null` semantics —
 * Caller decode via `Buffer.from(body, 'base64')` falls bytes gewuenscht.
 */
function normaliseObjectView<T extends KnowledgeObject & { body_b64?: string | null }>(
  raw: T,
): KnowledgeObject {
  const { body_b64, ...rest } = raw;
  if (body_b64 === undefined) return rest as KnowledgeObject;
  return { ...(rest as KnowledgeObject), body: body_b64 };
}
