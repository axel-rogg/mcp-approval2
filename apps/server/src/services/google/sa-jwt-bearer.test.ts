import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { parseServiceAccountKey, requestSaAccessToken } from './sa-jwt-bearer.js';

function buildTestSaJson(): { json: string; privateKey: string; clientEmail: string } {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const clientEmail = 'test-sa@test-project.iam.gserviceaccount.com';
  const json = JSON.stringify({
    type: 'service_account',
    project_id: 'test-project',
    private_key_id: 'test-key-id',
    private_key: privateKey,
    client_email: clientEmail,
    token_uri: 'https://oauth2.googleapis.com/token',
  });
  return { json, privateKey, clientEmail };
}

describe('parseServiceAccountKey', () => {
  it('parses a valid SA-JSON', () => {
    const { json } = buildTestSaJson();
    const sa = parseServiceAccountKey(json);
    expect(sa.client_email).toBe('test-sa@test-project.iam.gserviceaccount.com');
    expect(sa.project_id).toBe('test-project');
    expect(sa.private_key_id).toBe('test-key-id');
    expect(sa.token_uri).toBe('https://oauth2.googleapis.com/token');
    expect(sa.private_key).toContain('PRIVATE KEY');
  });

  it('falls back to default token_uri when missing', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const json = JSON.stringify({
      client_email: 'a@b.c',
      private_key: privateKey,
    });
    const sa = parseServiceAccountKey(json);
    expect(sa.token_uri).toBe('https://oauth2.googleapis.com/token');
  });

  it('rejects invalid JSON', () => {
    expect(() => parseServiceAccountKey('not-json')).toThrow(/parsing failed/);
  });

  it('rejects non-object', () => {
    expect(() => parseServiceAccountKey('"string"')).toThrow(/kein Objekt/);
  });

  it('rejects missing client_email', () => {
    expect(() =>
      parseServiceAccountKey(JSON.stringify({ private_key: 'PEM' })),
    ).toThrow(/client_email/);
  });

  it('rejects missing private_key', () => {
    expect(() =>
      parseServiceAccountKey(JSON.stringify({ client_email: 'a@b.c' })),
    ).toThrow(/private_key/);
  });

  it('rejects malformed private_key (not PEM)', () => {
    expect(() =>
      parseServiceAccountKey(
        JSON.stringify({ client_email: 'a@b.c', private_key: 'not-a-pem' }),
      ),
    ).toThrow(/private_key/);
  });
});

describe('requestSaAccessToken', () => {
  it('exchanges a signed JWT for an access_token', async () => {
    const { json } = buildTestSaJson();
    const sa = parseServiceAccountKey(json);

    let capturedUrl: string | URL = '';
    let capturedBody = '';
    const fakeFetch: typeof fetch = async (input, init) => {
      capturedUrl = input as string | URL;
      capturedBody = (init?.body as string) ?? '';
      return new Response(
        JSON.stringify({ access_token: 'fake-token-xyz', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const result = await requestSaAccessToken({ sa, fetchImpl: fakeFetch });
    expect(result.accessToken).toBe('fake-token-xyz');
    expect(result.expiresInSec).toBe(3600);
    expect(result.projectId).toBe('test-project');
    expect(String(capturedUrl)).toBe('https://oauth2.googleapis.com/token');

    // Body muss grant_type + assertion enthalten
    const params = new URLSearchParams(capturedBody);
    expect(params.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    );
    const assertion = params.get('assertion');
    expect(assertion).toBeTruthy();
    // JWT = 3 parts separated by '.'
    expect(assertion?.split('.')).toHaveLength(3);
  });

  it('uses custom scopes when provided', async () => {
    const { json } = buildTestSaJson();
    const sa = parseServiceAccountKey(json);
    let capturedAssertion = '';
    const fakeFetch: typeof fetch = async (_input, init) => {
      const body = (init?.body as string) ?? '';
      capturedAssertion = new URLSearchParams(body).get('assertion') ?? '';
      return new Response(
        JSON.stringify({ access_token: 't', expires_in: 3600 }),
        { status: 200 },
      );
    };
    await requestSaAccessToken({
      sa,
      fetchImpl: fakeFetch,
      scopes: [
        'https://www.googleapis.com/auth/devstorage.read_only',
        'https://www.googleapis.com/auth/compute.readonly',
      ],
    });
    // Decode JWT payload (middle section)
    const payload = JSON.parse(
      Buffer.from(capturedAssertion.split('.')[1] ?? '', 'base64url').toString('utf-8'),
    ) as { scope: string };
    expect(payload.scope).toContain('devstorage');
    expect(payload.scope).toContain('compute');
  });

  it('throws on HTTP error', async () => {
    const { json } = buildTestSaJson();
    const sa = parseServiceAccountKey(json);
    const fakeFetch: typeof fetch = async () =>
      new Response('Bad Request', { status: 400 });
    await expect(requestSaAccessToken({ sa, fetchImpl: fakeFetch })).rejects.toThrow(
      /HTTP 400/,
    );
  });

  it('throws on error in response body', async () => {
    const { json } = buildTestSaJson();
    const sa = parseServiceAccountKey(json);
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'expired' }),
        { status: 200 },
      );
    await expect(requestSaAccessToken({ sa, fetchImpl: fakeFetch })).rejects.toThrow(
      /invalid_grant/,
    );
  });
});
