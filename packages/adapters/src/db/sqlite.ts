/**
 * SQLite-DbAdapter via drizzle-orm/better-sqlite3.
 *
 * Verwendung: Tests + lokale Dev-Setups. KEIN RLS — App-Layer-Filter
 * via `owner_id = $userId` ist Pflicht. Der Adapter merkt sich nur die
 * `userId` und reicht sie an die Caller-Layer-Repository-Implementations
 * weiter (z.B. core-Package Repository-Helpers prepend dem WHERE-Block).
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §13.
 */

import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDb } from 'better-sqlite3';

import type {
  DbAdapter,
  RawDb,
  ScopedDb,
  TransactionCtx,
  DbDialect,
} from './interface.js';

export interface SqliteDbAdapterOptions {
  /** File-Path oder `:memory:`. */
  readonly filename: string;
  /** Drizzle-Migrations-Folder. Default: `./drizzle`. */
  readonly migrationsFolder?: string;
  /** Wenn gesetzt, wird hier ein bereits-geoeffneter Client injected (Tests). */
  readonly client?: BetterSqliteDb;
}

export class SqliteDbAdapter implements DbAdapter {
  public readonly dialect: DbDialect = 'sqlite';
  private readonly raw: BetterSqliteDb;
  private readonly db: BetterSQLite3Database;
  private readonly migrationsFolder: string;

  public constructor(opts: SqliteDbAdapterOptions) {
    this.raw = opts.client ?? new Database(opts.filename);
    // Pragmas: enable FK + WAL for sane local-dev defaults.
    this.raw.pragma('foreign_keys = ON');
    this.raw.pragma('journal_mode = WAL');
    this.db = drizzle(this.raw);
    this.migrationsFolder = opts.migrationsFolder ?? './drizzle';
  }

  public async scoped(userId: string): Promise<ScopedDb> {
    if (!userId || userId.trim() === '') {
      throw new Error('SqliteDbAdapter.scoped(): userId is required.');
    }
    const raw = this.raw;
    const drz = this.db;
    const dialect = this.dialect;
    return {
      userId,
      dialect,
      query: <T = unknown>(
        sql: string,
        params?: ReadonlyArray<unknown>,
      ): Promise<T[]> => {
        const stmt = raw.prepare(sql);
        const rows = stmt.all(
          ...((params ?? []) as unknown[]),
        ) as unknown as T[];
        return Promise.resolve(rows);
      },
      drizzle: drz,
    };
  }

  public unsafe(reason: string): RawDb {
    if (!reason || reason.trim().length < 8) {
      throw new Error(
        'SqliteDbAdapter.unsafe(): reason must be a non-empty string with ' +
          'at least 8 chars (will be audit-logged in Phase 1).',
      );
    }
    const raw = this.raw;
    const drz = this.db;
    const dialect = this.dialect;
    return {
      dialect,
      query: <T = unknown>(
        sql: string,
        params?: ReadonlyArray<unknown>,
      ): Promise<T[]> => {
        const stmt = raw.prepare(sql);
        const rows = stmt.all(
          ...((params ?? []) as unknown[]),
        ) as unknown as T[];
        return Promise.resolve(rows);
      },
      drizzle: drz,
    };
  }

  public async transaction<T>(
    userId: string,
    fn: (tx: ScopedDb, ctx: TransactionCtx) => Promise<T>,
  ): Promise<T> {
    if (!userId || userId.trim() === '') {
      throw new Error('SqliteDbAdapter.transaction(): userId is required.');
    }
    // better-sqlite3's transaction is sync; we collect the promise and
    // resolve outside the tx wrapper. Since we only use it for tests,
    // this simple pattern is fine.
    const scoped = await this.scoped(userId);
    const ctx: TransactionCtx = { userId, dialect: this.dialect };
    this.raw.exec('BEGIN');
    try {
      const result = await fn(scoped, ctx);
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  public async migrate(): Promise<void> {
    migrate(this.db, { migrationsFolder: this.migrationsFolder });
    return Promise.resolve();
  }

  public async close(): Promise<void> {
    this.raw.close();
    return Promise.resolve();
  }
}
