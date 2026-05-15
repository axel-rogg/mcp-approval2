/**
 * Env-Schema-Surface — re-exports + Type-Erweiterungen fuer das Boot-Env.
 *
 * Plan-Ref: PLAN-as3-autonomous.md §1.7 + PLAN-architecture-v1.md §13.
 *
 * Die kanonische Implementation lebt in `apps/server/src/lib/config.ts`
 * (Zod-Schema + `loadConfig(env)` factory + Multi-Origin-Helpers). Dieses
 * File ist die durch den AS-3-Spec referenzierte Pfad-Position
 * (`apps/server/src/schema/env.ts`) und re-exportiert die Surface, damit
 * neue Code-Pfade (kc-proxy, kc_wrappers, OAuth-Facade Erweiterungen)
 * einen einheitlichen Import-Pfad haben.
 *
 * Migration-Plan: bei Bedarf kann `lib/config.ts` spaeter hierher
 * verschoben werden; vorerst leben beide Pfade parallel ohne Duplizierung.
 *
 * Neue AS-3-Felder (siehe lib/config.ts ConfigSchema):
 *   - MCP_KNOWLEDGE_URL: optional, KC2-Base-URL
 *   - MCP_KNOWLEDGE_SERVICE_TOKEN: optional, shared S2S Bearer
 *   - SELF_OAUTH_ISSUER: optional, `iss`-Claim in OBO-JWTs, default ORIGIN
 *   - GOOGLE_ALLOWED_AUDIENCES: optional CSV fuer inbound ID-Token-Verify
 */

export {
  loadConfig,
  resolveOrigin,
  resolveRpId,
  type AppConfig,
} from '../lib/config.js';

/**
 * Helper: liefert den effektiven OAuth-Issuer fuer OBO-JWTs.
 * Fallback-Pfad: SELF_OAUTH_ISSUER ?? ORIGIN. Beide haben kein trailing-slash.
 */
export function effectiveOauthIssuer(config: {
  SELF_OAUTH_ISSUER?: string;
  ORIGIN: string;
}): string {
  return (config.SELF_OAUTH_ISSUER ?? config.ORIGIN).replace(/\/+$/, '');
}

/**
 * Helper: liefert die akzeptierten Google-Audiences fuer inbound
 * `verifyIdToken`-Calls. Mindestens GOOGLE_CLIENT_ID + alle Eintraege aus
 * GOOGLE_ALLOWED_AUDIENCES (deduped).
 */
export function effectiveGoogleAudiences(config: {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_ALLOWED_AUDIENCES: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const set = new Set<string>([config.GOOGLE_CLIENT_ID, ...config.GOOGLE_ALLOWED_AUDIENCES]);
  return [...set];
}
