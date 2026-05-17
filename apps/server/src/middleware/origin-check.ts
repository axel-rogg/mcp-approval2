/**
 * Origin-Check Middleware (CSRF-Lite).
 *
 * Family-Hardening 2026-05-17: blockt klassische CSRF gegen Cookie-Sessions.
 * Browser senden `Origin`-Header automatisch bei cross-origin POST/PUT/PATCH/
 * DELETE. Wir matchen gegen den konfigurierten Origin-Set; mismatch → 403.
 *
 * Erlaubte Origins:
 *   - `server.config.ORIGIN` (primärer Origin)
 *   - `server.config.ALLOWED_ORIGINS` (CSV, Multi-Origin-Setup)
 *
 * Was wir bewusst NICHT prüfen:
 *   - GET/HEAD/OPTIONS — RFC-7231 sind safe-Methods, Browser senden Origin
 *     hier inkonsistent (Firefox z.B. erst seit 70).
 *   - Routen ohne Cookie-Auth (Bearer-only-Routen — MCP, /v1/* mit
 *     Authorization-Header). CSRF-Vektor ist Cookie-basiert; Bearer-Token
 *     muss der Angreifer sowieso aktiv stehlen.
 *   - Fehlender Origin-Header — manche User-Agents (curl, native apps,
 *     non-browser-MCP-Clients) senden gar nichts. Wir akzeptieren das,
 *     blockieren nur ein vorhandenes-aber-falsches Origin.
 *
 * Diese Middleware ist surgical mountable: nur auf /auth/* und /oauth/*
 * verkabelt in app-factory. Restliche Routen bleiben unverändert.
 */
import type { MiddlewareHandler } from 'hono';
import { HttpError } from '../lib/errors.js';
import type { AppBindings } from '../lib/context.js';
import type { AppConfig } from '../lib/config.js';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface OriginCheckConfig {
  readonly ORIGIN: AppConfig['ORIGIN'];
  readonly ALLOWED_ORIGINS: AppConfig['ALLOWED_ORIGINS'];
}

export function originCheck(config: OriginCheckConfig): MiddlewareHandler<AppBindings> {
  const allowed = buildAllowedSet(config);
  return async (c, next) => {
    if (!STATE_CHANGING_METHODS.has(c.req.method)) {
      return next();
    }
    const origin = c.req.header('origin');
    if (!origin) {
      // Fehlender Origin: nicht-Browser-Client. Weiterlaufen — Auth-Layer fängt
      // separat.
      return next();
    }
    if (!allowed.has(origin)) {
      throw HttpError.forbidden(
        'origin_not_allowed',
        `Origin '${origin}' is not in the allowed set`,
      );
    }
    return next();
  };
}

function buildAllowedSet(config: OriginCheckConfig): Set<string> {
  const set = new Set<string>();
  if (config.ORIGIN) set.add(config.ORIGIN);
  // ALLOWED_ORIGINS ist nach zod-transform ein ReadonlyArray<string>.
  for (const o of config.ALLOWED_ORIGINS ?? []) {
    if (o) set.add(o);
  }
  return set;
}
