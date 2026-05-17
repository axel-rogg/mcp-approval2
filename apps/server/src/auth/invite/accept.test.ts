/**
 * Unit-Tests fuer acceptInvite — Fokus: SEC-010 (suspended-User-Block,
 * external_id-Drift-Block).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { DbAdapter, ScopedDb, RawDb, TransactionCtx } from '@mcp-approval2/adapters';
import type { AppConfig } from '../../lib/config.js';
import { acceptInvite } from './accept.js';

interface InviteRow {
  id: string;
  email: string;
  invited_by: string;
  status: 'pending' | 'accepted' | 'expired';
  expires_at: number;
  accepted_at: number | null;
  token_hash: string;
}

interface UserRow {
  id: string;
  email: string;
  external_id: string | null;
  role: 'admin' | 'member';
  status: 'active' | 'suspended';
}

function makeDb(opts: {
  invite?: Partial<InviteRow>;
  user?: Partial<UserRow>;
}): DbAdapter & { _users: UserRow[]; _invites: InviteRow[]; _audit: unknown[] } {
  const invites: InviteRow[] = [];
  const users: UserRow[] = [];
  const audit: unknown[] = [];
  if (opts.invite) {
    invites.push({
      id: 'inv-1',
      email: 'bob@example.com',
      invited_by: 'admin-1',
      status: 'pending',
      expires_at: Date.now() + 60_000,
      accepted_at: null,
      token_hash: '',
      ...opts.invite,
    });
  }
  if (opts.user) {
    users.push({
      id: 'user-1',
      email: 'bob@example.com',
      external_id: null,
      role: 'member',
      status: 'active',
      ...opts.user,
    });
  }
  const exec = async <T = unknown>(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<T[]> => {
    const t = sql.replace(/\s+/g, ' ').trim();
    if (t.startsWith('SELECT id, email, invited_by AS "invitedBy"')) {
      const r = invites.find((i) => i.token_hash === String(params[0]));
      if (!r) return [] as unknown as T[];
      return [
        {
          id: r.id,
          email: r.email,
          invitedBy: r.invited_by,
          status: r.status,
          expiresAt: r.expires_at,
          acceptedAt: r.accepted_at,
        },
      ] as unknown as T[];
    }
    if (t.startsWith('UPDATE invites SET status')) {
      const r = invites.find((i) => i.id === String(params[1]));
      if (r && r.status === 'pending') {
        r.status = 'accepted';
        r.accepted_at = Number(params[0]);
      }
      return [] as unknown as T[];
    }
    if (t.startsWith('SELECT id, role, status, external_id')) {
      const r = users.find((u) => u.email === String(params[0]));
      if (!r) return [] as unknown as T[];
      return [
        { id: r.id, role: r.role, status: r.status, externalId: r.external_id },
      ] as unknown as T[];
    }
    if (t.startsWith('UPDATE users SET status')) {
      const r = users.find((u) => u.id === String(params[3]));
      if (r) {
        r.status = 'active';
        r.external_id = String(params[0]);
      }
      return [] as unknown as T[];
    }
    if (t.startsWith('INSERT INTO users')) {
      const r: UserRow = {
        id: `user-${users.length + 1}`,
        email: String(params[1]),
        external_id: String(params[0]),
        role: 'member',
        status: 'active',
      };
      users.push(r);
      return [{ id: r.id, role: r.role }] as unknown as T[];
    }
    if (t.startsWith('INSERT INTO audit_log')) {
      audit.push(params);
      return [] as unknown as T[];
    }
    return [] as unknown as T[];
  };
  const raw: RawDb = { dialect: 'postgres', drizzle: {}, query: exec };
  const scoped: ScopedDb = { userId: 'stub', dialect: 'postgres', drizzle: {}, query: exec };
  return {
    dialect: 'postgres',
    _users: users,
    _invites: invites,
    _audit: audit,
    async scoped() {
      return scoped;
    },
    unsafe() {
      return raw;
    },
    async transaction<T>(_uid: string, fn: (tx: ScopedDb, ctx: TransactionCtx) => Promise<T>) {
      return fn(scoped, { userId: 'stub', dialect: 'postgres' });
    },
    async migrate() {},
    async close() {},
  };
}

const stubConfig = {} as unknown as AppConfig;
const RAW_TOKEN = 'sometoken';
const HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe('acceptInvite — SEC-010', () => {
  it('happy-path: keine existing user → INSERT', async () => {
    const db = makeDb({ invite: { token_hash: HASH } });
    const r = await acceptInvite(db, stubConfig, {
      rawToken: RAW_TOKEN,
      externalId: 'google|bob',
      email: 'bob@example.com',
      displayName: 'Bob',
    });
    expect(r.role).toBe('member');
    expect(db._users).toHaveLength(1);
    expect(db._users[0]!.external_id).toBe('google|bob');
  });

  it('happy-path: existing user ohne external_id → link + activate', async () => {
    const db = makeDb({
      invite: { token_hash: HASH },
      user: { external_id: null, status: 'active' },
    });
    const r = await acceptInvite(db, stubConfig, {
      rawToken: RAW_TOKEN,
      externalId: 'google|bob',
      email: 'bob@example.com',
      displayName: 'Bob',
    });
    expect(r.role).toBe('member');
    expect(db._users[0]!.external_id).toBe('google|bob');
  });

  it('SEC-010: suspended User → 403 + audit', async () => {
    const db = makeDb({
      invite: { token_hash: HASH },
      user: { status: 'suspended', external_id: null },
    });
    await expect(
      acceptInvite(db, stubConfig, {
        rawToken: RAW_TOKEN,
        externalId: 'google|bob',
        email: 'bob@example.com',
        displayName: 'Bob',
      }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(db._users[0]!.status).toBe('suspended');
    const actions = db._audit.map((p) => (p as ReadonlyArray<unknown>)[3]);
    expect(actions).toContain('invite.accept.rejected');
  });

  it('SEC-010: external_id-Drift → 403 + audit', async () => {
    const db = makeDb({
      invite: { token_hash: HASH },
      user: { external_id: 'google|original', status: 'active' },
    });
    await expect(
      acceptInvite(db, stubConfig, {
        rawToken: RAW_TOKEN,
        externalId: 'google|attacker',
        email: 'bob@example.com',
        displayName: 'Attacker',
      }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    // external_id MUSS unveraendert bleiben
    expect(db._users[0]!.external_id).toBe('google|original');
    const actions = db._audit.map((p) => (p as ReadonlyArray<unknown>)[3]);
    expect(actions).toContain('invite.accept.rejected');
  });

  it('SEC-010: admin-role User wird via Invite resurrected → warn + audit, NICHT abgelehnt (Phase A)', async () => {
    const db = makeDb({
      invite: { token_hash: HASH },
      user: { role: 'admin', external_id: null, status: 'active' },
    });
    const r = await acceptInvite(db, stubConfig, {
      rawToken: RAW_TOKEN,
      externalId: 'google|bob',
      email: 'bob@example.com',
      displayName: 'Bob',
    });
    expect(r.role).toBe('admin');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('admin-role user'),
    );
    const actions = db._audit.map((p) => (p as ReadonlyArray<unknown>)[3]);
    expect(actions).toContain('invite.accept.admin_resurrected');
  });
});
