/**
 * Integration-Tests fuer /writemode/{start,stop}.
 *
 * Scope:
 *   - HMAC valid → 200 + state aktiviert
 *   - HMAC invalid → 401, state unveraendert
 *   - expired window in Body → 400
 *   - window > MAX_WINDOW_MS → 400
 *   - missing SMOKE_TEST_KEY → 404
 *   - stop happy + stop ohne valid sig
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import type { AppBindings } from '../lib/context.js';
import {
  isWritemodeActive,
  writemodeRoutes,
  type WritemodeState,
} from './writemode.js';

const KEY = 'a'.repeat(32);

function signStart(key: string, expiresAt: number): string {
  return createHmac('sha256', key).update(String(expiresAt)).digest('hex');
}

function signStop(key: string): string {
  return createHmac('sha256', key).update('stop').digest('hex');
}

function buildApp(deps?: Parameters<typeof writemodeRoutes>[0]): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route('/', writemodeRoutes(deps));
  return app;
}

describe('writemode routes', () => {
  it('missing SMOKE_TEST_KEY → 404', async () => {
    const app = buildApp({});
    const res = await app.request('http://localhost/writemode/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expires_at: Date.now() + 60_000, hmac_sig: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('valid HMAC + future expires_at → 200 and state active', async () => {
    const state: WritemodeState = { activeUntil: 0, activatedAt: 0 };
    const fixedNow = 1_700_000_000_000;
    const expiresAt = fixedNow + 5 * 60 * 1000;
    const app = buildApp({
      smokeTestKey: KEY,
      state,
      now: () => fixedNow,
    });
    const res = await app.request('http://localhost/writemode/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expires_at: expiresAt,
        hmac_sig: signStart(KEY, expiresAt),
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, active_until: expiresAt });
    expect(isWritemodeActive(state, fixedNow)).toBe(true);
    expect(isWritemodeActive(state, expiresAt + 1)).toBe(false);
  });

  it('invalid HMAC → 401 and state untouched', async () => {
    const state: WritemodeState = { activeUntil: 0, activatedAt: 0 };
    const app = buildApp({ smokeTestKey: KEY, state });
    const expiresAt = Date.now() + 60_000;
    const res = await app.request('http://localhost/writemode/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expires_at: expiresAt,
        hmac_sig: 'deadbeef'.repeat(8), // wrong signature
      }),
    });
    expect(res.status).toBe(401);
    expect(state.activeUntil).toBe(0);
  });

  it('expires_at in the past → 400', async () => {
    const fixedNow = 1_700_000_000_000;
    const expiresAt = fixedNow - 1000;
    const app = buildApp({
      smokeTestKey: KEY,
      now: () => fixedNow,
    });
    const res = await app.request('http://localhost/writemode/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expires_at: expiresAt,
        hmac_sig: signStart(KEY, expiresAt),
      }),
    });
    expect(res.status).toBe(400);
  });

  it('window > MAX_WINDOW_MS → 400', async () => {
    const fixedNow = 1_700_000_000_000;
    const expiresAt = fixedNow + 30 * 60 * 1000; // 30 min > 15 min cap
    const app = buildApp({
      smokeTestKey: KEY,
      now: () => fixedNow,
    });
    const res = await app.request('http://localhost/writemode/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expires_at: expiresAt,
        hmac_sig: signStart(KEY, expiresAt),
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('window_too_long');
  });

  it('malformed JSON body → 400', async () => {
    const app = buildApp({ smokeTestKey: KEY });
    const res = await app.request('http://localhost/writemode/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('stop with valid sig → 200 and clears state', async () => {
    const fixedNow = 1_700_000_000_000;
    const state: WritemodeState = {
      activeUntil: fixedNow + 60_000,
      activatedAt: fixedNow,
    };
    const app = buildApp({
      smokeTestKey: KEY,
      state,
      now: () => fixedNow,
    });
    const res = await app.request('http://localhost/writemode/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hmac_sig: signStop(KEY) }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, was_active: true });
    expect(state.activeUntil).toBe(0);
  });

  it('stop with invalid sig → 401', async () => {
    const app = buildApp({ smokeTestKey: KEY });
    const res = await app.request('http://localhost/writemode/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hmac_sig: 'deadbeef'.repeat(8) }),
    });
    expect(res.status).toBe(401);
  });

  it('stop without SMOKE_TEST_KEY → 404', async () => {
    const app = buildApp({});
    const res = await app.request('http://localhost/writemode/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hmac_sig: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});
