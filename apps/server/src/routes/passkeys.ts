/**
 * /v1/passkeys — Listing eigener WebAuthn-Credentials.
 *
 * Plan-Ref: v1 mcp-approval `GET /webauthn/credentials` Port + Settings-UI.
 *
 *   GET  /v1/passkeys           Listet eigene Passkeys (Bearer-gated, RLS-scoped).
 *
 * Body-Shape:
 *   { passkeys: [{ credentialIdB64, friendlyName, createdAt, lastUsedAt,
 *                  prfSupported, invalidatedAt }] }
 *
 * Multi-User: `db.scoped(userId)` + `WHERE user_id = $1` doppelt enforced.
 *
 * Was hier NICHT lebt:
 *   - Enroll: /auth/webauthn/enroll/{begin,finish} (siehe routes/auth/webauthn.ts).
 *   - Invalidate/Delete: spaeter, v1 hatte das auch nicht (Recovery-Flow setzt
 *     invalidated_at automatisch wenn neuer Passkey enrolled).
 */
import { Hono } from 'hono';
import type { AppBindings, ServerContext } from '../lib/context.js';
import { HttpError } from '../lib/errors.js';
import { auth } from '../middleware/auth.js';

interface PasskeyRow {
  credentialId: Uint8Array | string;
  friendlyName: string | null;
  prfSupported: boolean;
  createdAt: number | string;
  lastUsedAt: number | string | null;
  invalidatedAt: number | string | null;
}

interface PasskeyResponse {
  readonly credentialIdB64: string;
  readonly friendlyName: string | null;
  readonly prfSupported: boolean;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly invalidatedAt: number | null;
}

function bytesToB64Url(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] ?? 0);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function rowToResponse(r: PasskeyRow): PasskeyResponse {
  // credentialId kommt als Uint8Array (postgres-js bytea). Wenn der Treiber
  // bereits einen string liefert (Test-Mocks), durchreichen.
  const credB64 =
    typeof r.credentialId === 'string'
      ? r.credentialId
      : bytesToB64Url(r.credentialId);
  return {
    credentialIdB64: credB64,
    friendlyName: r.friendlyName,
    prfSupported: r.prfSupported,
    createdAt: Number(r.createdAt),
    lastUsedAt: r.lastUsedAt === null ? null : Number(r.lastUsedAt),
    invalidatedAt: r.invalidatedAt === null ? null : Number(r.invalidatedAt),
  };
}

export interface PasskeysRouteDeps {
  readonly server: ServerContext;
}

export function passkeysRoutes(deps: PasskeysRouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const guard = auth(deps.server);

  app.get('/v1/passkeys', guard, async (c) => {
    const principal = c.get('user');
    if (!principal) throw HttpError.unauthorized();
    const scoped = await deps.server.db.scoped(principal.userId);
    const rows = await scoped.query<PasskeyRow>(
      `SELECT credential_id     AS "credentialId",
              friendly_name     AS "friendlyName",
              prf_supported     AS "prfSupported",
              created_at        AS "createdAt",
              last_used_at      AS "lastUsedAt",
              invalidated_at    AS "invalidatedAt"
         FROM webauthn_credentials
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [principal.userId],
    );
    return c.json({ passkeys: rows.map(rowToResponse) });
  });

  return app;
}
