#!/usr/bin/env tsx
/**
 * OpenBao initial setup nach `vault operator init && vault operator unseal`.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.2 (OpenBao-Setup).
 *
 * Schritte (alle idempotent, Check-Then-Create):
 *   1. transit secrets engine an /transit aktivieren
 *   2. Policy "mcp-approval2" schreiben (encrypt/decrypt auf transit/keys/user-*)
 *   3. approle auth method an /auth/approle aktivieren
 *   4. AppRole "mcp-approval2" anlegen mit der Policy
 *   5. role_id auslesen + secret_id generieren
 *   6. Print role_id + secret_id (Operator copy-pastet in .env)
 *
 * Env:
 *   VAULT_ADDR   default http://127.0.0.1:8200
 *   VAULT_TOKEN  Root- oder Privileged-Token (NUR fuer Bootstrap)
 *
 * Exit-Codes:
 *   0 — alle Schritte ok
 *   1 — Vault unreachable oder Step gescheitert
 *   2 — VAULT_TOKEN nicht gesetzt
 */

const POLICY_NAME = 'mcp-approval2';
const APPROLE_NAME = 'mcp-approval2';
const TRANSIT_MOUNT = 'transit';
const APPROLE_MOUNT = 'approle';

// Policy: encrypt/decrypt/rewrap auf alle user-* Keys, create-key wenn der
// User noch keinen hat. KEIN read fuer Key-Material (das verlaesst Vault nie).
// KEIN destroy — Crypto-Shred laeuft ueber separates Admin-Token (siehe §5.5).
const POLICY_HCL = `
path "${TRANSIT_MOUNT}/encrypt/user-*" {
  capabilities = ["update"]
}
path "${TRANSIT_MOUNT}/decrypt/user-*" {
  capabilities = ["update"]
}
path "${TRANSIT_MOUNT}/rewrap/user-*" {
  capabilities = ["update"]
}
path "${TRANSIT_MOUNT}/keys/user-*" {
  capabilities = ["create", "update"]
}
`.trim();

type VaultRes = { ok: boolean; status: number; body: unknown };

class Vault {
  constructor(
    private addr: string,
    private token: string,
  ) {}

  private async req(method: string, path: string, body?: unknown): Promise<VaultRes> {
    const url = `${this.addr}/v1/${path.replace(/^\/+/, '')}`;
    const res = await fetch(url, {
      method,
      headers: {
        'X-Vault-Token': this.token,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed: unknown = null;
    const text = await res.text();
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { ok: res.ok, status: res.status, body: parsed };
  }

  get(path: string) { return this.req('GET', path); }
  post(path: string, body?: unknown) { return this.req('POST', path, body ?? {}); }
  put(path: string, body?: unknown) { return this.req('PUT', path, body ?? {}); }
}

async function ensureMount(vault: Vault, mount: string, type: string) {
  const list = await vault.get('sys/mounts');
  const mounts = (list.body as { data?: Record<string, unknown> } | null)?.data ?? {};
  const key = `${mount}/`;
  if (key in mounts) {
    console.log(`  ok   mount ${mount} (already enabled, type=${type})`);
    return;
  }
  const res = await vault.post(`sys/mounts/${mount}`, { type });
  if (!res.ok) {
    throw new Error(`mount ${mount} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(`  +    mount ${mount} (enabled, type=${type})`);
}

async function ensureAuthMethod(vault: Vault, mount: string, type: string) {
  const list = await vault.get('sys/auth');
  const methods = (list.body as { data?: Record<string, unknown> } | null)?.data ?? {};
  const key = `${mount}/`;
  if (key in methods) {
    console.log(`  ok   auth ${mount} (already enabled, type=${type})`);
    return;
  }
  const res = await vault.post(`sys/auth/${mount}`, { type });
  if (!res.ok) {
    throw new Error(`auth ${mount} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(`  +    auth ${mount} (enabled, type=${type})`);
}

async function ensurePolicy(vault: Vault, name: string, hcl: string) {
  const res = await vault.put(`sys/policies/acl/${name}`, { policy: hcl });
  if (!res.ok) {
    throw new Error(`policy ${name} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(`  =    policy ${name} (written, idempotent)`);
}

async function ensureApprole(vault: Vault, name: string, policies: string[]) {
  const res = await vault.post(`auth/${APPROLE_MOUNT}/role/${name}`, {
    policies: policies.join(','),
    token_ttl: '1h',
    token_max_ttl: '4h',
    secret_id_ttl: '0',         // non-expiring; rotate via re-bootstrap if needed
    secret_id_num_uses: 0,
    bind_secret_id: true,
  });
  if (!res.ok) {
    throw new Error(`approle ${name} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(`  =    approle ${name} (configured, idempotent)`);
}

async function readRoleId(vault: Vault, name: string): Promise<string> {
  const res = await vault.get(`auth/${APPROLE_MOUNT}/role/${name}/role-id`);
  if (!res.ok) {
    throw new Error(`read role-id ${name} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const id = (res.body as { data?: { role_id?: string } } | null)?.data?.role_id;
  if (!id) throw new Error(`role_id missing in vault response`);
  return id;
}

async function generateSecretId(vault: Vault, name: string): Promise<string> {
  const res = await vault.post(`auth/${APPROLE_MOUNT}/role/${name}/secret-id`, {});
  if (!res.ok) {
    throw new Error(`generate secret-id ${name} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const sid = (res.body as { data?: { secret_id?: string } } | null)?.data?.secret_id;
  if (!sid) throw new Error(`secret_id missing in vault response`);
  return sid;
}

async function main() {
  if (process.argv.some((a) => a === '--help' || a === '-h')) {
    console.log('Usage: VAULT_ADDR=... VAULT_TOKEN=... tsx scripts/vault-bootstrap.ts');
    process.exit(0);
  }
  const addr = process.env['VAULT_ADDR'] ?? 'http://127.0.0.1:8200';
  const token = process.env['VAULT_TOKEN'];
  if (!token) {
    console.error('VAULT_TOKEN not set (Root- oder privilegierter Bootstrap-Token noetig)');
    process.exit(2);
  }

  const vault = new Vault(addr, token);

  // sanity ping
  const health = await vault.get('sys/health');
  if (health.status >= 500) {
    console.error(`vault unreachable at ${addr}: status ${health.status}`);
    process.exit(1);
  }

  console.log(`vault-bootstrap @ ${addr}`);
  try {
    await ensureMount(vault, TRANSIT_MOUNT, 'transit');
    await ensurePolicy(vault, POLICY_NAME, POLICY_HCL);
    await ensureAuthMethod(vault, APPROLE_MOUNT, 'approle');
    await ensureApprole(vault, APPROLE_NAME, [POLICY_NAME]);

    const roleId = await readRoleId(vault, APPROLE_NAME);
    const secretId = await generateSecretId(vault, APPROLE_NAME);

    console.log('\nbootstrap complete. update apps/server/.env:');
    console.log('');
    console.log(`  VAULT_ADDR=${addr}`);
    console.log(`  VAULT_ROLE_ID=${roleId}`);
    console.log(`  VAULT_SECRET_ID=${secretId}`);
    console.log('');
    console.log('Note: secret_id ist nicht-expirierend konfiguriert. Rotation via Re-Run dieses Scripts.');
  } catch (e) {
    console.error('vault-bootstrap failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
