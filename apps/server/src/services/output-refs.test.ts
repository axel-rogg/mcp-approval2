/**
 * Unit-Tests fuer OutputRefsService.
 *
 * Scope:
 *   - store + resolve roundtrip (text + binary)
 *   - owner-binding (anderer userId bekommt null)
 *   - expire ueber TTL-Cap
 *   - cleanupExpired loescht abgelaufene, behaelt frische
 *   - shouldUseRef-Schwellen
 *
 * Mock: in-memory BlobAdapter (Map<key, {body, userMeta, contentType}>),
 * der den minimal noetigen BlobAdapter-Surface implementiert.
 */
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import type {
  BlobAdapter,
  BlobMeta,
  GetResult,
  ListOptions,
  ListResult,
  PutOptions,
  PutResult,
} from '@mcp-approval2/adapters';
import {
  createOutputRefsService,
  INLINE_BINARY_BYTES,
  INLINE_TEXT_CHARS,
  DEFAULT_TTL_SEC,
} from './output-refs.js';

interface BlobEntry {
  body: Uint8Array;
  userMeta?: Record<string, string>;
  contentType?: string;
  lastModified: number;
}

function makeMemoryBlob(): BlobAdapter & { _store: Map<string, BlobEntry> } {
  const store = new Map<string, BlobEntry>();

  return {
    _store: store,

    async put(key, body, opts?: PutOptions): Promise<PutResult> {
      let buf: Uint8Array;
      if (typeof body === 'string') {
        buf = new TextEncoder().encode(body);
      } else if (body instanceof Uint8Array) {
        buf = body;
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of body) {
          chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array));
        }
        buf = Buffer.concat(chunks);
      }
      const entry: BlobEntry = {
        body: buf,
        lastModified: Date.now(),
      };
      if (opts?.userMeta) entry.userMeta = { ...opts.userMeta };
      if (opts?.contentType) entry.contentType = opts.contentType;
      store.set(key, entry);
      return { key, etag: String(buf.byteLength), size: buf.byteLength };
    },

    async get(key): Promise<GetResult> {
      const e = store.get(key);
      if (!e) throw new Error(`not found: ${key}`);
      const meta: BlobMeta = {
        key,
        size: e.body.byteLength,
        lastModified: e.lastModified,
        ...(e.contentType !== undefined && { contentType: e.contentType }),
        ...(e.userMeta !== undefined && { userMeta: e.userMeta }),
      };
      // `Readable.from(Uint8Array)` would iterate per-byte (numbers). Wrap in
      // an array so the stream emits a single Buffer chunk.
      return { meta, body: Readable.from([Buffer.from(e.body)]) };
    },

    async head(key): Promise<BlobMeta | null> {
      const e = store.get(key);
      if (!e) return null;
      return {
        key,
        size: e.body.byteLength,
        lastModified: e.lastModified,
        ...(e.contentType !== undefined && { contentType: e.contentType }),
        ...(e.userMeta !== undefined && { userMeta: e.userMeta }),
      };
    },

    async delete(key): Promise<void> {
      store.delete(key);
    },

    async list(opts?: ListOptions): Promise<ListResult> {
      const prefix = opts?.prefix ?? '';
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .sort();
      const items: BlobMeta[] = keys.map((key) => {
        const e = store.get(key);
        return {
          key,
          size: e ? e.body.byteLength : 0,
          lastModified: e?.lastModified ?? 0,
        };
      });
      return { items, hasMore: false };
    },
  };
}

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

