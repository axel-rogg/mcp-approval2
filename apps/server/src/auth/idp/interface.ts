/**
 * IdentityProvider-Interface.
 *
 * Plan-Ref: PLAN-architecture-v1.md §3.2 (Invite-Flow), §3.3 (Bootstrap).
 *
 * Abstraktion ueber OAuth-IdPs (Google, ggf. spaeter Microsoft / GitHub /
 * Apple). Provider liefert `start()` (Authorization-URL) und `complete()`
 * (Code→Profile) — keine Tokens persistieren, weil mcp-approval2 nur Identity
 * braucht, KEINE Workspace-API-Calls macht (das macht mcp-knowledge2 / mcp-gws).
 */

export interface IdpProfile {
  /** Provider-spezifischer Subject-Claim (z.B. Google `sub`). */
  readonly externalId: string;
  readonly email: string;
  readonly displayName: string;
  readonly emailVerified: boolean;
}

export interface IdpStartParams {
  readonly state: string;
  readonly nonce: string;
  /** Optional Invite-Token zur Carry-Through (cookie-frei). */
  readonly inviteToken?: string;
}

export interface IdpStartResult {
  /** Vollstaendige Authorization-URL fuer 302-Redirect. */
  readonly authorizationUrl: string;
}

export interface IdpCompleteParams {
  readonly code: string;
  readonly state: string;
  readonly expectedState: string;
  readonly nonce: string;
}

export interface IdentityProvider {
  readonly id: 'google' | string;
  start(p: IdpStartParams): Promise<IdpStartResult>;
  complete(p: IdpCompleteParams): Promise<IdpProfile>;
}
