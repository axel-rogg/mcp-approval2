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
 *   - JEDE Methode nimmt `userId` (UUID, NICHT email).
 *   - HttpKnowledgeAdapter signt damit den Per-Request-JWT (sub=userId).
 *   - mcp-knowledge2 RLS-policy filtert dann owner_id=userId.
 *
 * Owner-only-Operations:
 *   - deleteObject + revokeShare sind owner-only — der Storage-Service
 *     enforced das via RLS, der Adapter selbst macht keinen lokalen Check.
 *
 * Internal-Tail:
 *   - eraseUser ist ein Admin-Cascade (GDPR Article 17). Der Caller MUSS
 *     einen `confirmationToken` mitliefern, der serverseitig out-of-band
 *     gegen ein erase_token-Record verifiziert wird. Adapter sieht das nur
 *     als Pass-through.
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

export interface ListObjectsArgs {
  readonly userId: string;
  readonly kind?: ObjectKind;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface UpdateObjectArgs {
  readonly id: string;
  readonly userId: string;
  readonly patch: Partial<Omit<KnowledgeObject, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>>;
}

export interface SearchArgs {
  readonly userId: string;
  readonly query: string;
  readonly kinds?: ReadonlyArray<ObjectKind>;
  readonly limit?: number;
}

export interface CreateShareArgs {
  readonly resourceId: string;
  readonly resourceKind: ObjectKind;
  readonly userId: string;
  readonly grantedTo: string;
  readonly scope: ShareScope;
}

export interface ListSharesArgs {
  readonly resourceId: string;
  readonly userId: string;
}

export interface RevokeShareArgs {
  readonly shareId: string;
  readonly userId: string;
}

export interface EraseUserArgs {
  readonly userId: string;
  readonly confirmationToken: string;
}

export interface EraseUserResult {
  readonly deletedRows: number;
}

export interface KnowledgeAdapter {
  // ---------- Objects ----------
  createObject(args: CreateObjectArgs): Promise<KnowledgeObject>;
  getObject(args: { id: string; userId: string }): Promise<KnowledgeObject>;
  listObjects(args: ListObjectsArgs): Promise<ObjectsList>;
  updateObject(args: UpdateObjectArgs): Promise<KnowledgeObject>;
  deleteObject(args: { id: string; userId: string }): Promise<void>;

  // ---------- Sharing ----------
  createShare(args: CreateShareArgs): Promise<Share>;
  listShares(args: ListSharesArgs): Promise<ReadonlyArray<Share>>;
  revokeShare(args: RevokeShareArgs): Promise<void>;

  // ---------- Search ----------
  search(args: SearchArgs): Promise<ReadonlyArray<SearchHit>>;

  // ---------- Internal (admin only) ----------
  eraseUser(args: EraseUserArgs): Promise<EraseUserResult>;
}
