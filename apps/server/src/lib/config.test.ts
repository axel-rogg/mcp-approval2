/**
 * Tests fuer Multi-Origin-Helpers in config.ts.
 *
 * Fokus: SEC-003 fail-closed Verhalten von resolveOrigin.
 */
import { describe, it, expect } from 'vitest';
import { resolveOrigin, resolveRpId, type AppConfig } from './config.js';

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    NODE_ENV: 'test',
    PORT: 0,
    ORIGIN: 'https://mcp.example.test',
    DATABASE_URL: 'postgres://stub',
    DATABASE_DIALECT: 'postgres',
    JWT_SECRET: 'x'.repeat(48),
    JWT_ISSUER: 'mcp-approval2',
    JWT_AUDIENCE: 'mcp-approval2-api',
    SESSION_TTL_SEC: 1800,
    REFRESH_TTL_SEC: 30 * 24 * 60 * 60,
    GOOGLE_CLIENT_ID: 'stub',
    GOOGLE_CLIENT_SECRET: 'stub',
    GOOGLE_REDIRECT_URI: 'http://localhost:8787/auth/google/callback',
    RP_ID: 'mcp.example.test',
    RP_NAME: 'mcp-approval2',
    RP_ORIGIN: 'https://mcp.example.test',
    INVITE_TTL_SEC: 24 * 60 * 60,
    RECOVERY_TTL_SEC: 24 * 60 * 60,
    ALLOWED_ORIGINS: [],
    COOKIE_DOMAIN: '',
    GOOGLE_ALLOWED_AUDIENCES: [],
    DCR_OPEN: false,
    DCR_ALLOWED_REDIRECT_HOSTS: [],
    ...overrides,
  };
}

function mkReq(headers: Record<string, string>) {
  return {
    headers: {
      get(name: string): string | null {
        return headers[name.toLowerCase()] ?? null;
      },
    },
  };
}

describe('resolveOrigin — SEC-003 fail-closed', () => {
  it('akzeptiert RP_ORIGIN auch wenn ALLOWED_ORIGINS leer', () => {
    const c = baseConfig();
    const req = mkReq({ origin: 'https://mcp.example.test' });
    expect(resolveOrigin(req, c)).toBe('https://mcp.example.test');
  });

  it('lehnt fremden Origin bei leerer Allowlist ab (fail-closed Fallback auf RP_ORIGIN)', () => {
    const c = baseConfig();
    const req = mkReq({ origin: 'https://attacker.example' });
    // Vor dem Fix: jeder Origin wurde durchgelassen wenn ALLOWED_ORIGINS leer.
    // Jetzt: nur RP_ORIGIN akzeptiert.
    expect(resolveOrigin(req, c)).toBe('https://mcp.example.test');
  });

  it('akzeptiert Origin aus ALLOWED_ORIGINS', () => {
    const c = baseConfig({
      ALLOWED_ORIGINS: ['https://app.example.test'],
    });
    const req = mkReq({ origin: 'https://app.example.test' });
    expect(resolveOrigin(req, c)).toBe('https://app.example.test');
  });

  it('akzeptiert RP_ORIGIN auch wenn ALLOWED_ORIGINS nicht-leer (implizit hinzu)', () => {
    const c = baseConfig({
      ALLOWED_ORIGINS: ['https://app.example.test'], // RP_ORIGIN NICHT in der Liste
    });
    const req = mkReq({ origin: 'https://mcp.example.test' });
    expect(resolveOrigin(req, c)).toBe('https://mcp.example.test');
  });

  it('Host-Header Fallback nur fuer Allowlist-Origins', () => {
    const c = baseConfig({
      ALLOWED_ORIGINS: ['https://app.example.test'],
    });
    const reqOk = mkReq({ host: 'app.example.test' });
    expect(resolveOrigin(reqOk, c)).toBe('https://app.example.test');
    const reqBad = mkReq({ host: 'attacker.example' });
    expect(resolveOrigin(reqBad, c)).toBe('https://mcp.example.test');
  });

  it('Kein Header → RP_ORIGIN', () => {
    const c = baseConfig();
    expect(resolveOrigin(mkReq({}), c)).toBe('https://mcp.example.test');
  });
});

describe('resolveRpId', () => {
  it('extrahiert hostname aus URL', () => {
    expect(resolveRpId('https://mcp.example.test')).toBe('mcp.example.test');
    expect(resolveRpId('https://app.example.test:8443')).toBe('app.example.test');
  });

  it('behandelt unguelt URL als hostname-string', () => {
    expect(resolveRpId('localhost')).toBe('localhost');
  });
});
