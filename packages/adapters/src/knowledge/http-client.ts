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
  AddGroupMemberArgs,
  AddRefArgs,
  ArchiveGroupArgs,
  CreateGroupArgs,
  CreateShareArgs,
  CreateShareWithGroupArgs,
  EraseUserArgs,
  EraseUserResult,
  GetGroupArgs,
  GetObjectArgs,
  KnowledgeAdapter,
  ListGroupsArgs,
  ListObjectsArgs,
  ListSharedWithMeArgs,
  ListSharesArgs,
  RemoveGroupMemberArgs,
  RemoveRefArgs,
  RevokeShareArgs,
  SearchArgs,
  SetGroupReadAuditArgs,
  SyncUserArgs,
  SyncUserResult,
  UpdateObjectArgs,
} from './interface.js';
import type {
  CreateObjectArgs,
  Group,
  GroupMember,
  GroupShare,
  KnowledgeObject,
  ObjectsList,
  SearchHit,
  Share,
} from './types.js';
import { errorFromResponse, ServiceError } from './errors.js';

/**
 * Args fuer `JwtSigner.signOBO` — On-Behalf-Of-Token gegen KC2.
 *
 * Plan-Ref: PLAN-as3-autonomous.md §2.1 + §1.2.
 *
 * Wire-Shape (was der Signer in den JWT-Payload setzt):
 *   ```
 *   {
 *     iss: <SELF_OAUTH_ISSUER ?? ORIGIN>,
 *     aud: 'mcp-knowledge2',
 *     sub: <approval2-internal-users.id>,
 *     on_behalf_of: <google-email>,
 *     approval_id?: <uuid>,                 // Pflicht bei write-Tools
 *     request_id?: <uuid>,
 *     jti: <uuid>,                           // Replay-Prevention
 *     iat, exp                               // exp = iat + ttlSec (Default 120s)
 *   }
 *   ```
 */
export interface SignOboArgs {
  readonly sub: string;
  readonly aud: string;
  readonly on_behalf_of: string;
  readonly approval_id?: string;
  readonly request_id?: string;
  /** Default 120s. */
  readonly ttlSec?: number;
}

/**
 * SEC-K-016 / MUSS-§4.1.2: Args fuer `JwtSigner.signEraseReceipt`. JWT bindet
 * an einen konkreten zu-erasenden User + an die Approval die das authorisiert
 * hat. mcp-knowledge2 verifiziert `payload.sub === body.user_id` und schuetzt
 * `jti` gegen Replay.
 */
export interface SignEraseReceiptArgs {
  /** Subject = User-ID die geloescht werden soll. KC2 enforced sub===body.user_id. */
  readonly sub: string;
  /** Approval-ID die das Erase autorisiert hat (audit-trail correlation). */
  readonly approvalId?: string;
  /** Default 60s — erase ist nicht hot-path, kurze TTL ok. */
  readonly ttlSec?: number;
}

export interface JwtSigner {
  /**
   * Signt einen kurzlebigen Service-Boundary-JWT (Legacy-Pattern, v1).
   * Pflicht: sub. Optional: scope (fine-grained), ttlSec (default 60).
   *
   * **Deprecation:** Wird durch `signOBO` ersetzt (AS-3, §1.2). Bleibt
   * verfuegbar fuer den Internal-Erase-Pfad und Legacy-Pfade die noch
   * keinen OBO-Konsumenten haben.
   */
  sign(args: { sub: string; scope?: string; ttlSec?: number }): Promise<string>;

  /**
   * Signt einen OBO-JWT (On-Behalf-Of) fuer den Service-Call approval2 →
   * KC2. Wird im `X-On-Behalf-Of`-Header transportiert, das eigentliche
   * Bearer-Token ist der statische `SERVICE_TOKEN` (siehe
   * `HttpKnowledgeAdapterOptions.serviceToken`).
   *
   * Plan-Ref: PLAN-as3-autonomous.md §2.1.
   */
  signOBO(args: SignOboArgs): Promise<string>;

