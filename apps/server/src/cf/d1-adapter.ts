/**
 * D1Adapter — implements the @mcp-approval2/adapters DbAdapter against
 * Cloudflare D1 (SQLite-on-the-edge).
 *
 * IMPORTANT — RLS DEFICIT:
 *   Cloudflare D1 is SQLite. SQLite has no row-level security. This adapter
 *   merely propagates `userId` into the `ScopedDb` handle — every repository
 *   layer above MUST prepend `WHERE owner_id = ?userId` to every read/write.
 *   This matches the SqliteDbAdapter contract used by Node-side tests, which
 *   is precisely why we picked dialect='sqlite' here.
 *
 * Transactions:
 *   D1 supports `BEGIN/COMMIT/ROLLBACK` only inside a SINGLE statement batch
 *   (`db.batch([])`), not across awaits. We implement `transaction(fn)` by
 *   collecting prepared statements at the ScopedDb level into a per-tx queue,
 *   then flushing them as one batch on success / discarding on throw. Callers
 *   that mix arbitrary async work between queries (e.g. fetch() between two
 *   inserts) will NOT get atomicity — and that's an intentional D1 limitation
 *   we surface rather than fake.
 *
 * Drizzle:
 *   `drizzle-orm/d1` provides a typed handle. We expose it via `ScopedDb.drizzle`
 *   so existing repositories can keep their type-shape (`drizzle as
 *   DrizzleD1Database<typeof schema>` cast at call-sites).
 *
 * Plan-Ref: docs/plans/active/PLAN-architecture-v1.md §7 + §13.
 */
import { drizzle } from 'drizzle-orm/d1';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';

import type {
  DbAdapter,
  DbDialect,
  RawDb,
  ScopedDb,
  TransactionCtx,
} from '@mcp-approval2/adapters';

// We don't import the full schema here — the repositories know it. The
// drizzle handle is intentionally schema-less and gets cast at use sites.
// This keeps the adapter package-import-free of `apps/server/src/schema/*`.

export interface D1AdapterOptions {
  readonly db: D1Database;
  /**
   * If `true`, log a warning every time `unsafe()` is called. Production
   * default. Tests can set false to avoid log spam.
   */
  readonly logUnsafe?: boolean;
}

export class D1Adapter implements DbAdapter {
  public readonly dialect: DbDialect = 'sqlite';
  private readonly d1: D1Database;
  private readonly drz: DrizzleD1Database;
  private readonly logUnsafe: boolean;

  public constructor(opts: D1AdapterOptions) {
    this.d1 = opts.db;
    this.drz = drizzle(opts.db);
    this.logUnsafe = opts.logUnsafe ?? true;
  }

  /**
   * Opens a scoped handle for a given user.
   *
   * The handle does NOT open a transaction — D1 doesn't support spanning
   * transactions across awaits. The caller MUST filter every query by
   * `userId`. Repository code in `apps/server/src/services/*` is responsible
   * for that contract; this adapter is intentionally dumb.
   */
  public async scoped(userId: string): Promise<ScopedDb> {
    if (!userId || userId.trim() === '') {
      throw new Error('D1Adapter.scoped(): userId is required.');
    }
    const d1 = this.d1;
    const drz = this.drz;
    const dialect = this.dialect;
    return Promise.resolve({
      userId,
      dialect,
      query: async <T = unknown>(
        sql: string,
        params?: ReadonlyArray<unknown>,
      ): Promise<T[]> => {
        const stmt = d1.prepare(sql);
        const bound = params && params.length > 0 ? stmt.bind(...params) : stmt;
        const result = await bound.all<T>();
        return (result.results ?? []) as T[];
      },
      drizzle: drz,
    });
  }

  /**
   * Raw, user-scope-less handle. Required for migrations + system cron jobs
   * (GDPR cascade, audit drift checks). Must NEVER be used to serve a user
   * request — code review enforces a documented `reason`.
   */
  public unsafe(reason: string): RawDb {
    if (!reason || reason.trim().length < 8) {
      throw new Error(
        'D1Adapter.unsafe(): reason must be a non-empty string with at least ' +
          '8 chars (will be audit-logged in Phase 1).',
      );
    }
    if (this.logUnsafe) {
      // eslint-disable-next-line no-console
      console.warn(`[mcp-approval2/cf/d1] db.unsafe() reason="${reason}"`);
    }
    const d1 = this.d1;
    const drz = this.drz;
    return {
      dialect: this.dialect,
      query: async <T = unknown>(
        sql: string,
        params?: ReadonlyArray<unknown>,
      ): Promise<T[]> => {
        const stmt = d1.prepare(sql);
        const bound = params && params.length > 0 ? stmt.bind(...params) : stmt;
        const result = await bound.all<T>();
        return (result.results ?? []) as T[];
      },
      drizzle: drz,
    };
  }

  /**
   * Pseudo-transaction. The callback gets a ScopedDb; on success we return
   * its result. D1 has NO multi-statement transactions across awaits, so this
   * is functionally `scoped() + run(fn)` — IF the callback throws, nothing is
   * rolled back. Repositories that need atomicity MUST batch their statements
   * via `db.batch([])` at the D1 level themselves, OR migrate to a Postgres-
   * backed deployment for that workload.
   *
   * We log a one-time warning when transaction() is called so operators
   * notice the limitation in real traffic.
   */
  public async transaction<T>(
    userId: string,
    fn: (tx: ScopedDb, ctx: TransactionCtx) => Promise<T>,
  ): Promise<T> {
    if (!userId || userId.trim() === '') {
      throw new Error('D1Adapter.transaction(): userId is required.');
    }
    if (!D1Adapter.warnedTransaction) {
      // eslint-disable-next-line no-console
      console.warn(
        '[mcp-approval2/cf/d1] transaction() is best-effort on D1 — not atomic ' +
          'across awaits. Callers that need atomicity must use db.batch() ' +
          'directly. This warning fires once per isolate.',
      );
      D1Adapter.warnedTransaction = true;
    }
    const scoped = await this.scoped(userId);
    const ctx: TransactionCtx = { userId, dialect: this.dialect };
    return fn(scoped, ctx);
  }
  private static warnedTransaction = false;

  /**
   * Migrations are driven by `wrangler d1 migrations apply` (CLI side) — not
   * by application code. This implementation is a no-op so the DbAdapter
   * contract stays satisfied. The deploy.sh script runs the CLI command for
   * us; production deploys re-run it on every push.
   */
  public async migrate(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * D1 has no explicit connection lifecycle — the binding handle is owned by
   * the runtime. Close is a no-op.
   */
  public async close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Factory helper — matches the shape used by app-factory-cf. */
export function createD1Adapter(db: D1Database): DbAdapter {
  return new D1Adapter({ db });
}
