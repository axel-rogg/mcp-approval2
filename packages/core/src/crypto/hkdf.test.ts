import { describe, expect, it } from 'vitest';
import {
  deriveAuditKey,
  deriveRecordKey,
  hkdfSha256,
  hkdfSha256Sync,
} from './hkdf.js';

const enc = new TextEncoder();

describe('hkdfSha256', () => {
  it('is deterministic for fixed inputs', async () => {
    const ikm = enc.encode('master-key-bytes-master-key-bytes');
    const a = await hkdfSha256(ikm, 'salt', 'info', 32);
    const b = await hkdfSha256(ikm, 'salt', 'info', 32);
    expect(a).toEqual(b);
  });

  it('changes output when salt changes', async () => {
    const ikm = enc.encode('master');
    const a = await hkdfSha256(ikm, 'salt1', 'info', 32);
    const b = await hkdfSha256(ikm, 'salt2', 'info', 32);
    expect(a).not.toEqual(b);
  });

  it('changes output when info changes', async () => {
    const ikm = enc.encode('master');
    const a = await hkdfSha256(ikm, 'salt', 'info1', 32);
    const b = await hkdfSha256(ikm, 'salt', 'info2', 32);
    expect(a).not.toEqual(b);
  });

  it('returns the requested length', async () => {
    const ikm = enc.encode('master');
    const a = await hkdfSha256(ikm, 'salt', 'info', 16);
    const b = await hkdfSha256(ikm, 'salt', 'info', 64);
    expect(a.byteLength).toBe(16);
    expect(b.byteLength).toBe(64);
  });

  it('matches noble-hashes sync impl byte-for-byte', async () => {
    const ikm = enc.encode('master');
    const a = await hkdfSha256(ikm, 'salt', 'info', 32);
    const b = hkdfSha256Sync(ikm, 'salt', 'info', 32);
    expect(a).toEqual(b);
  });

  it('rejects empty ikm', async () => {
    await expect(hkdfSha256(new Uint8Array(0), 'salt', 'info', 32)).rejects.toThrow();
    expect(() => hkdfSha256Sync(new Uint8Array(0), 'salt', 'info', 32)).toThrow();
  });

  it('rejects non-positive length', async () => {
    const ikm = enc.encode('master');
    await expect(hkdfSha256(ikm, 'salt', 'info', 0)).rejects.toThrow();
    await expect(hkdfSha256(ikm, 'salt', 'info', -1)).rejects.toThrow();
  });

  it('accepts byte salt and byte info', async () => {
    const ikm = enc.encode('master');
    const a = await hkdfSha256(ikm, enc.encode('salt'), enc.encode('info'), 32);
    const b = await hkdfSha256(ikm, 'salt', 'info', 32);
    expect(a).toEqual(b);
  });
});

describe('deriveRecordKey', () => {
  it('binds output to recordType, recordId, and version', async () => {
    const mk = enc.encode('master-key-32-bytes-master-key-32');
    const k1 = await deriveRecordKey(mk, 'credentials', 'cred-1', 1);
    const k2 = await deriveRecordKey(mk, 'credentials', 'cred-1', 2);
    const k3 = await deriveRecordKey(mk, 'credentials', 'cred-2', 1);
    const k4 = await deriveRecordKey(mk, 'session', 'cred-1', 1);
    expect(k1).not.toEqual(k2);
    expect(k1).not.toEqual(k3);
    expect(k1).not.toEqual(k4);
    expect(k1.byteLength).toBe(32);
  });
});

describe('deriveAuditKey', () => {
  it('is deterministic per master key', async () => {
    const mk = enc.encode('master');
    const a = await deriveAuditKey(mk);
    const b = await deriveAuditKey(mk);
    expect(a).toEqual(b);
    expect(a.byteLength).toBe(32);
  });

  it('changes with the master key', async () => {
    const a = await deriveAuditKey(enc.encode('master-a'));
    const b = await deriveAuditKey(enc.encode('master-b'));
    expect(a).not.toEqual(b);
  });
});
