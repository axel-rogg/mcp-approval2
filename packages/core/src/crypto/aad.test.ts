import { describe, expect, it } from 'vitest';
import { aadBytes, buildAad } from './aad.js';

describe('buildAad', () => {
  it('builds credentials-AAD', () => {
    expect(
      buildAad({
        recordType: 'credentials',
        owner: 'u1',
        provider: 'jira',
        kind: 'api_token',
        id: 'c1',
      }),
    ).toBe('credentials|u1|jira|api_token|c1');
  });

  it('builds session-AAD', () => {
    expect(
      buildAad({
        recordType: 'session',
        userId: 'u1',
        sessionId: 's1',
      }),
    ).toBe('session|u1|s1');
  });

  it('builds audit-AAD', () => {
    expect(
      buildAad({
        recordType: 'audit',
        eventId: 'e1',
        requestId: 'r1',
      }),
    ).toBe('audit|e1|r1');
  });

  it('builds object-AAD', () => {
    expect(
      buildAad({
        recordType: 'object',
        owner: 'u1',
        kind: 'doc',
        subtype: 'plain',
        id: 'o1',
      }),
    ).toBe('object|u1|doc|plain|o1');
  });

  it('builds generic-AAD', () => {
    expect(
      buildAad({
        recordType: 'generic',
        namespace: 'ns',
        id: 'id1',
      }),
    ).toBe('generic|ns|id1');
  });

  it('rejects empty fields', () => {
    expect(() =>
      buildAad({
        recordType: 'credentials',
        owner: '',
        provider: 'jira',
        kind: 'api_token',
        id: 'c1',
      }),
    ).toThrow(/owner/);
  });

  it('rejects fields containing the pipe separator', () => {
    expect(() =>
      buildAad({
        recordType: 'generic',
        namespace: 'ns|injected',
        id: 'id1',
      }),
    ).toThrow(/pipe/);
  });

  it('differentiates record-types even with identical ids', () => {
    const a = buildAad({
      recordType: 'session',
      userId: 'u1',
      sessionId: 's1',
    });
    const b = buildAad({
      recordType: 'generic',
      namespace: 'u1',
      id: 's1',
    });
    expect(a).not.toBe(b);
  });
});

describe('aadBytes', () => {
  it('encodes strings as UTF-8 bytes', () => {
    const out = aadBytes('abc');
    expect(out).toEqual(new Uint8Array([0x61, 0x62, 0x63]));
  });

  it('passes through Uint8Array unchanged', () => {
    const buf = new Uint8Array([1, 2, 3]);
    expect(aadBytes(buf)).toBe(buf);
  });
});