describe('OutputRefsService', () => {
  describe('shouldUseRef', () => {
    it('text below threshold → false', () => {
      const svc = createOutputRefsService({ blob: makeMemoryBlob() });
      expect(svc.shouldUseRef('x'.repeat(INLINE_TEXT_CHARS))).toBe(false);
      expect(svc.shouldUseRef('x'.repeat(INLINE_TEXT_CHARS + 1))).toBe(true);
    });

    it('binary below threshold → false', () => {
      const svc = createOutputRefsService({ blob: makeMemoryBlob() });
      expect(svc.shouldUseRef(new Uint8Array(INLINE_BINARY_BYTES))).toBe(false);
      expect(svc.shouldUseRef(new Uint8Array(INLINE_BINARY_BYTES + 1))).toBe(true);
    });
  });

  describe('store + resolve', () => {
    it('text roundtrip', async () => {
      const blob = makeMemoryBlob();
      const svc = createOutputRefsService({ blob });
      const big = 'hello-'.repeat(2000); // ~12 KB
      const stored = await svc.store({ userId: USER_A, content: big });
      expect(stored.ref).toMatch(/^[0-9a-f-]{36}$/);
      expect(stored.expiresAt).toBeGreaterThan(Date.now());

      const resolved = await svc.resolve({ ref: stored.ref, userId: USER_A });
      expect(resolved).not.toBeNull();
      expect(resolved!.content).toBe(big);
    });

    it('binary roundtrip', async () => {
      const blob = makeMemoryBlob();
      const svc = createOutputRefsService({ blob });
      const bytes = new Uint8Array(60_000);
      for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;

      const stored = await svc.store({ userId: USER_A, content: bytes });
      const resolved = await svc.resolve({ ref: stored.ref, userId: USER_A });
      expect(resolved).not.toBeNull();
      expect(resolved!.content).toBeInstanceOf(Uint8Array);
      expect((resolved!.content as Uint8Array).byteLength).toBe(60_000);
      expect((resolved!.content as Uint8Array)[100]).toBe(100);
    });

    it('default TTL ≈ 24h', async () => {
      const blob = makeMemoryBlob();
      const fixedNow = 1_700_000_000_000;
      const svc = createOutputRefsService({ blob, now: () => fixedNow });
      const stored = await svc.store({ userId: USER_A, content: 'tiny' });
      expect(stored.expiresAt).toBe(fixedNow + DEFAULT_TTL_SEC * 1000);
    });

    it('returns null for non-existent ref', async () => {
      const svc = createOutputRefsService({ blob: makeMemoryBlob() });
      const got = await svc.resolve({ ref: 'does-not-exist', userId: USER_A });
      expect(got).toBeNull();
    });

    it('owner-binding: user B cannot resolve user A ref', async () => {
      const blob = makeMemoryBlob();
      const svc = createOutputRefsService({ blob });
      const stored = await svc.store({ userId: USER_A, content: 'secret' });
      // Key prefix already scopes by userId — User B's request hits a non-
      // existing key. Owner-binding fail returns null (same as not-found).
      const got = await svc.resolve({ ref: stored.ref, userId: USER_B });
      expect(got).toBeNull();
    });

    it('expired ref → null', async () => {
      const blob = makeMemoryBlob();
      let nowVal = 1_700_000_000_000;
      const svc = createOutputRefsService({ blob, now: () => nowVal });
      const stored = await svc.store({
        userId: USER_A,
        content: 'short-lived',
        ttlSec: 60,
      });
      nowVal = stored.expiresAt + 1;
      const got = await svc.resolve({ ref: stored.ref, userId: USER_A });
      expect(got).toBeNull();
    });
  });

  describe('cleanupExpired', () => {
    it('removes only expired entries', async () => {
      const blob = makeMemoryBlob();
      let nowVal = 1_700_000_000_000;
      const svc = createOutputRefsService({ blob, now: () => nowVal });

      const expired = await svc.store({
        userId: USER_A,
        content: 'expired-soon',
        ttlSec: 60,
      });
      nowVal += 30 * 1000;
      const fresh = await svc.store({
        userId: USER_A,
        content: 'fresh',
        ttlSec: 3600,
      });

      // jump past the first TTL but not the second
      nowVal = expired.expiresAt + 1;
      const result = await svc.cleanupExpired();
      expect(result.deleted).toBe(1);

      // expired one is gone, fresh one survives
      expect(await svc.resolve({ ref: expired.ref, userId: USER_A })).toBeNull();
      const stillThere = await svc.resolve({ ref: fresh.ref, userId: USER_A });
      expect(stillThere).not.toBeNull();
    });

    it('idempotent — running twice with nothing to delete is fine', async () => {
      const blob = makeMemoryBlob();
      const svc = createOutputRefsService({ blob });
      await svc.store({ userId: USER_A, content: 'fresh', ttlSec: 3600 });
      const r1 = await svc.cleanupExpired();
      const r2 = await svc.cleanupExpired();
      expect(r1.deleted).toBe(0);
      expect(r2.deleted).toBe(0);
    });
  });
});
