/**
 * Blob-Storage-Adapter.
 *
 * Portable Backend: S3-API (R2 / GCS / MinIO / AWS S3) primary, LocalFS
 * fuer Dev/Self-Host. Pro Worker/Server-Instance EIN Adapter.
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §7.2 + §13.
 *
 * Schluessel-Konvention (Phase 1 etabliert):
 *   - `objects/<id>`              — Body-Overflow (>16 KB inline)
 *   - `objects/<id>@v<n>`         — object_revisions overflow
 *   - `backup/<ts>.bin`           — D1/PG monthly dumps
 *   - `workspace/<id>/...`        — R2-Workspace-Layer (TBD)
 */

import type { Readable } from 'node:stream';

export interface BlobMeta {
  readonly key: string;
  readonly size: number;
  readonly etag?: string;
  readonly contentType?: string;
  /** Unix-ms. */
  readonly lastModified?: number;
  /** User-Metadata (S3 `x-amz-meta-*`). */
  readonly userMeta?: Readonly<Record<string, string>>;
}

export interface PutOptions {
  readonly contentType?: string;
  /** User-Metadata, wird im Backend als `x-amz-meta-*` gespeichert. */
  readonly userMeta?: Readonly<Record<string, string>>;
  /** Optional: If-Match auf existierendes ETag (Concurrency-Safe Replace). */
  readonly ifMatch?: string;
}

export interface PutResult {
  readonly key: string;
  readonly etag: string;
  readonly size: number;
}

export interface GetResult {
  readonly meta: BlobMeta;
  /** Node-Readable-Stream. Konsumenten muessen das Stream consumen oder
   *  destroyen (kein Auto-Cleanup). */
  readonly body: Readable;
}

export interface ListOptions {
  readonly prefix?: string;
  /** Pagination-Cursor von vorhergehender Response. */
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListResult {
  readonly items: ReadonlyArray<BlobMeta>;
  readonly cursor?: string;
  readonly hasMore: boolean;
}

/**
 * BlobAdapter — alle Methoden sind async.
 *
 * Multi-User: Keys MUESSEN per Caller (core-Package) bereits user-scoped
 * sein (z.B. `objects/<id>` wo `<id>` bereits owner-typisiert ist). Der
 * Adapter selbst ist user-blind.
 */
export interface BlobAdapter {
  /**
   * Schreibt einen Blob. Body kann `Uint8Array`, `Buffer`, `string`
   * (utf-8 encoded) oder `Readable` sein.
   */
  put(
    key: string,
    body: Uint8Array | string | Readable,
    opts?: PutOptions,
  ): Promise<PutResult>;

  /**
   * Liefert Body als Readable + Metadata. Wirft wenn key nicht existiert.
   */
  get(key: string): Promise<GetResult>;

  /**
   * Metadata-only. `null` wenn key nicht existiert.
   */
  head(key: string): Promise<BlobMeta | null>;

  /**
   * Idempotent: kein-throw wenn key nicht existiert.
   */
  delete(key: string): Promise<void>;

  /**
   * Listet keys mit Prefix-Filter. Pagination via cursor.
   */
  list(opts?: ListOptions): Promise<ListResult>;
}
