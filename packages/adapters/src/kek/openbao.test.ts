/**
 * Tests for OpenBaoKekProvider + AppRoleAuth + StaticTokenAuth.
 *
 * Default mode: pure unit tests with `fetch` mocked via `vi.fn()`.
 * Live mode: if both `VAULT_ADDR` and `VAULT_TOKEN` are set, the
 * "[live]" describe block runs end-to-end against the real backend.
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §5.2.
 */

import { webcrypto as nodeWebCrypto } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppRoleAuth,
  StaticTokenAuth,
  VaultAuthError,
} from './openbao-auth.js';
import {
  KekNetworkError,
  KekNotFoundError,
  KekPermissionError,
  KekResponseError,
  KekUnavailableError,
  KekValidationError,
  OpenBaoKekProvider,
  parseVaultRef,
} from './openbao.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomDek(): Uint8Array {
  const out = new Uint8Array(32);
  nodeWebCrypto.getRandomValues(out);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] as number);
  return btoa(s);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function recordFetch(
  handlers: Array<(call: RecordedCall) => Response | Promise<Response>>,
): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let idx = 0;
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h instanceof Headers) {
      h.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    } else if (Array.isArray(h)) {
      for (const [k, v] of h) headers[k.toLowerCase()] = v;
    } else if (h) {
      for (const k of Object.keys(h as Record<string, string>)) {
        headers[k.toLowerCase()] = (h as Record<string, string>)[k] as string;
      }
    }
    let parsedBody: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    const call: RecordedCall = { url, method, headers, body: parsedBody };
    calls.push(call);
    const handler = handlers[idx++];
    if (!handler) {
      throw new Error(`recordFetch: no handler for call #${idx} to ${method} ${url}`);
    }
    return handler(call);
  });
  return { fetch: mock as unknown as typeof fetch, calls };
}

// ---------------------------------------------------------------------------
// parseVaultRef
// ---------------------------------------------------------------------------

describe('parseVaultRef', () => {
  it('parses valid refs', () => {
    expect(parseVaultRef('vault://transit/keys/user-abc', 'transit')).toEqual({
      mount: 'transit',
      keyName: 'user-abc',
    });
  });

  it('accepts dotted/dashed/underscored keynames', () => {
    expect(parseVaultRef('vault://transit/keys/user_42.v2-beta', 'transit').keyName).toBe(
      'user_42.v2-beta',
    );
  });

  it('rejects empty refs', () => {
    expect(() => parseVaultRef('', 'transit')).toThrow(KekValidationError);
  });

  it('rejects refs with wrong scheme', () => {
    expect(() => parseVaultRef('local://user-x', 'transit')).toThrow(KekValidationError);
  });

  it('rejects refs whose mount does not match', () => {
    expect(() => parseVaultRef('vault://other/keys/user-x', 'transit')).toThrow(
      /mount "other" does not match/,
    );
  });

  it('rejects refs with bad keyname characters', () => {
    expect(() => parseVaultRef('vault://transit/keys/bad name', 'transit')).toThrow(
      KekValidationError,
    );
    expect(() => parseVaultRef('vault://transit/keys/bad/slash', 'transit')).toThrow(
      KekValidationError,
    );
  });

  it('rejects refs missing the /keys/ segment', () => {
    expect(() => parseVaultRef('vault://transit/user-x', 'transit')).toThrow(KekValidationError);
  });
});

// ---------------------------------------------------------------------------
// StaticTokenAuth
// ---------------------------------------------------------------------------

describe('StaticTokenAuth', () => {
  it('returns the configured token', async () => {
    const a = new StaticTokenAuth('s.fixed');
    await expect(a.getToken()).resolves.toBe('s.fixed');
  });

  it('rejects empty tokens', () => {
    expect(() => new StaticTokenAuth('')).toThrow(/non-empty/);
  });

  it('invalidate is a no-op', () => {
    const a = new StaticTokenAuth('s.fixed');
    a.invalidate();
    // Followed by getToken, still works.
    return expect(a.getToken()).resolves.toBe('s.fixed');
  });
});

