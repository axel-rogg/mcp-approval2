/**
 * Compile-time type tests for the DbAdapter interface.
 *
 * Wir wollen sicherstellen, dass beide konkreten Adapter-Klassen
 * die `DbAdapter`-Surface erfuellen ohne Cast.
 *
 * Keine Runtime-Connection — wir testen nur Typ-Vertraege.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { DbAdapter, ScopedDb, RawDb, DbDialect } from './interface.js';
import { PostgresDbAdapter } from './postgres.js';
import { SqliteDbAdapter } from './sqlite.js';

describe('DbAdapter type contracts', () => {
  it('PostgresDbAdapter assigns to DbAdapter', () => {
    expectTypeOf<PostgresDbAdapter>().toMatchTypeOf<DbAdapter>();
    expectTypeOf<PostgresDbAdapter>()
      .toHaveProperty('dialect')
      .toEqualTypeOf<DbDialect>();
  });

  it('SqliteDbAdapter assigns to DbAdapter', () => {
    expectTypeOf<SqliteDbAdapter>().toMatchTypeOf<DbAdapter>();
  });

  it('SqliteDbAdapter can be constructed in-memory', async () => {
    const adapter = new SqliteDbAdapter({ filename: ':memory:' });
    expect(adapter.dialect).toBe('sqlite');
    const scoped: ScopedDb = await adapter.scoped(
      '00000000-0000-0000-0000-000000000001',
    );
    expect(scoped.userId).toBe('00000000-0000-0000-0000-000000000001');
    expect(scoped.dialect).toBe('sqlite');
    const raw: RawDb = adapter.unsafe('compile-time-type-test');
    expect(raw.dialect).toBe('sqlite');
    await adapter.close();
  });
});