  /**
   * SEC-K-016 / MUSS-§4.1.2: Signt einen Erase-Receipt-JWS fuer den
   * Service-Call approval2 → KC2 /v1/internal/erase-user. Audience ist fest
   * `mcp-knowledge2:erase`, signed mit demselben RS256-Key wie OBO →
   * Verifikation via JWKS dort.
   *
   * Optional: solange KC2 REQUIRE_ERASE_RECEIPT=false ist, kann der Signer
   * undefined returnen oder die Methode kann komplett fehlen — der Caller
   * sollte beide Faelle abfangen.
   */
  signEraseReceipt?(args: SignEraseReceiptArgs): Promise<string>;
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
   *
   * Legacy-Token (KC2's SERVICE_TOKEN). Bei aktivem Scope-Split bevorzugt
   * `serviceTokens` (per-Scope). Sobald KC2 das legacy SERVICE_TOKEN
   * unsetzt, MUSS der Caller scoped tokens setzen.
   */
  readonly serviceToken?: string;

  /**
   * SEC-K-009: scope-spezifische Service-Tokens fuer die KC2-Internal-Routes.
   * `serviceFetch` waehlt anhand des Path die richtige Variante; faellt auf
   * `serviceToken` (legacy admin-master) zurueck wenn ein scope-token nicht
   * gesetzt ist.
   */
  readonly serviceTokens?: {
    /** Fuer /v1/internal/erase-user */
    readonly erase?: string;
    /** Fuer /v1/internal/users/sync */
    readonly sync?: string;
    /** Fuer /v1/internal/health-deep (+ weitere read-only ops) */
    readonly ops?: string;
  };
}

interface AuthedFetchArgs {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly userId: string;
  readonly body?: unknown;
  readonly scope?: string;
  readonly requestId?: string;
  readonly query?: Record<string, string | number | undefined>;
  /**
   * AS-3 (§1.2): wenn der Caller eine User-Email kennt (z.B. aus dem
   * Session-Principal), wandert sie in den OBO-JWT als
   * `on_behalf_of`-Claim. Pflicht im OBO-Pfad — wenn nicht gesetzt,
   * faellt der Adapter zurueck auf Legacy-JWT-Bearer (kein on-behalf-of
   * mitsenden).
   */
  readonly userEmail?: string;
  /**
   * AS-3 (§1.5 + §1.6): bei state-changing Tool-Calls nach Approval-
   * Approve traegt der Approval-Handler die `approval_id` mit, damit KC2
   * den Audit-Trail `via_proxy=true, approval_id=<…>` sieht.
   */
  readonly approvalId?: string;
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
  private readonly serviceTokens: HttpKnowledgeAdapterOptions['serviceTokens'];

  constructor(opts: HttpKnowledgeAdapterOptions) {
    if (!opts.baseUrl) throw new Error('HttpKnowledgeAdapter: baseUrl required');
    // Trailing slash strip — der Adapter haengt /v1/... an.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.jwtSigner = opts.jwtSigner;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.jwtTtlSec = opts.jwtTtlSec ?? 60;
    this.requestIdFactory = opts.requestIdFactory ?? defaultRequestId;
    this.serviceToken = opts.serviceToken;
    this.serviceTokens = opts.serviceTokens;
  }

  /**
   * SEC-K-009: waehle den scope-spezifischen Service-Token basierend auf
   * dem Path. Fallback auf legacy serviceToken (master) wenn scope-Variante
   * nicht gesetzt — kompatibel mit nicht-migrierten KC2-Versionen.
   */
  private pickServiceToken(path: string): string | undefined {
    const tokens = this.serviceTokens;
    if (tokens) {
      if (path === '/v1/internal/erase-user' && tokens.erase) return tokens.erase;
      if (path === '/v1/internal/users/sync' && tokens.sync) return tokens.sync;
      if (path === '/v1/internal/health-deep' && tokens.ops) return tokens.ops;
    }
    return this.serviceToken;
  }

  // ---------------------------------------------------------------------------
  // Internal: signed fetch
  // ---------------------------------------------------------------------------

  private async authedFetch<T>(args: AuthedFetchArgs): Promise<T> {
    const reqId = args.requestId ?? this.requestIdFactory();
    const url = this.buildUrl(args.path, args.query);

    // AS-3 (§1.2): wenn `serviceToken` konfiguriert ist → OBO-Pfad. Sonst
    // legacy Per-Call-JWT-Bearer.
    if (this.serviceToken) {
      const oboArgs: {
        sub: string;
        aud: string;
        on_behalf_of: string;
        ttlSec: number;
        approval_id?: string;
        request_id?: string;
      } = {
        sub: args.userId,
        aud: 'mcp-knowledge2',
        on_behalf_of: args.userEmail ?? args.userId,
        ttlSec: 120, // §2.1 default
        request_id: reqId,
      };
      if (args.approvalId !== undefined) oboArgs.approval_id = args.approvalId;
      const obo = await this.jwtSigner.signOBO(oboArgs);
      return this.doFetch<T>({
        method: args.method,
        url,
        token: this.serviceToken,
        body: args.body,
        reqId,
        oboToken: obo,
      });
    }

    // Legacy-Pfad: Per-Call-Bearer-JWT.
    const signArgs: { sub: string; ttlSec: number; scope?: string } = {
      sub: args.userId,
      ttlSec: this.jwtTtlSec,
    };
    if (args.scope !== undefined) signArgs.scope = args.scope;
    const token = await this.jwtSigner.sign(signArgs);
    return this.doFetch<T>({ method: args.method, url, token, body: args.body, reqId });
  }

