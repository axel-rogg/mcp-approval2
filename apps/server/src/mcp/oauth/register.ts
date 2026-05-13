/**
 * Dynamic Client Registration (RFC 7591).
 *
 * POST /oauth/register
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4, MCP-Spec Nov 2025.
 *
 * Open Registration (kein Initial-Access-Token noetig fuer MCP-Pilot —
 * der MCP-Hub ist single-tenant + invite-gated, der vorgelagerte Auth-
 * Schutz reicht aus). Wir generieren:
 *
 *   - `client_id`              — random UUID
 *   - `client_secret`          — random 32-byte base64url (NULL bei
 *                                 token_endpoint_auth_method='none')
 *   - `registration_access_token` — RFC 7592 Update/Delete-Token
 *
 * Validation (RFC 7591 §2.0):
 *   - redirect_uris: Pflicht, mind. 1, alle valid-URL.
 *   - grant_types: optional, default ['authorization_code','refresh_token'].
 *     Allowed: ['authorization_code', 'refresh_token'].
 *   - response_types: optional. Allowed: ['code'].
 *   - token_endpoint_auth_method: 'client_secret_post'|'client_secret_basic'|'none'.
 */
import { Hono } from 'hono';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { oauthError } from './errors.js';
import type {
  ClientRegistrationResponse,
} from './types.js';

const ALLOWED_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;
const ALLOWED_AUTH_METHODS = ['client_secret_post', 'client_secret_basic', 'none'] as const;
const ALLOWED_RESPONSE_TYPES = ['code'] as const;

const RegisterBodySchema = z
  .object({
    redirect_uris: z
      .array(z.string().url(), { invalid_type_error: 'redirect_uris must be array of URLs' })
      .min(1, 'redirect_uris must contain at least one URI'),
    grant_types: z
      .array(z.enum(ALLOWED_GRANT_TYPES))
      .optional()
      .default(['authorization_code', 'refresh_token']),
    response_types: z.array(z.enum(ALLOWED_RESPONSE_TYPES)).optional().default(['code']),
    scope: z.string().optional(),
    token_endpoint_auth_method: z
      .enum(ALLOWED_AUTH_METHODS)
      .optional()
      .default('client_secret_post'),
    client_name: z.string().min(1).max(200).optional(),
    client_uri: z.string().url().optional(),
    logo_uri: z.string().url().optional(),
    contacts: z.array(z.string().email()).optional(),
    software_id: z.string().min(1).max(200).optional(),
  })
  .strict();

export function registerRoutes(server: ServerContext): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.post('/oauth/register', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return oauthError(c, 400, 'invalid_client_metadata', 'request body must be JSON');
    }
    const parsed = RegisterBodySchema.safeParse(body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return oauthError(c, 400, 'invalid_client_metadata', msg);
    }
    const meta = parsed.data;

    // Generate identity.
    const clientId = randomUUID();
    const isPublicClient = meta.token_endpoint_auth_method === 'none';
    const clientSecretRaw = isPublicClient ? null : randomBytes(32).toString('base64url');
    const clientSecretHash = clientSecretRaw
      ? createHash('sha256').update(clientSecretRaw).digest('hex')
      : null;
    const registrationAccessToken = randomBytes(32).toString('base64url');
    const registrationAccessTokenHash = createHash('sha256')
      .update(registrationAccessToken)
      .digest('hex');

    const createdAt = Date.now();

    // Persist via unsafe (Service-Rolle, kein User-Scope).
    const raw = server.db.unsafe('oauth_register_client');
    await raw.query(
      `INSERT INTO oauth_clients (
        client_id, client_secret_hash, redirect_uris, grant_types, scope,
        token_endpoint_auth_method, client_name, client_uri, logo_uri, contacts,
        software_id, registration_access_token_hash, created_at, expires_at,
        registration_source
      ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5,
                $6, $7, $8, $9, $10::jsonb,
                $11, $12, $13, NULL, 'dcr')`,
      [
        clientId,
        clientSecretHash,
        JSON.stringify(meta.redirect_uris),
        JSON.stringify(meta.grant_types),
        meta.scope ?? null,
        meta.token_endpoint_auth_method,
        meta.client_name ?? null,
        meta.client_uri ?? null,
        meta.logo_uri ?? null,
        meta.contacts ? JSON.stringify(meta.contacts) : null,
        meta.software_id ?? null,
        registrationAccessTokenHash,
        createdAt,
      ],
    );

    const response: ClientRegistrationResponse = {
      client_id: clientId,
      client_id_issued_at: Math.floor(createdAt / 1000),
      ...(clientSecretRaw
        ? {
            client_secret: clientSecretRaw,
            client_secret_expires_at: 0,
          }
        : {}),
      registration_access_token: registrationAccessToken,
      registration_client_uri: `${server.config.ORIGIN.replace(/\/$/, '')}/oauth/register/${clientId}`,
      redirect_uris: meta.redirect_uris,
      grant_types: meta.grant_types,
      token_endpoint_auth_method: meta.token_endpoint_auth_method,
      ...(meta.client_name !== undefined ? { client_name: meta.client_name } : {}),
      ...(meta.client_uri !== undefined ? { client_uri: meta.client_uri } : {}),
      ...(meta.logo_uri !== undefined ? { logo_uri: meta.logo_uri } : {}),
      ...(meta.contacts !== undefined ? { contacts: meta.contacts } : {}),
      ...(meta.software_id !== undefined ? { software_id: meta.software_id } : {}),
      ...(meta.scope !== undefined ? { scope: meta.scope } : {}),
    };

    return c.json(response, 201);
  });

  return app;
}
