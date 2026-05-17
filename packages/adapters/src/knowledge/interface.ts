/**
 * KnowledgeAdapter — Service-Boundary zu mcp-knowledge2.
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §2.1 + §7.1.
 *
 * Der Adapter ist eine portable Indirektion ueber die Storage-API:
 *   - HttpKnowledgeAdapter (Live, gegen mcp-knowledge2 ueber HTTPS+JWT)
 *   - In-Memory-Stub (Tests, ausserhalb dieses Files)
 *
 * Multi-User-Schutz:
 *   - JEDE user-facing Methode nimmt `userId` (UUID, NICHT email).
 *   - HttpKnowledgeAdapter signt damit den Per-Request-JWT (sub=userId).
 *   - mcp-knowledge2 RLS-policy filtert dann owner_id=userId.
 *
 * Owner-only-Operations:
 *   - deleteObject + revokeShare sind owner-only — der Storage-Service
 *     enforced das via RLS, der Adapter selbst macht keinen lokalen Check.
 *
 * Internal-Tail (D-10):
 *   - `eraseUser` ist ein Admin-Cascade (GDPR Article 17). Authentifiziert
 *     ueber den Service-Token (Bearer mit dem statischen SERVICE_TOKEN),
 *     NICHT ueber den User-JWT. Der Caller MUSS einen `confirmationToken`
 *     mitliefern, der serverseitig out-of-band gegen ein erase_token-Record
 *     verifiziert wird.
 *   - Response ist ein detailliertes Cascade-Summary (objects, shares,
 *     idempotency, uploads, audit_pseudonymised, blobs_deleted, blobs_pending).
 */

import type {
  CreateObjectArgs,
  KnowledgeObject,
  ObjectsList,
  SearchHit,
  Share,
  ShareScope,
} from './types.js';

/**
 * AS-3 (§1.2): User-Identity-Trio fuer OBO-Calls.
 *
 * Alle user-facing Operationen koennen optional `userEmail` +
 * `approvalId` mitgeben. Im OBO-Pfad (adapter-side serviceToken
 * konfiguriert) wandert das in den signed OBO-JWT als `on_behalf_of`
 * resp. `approval_id`-Claim. Im Legacy-Pfad (kein serviceToken) werden
 * die Felder ignoriert.
 */
export interface OnBehalfOfFields {
  /** Google-email; in OBO-JWT als `on_behalf_of` mitgesendet. */
  readonly userEmail?: string;
  /** Optional approval_id bei state-changing Tools nach Approve. */
  readonly approvalId?: string;
}

export interface GetObjectArgs extends OnBehalfOfFields {
  readonly id: string;
  readonly userId: string;
  /**
   * D-11: Server liefert `body_b64` nur wenn `?expand=body` requested. Default
   * `false` → nur Metadata.
   */
  readonly expandBody?: boolean;
}

export interface ListObjectsArgs extends OnBehalfOfFields {
  readonly userId: string;
  readonly subtype?: string;
  /**
   * Server-side prefix-match filter (`LIKE 'prefix%'`). Mutually exclusive
   * with `subtype` — passing both throws locally before the HTTP call.
   *
   * Use case: list all apps (`subtype_prefix: 'app:'`) without enumerating
   * each app-type. The Postgres B-Tree-Index on `(owner_id, subtype)` makes
   * this index-friendly because the pattern is left-anchored.
   */
  readonly subtypePrefix?: string;
  readonly limit?: number;
  /**
   * D-4: Server cursor ist Integer (Unix-ms vom letzten updatedAt). `null`
   * heisst Anfang. Wir erlauben hier `number | null`.
   */
  readonly cursor?: number | null;
}

export interface UpdateObjectArgs extends OnBehalfOfFields {
  readonly id: string;
  readonly userId: string;
  readonly patch: {
    readonly title?: string | null;
    readonly description?: string | null;
    readonly keywords?: ReadonlyArray<string> | null;
    readonly triggerHints?: string | null;
    readonly meta?: Record<string, unknown> | null;
    readonly body?: Uint8Array | string;
    readonly pinned?: boolean;
    readonly archived?: boolean;
    readonly expiresAt?: number | null;
    readonly expectedVersion?: number;
    readonly reEmbed?: boolean;
  };
}

