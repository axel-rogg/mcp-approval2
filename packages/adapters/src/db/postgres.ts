/**
 * Postgres-DbAdapter via drizzle-orm/postgres-js.
 *
 * Tenant-Isolation: `scoped(userId)` oeffnet Transaction + setzt
 * `SET LOCAL app.current_user = '<userId>'`. RLS-Policies im Schema
 * lesen das Setting via `current_setting('app.current_user')::uuid`.
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §4.2 + §7.2.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import type {
  DbAdapter,
  RawDb,
  ScopedDb,
  TransactionCtx,
  DbDialect,
} from './interface.js';

// postgres-js typed `unsafe()` mit `ParameterOrJSON<never>[]` als Params.
// Wir benoetigen einen schmalen Cast-Helper damit wir userland-`unknown[]`
// reichen koennen (TS-strict laesst kein implizites Casten zu).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PgParam = any;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PostgresDbAdapterOptions {
  /** PG-URL, z.B. `postgres://user:pw@host:5432/db`. */
  readonly url: string;
  /** Drizzle-Migrations-Folder. Default: `./drizzle`. */
  readonly migrationsFolder?: string;
  /** Override poolsize. Default: 10. */
  readonly max?: number;
  /**
   * Wenn gesetzt, wird hier ein bereits gebauter `postgres.Sql`-Client
   * injiziert (fuer Tests).
   */
  readonly client?: postgres.Sql;
}

function assertUuid(userId: string): void {
  if (!UUID_RE.test(userId)) {
    throw new Error(
      `PostgresDbAdapter.scoped(): userId is not a valid UUID. Refusing to ` +
        `interpolate untrusted input into SET LOCAL (got length ${userId.length}).`,
    );
  }
}

export class PostgresDbAdapter implements DbAdapter {
  public readonly dialect: DbDialect = 'postgres';
  private readonly sql: postgres.Sql;
  private readonly db: PostgresJsDatabase;
  private readonly migrationsFolder: string;

  public constructor(opts: PostgresDbAdapterOptions) {
    this.sql =
      opts.client ??
      postgres(opts.url, {
        max: opts.max ?? 10,
        prepare: false,
      });
    this.db = drizzle(this.sql);
    this.migrationsFolder = opts.migrationsFolder ?? './drizzle';
  }

  public async scoped(userId: string): Promise<ScopedDb> {
    assertUuid(userId);
    // Standalone scoped()-call: caller is responsible for commit/rollback.
    // We open a tagged session via reserved connection so that SET LOCAL
    // stays scoped. The returned ScopedDb keeps the reserved connection
    // until released — call sites SHOULD prefer transaction() instead.
    const reserved = await this.sql.reserve();
    await reserved`BEGIN`;
    await reserved`SELECT set_config('app.current_user', ${userId}, true)`;

    const scopedDb = drizzle(reserved as unknown as postgres.Sql);

    const handle: ScopedDb & { release(): Promise<void> } = {
      userId,
      dialect: this.dialect,
      query: async <T = unknown>(
        text: string,
        params?: ReadonlyArray<unknown>,
      ): Promise<T[]> => {
        const result = await reserved.unsafe<T[]>(
          text,
          (params ?? []) as PgParam[],
        );
        return result as unknown as T[];
      },
      drizzle: scopedDb,
      release: async (): Promise<void> => {
        try {
          await reserved`COMMIT`;
        } finally {
          reserved.release();
        }
      },
    };
    return handle;
  }

  public unsafe(reason: string): RawDb {
    if (!reason || reason.trim().length < 8) {
      throw new Error(
        'PostgresDbAdapter.unsafe(): reason must be a non-empty string with ' +
          'at least 8 chars (will be audit-logged in Phase 1).',
      );
    }
    const sql = this.sql;
    const drz = this.db;
    return {
      dialect: this.dialect,
      query: async <T = unknown>(
        text: string,
        params?: ReadonlyArray<unknown>,
      ): Promise<T[]> => {
        const result = await sql.unsafe<T[]>(
          text,
          (params ?? []) as PgParam[],
        );
        return result as unknown as T[];
      },
      drizzle: drz,
    };
  }

  public async transaction<T>(
    userId: string,
    fn: (tx: ScopedDb, ctx: TransactionCtx) => Promise<T>,
  ): Promise<T> {
    assertUuid(userId);
    const result = await this.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.current_user', ${userId}, true)`;
      const drz = drizzle(tx as unknown as postgres.Sql);
      const scoped: ScopedDb = {
        userId,
        dialect: this.dialect,
        query: async <U = unknown>(
          text: string,
          params?: ReadonlyArray<unknown>,
        ): Promise<U[]> => {
          const rows = await tx.unsafe<U[]>(
            text,
            (params ?? []) as PgParam[],
          );
          return rows as unknown as U[];
        },
        drizzle: drz,
      };
      const ctx: TransactionCtx = { userId, dialect: this.dialect };
      return await fn(scoped, ctx);
    });
    return result as T;
  }

  public async migrate(): Promise<void> {
    await migrate(this.db, { migrationsFolder: this.migrationsFolder });
  }

  public async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
