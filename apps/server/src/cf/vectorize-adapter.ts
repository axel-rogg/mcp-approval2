/**
 * VectorizeAdapter — Cloudflare Vectorize as the pgvector replacement.
 *
 * The Node deploy uses Postgres + pgvector (one row per embedding, indexed by
 * IVFFlat). The CF deploy maps the same operations onto Vectorize:
 *
 *   - Namespacing: Vectorize has no native per-tenant scoping. We FLATTEN the
 *     namespace into the vector id (`${namespace}:${id}`) AND mirror it as a
 *     filterable metadata field (`metadata.namespace`). Both are belt-and-
 *     suspenders: queries pass `filter: { namespace }`, and bulk-deletes use
 *     the prefixed id. The metadata field is mandatory — the post-filter on
 *     query() requires it. Repositories MUST NOT bypass the namespace
 *     parameter or multi-tenant safety collapses.
 *
 *   - Dimensions: index is created at 768. If your embedding model differs
 *     (e.g. text-embedding-3-small=1536), recreate the index — Vectorize is
 *     immutable in dimension/metric. See deploy.sh.
 *
 *   - Eventually-consistent: upsert is durable immediately, but query() lags
 *     behind by minutes on the free tier. Repositories must NOT assume read-
 *     your-writes — index after writes, query against the post-eventual state.
 *
 * Plan-Ref: docs/plans/active/PLAN-architecture-v1.md §8.
 */
import type {
  VectorizeIndex,
  VectorizeMatch,
  VectorizeVector,
} from '@cloudflare/workers-types';

/**
 * Adapter contract is local to the CF deploy — the Node side uses pgvector
 * inline in repository code. If/when we promote a shared VecAdapter into
 * `@mcp-approval2/adapters`, these types should move there 1:1.
 */
export interface VectorRecord {
  readonly id: string;
  readonly values: Float32Array | ReadonlyArray<number>;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface QueryOpts {
  readonly topK?: number;
  /**
   * Additional metadata filter, AND-merged with the namespace filter. Keys
   * must match Vectorize's filterable-metadata config (see deploy.sh — we
   * declare `namespace`, `owner_id`, `kind`).
   */
  readonly filter?: Readonly<Record<string, string | number | boolean>>;
  /** Include the raw vector values in matches. Defaults to false. */
  readonly returnValues?: boolean;
}

export interface Match {
  readonly id: string;
  readonly score: number;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface VecAdapter {
  upsert(namespace: string, vectors: ReadonlyArray<VectorRecord>): Promise<void>;
  query(
    namespace: string,
    vector: Float32Array | ReadonlyArray<number>,
    opts?: QueryOpts,
  ): Promise<Match[]>;
  delete(namespace: string, ids: ReadonlyArray<string>): Promise<void>;
}

function namespacedId(namespace: string, id: string): string {
  assertNamespace(namespace);
  return `${namespace}:${id}`;
}

function assertNamespace(namespace: string): void {
  if (!namespace || namespace.trim() === '') {
    throw new Error('VectorizeAdapter: namespace is required (multi-tenant safety).');
  }
  if (namespace.includes(':')) {
    // Prevent collisions in the prefixed-id space.
    throw new Error(
      `VectorizeAdapter: namespace must not contain ':' (got "${namespace}").`,
    );
  }
}

function toFloatArray(values: Float32Array | ReadonlyArray<number>): number[] {
  if (values instanceof Float32Array) return Array.from(values);
  return Array.from(values);
}

export class VectorizeAdapter implements VecAdapter {
  private readonly vec: VectorizeIndex;
  public constructor(vec: VectorizeIndex) {
    this.vec = vec;
  }

  public async upsert(
    namespace: string,
    vectors: ReadonlyArray<VectorRecord>,
  ): Promise<void> {
    assertNamespace(namespace);
    if (vectors.length === 0) return;
    const payload: VectorizeVector[] = vectors.map((v) => ({
      id: namespacedId(namespace, v.id),
      values: toFloatArray(v.values),
      metadata: { ...(v.metadata ?? {}), namespace },
    }));
    await this.vec.upsert(payload);
  }

  public async query(
    namespace: string,
    vector: Float32Array | ReadonlyArray<number>,
    opts: QueryOpts = {},
  ): Promise<Match[]> {
    assertNamespace(namespace);
    const filter = { namespace, ...(opts.filter ?? {}) };
    const res = await this.vec.query(toFloatArray(vector), {
      topK: opts.topK ?? 10,
      filter,
      returnValues: opts.returnValues ?? false,
      returnMetadata: 'all',
    });
    return res.matches.map((m: VectorizeMatch): Match => {
      // Strip the namespace prefix so callers see the logical id.
      const prefix = `${namespace}:`;
      const id = m.id.startsWith(prefix) ? m.id.slice(prefix.length) : m.id;
      const out: Match = m.metadata
        ? {
            id,
            score: m.score,
            metadata: m.metadata as Readonly<
              Record<string, string | number | boolean>
            >,
          }
        : { id, score: m.score };
      return out;
    });
  }

  public async delete(namespace: string, ids: ReadonlyArray<string>): Promise<void> {
    assertNamespace(namespace);
    if (ids.length === 0) return;
    await this.vec.deleteByIds(ids.map((id) => namespacedId(namespace, id)));
  }
}

/** Factory helper — matches the shape used by app-factory-cf. */
export function createVectorizeAdapter(vec: VectorizeIndex): VecAdapter {
  return new VectorizeAdapter(vec);
}
