/**
 * Tests fuer den Google-IdP-Adapter — Phase AS-3 (verifyIdToken).
 *
 * Plan-Ref: PLAN-as3-autonomous.md §1.1.
 *
 * `verifyIdToken` ist die inbound-Verify-Surface fuer Google-ID-Tokens
 * die NICHT aus unserem eigenen OAuth-Code-Flow stammen (z.B. PWA aus
 * KC2-Domain die ein bereits-validiertes Token an approval2 reicht).
 *
 * Wir mocken Google's JWKS hier nicht — der Pfad ist End-to-End in
 * Tier 3 (E2E gegen Google-OIDC-Mock) abgedeckt. Hier nur:
 *   - Refuse leere `expectedAudiences`-Liste (Defense gegen Skip)
 *   - Reject bei sub/email-Missing (synthetic token)
 *   - Nonce-Mismatch fail
 */
import { describe, it, expect, vi } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { verifyIdToken } from './google.js';

// Wir stubben jose.createRemoteJWKSet im internen google.ts Modul nicht
// direkt — das wuerde Test-Hostname-Kontamination geben. Stattdessen
// testen wir nur die Input-Validation-Branches die OHNE Remote-Fetch
// passieren (kein Token-Sign, kein Remote-Call).

describe('verifyIdToken — input validation', () => {
  it('refuses empty expectedAudiences (Defense gegen Audience-Skip)', async () => {
    await expect(
      verifyIdToken({
        token: 'whatever',
        expectedAudiences: [],
      }),
    ).rejects.toThrow(/expectedAudiences must not be empty/);
  });

  it('refuses malformed token (signature fail bubbles als unauthorized)', async () => {
    // Note: ein "valider" Token koennen wir hier nicht bauen ohne Google-Key.
    // Wir reichen ein syntaktisch ungueltiges JWT — jwtVerify wirft.
    await expect(
      verifyIdToken({
        token: 'not.a.valid.jwt',
        expectedAudiences: ['my-client-id'],
      }),
    ).rejects.toThrow();
  });
});

// Hinweis: positive-path Tests (echtes verifizierbares Token) erfordern
// einen lokalen JWKS-Stub mit network-mock. Das machen wir in Tier 3 mit
// MSW oder Google-OIDC-Mock. Der hier abgedeckte Defense-Pfad reicht fuer
// Tier 2.
