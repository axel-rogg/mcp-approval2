/**
 * Knowledge-Service Types.
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §2.1 + §7.
 *
 * Diese Types definieren die Wire-Shape zwischen mcp-approval2 (Caller) und
 * mcp-knowledge2 (Storage-Service). Sie sind explizit Caller-seitig
 * dokumentiert — autoritativ wird das Schema erst, wenn der paralleler
 * mcp-knowledge2-Plan finalisiert ist und das Wire-Format gegengezeichnet
 * wurde (siehe §2.1 Konsolidierungs-Hinweis).
 *
 * Body-Encoding-Konvention (aus dem v1-Hub uebernommen):
 *   - `body_inline` <= 16 KB encrypted ciphertext (BLOB)
 *   - sonst `r2_key = 'objects/<id>'` im Blob-Store
 * Der Adapter selbst sieht die Bodies nicht entschluesselt — Crypto liegt
 * in mcp-knowledge2.
 */

export type ObjectKind = 'doc' | 'skill' | 'app' | 'memo';

export type ShareScope = 'read' | 'write';

/**
 * KnowledgeObject — die kanonische Read-Form, wie mcp-knowledge2 sie zurueckgibt.
 *
 * Felder folgen dem Plan §7.2-Schema. `body` ist optional und nur in
 * Read-Responses populated (Plain-Text nach Storage-side Decryption).
 */
export interface KnowledgeObject {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: ObjectKind;
  readonly subtype: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly keywords: ReadonlyArray<string>;
  readonly body: string | null;
  readonly bodyHash: string | null;
  readonly visibility: 'private' | 'shared';
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
}

export interface CreateObjectArgs {
  readonly userId: string;
  readonly kind: ObjectKind;
  readonly subtype?: string;
  readonly title?: string;
  readonly description?: string;
  readonly keywords?: ReadonlyArray<string>;
  readonly body?: string;
  readonly visibility?: 'private' | 'shared';
}

export interface ObjectsList {
  readonly items: ReadonlyArray<KnowledgeObject>;
  readonly cursor: string | null;
  readonly hasMore: boolean;
}

export interface Share {
  readonly id: string;
  readonly resourceId: string;
  readonly resourceKind: ObjectKind;
  readonly grantedBy: string;
  readonly grantedTo: string;
  readonly scope: ShareScope;
  readonly createdAt: number;
  readonly revokedAt: number | null;
}

export interface SearchHit {
  readonly id: string;
  readonly kind: ObjectKind;
  readonly subtype: string | null;
  readonly title: string | null;
  readonly snippet: string | null;
  readonly score: number;
  readonly ownerId: string;
  readonly sharedToMe: boolean;
}
