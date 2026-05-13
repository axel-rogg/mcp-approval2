/**
 * OutputRefsService — TTL-cached Tool-Outputs (Blob-Storage).
 *
 * Plan-Ref: mcp-approval/outputs (Phase 8.5b'), portiert nach mcp-approval2.
 *
 * Use-Case: grosse Tool-Outputs (LLM-Responses, generierte Bilder, PDFs) sollen
 * nicht den Agent-Context fluten. Statt inline returnen, packen wir den
 * Payload in den Blob-Storage und geben einen Ref-String zurueck. Der Agent
 * holt den Inhalt nur dann ueber `resolve()`, wenn er die Bytes wirklich
 * braucht (z.B. um sie an ein anderes Tool weiterzureichen).
 *
 * Schwelle: text ≥ 8000 chars, binary ≥ 50 KB → in Blob; sonst inline.
 *
 * Storage-Layout:
 *   - Key: `output_refs/<userId>/<ref-ulid>` (owner-scoped Prefix)
 *   - userMeta:
 *       owner_id    — Owner-UUID (Defense-in-Depth zusaetzlich zum Key-Prefix)
 *       expires_at  — Unix-ms; nach diesem Punkt darf `resolve()` 410 zurueckgeben
 *       created_at  — Unix-ms
 *       is_binary   — '1' wenn Uint8Array, '0' wenn string
 *   - Body: rohes content (string-UTF8 oder Uint8Array)
 *
 * Owner-Only: Caller-Pflicht — `resolve()` matched `userId` gegen
 * `userMeta.owner_id`. Ein anderer User mit korrektem Ref bekommt 403.
 *
 * Cleanup: `cleanupExpired()` listet den `output_refs/`-Prefix, prueft
 * userMeta.expires_at und loescht abgelaufene Eintraege. Idempotent (mehrfache
 * Calls leeren immer nur was abgelaufen ist).
 */
import { randomUuidV4 } from '@mcp-approval2/core';
import type { BlobAdapter } from '@mcp-approval2/adapters';

export const DEFAULT_TTL_SEC = 24 * 60 * 60; // 24h
export const MAX_TTL_SEC = 7 * 24 * 60 * 60; // 7d

export const INLINE_TEXT_CHARS = 8000;
export const INLINE_BINARY_BYTES = 50_000;

const KEY_PREFIX = 'output_refs/';

export interface StoreOutputArgs {
  readonly userId: string;
  readonly content: string | Uint8Array;
  readonly ttlSec?: number;
}

export interface StoreOutputResult {
  readonly ref: string;
  readonly expiresAt: number;
}

export interface ResolveOutputArgs {
  readonly ref: string;
  readonly userId: string;
}

export interface ResolveOutputResult {
  readonly content: string | Uint8Array;
}

export interface CleanupResult {
  readonly deleted: number;
}

export interface OutputRefsService {
  store(args: StoreOutputArgs): Promise<StoreOutputResult>;
  resolve(args: ResolveOutputArgs): Promise<ResolveOutputResult | null>;
  cleanupExpired(): Promise<CleanupResult>;
  /** Hilfs-Helper fuer Tool-Callsites: muss content via store() persistiert werden? */
  shouldUseRef(content: string | Uint8Array): boolean;
}

export interface OutputRefsServiceOptions {
  readonly blob: BlobAdapter;
  /** Optional fuer Tests: liefert aktuelle Unix-ms. Default `Date.now`. */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function keyFor(userId: string, ref: string): string {
  return `${KEY_PREFIX}${userId}/${ref}`;
}

function parseUserMeta(
  raw: Readonly<Record<string, string>> | undefined,
): { ownerId: string; expiresAt: number; isBinary: boolean } | null {
  if (!raw) return null;
  const ownerId = raw['owner_id'];
  const expiresAtStr = raw['expires_at'];
  if (!ownerId || !expiresAtStr) return null;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt)) return null;
  const isBinary = raw['is_binary'] === '1';
  return { ownerId, expiresAt, isBinary };
}

async function streamToBytes(body: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    if (chunk instanceof Buffer) {
      chunks.push(chunk);
    } else if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk, 'utf8'));
    } else if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk));
    } else if (typeof chunk === 'number') {
      // `Readable.from(Uint8Array)` iterates per byte — collect them into a byte array.
      chunks.push(Buffer.from([chunk]));
    } else {
      // ArrayBuffer / typed-array path
      chunks.push(Buffer.from(chunk as ArrayBuffer));
    }
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createOutputRefsService(
  opts: OutputRefsServiceOptions,
): OutputRefsService {
  const { blob } = opts;
  const now = opts.now ?? (() => Date.now());

  return {
    shouldUseRef(content) {
      if (typeof content === 'string') return content.length > INLINE_TEXT_CHARS;
      return content.byteLength > INLINE_BINARY_BYTES;
    },

    async store(args) {
      const ref = randomUuidV4();
      const ttl = Math.min(
        Math.max(args.ttlSec ?? DEFAULT_TTL_SEC, 1),
        MAX_TTL_SEC,
      );
      const createdAt = now();
      const expiresAt = createdAt + ttl * 1000;
      const isBinary = typeof args.content !== 'string';

      const body: Uint8Array | string =
        typeof args.content === 'string' ? args.content : args.content;

      await blob.put(keyFor(args.userId, ref), body, {
        contentType: isBinary ? 'application/octet-stream' : 'text/plain; charset=utf-8',
        userMeta: {
          owner_id: args.userId,
          expires_at: String(expiresAt),
          created_at: String(createdAt),
          is_binary: isBinary ? '1' : '0',
        },
      });

      return { ref, expiresAt };
    },

    async resolve(args) {
      const key = keyFor(args.userId, args.ref);
      const head = await blob.head(key);
      if (!head) return null;

      const meta = parseUserMeta(head.userMeta);
      if (!meta) return null;
      if (meta.ownerId !== args.userId) return null;
      if (now() > meta.expiresAt) return null;

      const got = await blob.get(key);
      const bytes = await streamToBytes(got.body);
      const content: string | Uint8Array = meta.isBinary
        ? bytes
        : new TextDecoder().decode(bytes);
      return { content };
    },

    async cleanupExpired() {
      const ts = now();
      let deleted = 0;
      let cursor: string | undefined;

      do {
        const listOpts: { prefix: string; cursor?: string } = {
          prefix: KEY_PREFIX,
        };
        if (cursor !== undefined) listOpts.cursor = cursor;
        const page = await blob.list(listOpts);
        for (const item of page.items) {
          // `list()` enthaelt nicht garantiert userMeta — bei LocalFsBlobAdapter
          // wird das Sidecar nicht in den List-Items mitgezogen. Daher `head()`
          // pro key (1 extra Roundtrip). Bei S3 spart ein parallel-Pattern Zeit;
          // hier reicht serial — Cleanup laeuft im Cron.
          const head = item.userMeta ? item : await blob.head(item.key);
          if (!head) continue;
          const meta = parseUserMeta(head.userMeta);
          // Wenn UserMeta nicht parsebar ist (fehlende fields), aggressiv ueberspringen
          // statt zu loeschen — sonst ueberraschende Datenverluste bei Schema-Drift.
          if (!meta) continue;
          if (ts > meta.expiresAt) {
            await blob.delete(item.key);
            deleted++;
          }
        }
        cursor = page.cursor;
        if (!page.hasMore) cursor = undefined;
      } while (cursor !== undefined);

      return { deleted };
    },
  };
}
