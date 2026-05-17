/**
 * Unit-Tests fuer WritemodeService.
 *
 * Scope:
 *   - activate persistiert (id, expires_at = now + duration*60_000)
 *   - isActive: true wenn aktive Row vorhanden, false sonst
 *   - isActive: false nach expiry (now > expires_at)
 *   - deactivate: setzt aktive Rows auf expired, idempotent
 *   - Cross-User-Isolation: User A's Session affected NICHT User B's isActive
 *   - Duration-Validation: 30 / -1 / 9999 werfen
 *
 * Mocks: in-memory DbAdapter analog prefs.test.ts.
 */
import { describe, it, expect } from 'vitest';
import type {
  DbAdapter,
  ScopedDb,
  RawDb,
  TransactionCtx,
} from '@mcp-approval2/adapters';
import { createWritemodeService } from './writemode.js';

interface Row {
  id: string;
  user_id: string;
  activated_at: number;
  expires_at: number;
  activated_by_credential: string;
  method: string;
}

function makeMemoryDb(): DbAdapter & { _rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  let nextId = 1;

  function exec<T = unknown>(text: string, params: ReadonlyArray<unknown> = []): T[] {
    const t = text.replace(/\s+/g, ' ').trim();

    if (t.startsWith('INSERT INTO write_mode')) {
      const [uid, activatedAt, expiresAt, credId, method] = params as readonly unknown[];
      const id = `id-${nextId++}`;
      const row: Row = {
        id,
        user_id: String(uid),
        activated_at: Number(activatedAt),
        expires_at: Number(expiresAt),
        activated_by_credential: String(credId),
        method: String(method),
      };
      rows.set(id, row);
      return [row] as unknown as T[];
    }

    if (t.startsWith('UPDATE write_mode')) {
      const [uid, now] = params as readonly unknown[];
      const affected: { id: string }[] = [];
      for (const r of rows.values()) {
        if (r.user_id === String(uid) && r.expires_at > Number(now)) {
          r.expires_at = Number(now);
          affected.push({ id: r.id });
        }
      }
      return affected as unknown as T[];
    }

    if (t.startsWith('SELECT id FROM write_mode')) {
      const [uid, now] = params as readonly unknown[];
      const matches: { id: string }[] = [];
      for (const r of rows.values()) {
        if (r.user_id === String(uid) && r.expires_at > Number(now)) {
          matches.push({ id: r.id });
          if (matches.length >= 1) break; // LIMIT 1
        }
      }
      return matches as unknown as T[];
    }

    if (t.startsWith('SELECT id, user_id, activated_at')) {
      const [uid, now] = params as readonly unknown[];
      const matches: Row[] = [];
      for (const r of rows.values()) {
        if (r.user_id === String(uid) && r.expires_at > Number(now)) {
          matches.push(r);
        }
      }
      matches.sort((a, b) => b.expires_at - a.expires_at);
      return matches as unknown as T[];
    }

    throw new Error(`unmocked SQL: ${t.slice(0, 100)}`);
  }

  const scoped = (userId: string): ScopedDb => ({
    userId,
    dialect: 'postgres',
    drizzle: {},
    async query<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
      return exec<T>(sql, params);
    },
  });

  const raw: RawDb = {
    dialect: 'postgres',
    drizzle: {},
    async query<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
      return exec<T>(sql, params);
    },
  };

  return {
    dialect: 'postgres',
    _rows: rows,
    async scoped(userId: string) {
      return scoped(userId);
    },
    unsafe() {
      return raw;
    },
    async transaction<T>(
      userId: string,
      fn: (tx: ScopedDb, ctx: TransactionCtx) => Promise<T>,
    ): Promise<T> {
      return fn(scoped(userId), { userId, dialect: 'postgres' });
    },
    async migrate() {},
    async close() {},
  };
}

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const CRED = 'cred-abc';

describe('WritemodeService', () => {
  it('activate → isActive true, expires_at = now + duration*60_000', async () => {
    const db = makeMemoryDb();
    const svc = createWritemodeService({ db });
    const now = 1_000_000;
    const session = await svc.activate({
      userId: USER_A,
      durationMin: 15,
      credentialId: CRED,
      now,
    });
    expect(session.userId).toBe(USER_A);
    expect(session.activatedAt).toBe(now);
    expect(session.expiresAt).toBe(now + 15 * 60_000);
    expect(session.method).toBe('webauthn');

    expect(await svc.isActive({ userId: USER_A, now })).toBe(true);
    expect(await svc.isActive({ userId: USER_A, now: session.expiresAt - 1 })).toBe(true);
    expect(await svc.isActive({ userId: USER_A, now: session.expiresAt })).toBe(false);
    expect(await svc.isActive({ userId: USER_A, now: session.expiresAt + 1_000 })).toBe(false);
  });

  it('cross-user isolation: User A active, User B not', async () => {
    const db = makeMemoryDb();
    const svc = createWritemodeService({ db });
    const now = 2_000_000;
    await svc.activate({ userId: USER_A, durationMin: 60, credentialId: CRED, now });
    expect(await svc.isActive({ userId: USER_A, now })).toBe(true);
    expect(await svc.isActive({ userId: USER_B, now })).toBe(false);
  });

  it('deactivate: setzt aktive Rows expired + idempotent', async () => {
    const db = makeMemoryDb();
    const svc = createWritemodeService({ db });
    const now = 3_000_000;
    await svc.activate({ userId: USER_A, durationMin: 240, credentialId: CRED, now });
    expect(await svc.isActive({ userId: USER_A, now })).toBe(true);

    const ended = await svc.deactivate({ userId: USER_A, now });
    expect(ended).toBe(1);
    expect(await svc.isActive({ userId: USER_A, now })).toBe(false);

    const endedAgain = await svc.deactivate({ userId: USER_A, now });
    expect(endedAgain).toBe(0);
  });

  it('listActive returns sorted-desc by expires_at', async () => {
    const db = makeMemoryDb();
    const svc = createWritemodeService({ db });
    const now = 4_000_000;
    const a = await svc.activate({ userId: USER_A, durationMin: 15, credentialId: CRED, now });
    const b = await svc.activate({ userId: USER_A, durationMin: 240, credentialId: CRED, now });
    const sessions = await svc.listActive({ userId: USER_A, now });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.id).toBe(b.id);
    expect(sessions[1]?.id).toBe(a.id);
  });

  it('rejects invalid durations', async () => {
    const db = makeMemoryDb();
    const svc = createWritemodeService({ db });
    await expect(
      svc.activate({
        userId: USER_A,
        durationMin: 30 as unknown as 15,
        credentialId: CRED,
      }),
    ).rejects.toThrow(/invalid duration/);
    await expect(
      svc.activate({
        userId: USER_A,
        durationMin: -1 as unknown as 15,
        credentialId: CRED,
      }),
    ).rejects.toThrow(/invalid duration/);
  });

  it('rejects empty credentialId', async () => {
    const db = makeMemoryDb();
    const svc = createWritemodeService({ db });
    await expect(
      svc.activate({ userId: USER_A, durationMin: 15, credentialId: '' }),
    ).rejects.toThrow(/credentialId/);
  });
});
