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
  ObjectKind,
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
  readonly kind?: ObjectKind;
  readonly subtype?: string;
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
   * D-9 (joint): Server akzeptiert SINGLE `kind` heute. Multi-kind ist als
   * Follow-up gequeued. Adapter sendet:
   *   - wenn kinds.length === 1 → server `kind: ObjectKind`
   *   - wenn kinds.length > 1   → server `kind: ObjectKind[]` (forward-compatible,
   *     wird heute server-seitig silently ignoriert / multi-kind-Follow-up)
   *   - wenn kinds undefined    → kein Filter
   */
  readonly kinds?: ReadonlyArray<ObjectKind>;
  readonly limit?: number;
}

export interface CreateShareArgs extends OnBehalfOfFields {
  readonly resourceId: string;
  /**
   * D-6: server leitet resourceKind aus dem Object-Row ab. Wir behalten das
   * Feld im Caller-Args (fuer Audit-Logging), schicken es aber NICHT mit.
   */
  readonly resourceKind: ObjectKind;
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
