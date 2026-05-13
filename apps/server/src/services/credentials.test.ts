/**
 * Unit-Tests fuer CredentialsService.
 *
 * Scope: encrypt/decrypt-Roundtrip + PRF-Pfad + AAD-Tamper-Detection.
 * Mocks: in-memory DbAdapter (Map-based) + LocalKekProvider mit HKDF-Master.
 */
import { describe, it, expect } from 'vitest';
import { LocalKekProvider } from '@mcp-approval2/adapters';
import type { DbAdapter, KekProvider, ScopedDb, TransactionCtx } from '@mcp-approval2/adapters';
import { randomBytes } from '@mcp-approval2/core';
import { createCredentialsService, PrfRequiredError } from './credentials.js';

interface Row {
  id: string;
  owner_id: string;
  provider: string;
  kind: string;
  label: string;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  wrapped_dek: Uint8Array;
  aad: string;
  kek_ref: string;
  alg: string;
  prf_enabled: boolean;
  prf_credential_id: Uint8Array | null;
  meta_json: Record<string, unknown> | null;
  created_at: number;
  rotated_at: number | null;
  last_used_at: number | null;
  expires_at: number | null;
}

/**
 * Minimaler in-memory DbAdapter — versteht nur die SQL-Strings die unser
 * Service produziert. Statt einen SQL-Parser zu schreiben, matchen wir per
 * Substring.
 */
function makeMemoryDb(): DbAdapter & { _rows: Map<string, Row>; _audit: unknown[] } {
  const rows = new Map<string, Row>();
  const audit: unknown[] = [];

  function execScoped<T = unknown>(text: string, params: ReadonlyArray<unknown> = []): T[] {
    const t = text.replace(/\s+/g, ' ').trim();

    if (t.startsWith('INSERT INTO credentials')) {
      const [
        id,
        owner_id,
        provider,
        kind,
        label,
        ciphertext,
        nonce,
        wrapped_dek,
        aad,
        kek_ref,
        prf_enabled,
        prf_credential_id,
        meta_json,
        created_at,
      ] = params as readonly unknown[];
      const row: Row = {
        id: String(id),
        owner_id: String(owner_id),
        provider: String(provider),
        kind: String(kind),
        label: String(label),
        ciphertext: ciphertext as Uint8Array,
        nonce: nonce as Uint8Array,
        wrapped_dek: wrapped_dek as Uint8Array,
        aad: String(aad),
        kek_ref: String(kek_ref),
        alg: 'A256GCM',
        prf_enabled: Boolean(prf_enabled),
        prf_credential_id: (prf_credential_id ?? null) as Uint8Array | null,
        meta_json: meta_json ? (JSON.parse(String(meta_json)) as Record<string, unknown>) : null,
        created_at: Number(created_at),
        rotated_at: null,
        last_used_at: null,
        expires_at: null,
      };
      rows.set(row.id, row);
      return [row] as unknown as T[];
    }

    if (t.startsWith('SELECT') && t.includes('FROM credentials WHERE id = $1')) {
      const id = String(params[0]);
      const r = rows.get(id);
      return (r ? [r] : []) as unknown as T[];
    }

    if (t.startsWith('SELECT') && t.includes('FROM credentials WHERE provider = $1 AND label = $2')) {
      const [provider, label] = params as readonly unknown[];
      const out = Array.from(rows.values()).filter(
        (r) => r.provider === provider && r.label === label,
      );
      return out as unknown as T[];
    }

    if (t.startsWith('SELECT') && t.includes('FROM credentials WHERE provider = $1')) {
      const [provider] = params as readonly unknown[];
      return Array.from(rows.values()).filter((r) => r.provider === provider) as unknown as T[];
    }

    if (t.startsWith('SELECT') && t.includes('FROM credentials ORDER BY')) {
      return Array.from(rows.values()) as unknown as T[];
    }

    if (t.startsWith('UPDATE credentials SET last_used_at')) {
      const [ts, id] = params as readonly unknown[];
      const r = rows.get(String(id));
      if (r) r.last_used_at = Number(ts);
      return [] as unknown as T[];
    }

    if (t.startsWith('UPDATE credentials SET ciphertext')) {
      const [ciphertext, nonce, wrapped_dek, rotated_at, id] = params as readonly unknown[];
      const r = rows.get(String(id));
      if (r) {
        r.ciphertext = ciphertext as Uint8Array;
        r.nonce = nonce as Uint8Array;
        r.wrapped_dek = wrapped_dek as Uint8Array;
        r.rotated_at = Number(rotated_at);
      }
      return [] as unknown as T[];
    }

    if (t.startsWith('DELETE FROM credentials WHERE id = $1')) {
      const id = String(params[0]);
      const existed = rows.delete(id);
      return (existed ? [{ id }] : []) as unknown as T[];
    }

    if (t.startsWith('INSERT INTO audit_log')) {
      audit.push(params);
      return [] as unknown as T[];
    }

    throw new Error(`unmocked SQL: ${t.slice(0, 80)}`);
  }

  const scoped = (userId: string): ScopedDb => ({
    userId,
    dialect: 'postgres',
    drizzle: {},
    async query<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
      return execScoped<T>(sql, params);
    },
  });

  const adapter: DbAdapter & { _rows: Map<string, Row>; _audit: unknown[] } = {
    dialect: 'postgres',
    _rows: rows,
    _audit: audit,
    async scoped(userId: string) {
      return scoped(userId);
    },
    unsafe(_reason: string) {
      return {
        dialect: 'postgres' as const,
        drizzle: {},
        async query<T = unknown>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
          return execScoped<T>(sql, params);
        },
      };
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
  return adapter;
}

