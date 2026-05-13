/**
 * Unit-Tests fuer AuditSink-Adapter.
 *
 * Scope:
 *   - PostgresAuditSink schreibt einen Row mit allen Pflicht-Feldern.
 *   - PostgresAuditSink failt fail-soft (db-error → kein throw).
 *   - OtelAuditSink POSTet JSON-Payload mit event_type='audit'.
 *   - OtelAuditSink fail-soft bei non-2xx + Network-Error.
 *   - OtelAuditSink redacted Authorization-Header NICHT (Token muss raus zum
 *     SIEM-Endpoint), aber Audit-Event-Body enthaelt keinen Token mehr.
 *   - CombinedAuditSink ruft beide Sinks in Reihenfolge, fail-soft.
 *   - createAuditSink-Factory waehlt den richtigen Sink + erzwingt Pflicht-
 *     Felder.
 */
import { describe, it, expect, vi } from 'vitest';
import type { DbAdapter, RawDb, ScopedDb, TransactionCtx } from '@mcp-approval2/adapters';
import {
  CombinedAuditSink,
  createAuditSink,
  OtelAuditSink,
  PostgresAuditSink,
  type AuditSink,
} from './audit-sink.js';
import type { AuditEvent } from './audit.js';

// ---------------------------------------------------------------------------
// In-memory DbAdapter — sammelt INSERTs in einer Liste.
// ---------------------------------------------------------------------------

interface CapturedInsert {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
}

function makeMemoryDb(opts: { throwOnInsert?: boolean } = {}): DbAdapter & {
  _inserts: CapturedInsert[];
} {
  const inserts: CapturedInsert[] = [];

  const raw: RawDb = {
    dialect: 'postgres',
    drizzle: {} as unknown,
    async query<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
      if (opts.throwOnInsert) throw new Error('synthetic db failure');
      inserts.push({ sql, params });
      return [] as unknown as T[];
    },
  };

  const adapter: DbAdapter = {
    dialect: 'postgres',
    scoped(_userId: string): Promise<ScopedDb> {
      throw new Error('not used in audit-sink tests');
    },
    unsafe(_reason: string): RawDb {
      return raw;
    },
    transaction<T>(
      _userId: string,
      _fn: (tx: ScopedDb, ctx: TransactionCtx) => Promise<T>,
    ): Promise<T> {
      throw new Error('not used in audit-sink tests');
    },
    async migrate(): Promise<void> {
      /* noop */
    },
    async close(): Promise<void> {
      /* noop */
    },
  };

  return Object.assign(adapter, { _inserts: inserts });
}

// ---------------------------------------------------------------------------
// Helper: minimal AuditEvent
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    action: 'user.login.success',
    actorUserId: 'user-1',
    result: 'success',
    requestId: 'req-abc',
    ip: '127.0.0.1',
    userAgent: 'vitest/1.0',
    details: { method: 'password' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PostgresAuditSink
// ---------------------------------------------------------------------------

describe('PostgresAuditSink', () => {
  it('insertet alle Pflicht-Felder in audit_log', async () => {
    const db = makeMemoryDb();
    const sink = new PostgresAuditSink(db);

    await sink.emit(makeEvent());

    expect(db._inserts).toHaveLength(1);
    const row = db._inserts[0]!;
    expect(row.sql).toMatch(/INSERT INTO audit_log/);
    const [action, actor, target, result, requestId, ip, ua, details, createdAt] = row.params;
    expect(action).toBe('user.login.success');
    expect(actor).toBe('user-1');
    expect(target).toBeNull();
    expect(result).toBe('success');
    expect(requestId).toBe('req-abc');
    expect(ip).toBe('127.0.0.1');
    expect(ua).toBe('vitest/1.0');
    expect(details).toBe(JSON.stringify({ method: 'password' }));
    expect(typeof createdAt).toBe('number');
  });

  it('schluckt DB-Fehler still (fail-soft)', async () => {
    const db = makeMemoryDb({ throwOnInsert: true });
    const sink = new PostgresAuditSink(db);
    // Original-emitAudit `console.error`-ruft — wir spy-en, damit der Test
    // keine Output-Pollution erzeugt und gleichzeitig prueft dass der Catch
    // greift.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(sink.emit(makeEvent())).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// OtelAuditSink
// ---------------------------------------------------------------------------

describe('OtelAuditSink', () => {
  it('POSTet JSON mit event_type=audit + event_action', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init !== undefined ? { init } : {}) });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;

    const sink = new OtelAuditSink({
      endpoint: 'https://siem.example.com/ingest',
      token: 'sek-token',
      fetchImpl: fakeFetch,
    });

    await sink.emit(makeEvent());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://siem.example.com/ingest');
    const init = calls[0]!.init!;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['authorization']).toBe('Bearer sek-token');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['event_type']).toBe('audit');
    expect(body['event_action']).toBe('user.login.success');
    expect(body['actor_user_id']).toBe('user-1');
    expect(body['result']).toBe('success');
    expect(body['request_id']).toBe('req-abc');
    expect(typeof body['emitted_at']).toBe('string');
  });

  it('fail-soft bei non-2xx Response', async () => {
    const fakeFetch = (async () => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch;
    const sink = new OtelAuditSink({
      endpoint: 'https://siem.example.com/ingest',
      fetchImpl: fakeFetch,
    });
    await expect(sink.emit(makeEvent())).resolves.toBeUndefined();
  });

  it('fail-soft bei Network-Error', async () => {
    const fakeFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const sink = new OtelAuditSink({
      endpoint: 'https://siem.example.com/ingest',
      fetchImpl: fakeFetch,
    });
    await expect(sink.emit(makeEvent())).resolves.toBeUndefined();
  });

  it('rejected invalide endpoint im Constructor', () => {
    expect(
      () => new OtelAuditSink({ endpoint: 'not-a-url' }),
    ).toThrow(/http\(s\) URL/);
  });
});