  private async serviceFetch<T>(
    args: ServiceFetchArgs & { readonly extraHeaders?: Record<string, string> },
  ): Promise<T> {
    const token = this.pickServiceToken(args.path);
    if (!token) {
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
      token,
      body: args.body,
      reqId,
      ...(args.extraHeaders !== undefined ? { extraHeaders: args.extraHeaders } : {}),
    });
  }

  private async doFetch<T>(opts: {
    readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    readonly url: string;
    readonly token: string;
    readonly body?: unknown;
    readonly reqId: string;
    /** AS-3: OBO-JWT als `X-On-Behalf-Of`-Header, parallel zum Service-Bearer. */
    readonly oboToken?: string;
    /** SEC-K-016: zusaetzliche Header (z.B. `x-erase-receipt`). */
    readonly extraHeaders?: Record<string, string>;
  }): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.token}`,
      'x-request-id': opts.reqId,
      accept: 'application/json',
    };
    if (opts.oboToken !== undefined) {
      headers['x-on-behalf-of'] = opts.oboToken;
    }
    if (opts.extraHeaders !== undefined) {
      for (const [k, v] of Object.entries(opts.extraHeaders)) {
        headers[k.toLowerCase()] = v;
      }
    }
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
    // ADR-0004: kein `kind` mehr, optionales free-form `subtype`.
    const body: Record<string, unknown> = {};
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
      scope: 'objects:write',
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
    });
  }

  async getObject(args: GetObjectArgs): Promise<KnowledgeObject> {
    // D-11: optional ?expand=body → server returnt body_b64. Wir mappen das
    // hier in das `body`-Field der KnowledgeObject.
    // PLAN-document-linking §10.5 D1: optional refs_limit → wandert als
    // Query-Param durch zu KC2. undefined = KC2-Default, 0 = suppress.
    const query: Record<string, string | number | undefined> = {};
    if (args.expandBody) query['expand'] = 'body';
    if (args.refsLimit !== undefined) query['refs_limit'] = args.refsLimit;
    if (args.includeRefBodies !== undefined && args.includeRefBodies.length > 0) {
      query['include_bodies'] = args.includeRefBodies.join(',');
    }
    const raw = await this.authedFetch<KnowledgeObject & { body_b64?: string | null }>({
      method: 'GET',
      path: `/v1/objects/${encodeURIComponent(args.id)}`,
      userId: args.userId,
      query,
      scope: 'objects:read',
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
    });
    return normaliseObjectView(raw);
  }

  async listObjects(args: ListObjectsArgs): Promise<ObjectsList> {
    // D-4 + D-5: server liefert `{items, next_cursor}` mit number-cursor.
    // ADR-0004: nur noch free-form `subtype`-Filter.
    // Mutual-Exclusive: subtype + subtypePrefix duerfen nicht zusammen
    // gesetzt sein. Wir fangen das lokal ab — kein unnoetiger HTTP-Call
    // gegen eine garantierte 400.
    if (args.subtype !== undefined && args.subtypePrefix !== undefined) {
      throw new ServiceError(
        'listObjects: subtype and subtypePrefix are mutually exclusive',
        400,
      );
    }
    const query: Record<string, string | number | undefined> = {};
    if (args.subtype !== undefined) query['subtype'] = args.subtype;
    if (args.subtypePrefix !== undefined) query['subtype_prefix'] = args.subtypePrefix;
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
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
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
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
    });
    return normaliseObjectView(raw);
  }

  async deleteObject(args: {
    id: string;
    userId: string;
    userEmail?: string;
    approvalId?: string;
  }): Promise<void> {
    await this.authedFetch<void>({
      method: 'DELETE',
      path: `/v1/objects/${encodeURIComponent(args.id)}`,
      userId: args.userId,
      scope: 'objects:write',
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Refs (PLAN-document-linking §10.5)
  // ---------------------------------------------------------------------------

  async addRef(args: AddRefArgs): Promise<void> {
    const body: Record<string, unknown> = { to_id: args.toId, role: args.role };
    if (args.meta !== undefined) body['meta'] = args.meta;
    await this.authedFetch<void>({
      method: 'POST',
      path: `/v1/objects/${encodeURIComponent(args.fromId)}/refs`,
      userId: args.userId,
      body,
      scope: 'objects:write',
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
    });
  }

  async removeRef(args: RemoveRefArgs): Promise<void> {
    await this.authedFetch<void>({
      method: 'DELETE',
      path: `/v1/objects/${encodeURIComponent(args.fromId)}/refs`,
      userId: args.userId,
      body: { to_id: args.toId, role: args.role },
      scope: 'objects:write',
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
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
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
    });
  }

  async listShares(args: ListSharesArgs): Promise<ReadonlyArray<Share>> {
    // D-8: server liefert `{items: [...]}`.
    const res = await this.authedFetch<{ items: ReadonlyArray<Share> }>({
      method: 'GET',
      path: `/v1/objects/${encodeURIComponent(args.resourceId)}/shares`,
      userId: args.userId,
      scope: 'shares:read',
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
    });
    return res.items;
  }

  async revokeShare(args: RevokeShareArgs): Promise<void> {
    await this.authedFetch<void>({
      method: 'DELETE',
      path: `/v1/shares/${encodeURIComponent(args.shareId)}`,
      userId: args.userId,
      scope: 'shares:write',
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
    });
  }

  async listSharedWithMe(args: ListSharedWithMeArgs): Promise<ReadonlyArray<Share>> {
    const res = await this.authedFetch<{ items: ReadonlyArray<Share> }>({
      method: 'GET',
      path: '/v1/shared-with-me',
      userId: args.userId,
      scope: 'shares:read',
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
    });
    return res.items;
  }

  // ---------------------------------------------------------------------------
  // Phase 1: Group-Sharing (Item 6d)
  // ---------------------------------------------------------------------------

  async createGroup(args: CreateGroupArgs): Promise<Group> {
    const body: Record<string, unknown> = { name: args.name };
    if (args.description !== undefined) body['description'] = args.description;
    if (args.readAuditEnabled !== undefined) body['read_audit_enabled'] = args.readAuditEnabled;
    if (args.cascadeOnShareDefault !== undefined) {
      body['cascade_on_share_default'] = args.cascadeOnShareDefault;
    }
    return this.authedFetch<Group>({
      method: 'POST',
      path: '/v1/groups',
      userId: args.userId,
      body,
      scope: 'groups:write',
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
    });
  }

  async listGroups(args: ListGroupsArgs): Promise<ReadonlyArray<Group>> {
    const res = await this.authedFetch<{ items: ReadonlyArray<Group> }>({
      method: 'GET',
      path: '/v1/groups',
      userId: args.userId,
      scope: 'groups:read',
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
    });
    return res.items;
  }

  async getGroup(
    args: GetGroupArgs,
  ): Promise<{ group: Group; members: ReadonlyArray<GroupMember> }> {
    return this.authedFetch<{ group: Group; members: ReadonlyArray<GroupMember> }>({
      method: 'GET',
      path: `/v1/groups/${encodeURIComponent(args.groupId)}`,
      userId: args.userId,
      scope: 'groups:read',
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
    });
  }

  async archiveGroup(args: ArchiveGroupArgs): Promise<void> {
    await this.authedFetch<void>({
      method: 'DELETE',
      path: `/v1/groups/${encodeURIComponent(args.groupId)}`,
      userId: args.userId,
      scope: 'groups:write',
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
    });
  }

  async addGroupMember(args: AddGroupMemberArgs): Promise<GroupMember> {
    const body: Record<string, unknown> = { user_id: args.targetUserId };
    if (args.role !== undefined) body['role'] = args.role;
    return this.authedFetch<GroupMember>({
      method: 'POST',
      path: `/v1/groups/${encodeURIComponent(args.groupId)}/members`,
      userId: args.userId,
      body,
      scope: 'groups:write',
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
    });
  }

  async removeGroupMember(args: RemoveGroupMemberArgs): Promise<void> {
    await this.authedFetch<void>({
      method: 'DELETE',
      path: `/v1/groups/${encodeURIComponent(args.groupId)}/members/${encodeURIComponent(args.targetUserId)}`,
      userId: args.userId,
      scope: 'groups:write',
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
    });
  }

  async setGroupReadAudit(args: SetGroupReadAuditArgs): Promise<void> {
    await this.authedFetch<void>({
      method: 'PATCH',
      path: `/v1/groups/${encodeURIComponent(args.groupId)}/read-audit`,
      userId: args.userId,
      body: { enabled: args.enabled },
      scope: 'groups:write',
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
    });
  }

  async createShareWithGroup(args: CreateShareWithGroupArgs): Promise<GroupShare> {
    const body: Record<string, unknown> = {
      group_id: args.groupId,
      scope: args.scope,
    };
    if (args.expiresAt !== undefined) body['expires_at'] = args.expiresAt;
    return this.authedFetch<GroupShare>({
      method: 'POST',
      path: `/v1/objects/${encodeURIComponent(args.resourceId)}/share-with-group`,
      userId: args.userId,
      body,
      scope: 'shares:write',
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  async search(args: SearchArgs): Promise<ReadonlyArray<SearchHit>> {
    // ADR-0004: free-form `subtypes`-Array statt `kind`. Storage erlaubt
    // Mehrfach-Filter; leeres Array / undefined → kein Filter.
    const body: Record<string, unknown> = { query: args.query };
    if (args.subtypes !== undefined && args.subtypes.length > 0) {
      body['subtypes'] = args.subtypes;
    }
    // subtype_prefixes combinable with subtypes (server joins via OR).
    if (args.subtypePrefixes !== undefined && args.subtypePrefixes.length > 0) {
      body['subtype_prefixes'] = args.subtypePrefixes;
    }
    if (args.limit !== undefined) body['limit'] = args.limit;
    const res = await this.authedFetch<{ items: ReadonlyArray<SearchHit> }>({
      method: 'POST',
      path: '/v1/search',
      userId: args.userId,
      body,
      scope: 'search:read',
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
    });
    return res.items;
  }

  // ---------------------------------------------------------------------------
  // Internal (admin) — D-10: Service-Token, NICHT User-JWT.
  // ---------------------------------------------------------------------------

  /**
   * AS-3 (§2.2 + A11): Push-Sync User-State an KC2.
   *
   * Wire-Shape: `POST /v1/internal/users/sync`
   *   Body (snake_case):
   *     `{user_id, email, display_name, status, external_id?}`
   *   Response: `{status: 'created'|'updated'|'unchanged', kc_user_id}`
   *
   * Auth: Service-Token im Bearer-Header. KEIN OBO-JWT — das ist ein
   * Admin-Call.
   */
  async syncUser(args: SyncUserArgs): Promise<SyncUserResult> {
    const body: Record<string, unknown> = {
      user_id: args.userId,
      email: args.email,
      display_name: args.displayName,
      status: args.status,
    };
    if (args.externalId !== undefined) body['external_id'] = args.externalId;
    const raw = await this.serviceFetch<{
      status: 'created' | 'updated' | 'unchanged';
      kc_user_id: string;
    }>({
      method: 'POST',
      path: '/v1/internal/users/sync',
      body,
    });
    return {
      status: raw.status,
      kcUserId: raw.kc_user_id,
    };
  }

  async eraseUser(args: EraseUserArgs): Promise<EraseUserResult> {
    // SEC-K-016 + MUSS-§4.1.2: wenn der Signer `signEraseReceipt` anbietet,
    // signen wir einen Receipt-JWS und packen ihn als `x-erase-receipt`-
    // Header dazu. KC2 enforced (mit REQUIRE_ERASE_RECEIPT=true) dass
    // `payload.sub === body.user_id`. Bei Adaptern ohne Signer-Support
    // weiterhin nur SERVICE_TOKEN — KC2 toleriert das im Migrations-Window.
    const extraHeaders: Record<string, string> = {};
    if (this.jwtSigner.signEraseReceipt) {
      const receiptArgs: { sub: string; ttlSec: number; approvalId?: string } = {
        sub: args.userId,
        ttlSec: 60,
      };
      if (args.approvalId !== undefined) receiptArgs.approvalId = args.approvalId;
      const receipt = await this.jwtSigner.signEraseReceipt(receiptArgs);
      extraHeaders['x-erase-receipt'] = receipt;
    }

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
      extraHeaders,
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
 *
 * Setzt zusaetzlich `bodyEncoding='base64'` damit Downstream-Renderer (PWA-
 * decodeBody) den richtigen Pfad waehlen. Ohne den Marker wuerde der Default
 * 'utf8' base64-Garbage als Plain-Text rendern.
 */
function normaliseObjectView<T extends KnowledgeObject & { body_b64?: string | null }>(
  raw: T,
): KnowledgeObject {
  const { body_b64, ...rest } = raw;
  if (body_b64 === undefined) return rest as KnowledgeObject;
  return {
    ...(rest as KnowledgeObject),
    body: body_b64,
    bodyEncoding: 'base64',
  };
}
