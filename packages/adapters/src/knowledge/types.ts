/**
 * Knowledge-Service Types.
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §2.1 + §7.
 *
 * Diese Types definieren die Wire-Shape zwischen mcp-approval2 (Caller) und
 * mcp-knowledge2 (Storage-Service). Stand 2026-05-13 sind sie aligned mit
 * `/workspaces/mcp-knowledge2/docs/openapi.yaml` + dem CROSS-SERVICE-CONTRACT.md
 * (Drifts D-1..D-12 resolved; siehe `docs/CROSS-SERVICE-CONTRACT-RESOLUTION.md`).
 *
 * Body-Encoding-Konvention (Server-Seite, fuer Kontext):
 *   - Inline-Body wird base64-encoded als `body_b64` ueber die HTTP-Wire
 *     gereicht (Create: required min 1, Update: optional). Server speichert
 *     intern in `blob_key` (DB-Spalte, NICHT wire-sichtbar) — entweder
 *     inline-BLOB oder S3-Objekt. D-12: das alte `r2_key` ist Legacy aus
 *     dem v1-Hub und kommt im Wire-Protokoll nicht vor.
 *   - Read: Body kommt NUR mit `?expand=body` als `body_b64` (base64-encoded).
 *     Standard-Reads liefern nur Metadata (bodySize/bodyHash).
 */

export type ShareScope = 'read' | 'write';

/**
 * KnowledgeObject — die kanonische Read-Form, wie mcp-knowledge2 sie zurueckgibt.
 *
 * Felder spiegeln das Server-Schema (`/v1/objects` ObjectView) wider. Body ist
 * nur populated wenn `?expand=body` requested wurde — dann als base64-string.
 *
 * Naming-Hinweis: Server emittiert die Felder camelCase (ownerId, bodySize,
 * mimeType, ...) im JSON-Envelope.
 */
export interface KnowledgeObject {
  readonly id: string;
  readonly ownerId: string;
  readonly subtype?: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly keywords: ReadonlyArray<string> | null;
  readonly triggerHints: string | null;
  readonly meta: Record<string, unknown> | null;
  readonly bodySize: number;
  readonly bodyHash: string | null;
  readonly mimeType: string | null;
  readonly filename: string | null;
  readonly visibility: 'private' | 'shared';
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly refcount: number;
  readonly currentVersion: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastUsedAt: number | null;
  /**
   * Base64-encoded body. Nur populated wenn `?expand=body` requested wurde.
   * Caller-Side decode: `Buffer.from(body, 'base64')` → Uint8Array.
   */
  readonly body?: string | null;
}

export interface CreateObjectArgs {
  readonly userId: string;
  /**
   * AS-3 (§1.2): optional `on_behalf_of`-Email fuer den OBO-JWT. Wird im
   * Legacy-Pfad ignoriert. Siehe `OnBehalfOfFields` in interface.ts.
   */
  readonly userEmail?: string;
  /**
   * AS-3 (§1.5): bei state-changing Calls nach Approve, von der
   * Approval-Resolve-Pipeline gesetzt. Wandert in den OBO-JWT als
   * `approval_id`-Claim → KC2-Audit `via_proxy=true, approval_id=<…>`.
   */
  readonly approvalId?: string;
  readonly subtype?: string;
  readonly title?: string;
  readonly description?: string;
  readonly keywords?: ReadonlyArray<string>;
  readonly triggerHints?: string;
  readonly meta?: Record<string, unknown>;
  /**
   * Body als rohe Bytes ODER UTF-8-String. Der Adapter base64-encodet und
   * schickt das als `body_b64` ans Server-DTO (D-2). Server erfordert
   * mindestens 1 Byte — `undefined` → request schlaegt fehl. Wenn kein Body
   * gewuenscht: `body: ''` oder `new Uint8Array([0])` setzen (Server-side
   * Min-Length-Schutz).
   */
  readonly body?: Uint8Array | string;
  readonly mimeType?: string;
  readonly filename?: string;
  /** Server-side Embedding via Vertex/bge-m3 antriggern (D-3). */
  readonly embed?: boolean;
  readonly visibility?: 'private' | 'shared';
}

/**
 * Server liefert `{items, next_cursor}` — `next_cursor` ist ein Integer
 * (Unix-ms vom letzten `updatedAt`). `null` heisst "Ende erreicht".
 */
export interface ObjectsList {
  readonly items: ReadonlyArray<KnowledgeObject>;
  readonly nextCursor: number | null;
}

/**
 * ShareView vom Server. Post-generic-object-model (ADR-0004): kein
 * `resourceKind` mehr — Caller laesst sich via JOIN auf `objects.subtype`
 * den Discriminator nachziehen, falls noetig. `grantedAt` (NICHT
 * `createdAt`) — D-7.
 */
export interface Share {
  readonly id: string;
  readonly resourceId: string;
  readonly grantedBy: string;
  readonly grantedTo: string;
  readonly scope: ShareScope;
  readonly grantedAt: number;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
}

/**
 * SearchHit — D-9 documented: server akzeptiert subtype-Filter via
 * `subtypes`-Array. Score-Felder `ftsRank` + `vectorScore` (camelCase)
 * sind im Hit enthalten.
 */
export interface SearchHit {
  readonly id: string;
  readonly subtype?: string | null;
  readonly title: string | null;
  readonly score: number;
  readonly ftsRank: number | null;
  readonly vectorScore: number | null;
}
