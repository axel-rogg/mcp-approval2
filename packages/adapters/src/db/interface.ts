/**
 * Database-Adapter-Interface.
 *
 * Portable Runtime: pro Deployment-Target eine Konkrete Impl (Postgres
 * fuer Self-Host primary, SQLite fuer Tests/Dev). Plan-Reference:
 * docs/plans/active/PLAN-architecture-v1.md §7 + §13.
 *
 * Multi-User-Isolation:
 *   - Postgres: RLS-Policies lesen `current_setting('app.current_user')::uuid`.
 *     `scoped(userId)` oeffnet Transaction + `SET LOCAL app.current_user`.
 *   - SQLite: kein RLS. Repository-Pattern enforct den Filter im App-Layer.
 *     `scoped(userId)` merkt sich nur die userId fuer query-builder.
 *
 * Drizzle-Typ: Konsumenten importieren `PostgresJsDatabase` /
 * `BetterSQLite3Database` aus drizzle direkt; `ScopedDb.drizzle` ist nur
 * als `unknown`-handle exponiert, weil die konkrete Schema-Typisierung
 * im core-Package liegt.
 */

export type DbDialect = 'postgres' | 'sqlite';

export interface TransactionCtx {
  readonly userId: string;
  readonly dialect: DbDialect;
}

/**
 * Tenant-scoped DB-handle.
 *
 * Alle Queries laufen im Kontext des `userId`. Bei Postgres
 * via RLS, bei SQLite via App-Layer-Filter (Caller-Pflicht).
 *
 * Lebenszeit: kurzlebig (ein HTTP-Request / eine Transaction).
 */
export interface ScopedDb {
  readonly userId: string;
  readonly dialect: DbDialect;

  /**
   * Raw-SQL-Query mit dem aktuellen User-Scope.
   * Postgres: laeuft in der aktiven Transaction mit SET LOCAL.
   * SQLite: laeuft auf der DB direkt, RLS-Enforcement ist Caller-Pflicht.
   */
  query<T = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<T[]>;

  /**
   * Drizzle-Handle fuer type-safe Queries. Konkreter Typ haengt vom
   * Dialect ab — Konsumenten muessen casten:
   *
   *   const db = scoped.drizzle as PostgresJsDatabase<typeof schema>;
   */
  readonly drizzle: unknown;
}

/**
 * Raw-DB-Handle ohne User-Scope.
 *
 * NUR fuer:
 *   - Migrations
 *   - System-Cron-Jobs (z.B. GDPR-Cascade-Delete)
 *   - Admin-Audit-Reads (mit explizitem audit-log Eintrag)
 *
 * Code-Review-Pflicht: `unsafe()` darf nur mit ausgeschriebener Begruendung
 * aufgerufen werden. Linter-Regel (Phase 1): grep-Verbot fuer `unsafe(`
 * ausser in expliziter Allowlist.
 */
export interface RawDb {
  readonly dialect: DbDialect;
  query<T = unknown>(sql: string, params?: ReadonlyArray<unknown>): Promise<T[]>;
  readonly drizzle: unknown;
}

/**
 * Top-Level-Adapter. Pro Worker/Server-Instance EINER.
 */
export interface DbAdapter {
  readonly dialect: DbDialect;

  /**
   * Oeffnet einen scoped-Kontext.
   *
   * Postgres: Begin transaction, SET LOCAL app.current_user. Caller
   *   MUSS `scoped` ueber `transaction()` oder einen Wrapper benutzen,
   *   damit das Tx-Commit/Rollback sauber laeuft. Direkter `scoped()`-
   *   Call ist legal aber Caller traegt Commit-Verantwortung.
   *
   * SQLite: legt nur einen Cursor-Wrapper an.
   */
  scoped(userId: string): Promise<ScopedDb>;

  /**
   * Raw-Handle ohne Scope. Reason wird im Audit-Log eingetragen (in
   * Phase-1-Wrapper-Implementation). Code-Review-Pflicht.
   */
  unsafe(reason: string): RawDb;

  /**
   * Tx-Helper: oeffnet Transaction + scoped-Kontext, ruft callback,
   * commit-on-success, rollback-on-throw.
   */
  transaction<T>(
    userId: string,
    fn: (tx: ScopedDb, ctx: TransactionCtx) => Promise<T>,
  ): Promise<T>;

  /**
   * Migrations laufen (Drizzle-folder-based).
   */
  migrate(): Promise<void>;

  /**
   * Closes underlying pool / connection.
   */
  close(): Promise<void>;
}