// ---------------------------------------------------------------------------
// AppRoleAuth — caching + renew
// ---------------------------------------------------------------------------

describe('AppRoleAuth', () => {
  let now = 1_000_000_000;
  beforeEach(() => {
    now = 1_000_000_000;
  });

  function makeAuth(handlers: Array<(c: RecordedCall) => Response | Promise<Response>>) {
    const rec = recordFetch(handlers);
    const auth = new AppRoleAuth({
      addr: 'http://vault.example:8200',
      roleId: 'role-1',
      secretId: 'secret-1',
      fetchImpl: rec.fetch,
      now: () => now,
      renewSkewSeconds: 60,
    });
    return { auth, calls: rec.calls };
  }

  it('logs in on first getToken and caches the result', async () => {
    const { auth, calls } = makeAuth([
      () =>
        jsonResponse(200, {
          auth: { client_token: 't.first', lease_duration: 3600, renewable: true },
        }),
    ]);

    const t1 = await auth.getToken();
    expect(t1).toBe('t.first');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://vault.example:8200/v1/auth/approle/login');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ role_id: 'role-1', secret_id: 'secret-1' });

    // Second call: cached, no HTTP.
    const t2 = await auth.getToken();
    expect(t2).toBe('t.first');
    expect(calls).toHaveLength(1);
  });

  it('uses renew-self when the cached token expires', async () => {
    const { auth, calls } = makeAuth([
      () =>
        jsonResponse(200, {
          auth: { client_token: 't.first', lease_duration: 100, renewable: true },
        }),
      (c) => {
        expect(c.url).toBe('http://vault.example:8200/v1/auth/token/renew-self');
        expect(c.headers['x-vault-token']).toBe('t.first');
        return jsonResponse(200, {
          auth: { client_token: 't.renewed', lease_duration: 100, renewable: true },
        });
      },
    ]);

    const t1 = await auth.getToken();
    expect(t1).toBe('t.first');

    // Advance past expiry (lease 100s, skew 60s → usable 40s).
    now += 60_000;
    const t2 = await auth.getToken();
    expect(t2).toBe('t.renewed');
    expect(calls).toHaveLength(2);
  });

  it('falls back to full login when renew-self fails', async () => {
    const { auth, calls } = makeAuth([
      () =>
        jsonResponse(200, {
          auth: { client_token: 't.first', lease_duration: 100, renewable: true },
        }),
      () => jsonResponse(403, { errors: ['permission denied'] }),
      () =>
        jsonResponse(200, {
          auth: { client_token: 't.relogin', lease_duration: 3600, renewable: true },
        }),
    ]);

    await auth.getToken();
    now += 60_000;
    const t2 = await auth.getToken();
    expect(t2).toBe('t.relogin');
    expect(calls).toHaveLength(3);
    expect(calls[1]!.url).toBe('http://vault.example:8200/v1/auth/token/renew-self');
    expect(calls[2]!.url).toBe('http://vault.example:8200/v1/auth/approle/login');
  });

  it('does not call renew-self for non-renewable tokens', async () => {
    const { auth, calls } = makeAuth([
      () =>
        jsonResponse(200, {
          auth: { client_token: 't.first', lease_duration: 100, renewable: false },
        }),
      () =>
        jsonResponse(200, {
          auth: { client_token: 't.relogin', lease_duration: 100, renewable: false },
        }),
    ]);

    await auth.getToken();
    now += 60_000;
    const t2 = await auth.getToken();
    expect(t2).toBe('t.relogin');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe('http://vault.example:8200/v1/auth/approle/login');
  });

  it('invalidate forces a re-login on next call', async () => {
    const { auth, calls } = makeAuth([
      () =>
        jsonResponse(200, {
          auth: { client_token: 't.first', lease_duration: 3600, renewable: true },
        }),
      () =>
        jsonResponse(200, {
          auth: { client_token: 't.second', lease_duration: 3600, renewable: true },
        }),
    ]);

    expect(await auth.getToken()).toBe('t.first');
    auth.invalidate();
    expect(await auth.getToken()).toBe('t.second');
    expect(calls).toHaveLength(2);
  });

  it('throws VaultAuthError on login failure', async () => {
    const { auth } = makeAuth([
      () => jsonResponse(400, { errors: ['invalid role or secret id'] }),
    ]);
    await expect(auth.getToken()).rejects.toBeInstanceOf(VaultAuthError);
  });

  it('throws VaultAuthError if response is missing client_token', async () => {
    const { auth } = makeAuth([() => jsonResponse(200, { auth: { lease_duration: 3600 } })]);
    await expect(auth.getToken()).rejects.toBeInstanceOf(VaultAuthError);
  });

  it('rejects construction with missing fields', () => {
    expect(
      () =>
        new AppRoleAuth({
          addr: '',
          roleId: 'r',
          secretId: 's',
        }),
    ).toThrow(/addr/);
    expect(
      () =>
        new AppRoleAuth({
          addr: 'http://x',
          roleId: '',
          secretId: 's',
        }),
    ).toThrow(/roleId/);
    expect(
      () =>
        new AppRoleAuth({
          addr: 'http://x',
          roleId: 'r',
          secretId: '',
        }),
    ).toThrow(/secretId/);
  });

  it('strips a trailing slash on addr', async () => {
    const rec = recordFetch([
      () =>
        jsonResponse(200, {
          auth: { client_token: 't.x', lease_duration: 3600, renewable: true },
        }),
    ]);
    const auth = new AppRoleAuth({
      addr: 'http://vault.example:8200/',
      roleId: 'r',
      secretId: 's',
      fetchImpl: rec.fetch,
      now: () => now,
    });
    await auth.getToken();
    expect(rec.calls[0]!.url).toBe('http://vault.example:8200/v1/auth/approle/login');
  });

  it('deduplicates concurrent getToken calls', async () => {
    let resolveLogin: ((res: Response) => void) | null = null;
    const loginPromise = new Promise<Response>((resolve) => {
      resolveLogin = resolve;
    });
    const rec = recordFetch([() => loginPromise]);
    const auth = new AppRoleAuth({
      addr: 'http://vault.example:8200',
      roleId: 'r',
      secretId: 's',
      fetchImpl: rec.fetch,
      now: () => now,
    });

    const p1 = auth.getToken();
    const p2 = auth.getToken();
    // Only one HTTP call so far.
    expect(rec.calls).toHaveLength(1);

    resolveLogin!(
      jsonResponse(200, {
        auth: { client_token: 't.shared', lease_duration: 3600, renewable: true },
      }),
    );
    const [t1, t2] = await Promise.all([p1, p2]);
    expect(t1).toBe('t.shared');
    expect(t2).toBe('t.shared');
    expect(rec.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// OpenBaoKekProvider — wrap / unwrap / rotate / destroy / create
// ---------------------------------------------------------------------------

describe('OpenBaoKekProvider', () => {
  const REF = 'vault://transit/keys/user-abc';

  function makeProvider(handlers: Array<(c: RecordedCall) => Response | Promise<Response>>) {
    const rec = recordFetch(handlers);
    const provider = new OpenBaoKekProvider({
      addr: 'http://vault.example:8200',
      auth: new StaticTokenAuth('s.test'),
      fetchImpl: rec.fetch,
    });
    return { provider, calls: rec.calls };
  }

  describe('constructor', () => {
    it('rejects missing addr', () => {
      expect(
        () =>
          new OpenBaoKekProvider({
            addr: '',
            auth: new StaticTokenAuth('t'),
          }),
      ).toThrow(KekValidationError);
    });

    it('rejects missing auth', () => {
      expect(
        () =>
          new OpenBaoKekProvider({
            addr: 'http://x',
            // @ts-expect-error testing runtime guard
            auth: undefined,
          }),
      ).toThrow(KekValidationError);
    });

    it('strips trailing slash on addr', async () => {
      const rec = recordFetch([
        () => jsonResponse(200, { data: { ciphertext: 'vault:v1:Zm9v' } }),
      ]);
      const provider = new OpenBaoKekProvider({
        addr: 'http://vault.example:8200/',
        auth: new StaticTokenAuth('s.test'),
        fetchImpl: rec.fetch,
      });
      await provider.wrap(new Uint8Array([1, 2, 3]), REF);
      expect(rec.calls[0]!.url).toBe(
        'http://vault.example:8200/v1/transit/encrypt/user-abc',
      );
    });
  });

  describe('wrap', () => {
    it('POSTs to /encrypt and returns the ciphertext as UTF-8 bytes', async () => {
      const dek = randomDek();
      const expectedB64 = toBase64(dek);
      const { provider, calls } = makeProvider([
        (c) => {
          expect(c.method).toBe('POST');
          expect(c.url).toBe('http://vault.example:8200/v1/transit/encrypt/user-abc');
          expect(c.headers['x-vault-token']).toBe('s.test');
          expect(c.headers['content-type']).toBe('application/json');
          expect(c.body).toEqual({ plaintext: expectedB64 });
          return jsonResponse(200, { data: { ciphertext: 'vault:v1:ZWFzeQ==' } });
        },
      ]);

      const wrapped = await provider.wrap(dek, REF);
      expect(new TextDecoder().decode(wrapped)).toBe('vault:v1:ZWFzeQ==');
      expect(calls).toHaveLength(1);
    });

    it('rejects empty DEK', async () => {
      const { provider } = makeProvider([]);
      await expect(provider.wrap(new Uint8Array(0), REF)).rejects.toBeInstanceOf(
        KekValidationError,
      );
    });

    it('rejects invalid ref', async () => {
      const { provider } = makeProvider([]);
      await expect(provider.wrap(randomDek(), 'not-a-ref')).rejects.toBeInstanceOf(
        KekValidationError,
      );
    });

    it('throws KekResponseError on missing ciphertext', async () => {
      const { provider } = makeProvider([() => jsonResponse(200, { data: {} })]);
      await expect(provider.wrap(randomDek(), REF)).rejects.toBeInstanceOf(KekResponseError);
    });

    it('throws KekResponseError on non-vault: ciphertext', async () => {
      const { provider } = makeProvider([
        () => jsonResponse(200, { data: { ciphertext: 'something-else' } }),
      ]);
      await expect(provider.wrap(randomDek(), REF)).rejects.toBeInstanceOf(KekResponseError);
    });
  });

  describe('unwrap', () => {
    it('POSTs to /decrypt and returns the decoded DEK', async () => {
      const dek = randomDek();
      const expectedB64 = toBase64(dek);
      const wrappedBytes = new TextEncoder().encode('vault:v1:ZWFzeQ==');

      const { provider, calls } = makeProvider([
        (c) => {
          expect(c.url).toBe('http://vault.example:8200/v1/transit/decrypt/user-abc');
          expect(c.body).toEqual({ ciphertext: 'vault:v1:ZWFzeQ==' });
          return jsonResponse(200, { data: { plaintext: expectedB64 } });
        },
      ]);

      const out = await provider.unwrap(wrappedBytes, REF);
      expect(out).toEqual(dek);
      expect(calls).toHaveLength(1);
    });

    it('round-trips wrap → unwrap with a mocked Vault', async () => {
      const dek = randomDek();
      // Simulate a Vault that stores plaintext-by-ciphertext in a Map.
      const store = new Map<string, string>();
      const rec = recordFetch([
        (c) => {
          const ct = `vault:v1:${(c.body as { plaintext: string }).plaintext}-CT`;
          store.set(ct, (c.body as { plaintext: string }).plaintext);
          return jsonResponse(200, { data: { ciphertext: ct } });
        },
        (c) => {
          const pt = store.get((c.body as { ciphertext: string }).ciphertext);
          if (!pt) return jsonResponse(404, { errors: ['no existing key'] });
          return jsonResponse(200, { data: { plaintext: pt } });
        },
      ]);
      const provider = new OpenBaoKekProvider({
        addr: 'http://vault.example:8200',
        auth: new StaticTokenAuth('s.test'),
        fetchImpl: rec.fetch,
      });

      const wrapped = await provider.wrap(dek, REF);
      const back = await provider.unwrap(wrapped, REF);
      expect(back).toEqual(dek);
    });

    it('rejects empty wrapped', async () => {
      const { provider } = makeProvider([]);
      await expect(provider.unwrap(new Uint8Array(0), REF)).rejects.toBeInstanceOf(
        KekValidationError,
      );
    });

    it('rejects wrapped that does not start with vault:', async () => {
      const { provider } = makeProvider([]);
      const bogus = new TextEncoder().encode('not-vault-ciphertext');
      await expect(provider.unwrap(bogus, REF)).rejects.toBeInstanceOf(KekValidationError);
    });

    it('throws KekResponseError on missing plaintext', async () => {
      const wrapped = new TextEncoder().encode('vault:v1:abc');
      const { provider } = makeProvider([() => jsonResponse(200, { data: {} })]);
      await expect(provider.unwrap(wrapped, REF)).rejects.toBeInstanceOf(KekResponseError);
    });
  });

  describe('error mapping', () => {
    const wrapped = new TextEncoder().encode('vault:v1:abc');

    it('maps 404 → KekNotFoundError', async () => {
      const { provider } = makeProvider([
        () => jsonResponse(404, { errors: ['encryption key not found'] }),
      ]);
      const err = await provider.unwrap(wrapped, REF).catch((e) => e);
      expect(err).toBeInstanceOf(KekNotFoundError);
      expect(err.status).toBe(404);
      expect(err.vaultMessage).toContain('encryption key not found');
    });

    it('maps 400 "key not found" → KekNotFoundError', async () => {
      const { provider } = makeProvider([
        () => jsonResponse(400, { errors: ['encryption key not found'] }),
      ]);
      const err = await provider.unwrap(wrapped, REF).catch((e) => e);
      expect(err).toBeInstanceOf(KekNotFoundError);
    });

    it('maps 403 → KekPermissionError (without retry when disabled)', async () => {
      const rec = recordFetch([() => jsonResponse(403, { errors: ['permission denied'] })]);
      const provider = new OpenBaoKekProvider({
        addr: 'http://vault.example:8200',
        auth: new StaticTokenAuth('s.test'),
        fetchImpl: rec.fetch,
        retryOnExpiredToken: false,
      });
      const err = await provider.unwrap(wrapped, REF).catch((e) => e);
      expect(err).toBeInstanceOf(KekPermissionError);
      expect(rec.calls).toHaveLength(1);
    });

    it('retries once after 403 (expired-token race) and surfaces error if second attempt also fails', async () => {
      // Default retryOnExpiredToken=true → first 403 triggers invalidate + retry.
      // Both attempts fail → final error is the second one.
      const { provider, calls } = makeProvider([
        () => jsonResponse(403, { errors: ['permission denied'] }),
        () => jsonResponse(403, { errors: ['permission denied again'] }),
      ]);
      const err = await provider.unwrap(wrapped, REF).catch((e) => e);
      expect(err).toBeInstanceOf(KekPermissionError);
      expect(calls).toHaveLength(2);
    });

    it('retry on 403 succeeds on second attempt', async () => {
      const { provider, calls } = makeProvider([
        () => jsonResponse(403, { errors: ['expired token'] }),
        () => jsonResponse(200, { data: { plaintext: toBase64(new Uint8Array([7])) } }),
      ]);
      const out = await provider.unwrap(wrapped, REF);
      expect(out).toEqual(new Uint8Array([7]));
      expect(calls).toHaveLength(2);
    });

    it('invalidates AppRoleAuth cache between 403 retries', async () => {
      const rec = recordFetch([
        // login #1
        () =>
          jsonResponse(200, {
            auth: { client_token: 't.first', lease_duration: 3600, renewable: false },
          }),
        // wrap → 403 (uses t.first)
        () => jsonResponse(403, { errors: ['expired'] }),
        // re-login (after invalidate)
        () =>
          jsonResponse(200, {
            auth: { client_token: 't.second', lease_duration: 3600, renewable: false },
          }),
        // wrap retry succeeds (uses t.second)
        (c) => {
          expect(c.headers['x-vault-token']).toBe('t.second');
          return jsonResponse(200, { data: { ciphertext: 'vault:v1:ZWFzeQ==' } });
        },
      ]);
      const auth = new AppRoleAuth({
        addr: 'http://vault.example:8200',
        roleId: 'r',
        secretId: 's',
        fetchImpl: rec.fetch,
      });
      const provider = new OpenBaoKekProvider({
        addr: 'http://vault.example:8200',
        auth,
        fetchImpl: rec.fetch,
      });
      await provider.wrap(randomDek(), REF);
      expect(rec.calls).toHaveLength(4);
    });

    it('maps 503 → KekUnavailableError', async () => {
      const { provider } = makeProvider([
        () => jsonResponse(503, { errors: ['Vault is sealed'] }),
      ]);
      const err = await provider.unwrap(wrapped, REF).catch((e) => e);
      expect(err).toBeInstanceOf(KekUnavailableError);
    });

    it('maps unknown 500-class → KekResponseError', async () => {
      const { provider } = makeProvider([
        () => jsonResponse(500, { errors: ['internal'] }),
      ]);
      const err = await provider.unwrap(wrapped, REF).catch((e) => e);
      expect(err).toBeInstanceOf(KekResponseError);
      expect(err).not.toBeInstanceOf(KekNotFoundError);
      expect(err).not.toBeInstanceOf(KekUnavailableError);
    });

    it('wraps network errors as KekNetworkError', async () => {
      const rec = recordFetch([
        () => {
          throw new TypeError('fetch failed: ECONNREFUSED');
        },
      ]);
      const provider = new OpenBaoKekProvider({
        addr: 'http://vault.example:8200',
        auth: new StaticTokenAuth('s.test'),
        fetchImpl: rec.fetch,
      });
      const err = await provider.unwrap(wrapped, REF).catch((e) => e);
      expect(err).toBeInstanceOf(KekNetworkError);
      expect((err as KekNetworkError).message).toContain('ECONNREFUSED');
    });

    it('throws KekResponseError when response body is not JSON', async () => {
      const { provider } = makeProvider([() => textResponse(200, 'not json')]);
      const err = await provider.unwrap(wrapped, REF).catch((e) => e);
      expect(err).toBeInstanceOf(KekResponseError);
    });

    it('preserves vault message on KekNotFoundError even when errors[] is empty', async () => {
      const { provider } = makeProvider([() => textResponse(404, 'route not found')]);
      const err = await provider.unwrap(wrapped, REF).catch((e) => e);
      expect(err).toBeInstanceOf(KekNotFoundError);
      expect(err.vaultMessage).toBe('route not found');
    });
  });

  describe('rotate', () => {
    it('rotate(sameRef) POSTs /keys/{name}/rotate', async () => {
      const { provider, calls } = makeProvider([() => emptyResponse(204)]);
      await provider.rotate(REF, REF);
      expect(calls[0]!.method).toBe('POST');
      expect(calls[0]!.url).toBe('http://vault.example:8200/v1/transit/keys/user-abc/rotate');
    });

    it('rotate(oldRef → newRef) does not hit the network', async () => {
      const { provider, calls } = makeProvider([]);
      await provider.rotate(REF, 'vault://transit/keys/user-new');
      expect(calls).toHaveLength(0);
    });

    it('rotate(oldRef → newRef) validates both refs', async () => {
      const { provider } = makeProvider([]);
      await expect(provider.rotate(REF, 'bogus')).rejects.toBeInstanceOf(KekValidationError);
    });
  });

  describe('destroyKey', () => {
    it('flips deletion_allowed then DELETEs the key', async () => {
      const { provider, calls } = makeProvider([
        (c) => {
          expect(c.method).toBe('POST');
          expect(c.url).toBe(
            'http://vault.example:8200/v1/transit/keys/user-abc/config',
          );
          expect(c.body).toEqual({ deletion_allowed: true });
          return emptyResponse(204);
        },
        (c) => {
          expect(c.method).toBe('DELETE');
          expect(c.url).toBe('http://vault.example:8200/v1/transit/keys/user-abc');
          return emptyResponse(204);
        },
      ]);
      await provider.destroyKey(REF);
      expect(calls).toHaveLength(2);
    });

    it('surfaces 404 as KekNotFoundError on the config step', async () => {
      const { provider } = makeProvider([
        () => jsonResponse(404, { errors: ['key not found'] }),
      ]);
      await expect(provider.destroyKey(REF)).rejects.toBeInstanceOf(KekNotFoundError);
    });
  });

  describe('createKey', () => {
    it('POSTs /keys/{name} with the default type', async () => {
      const { provider, calls } = makeProvider([(c) => {
        expect(c.method).toBe('POST');
        expect(c.url).toBe('http://vault.example:8200/v1/transit/keys/user-abc');
        expect(c.body).toEqual({ type: 'aes256-gcm96' });
        return emptyResponse(204);
      }]);
      await provider.createKey(REF);
      expect(calls).toHaveLength(1);
    });

    it('honours a custom key type', async () => {
      const { provider, calls } = makeProvider([() => emptyResponse(204)]);
      await provider.createKey(REF, 'chacha20-poly1305');
      expect(calls[0]!.body).toEqual({ type: 'chacha20-poly1305' });
    });
  });

  describe('transitMount override', () => {
    it('threads a custom mount through every URL', async () => {
      const rec = recordFetch([
        () => jsonResponse(200, { data: { ciphertext: 'vault:v1:ZWFzeQ==' } }),
      ]);
      const provider = new OpenBaoKekProvider({
        addr: 'http://vault.example:8200',
        auth: new StaticTokenAuth('s.test'),
        transitMount: 'my-transit',
        fetchImpl: rec.fetch,
      });
      await provider.wrap(new Uint8Array([1]), 'vault://my-transit/keys/user-abc');
      expect(rec.calls[0]!.url).toBe(
        'http://vault.example:8200/v1/my-transit/encrypt/user-abc',
      );
    });

    it('rejects refs whose mount does not match the provider mount', async () => {
      const { provider } = makeProvider([]);
      await expect(
        provider.wrap(new Uint8Array([1]), 'vault://other/keys/user-abc'),
      ).rejects.toBeInstanceOf(KekValidationError);
    });
  });
});

// ---------------------------------------------------------------------------
// [live] end-to-end against a real OpenBao — skipped unless env is set
// ---------------------------------------------------------------------------

const LIVE_ADDR = process.env['VAULT_ADDR'];
const LIVE_TOKEN = process.env['VAULT_TOKEN'];
const LIVE_KEY = `mcp-approval2-test-${Date.now()}`;
const LIVE_REF = `vault://transit/keys/${LIVE_KEY}`;
const liveMode = !!(LIVE_ADDR && LIVE_TOKEN);

describe.skipIf(!liveMode)('[live] OpenBaoKekProvider against $VAULT_ADDR', () => {
  let provider: OpenBaoKekProvider;

  beforeEach(() => {
    provider = new OpenBaoKekProvider({
      addr: LIVE_ADDR as string,
      auth: new StaticTokenAuth(LIVE_TOKEN as string),
    });
  });

  afterEach(async () => {
    try {
      await provider.destroyKey(LIVE_REF);
    } catch {
      // best-effort cleanup
    }
  });

  it('createKey → wrap → unwrap → destroyKey roundtrip', async () => {
    await provider.createKey(LIVE_REF);
    const dek = randomDek();
    const wrapped = await provider.wrap(dek, LIVE_REF);
    const back = await provider.unwrap(wrapped, LIVE_REF);
    expect(back).toEqual(dek);
    await provider.destroyKey(LIVE_REF);
    await expect(provider.unwrap(wrapped, LIVE_REF)).rejects.toBeInstanceOf(KekNotFoundError);
  });
});
