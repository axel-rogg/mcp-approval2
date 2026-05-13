/**
 * OpenBao / Vault API response shapes used by the OpenBaoKekProvider.
 *
 * We only model the fields we actually read. OpenBao mirrors HashiCorp
 * Vault's REST shape, so these stay accurate for both backends.
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §5.2.
 */

/** Envelope-Wrap fields shared by most Vault responses. */
export interface VaultEnvelope<TData> {
  readonly request_id?: string;
  readonly lease_id?: string;
  readonly renewable?: boolean;
  readonly lease_duration?: number;
  readonly data?: TData;
  readonly warnings?: readonly string[] | null;
}

/** Body of POST /v1/auth/approle/login. */
export interface AppRoleLoginResponse {
  readonly auth: {
    readonly client_token: string;
    readonly accessor?: string;
    readonly policies?: readonly string[];
    readonly token_policies?: readonly string[];
    readonly metadata?: Record<string, string>;
    readonly lease_duration: number;
    readonly renewable: boolean;
    readonly entity_id?: string;
    readonly token_type?: string;
    readonly orphan?: boolean;
  };
}

/** Body of POST /v1/auth/token/renew-self. */
export interface TokenRenewResponse {
  readonly auth: {
    readonly client_token: string;
    readonly lease_duration: number;
    readonly renewable: boolean;
  };
}

/** Body of POST /v1/{mount}/encrypt/{key}. */
export type TransitEncryptResponse = VaultEnvelope<{
  readonly ciphertext: string; // "vault:v1:<base64>"
  readonly key_version?: number;
}>;

/** Body of POST /v1/{mount}/decrypt/{key}. */
export type TransitDecryptResponse = VaultEnvelope<{
  readonly plaintext: string; // base64-encoded DEK
}>;

/** Body of an error response. Vault returns `{ errors: string[] }`. */
export interface VaultErrorBody {
  readonly errors?: readonly string[];
}

/** Internal: how an HTTP failure surfaces to the caller. */
export interface HttpFailure {
  readonly status: number;
  readonly errors: readonly string[];
  readonly rawBody: string;
}
