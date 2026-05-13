import { describe, expect, it } from 'vitest';
import { PRF_DEK_LEN, xorBytes, xorPrfDek } from './prf-xor.js';
import { randomBytes } from './random.js';

describe('xorPrfDek', () => {
  it('is its own inverse', () => {
    const a = randomBytes(PRF_DEK_LEN);
    const b = randomBytes(PRF_DEK_LEN);
    const mixed = xorPrfDek(a, b);
    const recovered = xorPrfDek(mixed, b);
    expect(recovered).toEqual(a);
  });

  it('produces all-zeros for a XOR a', () => {
    const a = randomBytes(PRF_DEK_LEN);
    const zero = xorPrfDek(a, a);
    expect(zero).toEqual(new Uint8Array(PRF_DEK_LEN));
  });

  it('returns a fresh buffer (does not mutate inputs)', () => {
    const a = new Uint8Array(PRF_DEK_LEN);
    const b = new Uint8Array(PRF_DEK_LEN);
    a[0] = 0xff;
    const out = xorPrfDek(a, b);
    expect(out).not.toBe(a);
    expect(out).not.toBe(b);
    expect(a[0]).toBe(0xff); // unchanged
    expect(b[0]).toBe(0x00); // unchanged
    expect(out[0]).toBe(0xff);
  });

  it('rejects wrong length on a', () => {
    expect(() => xorPrfDek(new Uint8Array(16), new Uint8Array(PRF_DEK_LEN))).toThrow();
  });

  it('rejects wrong length on b', () => {
    expect(() => xorPrfDek(new Uint8Array(PRF_DEK_LEN), new Uint8Array(16))).toThrow();
  });
});

describe('xorBytes', () => {
  it('xors equal-length buffers', () => {
    const a = new Uint8Array([0x0f, 0xf0]);
    const b = new Uint8Array([0xff, 0xff]);
    expect(xorBytes(a, b)).toEqual(new Uint8Array([0xf0, 0x0f]));
  });

  it('throws on length mismatch', () => {
    expect(() => xorBytes(new Uint8Array(2), new Uint8Array(3))).toThrow(
      /length mismatch/,
    );
  });
});