function makeKek(): KekProvider {
  return new LocalKekProvider({ masterKey: randomBytes(32) });
}

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

describe('CredentialsService', () => {
  it('create + read roundtrip without PRF', async () => {
    const db = makeMemoryDb();
    const svc = createCredentialsService({ db, kekProvider: makeKek() });
    const meta = await svc.create({
      userId: USER_A,
      provider: 'jira',
      kind: 'api_token',
      label: 'work-jira',
      secret: 'pat-super-secret-xyz',
      prfEnabled: false,
    });
    expect(meta.id).toBeDefined();
    expect(meta.prfEnabled).toBe(false);
    expect(meta.provider).toBe('jira');

    const { secret, meta: m2 } = await svc.read({
      userId: USER_A,
      credentialId: meta.id,
    });
    expect(secret).toBe('pat-super-secret-xyz');
    expect(m2.id).toBe(meta.id);
  });

  it('create + read roundtrip WITH PRF', async () => {
    const db = makeMemoryDb();
    const svc = createCredentialsService({ db, kekProvider: makeKek() });
    const prf = randomBytes(32);
    const meta = await svc.create({
      userId: USER_A,
      provider: 'gitlab',
      kind: 'oauth_refresh',
      label: 'main',
      secret: 'rt-very-secret',
      prfEnabled: true,
      prfOutput: prf,
    });
    expect(meta.prfEnabled).toBe(true);

    const { secret } = await svc.read({
      userId: USER_A,
      credentialId: meta.id,
      prfOutput: prf,
    });
    expect(secret).toBe('rt-very-secret');
  });

  it('read without prfOutput on prf_enabled row → PrfRequiredError', async () => {
    const db = makeMemoryDb();
    const svc = createCredentialsService({ db, kekProvider: makeKek() });
    const prf = randomBytes(32);
    const meta = await svc.create({
      userId: USER_A,
      provider: 'gitlab',
      kind: 'oauth_refresh',
      label: 'main',
      secret: 'rt-very-secret',
      prfEnabled: true,
      prfOutput: prf,
    });
    await expect(svc.read({ userId: USER_A, credentialId: meta.id })).rejects.toBeInstanceOf(
      PrfRequiredError,
    );
  });

  it('create with prfEnabled=true but no prfOutput → 400', async () => {
    const db = makeMemoryDb();
    const svc = createCredentialsService({ db, kekProvider: makeKek() });
    await expect(
      svc.create({
        userId: USER_A,
        provider: 'jira',
        kind: 'api_token',
        label: 'broken',
        secret: 'x',
        prfEnabled: true,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('read with WRONG prfOutput fails (auth-tag mismatch)', async () => {
    const db = makeMemoryDb();
    const svc = createCredentialsService({ db, kekProvider: makeKek() });
    const prf = randomBytes(32);
    const wrong = randomBytes(32);
    const meta = await svc.create({
      userId: USER_A,
      provider: 'gitlab',
      kind: 'oauth_refresh',
      label: 'main',
      secret: 'rt-very-secret',
      prfEnabled: true,
      prfOutput: prf,
    });
    await expect(
      svc.read({ userId: USER_A, credentialId: meta.id, prfOutput: wrong }),
    ).rejects.toThrow();
  });

  it('AAD-tamper: aendere provider in row → decrypt failed', async () => {
    const db = makeMemoryDb();
    const svc = createCredentialsService({ db, kekProvider: makeKek() });
    const meta = await svc.create({
      userId: USER_A,
      provider: 'jira',
      kind: 'api_token',
      label: 'work',
      secret: 'pat-secret',
      prfEnabled: false,
    });
    const row = db._rows.get(meta.id);
    expect(row).toBeDefined();
    // AAD ist in der row gespeichert — wenn jemand provider in DB swappt, ohne
    // AAD anzupassen, schlaegt decrypt fehl. Wir simulieren das umgekehrt:
    // wir aendern die gespeicherte AAD auf einen anderen provider.
    if (row) {
      row.aad = `credentials|${USER_A}|EVIL|api_token|${meta.id}`;
    }
    await expect(svc.read({ userId: USER_A, credentialId: meta.id })).rejects.toThrow();
  });

  it('list returns metadata without secret leak', async () => {
    const db = makeMemoryDb();
    const svc = createCredentialsService({ db, kekProvider: makeKek() });
    await svc.create({
      userId: USER_A,
      provider: 'jira',
      kind: 'api_token',
      label: 'a',
      secret: 'sec-a',
      prfEnabled: false,
    });
    await svc.create({
      userId: USER_A,
      provider: 'github',
      kind: 'oauth_refresh',
      label: 'b',
      secret: 'sec-b',
      prfEnabled: false,
    });
    const list = await svc.list({ userId: USER_A });
    expect(list).toHaveLength(2);
    // Compile-time check: meta type has no `secret` property
    // @ts-expect-error — meta hat kein secret
    void list[0]?.secret;

    const filtered = await svc.list({ userId: USER_A, provider: 'github' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.provider).toBe('github');
  });

  it('rotate replaces secret, keeps id+aad stable', async () => {
    const db = makeMemoryDb();
    const svc = createCredentialsService({ db, kekProvider: makeKek() });
    const meta = await svc.create({
      userId: USER_A,
      provider: 'jira',
      kind: 'api_token',
      label: 'work',
      secret: 'old',
      prfEnabled: false,
    });
    await svc.rotate({
      userId: USER_A,
      credentialId: meta.id,
      newSecret: 'new-secret',
    });
    const { secret, meta: m2 } = await svc.read({ userId: USER_A, credentialId: meta.id });
    expect(secret).toBe('new-secret');
    expect(m2.rotatedAt).not.toBeNull();
  });

  it('delete then read → not found', async () => {
    const db = makeMemoryDb();
    const svc = createCredentialsService({ db, kekProvider: makeKek() });
    const meta = await svc.create({
      userId: USER_A,
      provider: 'jira',
      kind: 'api_token',
      label: 'x',
      secret: 's',
      prfEnabled: false,
    });
    await svc.delete({ userId: USER_A, credentialId: meta.id });
    await expect(svc.read({ userId: USER_A, credentialId: meta.id })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('resolveForSubMcp returns plaintext for given provider/label', async () => {
    const db = makeMemoryDb();
    const svc = createCredentialsService({ db, kekProvider: makeKek() });
    await svc.create({
      userId: USER_A,
      provider: 'jira',
      kind: 'api_token',
      label: 'default',
      secret: 'jira-pat',
      prfEnabled: false,
    });
    const { secret } = await svc.resolveForSubMcp({
      userId: USER_A,
      provider: 'jira',
      // label omitted → 'default'
    });
    expect(secret).toBe('jira-pat');
  });

  it('kek_ref bound to user — per-user KEK isolation', async () => {
    const db = makeMemoryDb();
    const svc = createCredentialsService({ db, kekProvider: makeKek() });
    const a = await svc.create({
      userId: USER_A,
      provider: 'jira',
      kind: 'api_token',
      label: 'work',
      secret: 'a-secret',
      prfEnabled: false,
    });
    const b = await svc.create({
      userId: USER_B,
      provider: 'jira',
      kind: 'api_token',
      label: 'work',
      secret: 'b-secret',
      prfEnabled: false,
    });
    const rowA = db._rows.get(a.id);
    const rowB = db._rows.get(b.id);
    expect(rowA?.kek_ref).toContain(`user-${USER_A}`);
    expect(rowB?.kek_ref).toContain(`user-${USER_B}`);
    expect(rowA?.kek_ref).not.toBe(rowB?.kek_ref);
  });
});