// ---------------------------------------------------------------------------
// CombinedAuditSink
// ---------------------------------------------------------------------------

describe('CombinedAuditSink', () => {
  it('ruft alle Sinks in Reihenfolge', async () => {
    const order: string[] = [];
    const a: AuditSink = {
      async emit() {
        order.push('a');
      },
    };
    const b: AuditSink = {
      async emit() {
        order.push('b');
      },
    };
    const combined = new CombinedAuditSink([a, b]);
    await combined.emit(makeEvent());
    expect(order).toEqual(['a', 'b']);
  });

  it('fail-soft wenn ein Sink (theoretisch) wirft', async () => {
    const ok: string[] = [];
    const bad: AuditSink = {
      async emit() {
        throw new Error('boom');
      },
    };
    const good: AuditSink = {
      async emit() {
        ok.push('good');
      },
    };
    const combined = new CombinedAuditSink([bad, good]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(combined.emit(makeEvent())).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(ok).toEqual(['good']);
  });

  it('rejected leere sink-list', () => {
    expect(() => new CombinedAuditSink([])).toThrow(/at least one sink/);
  });
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe('createAuditSink', () => {
  it('mode=pg baut PostgresAuditSink', () => {
    const db = makeMemoryDb();
    const sink = createAuditSink({ mode: 'pg', pgDb: db });
    expect(sink).toBeInstanceOf(PostgresAuditSink);
  });

  it('mode=otel baut OtelAuditSink', () => {
    const sink = createAuditSink({
      mode: 'otel',
      otelEndpoint: 'https://siem.example.com/ingest',
    });
    expect(sink).toBeInstanceOf(OtelAuditSink);
  });

  it('mode=combined baut CombinedAuditSink mit pg+otel', async () => {
    const db = makeMemoryDb();
    const fakeFetch = (async () => new Response(null, { status: 202 })) as unknown as typeof fetch;
    const sink = createAuditSink({
      mode: 'combined',
      pgDb: db,
      otelEndpoint: 'https://siem.example.com/ingest',
      otelFetchImpl: fakeFetch,
    });
    expect(sink).toBeInstanceOf(CombinedAuditSink);
    await sink.emit(makeEvent());
    expect(db._inserts).toHaveLength(1);
  });

  it('mode=pg ohne pgDb wirft', () => {
    expect(() => createAuditSink({ mode: 'pg' })).toThrow(/pgDb required/);
  });

  it('mode=otel ohne endpoint wirft', () => {
    expect(() => createAuditSink({ mode: 'otel' })).toThrow(/otelEndpoint required/);
  });

  it('mode=combined ohne pgDb wirft', () => {
    expect(() =>
      createAuditSink({ mode: 'combined', otelEndpoint: 'https://x.example.com' }),
    ).toThrow(/pgDb required/);
  });

  it('mode=combined ohne endpoint wirft', () => {
    const db = makeMemoryDb();
    expect(() => createAuditSink({ mode: 'combined', pgDb: db })).toThrow(
      /otelEndpoint required/,
    );
  });
});
