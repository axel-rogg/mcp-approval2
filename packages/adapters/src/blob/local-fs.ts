/**
 * LocalFsBlobAdapter — speichert Blobs als Dateien unter `baseDir`.
 *
 * Sidecar-Metadata: pro `<key>` wird `<key>.meta.json` mit
 * `{ contentType?, userMeta?, etag, lastModified }` angelegt. Damit
 * hat das Backend feature-parity zu S3 (head/userMeta/ETag).
 *
 * Use-Case: Dev/Self-Host ohne Object-Storage.
 */

import { createHash } from 'node:crypto';
import { promises as fs, createReadStream } from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import type {
  BlobAdapter,
  BlobMeta,
  GetResult,
  ListOptions,
  ListResult,
  PutOptions,
  PutResult,
} from './interface.js';

interface SidecarMeta {
  readonly contentType?: string;
  readonly userMeta?: Record<string, string>;
  readonly etag: string;
  readonly lastModified: number;
}

export interface LocalFsBlobAdapterOptions {
  /** Wurzelverzeichnis fuer alle Blobs. Wird auto-mkdir'd. */
  readonly baseDir: string;
}

function safeJoin(baseDir: string, key: string): string {
  // Verhindere Pfad-Escapes via '..'.
  const target = path.resolve(baseDir, key);
  const root = path.resolve(baseDir);
  if (!target.startsWith(root + path.sep) && target !== root) {
    throw new Error(`LocalFsBlobAdapter: path escape rejected for key "${key}"`);
  }
  return target;
}

function metaPath(filePath: string): string {
  return filePath + '.meta.json';
}

function computeEtag(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

export class LocalFsBlobAdapter implements BlobAdapter {
  private readonly baseDir: string;
  private initialized = false;

  public constructor(opts: LocalFsBlobAdapterOptions) {
    this.baseDir = opts.baseDir;
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.baseDir, { recursive: true });
    this.initialized = true;
  }

  private async readSidecar(filePath: string): Promise<SidecarMeta | null> {
    try {
      const txt = await fs.readFile(metaPath(filePath), 'utf8');
      return JSON.parse(txt) as SidecarMeta;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      throw err;
    }
  }

  public async put(
    key: string,
    body: Uint8Array | string | Readable,
    opts?: PutOptions,
  ): Promise<PutResult> {
    await this.ensureInit();
    const target = safeJoin(this.baseDir, key);
    await fs.mkdir(path.dirname(target), { recursive: true });

    let buf: Uint8Array;
    if (typeof body === 'string') {
      buf = new TextEncoder().encode(body);
    } else if (body instanceof Uint8Array) {
      buf = body;
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(
          chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array),
        );
      }
      buf = Buffer.concat(chunks);
    }

    if (opts?.ifMatch) {
      const existing = await this.readSidecar(target);
      if (existing && existing.etag !== opts.ifMatch) {
        throw new Error(
          `LocalFsBlobAdapter.put(${key}): If-Match precondition failed`,
        );
      }
    }

    const etag = computeEtag(buf);
    await fs.writeFile(target, buf);
    const sidecar: SidecarMeta = {
      etag,
      lastModified: Date.now(),
      ...(opts?.contentType !== undefined && { contentType: opts.contentType }),
      ...(opts?.userMeta !== undefined && { userMeta: { ...opts.userMeta } }),
    };
    await fs.writeFile(metaPath(target), JSON.stringify(sidecar), 'utf8');

    return { key, etag, size: buf.byteLength };
  }

  public async get(key: string): Promise<GetResult> {
    await this.ensureInit();
    const target = safeJoin(this.baseDir, key);
    const stat = await fs.stat(target);
    const sidecar = await this.readSidecar(target);
    const stream = createReadStream(target);
    const meta: {
      -readonly [K in keyof BlobMeta]: BlobMeta[K];
    } = {
      key,
      size: stat.size,
      lastModified: stat.mtimeMs,
    };
    if (sidecar) {
      meta.etag = sidecar.etag;
      if (sidecar.contentType !== undefined) {
        meta.contentType = sidecar.contentType;
      }
      if (sidecar.userMeta !== undefined) {
        meta.userMeta = sidecar.userMeta;
      }
    }
    return { meta, body: stream };
  }

  public async head(key: string): Promise<BlobMeta | null> {
    await this.ensureInit();
    const target = safeJoin(this.baseDir, key);
    try {
      const stat = await fs.stat(target);
      const sidecar = await this.readSidecar(target);
      const meta: {
        -readonly [K in keyof BlobMeta]: BlobMeta[K];
      } = {
        key,
        size: stat.size,
        lastModified: stat.mtimeMs,
      };
      if (sidecar) {
        meta.etag = sidecar.etag;
        if (sidecar.contentType !== undefined) {
          meta.contentType = sidecar.contentType;
        }
        if (sidecar.userMeta !== undefined) {
          meta.userMeta = sidecar.userMeta;
        }
      }
      return meta;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      throw err;
    }
  }

  public async delete(key: string): Promise<void> {
    await this.ensureInit();
    const target = safeJoin(this.baseDir, key);
    await fs.rm(target, { force: true });
    await fs.rm(metaPath(target), { force: true });
  }

  public async list(opts?: ListOptions): Promise<ListResult> {
    await this.ensureInit();
    const prefix = opts?.prefix ?? '';
    const limit = opts?.limit ?? 1000;
    const cursor = opts?.cursor;
    const allItems: BlobMeta[] = [];

    async function walk(dir: string, rel: string): Promise<void> {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return;
        throw err;
      }
      // Sortiert deterministisch.
      entries.sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const e of entries) {
        const childAbs = path.join(dir, e.name);
        const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) {
          await walk(childAbs, childRel);
          continue;
        }
        if (childRel.endsWith('.meta.json')) continue;
        if (!childRel.startsWith(prefix)) continue;
        const stat = await fs.stat(childAbs);
        allItems.push({
          key: childRel,
          size: stat.size,
          lastModified: stat.mtimeMs,
        });
      }
    }

    await walk(this.baseDir, '');

    // Cursor: numerischer Offset (encoded). Einfach + ausreichend fuer Dev.
    const offset = cursor ? Number.parseInt(cursor, 10) : 0;
    const slice = allItems.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;
    const hasMore = nextOffset < allItems.length;
    const result: {
      -readonly [K in keyof ListResult]: ListResult[K];
    } = {
      items: slice,
      hasMore,
    };
    if (hasMore) {
      result.cursor = String(nextOffset);
    }
    return result;
  }
}
