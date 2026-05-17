/**
 * Security-Headers Middleware.
 *
 * Family-Hardening 2026-05-17: minimale Defense-in-Depth-Header gegen
 * Clickjacking, MIME-Sniff, Referrer-Leak, XSS-Schadensmultiplikator.
 *
 * Headers (alle defensiv, brechen keine bestehenden Pfade):
 *   - X-Content-Type-Options: nosniff
 *   - X-Frame-Options: DENY
 *   - Referrer-Policy: strict-origin-when-cross-origin
 *   - Strict-Transport-Security: max-age=15552000; includeSubDomains
 *   - X-Permitted-Cross-Domain-Policies: none
 *   - Origin-Agent-Cluster: ?1
 *   - Cross-Origin-Resource-Policy: same-origin
 *
 * CSP wird hier bewusst NICHT gesetzt — die PWA nutzt inline-bootstrap +
 * dynamische import()-Pfade, eine zu strikte CSP wuerde die App brechen.
 * Wenn CSP gewünscht: in einer eigenen Phase mit nonce-Pattern bauen.
 */
import { secureHeaders } from 'hono/secure-headers';
import type { MiddlewareHandler } from 'hono';
import type { AppBindings } from '../lib/context.js';

export function securityHeaders(): MiddlewareHandler<AppBindings> {
  return secureHeaders({
    xContentTypeOptions: 'nosniff',
    xFrameOptions: 'DENY',
    referrerPolicy: 'strict-origin-when-cross-origin',
    strictTransportSecurity: 'max-age=15552000; includeSubDomains',
    xPermittedCrossDomainPolicies: 'none',
    originAgentCluster: '?1',
    crossOriginResourcePolicy: 'same-origin',
    // CSP weggelassen — siehe Datei-Header (PWA hat dynamische imports +
    // inline-bootstrap; strict-CSP würde sie brechen).
    // X-XSS-Protection deprecated; Hono default '0' ist ok.
  });
}
