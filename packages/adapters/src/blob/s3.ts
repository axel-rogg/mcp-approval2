/**
 * S3-BlobAdapter — funktioniert mit R2 / MinIO / GCS-S3-API / AWS S3.
 *
 * Endpoint-Override via `endpoint` (z.B. `https://<accountid>.r2.cloudflarestorage.com`
 * fuer R2 oder `http://localhost:9000` fuer lokales MinIO).
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §7.2 + §13.
 */

import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';

import type {
  BlobAdapter,
  BlobMeta,
  GetResult,
  ListOptions,
  ListResult,
  PutOptions,
  PutResult,
} from './interface.js';

export interface S3BlobAdapterOptions {
  readonly bucket: string;
  readonly region: string;
  /** S3-API-Endpoint. R2: `https://<accountId>.r2.cloudflarestorage.com`. */
  readonly endpoint?: string;
  /** Path-style addressing (notwendig fuer MinIO + R2). Default: true. */
  readonly forcePathStyle?: boolean;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  /** Injected client (fuer Tests). */
  readonly client?: S3Client;
}

function toBlobMeta(
  key: string,
  size: number,
  etag: string | undefined,
  contentType: string | undefined,
  lastModified: Date | undefined,
  userMeta: Record<string, string> | undefined,
): BlobMeta {
  const meta: {
    -readonly [K in keyof BlobMeta]: BlobMeta[K];
  } = {
    key,
    size,
  };
  if (etag !== undefined) meta.etag = etag;
  if (contentType !== undefined) meta.contentType = contentType;
  if (lastModified !== undefined) meta.lastModified = lastModified.getTime();
  if (userMeta !== undefined) meta.userMeta = userMeta;
  return meta;
}

export class S3BlobAdapter implements BlobAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;

  public constructor(opts: S3BlobAdapterOptions) {
    this.bucket = opts.bucket;
    if (opts.client) {
      this.client = opts.client;
    } else {
      const cfg: S3ClientConfig = {
        region: opts.region,
        forcePathStyle: opts.forcePathStyle ?? true,
      };
      if (opts.endpoint !== undefined) {
        cfg.endpoint = opts.endpoint;
      }
      if (opts.accessKeyId !== undefined && opts.secretAccessKey !== undefined) {
        cfg.credentials = {
          accessKeyId: opts.accessKeyId,
          secretAccessKey: opts.secretAccessKey,
        };
      }
      this.client = new S3Client(cfg);
    }
  }

  public async put(
    key: string,
    body: Uint8Array | string | Readable,
    opts?: PutOptions,
  ): Promise<PutResult> {
    let buf: Uint8Array;
    if (typeof body === 'string') {
      buf = new TextEncoder().encode(body);
    } else if (body instanceof Uint8Array) {
      buf = body;
    } else {
      // Readable -> Buffer (S3 SDK can handle streams, but we want size for
      // PutResult.size; concat keeps the contract simple).
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(
          chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array),
        );
      }
      buf = Buffer.concat(chunks);
    }

    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: buf,
      ContentType: opts?.contentType,
      ContentLength: buf.byteLength,
      Metadata: opts?.userMeta ? { ...opts.userMeta } : undefined,
      IfMatch: opts?.ifMatch,
    });
    const res = await this.client.send(cmd);
    return {
      key,
      etag: (res.ETag ?? '').replace(/^"|"$/g, ''),
      size: buf.byteLength,
    };
  }

  public async get(key: string): Promise<GetResult> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    const res = await this.client.send(cmd);
    if (!res.Body) {
      throw new Error(`S3BlobAdapter.get(${key}): empty body`);
    }
    const stream = res.Body as unknown as Readable;
    const meta = toBlobMeta(
      key,
      Number(res.ContentLength ?? 0),
      res.ETag?.replace(/^"|"$/g, ''),
      res.ContentType,
      res.LastModified,
      res.Metadata,
    );
    return { meta, body: stream };
  }

  public async head(key: string): Promise<BlobMeta | null> {
    try {
      const cmd = new HeadObjectCommand({ Bucket: this.bucket, Key: key });
      const res = await this.client.send(cmd);
      return toBlobMeta(
        key,
        Number(res.ContentLength ?? 0),
        res.ETag?.replace(/^"|"$/g, ''),
        res.ContentType,
        res.LastModified,
        res.Metadata,
      );
    } catch (err) {
      if (err instanceof NotFound || err instanceof NoSuchKey) {
        return null;
      }
      // Some endpoints return 404 with a generic name; check status code.
      const status = (err as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw err;
    }
  }

  public async delete(key: string): Promise<void> {
    const cmd = new DeleteObjectCommand({ Bucket: this.bucket, Key: key });
    await this.client.send(cmd);
  }

  public async list(opts?: ListOptions): Promise<ListResult> {
    const cmd = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: opts?.prefix,
      ContinuationToken: opts?.cursor,
      MaxKeys: opts?.limit,
    });
    const res = await this.client.send(cmd);
    const items: BlobMeta[] = (res.Contents ?? []).map((obj) =>
      toBlobMeta(
        obj.Key ?? '',
        Number(obj.Size ?? 0),
        obj.ETag?.replace(/^"|"$/g, ''),
        undefined,
        obj.LastModified,
        undefined,
      ),
    );
    const result: {
      -readonly [K in keyof ListResult]: ListResult[K];
    } = {
      items,
      hasMore: Boolean(res.IsTruncated),
    };
    if (res.NextContinuationToken !== undefined) {
      result.cursor = res.NextContinuationToken;
    }
    return result;
  }
}