export interface SearchArgs extends OnBehalfOfFields {
  readonly userId: string;
  readonly query: string;
  /**
   * Post-ADR-0004: free-form subtype-Filter. Storage akzeptiert
   * `subtypes: string[]` als Mehrfach-Filter (kind-agnostisch). Leeres
   * Array oder undefined → kein Filter.
   */
  readonly subtypes?: ReadonlyArray<string>;
  /**
   * Prefix-match filters analog to `subtypes`. Combinable — KC2 joins
   * via OR. e.g. `subtypePrefixes: ['app:']` for "all apps", or
   * `subtypes: ['skill'], subtypePrefixes: ['app:']` for "all skills
   * AND all apps".
   */
  readonly subtypePrefixes?: ReadonlyArray<string>;
  readonly limit?: number;
}

export interface CreateShareArgs extends OnBehalfOfFields {
  readonly resourceId: string;
  readonly userId: string;
  readonly grantedTo: string;
  readonly scope: ShareScope;
  readonly expiresAt?: number;
}

export interface ListSharesArgs extends OnBehalfOfFields {
  readonly resourceId: string;
  readonly userId: string;
}

export interface RevokeShareArgs extends OnBehalfOfFields {
  readonly shareId: string;
  readonly userId: string;
}

export interface EraseUserArgs {
  readonly userId: string;
  readonly confirmationToken: string;
  /**
   * SEC-K-016 + MUSS-§4.1.2: Optional approval-id zur Korrelation. Wird in
   * den Erase-Receipt-JWS (`payload.approval_id`) eingebettet damit
   * mcp-knowledge2 die Erase einer Approval-Spur zuordnen kann.
   */
  readonly approvalId?: string;
}

/**
 * AS-3 (§2.2 + A11): Push-Sync von approval2-User-State an KC2.
 *
 * Wird bei User-Create/Suspend/Erase aufgerufen. KC2 wiederholt die
 * users-Row in seiner eigenen users-Tabelle (citext-email-mapping).
 *
 * Authentifizierung: SERVICE_TOKEN (`Authorization: Bearer <token>`),
 * NICHT user-JWT — das ist ein Admin-/System-Call.
 */
export type UserSyncStatus = 'active' | 'invited' | 'suspended' | 'deleted';

export interface SyncUserArgs {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: UserSyncStatus;
  readonly externalId?: string;
}

export interface SyncUserResult {
  /** 'created' wenn KC2 die Row neu angelegt hat, 'updated' wenn Patch. */
  readonly status: 'created' | 'updated' | 'unchanged';
  /** KC2-side user-id (kann von approval2-id divergieren). */
  readonly kcUserId: string;
}

/**
 * D-10: Server-Response ist ein detailliertes Cascade-Summary, nicht nur eine
 * Zaehlerzeile. Wir mappen 1:1 vom Server.
 */
export interface EraseUserResult {
  readonly status: 'ok' | 'partial';
  readonly deleted: {
    readonly objects: number;
    readonly shares: number;
    readonly idempotency: number;
    readonly uploads: number;
    readonly auditPseudonymised: number;
    readonly blobsDeleted: number;
    readonly blobsPending: number;
  };
  /**
   * Backwards-compat-Alias: alte Caller lesen `result.deletedRows`. Wir
   * berechnen das aus `deleted.objects` (der Haupt-Datenkern) — siehe
   * apps/server/src/services/gdpr.ts.
   */
  readonly deletedRows: number;
}

export interface KnowledgeAdapter {
  // ---------- Objects ----------
  createObject(args: CreateObjectArgs): Promise<KnowledgeObject>;
  getObject(args: GetObjectArgs): Promise<KnowledgeObject>;
  listObjects(args: ListObjectsArgs): Promise<ObjectsList>;
  updateObject(args: UpdateObjectArgs): Promise<KnowledgeObject>;
  deleteObject(args: {
    id: string;
    userId: string;
    userEmail?: string;
    approvalId?: string;
  }): Promise<void>;

  // ---------- Sharing ----------
  createShare(args: CreateShareArgs): Promise<Share>;
  listShares(args: ListSharesArgs): Promise<ReadonlyArray<Share>>;
  revokeShare(args: RevokeShareArgs): Promise<void>;

  // ---------- Search ----------
  search(args: SearchArgs): Promise<ReadonlyArray<SearchHit>>;

  // ---------- Internal (admin only) ----------
  eraseUser(args: EraseUserArgs): Promise<EraseUserResult>;
  /**
   * AS-3: Push-Sync User-State an KC2. Wird vom UserService bei
   * Create/Suspend/Erase aufgerufen. Caller-Pflicht: SERVICE_TOKEN muss
   * konfiguriert sein.
   */
  syncUser(args: SyncUserArgs): Promise<SyncUserResult>;
}
