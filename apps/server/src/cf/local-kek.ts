/**
 * createCfLocalKekProvider — wires the existing `LocalKekProvider` against the
 * Cloudflare `MASTER_KEY` secret.
 *
 * TRUST MODEL — read carefully:
 *   The CF deploy is a SINGLE-OPERATOR PRIVATE setup. There is no OpenBao,
 *   no HSM, no per-user Transit-engine. The master key sits as a CF Worker
 *   secret (encrypted at rest by Cloudflare, decrypted at boot inside an
 *   isolate). HKDF-derives per-user KEKs from that one master.
 *
 *   The operator (= you) implicitly trusts Cloudflare with the encrypted
 *   master key blob. If that's not OK, deploy the Node + OpenBao variant
 *   instead (see deploy/fly/Dockerfile.server + docker-compose.yml).
 *
 *   Multi-user under this provider is technically possible but the operator
 *   can still impersonate any user offline (re-derive their KEK from the
 *   master key). This is documented in apps/server/src/cf/README.md and in
 *   the runbook. Don't ship this to non-trusting tenants.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5 (Crypto), ADR-0002 (KEK provider
 * selection), and the carve-out in docs/runbooks/runbook-cloudflare-deploy.md.
 */
import {
  LocalKekProvider,
  type KekProvider,
} from '@mcp-approval2/adapters';

/**
 * Decode base64 (standard alphabet, not URL-safe). We can't rely on Buffer
 * inside a Worker isolate even with nodejs_compat, so we use `atob`.
 */
function decodeBase64(b64: string): Uint8Array {
  const trimmed = b64.trim();
  // Tolerate both standard and URL-safe alphabets — operators occasionally
  // paste base64url.
  const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLen);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function createCfLocalKekProvider(masterKeyBase64: string): KekProvider {
  if (!masterKeyBase64 || masterKeyBase64.trim() === '') {
    throw new Error(
      'createCfLocalKekProvider: MASTER_KEY secret is empty. Set it via ' +
        '`wrangler secret put MASTER_KEY` with a 32-byte base64 value.',
    );
  }
  const masterKey = decodeBase64(masterKeyBase64);
  if (masterKey.byteLength !== 32) {
    throw new Error(
      `createCfLocalKekProvider: MASTER_KEY must decode to 32 bytes (got ${masterKey.byteLength}). ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }
  return new LocalKekProvider({ masterKey });
}
