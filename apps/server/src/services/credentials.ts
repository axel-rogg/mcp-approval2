/**
 * Credentials-Service — CRUD fuer User-Service-Tokens (Jira-PATs, GitLab-OAuth,
 * GitHub-Tokens, etc.) mit zwei-stufiger Envelope-Encryption + optionalem
 * WebAuthn-PRF-Layer.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.
 *
 * Crypto-Stack pro Credential:
 *   1. random 32-byte DEK (AES-256-GCM).
 *   2. wenn `prf_enabled=true`: effectiveDek = DEK XOR prfOutput (32 byte).
 *   3. ciphertext = AES-GCM(effectiveDek, plaintext, aad).
 *   4. wrapped_dek = KEK.wrap(rawDek, kek_ref) — wir wrappen IMMER den raw-DEK,
 *      nicht den XOR-ed one (sonst koennten wir ohne PRF nichtmal beim Backup
 *      decrypten). Der PRF-XOR-Layer ist ein "Approval-Gate" auf dem
 *      ciphertext-side, kein zusaetzlicher key-wrap-step.
 *
 * AAD-Konvention (cross-row-replay-safe):
 *   credentials|{owner_id}|{provider}|{kind}|{credential_id}
 *
 * Owner-Only: RLS-Policy enforct das DB-seitig. Wir nutzen `db.scoped(userId)`
 * fuer alle Queries, damit `SET LOCAL app.current_user` korrekt gesetzt ist.
 *
 * `resolveForSubMcp` ist der Sub-MCP-Server-Hook (§5.4) — Sub-MCPs holen JIT
 * den access_token + expiresAt, ohne dass das Refresh-Token / PAT-Plaintext
 * je den Worker verlaesst.
 */
import type { DbAdapter, KekProvider } from '@mcp-approval2/adapters';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  buildAad,
  randomBytes,
  randomUuidV4,
  xorPrfDek,
} from '@mcp-approval2/core';
import { AppError, HttpError } from '../lib/errors.js';
import { emitAudit } from './audit.js';

export type CredentialKind = 'oauth_refresh' | 'api_token' | 'password' | 'service_account';

export interface CredentialMeta {
  readonly id: string;
  readonly ownerId: string;
  readonly provider: string;
  readonly kind: CredentialKind;
  readonly label: string;
  readonly prfEnabled: boolean;
  readonly prfCredentialId: Uint8Array | null;
  readonly metadata: Record<string, unknown> | null;
  readonly createdAt: number;
  readonly rotatedAt: number | null;
  readonly lastUsedAt: number | null;
  readonly expiresAt: number | null;
}

/**
 * Sentinel-Error: prf_enabled=true aber Caller hat keinen prfOutput geliefert.
 * Caller (HTTP-Route, Sub-MCP) faengt das und triggert den Approval-Flow.
 */
export class PrfRequiredError extends AppError {
  public readonly prfCredentialId: Uint8Array | null;
  constructor(prfCredentialId: Uint8Array | null) {
    super('forbidden', 'PRF_REQUIRED', {
      reason: 'credential requires PRF-output from WebAuthn-approval',
    });
    this.name = 'PrfRequiredError';
    this.prfCredentialId = prfCredentialId;
  }
}

export interface CreateCredentialArgs {
  readonly userId: string;
  readonly provider: string;
  readonly kind: CredentialKind;
  readonly label: string;
  readonly secret: string;
  readonly prfEnabled?: boolean;
  readonly prfOutput?: Uint8Array;
  readonly prfCredentialId?: Uint8Array;
  readonly metadata?: Record<string, unknown>;
  readonly expiresAt?: number;
}

export interface ReadCredentialArgs {
  readonly userId: string;
  readonly credentialId: string;
  readonly prfOutput?: Uint8Array;
}

export interface ListCredentialsArgs {
  readonly userId: string;
  readonly provider?: string;
}

export interface RotateCredentialArgs {
  readonly userId: string;
  readonly credentialId: string;
  readonly newSecret: string;
  readonly prfOutput?: Uint8Array;
}

export interface DeleteCredentialArgs {
  readonly userId: string;
  readonly credentialId: string;
}

export interface ResolveForSubMcpArgs {
  readonly userId: string;
  readonly provider: string;
  readonly label?: string;
  readonly prfOutput?: Uint8Array;
}

export interface CredentialsServiceOptions {
  readonly db: DbAdapter;
  readonly kekProvider: KekProvider;
  /**
   * Pro User ein KEK-Ref. Default-Builder ist `vault://transit/keys/user-{id}`
   * — fuer Tests / Local-Setup uebersteuerbar.
   */
  readonly kekRefForUser?: (userId: string) => string;
  /** Optional: actor-Kontext fuer audit (request-id, ip, ua). */
  readonly auditDefaults?: () => AuditDefaults;
}

export interface AuditDefaults {
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

export interface CredentialsService {
  create(args: CreateCredentialArgs): Promise<CredentialMeta>;
  read(args: ReadCredentialArgs): Promise<{ secret: string; meta: CredentialMeta }>;
  list(args: ListCredentialsArgs): Promise<CredentialMeta[]>;
  rotate(args: RotateCredentialArgs): Promise<void>;
  delete(args: DeleteCredentialArgs): Promise<void>;
  resolveForSubMcp(args: ResolveForSubMcpArgs): Promise<{ secret: string; expiresAt: number | null }>;
}

interface CredentialRowRaw {
  readonly id: string;
  readonly owner_id: string;
  readonly provider: string;
  readonly kind: string;
  readonly label: string;
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly wrapped_dek: Uint8Array;
  readonly aad: string;
  readonly kek_ref: string;
  readonly alg: string;
  readonly prf_enabled: boolean;
  readonly prf_credential_id: Uint8Array | null;
  readonly meta_json: Record<string, unknown> | null;
  readonly created_at: number | string;
  readonly rotated_at: number | string | null;
  readonly last_used_at: number | string | null;
  readonly expires_at: number | string | null;
}

const SELECT_COLS = `
  id, owner_id, provider, kind, label,
  ciphertext, nonce, wrapped_dek, aad, kek_ref, alg,
  prf_enabled, prf_credential_id,
  meta_json,
  created_at, rotated_at, last_used_at, expires_at
`;

const enc = new TextEncoder();
const dec = new TextDecoder();

function toNumber(v: number | string | null): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'number' ? v : Number(v);
}

function rowToMeta(row: CredentialRowRaw): CredentialMeta {
  return {
    id: row.id,
    ownerId: row.owner_id,
    provider: row.provider,
    kind: row.kind as CredentialKind,
    label: row.label,
    prfEnabled: row.prf_enabled,
    prfCredentialId: row.prf_credential_id ?? null,
    metadata: row.meta_json ?? null,
    createdAt: toNumber(row.created_at) ?? 0,
    rotatedAt: toNumber(row.rotated_at),
    lastUsedAt: toNumber(row.last_used_at),
    expiresAt: toNumber(row.expires_at),
  };
}

export function createCredentialsService(opts: CredentialsServiceOptions): CredentialsService {
  const { db, kekProvider } = opts;
  const kekRefFor =
    opts.kekRefForUser ?? ((userId: string) => `vault://transit/keys/user-${userId}`);
  const auditDefaults: () => AuditDefaults = opts.auditDefaults ?? (() => ({}));

  function auditExtras(): AuditDefaults {
    const def = auditDefaults();
    const out: AuditDefaults = {};
    if (def.requestId !== undefined) out.requestId = def.requestId;
    if (def.ip !== undefined) out.ip = def.ip;
    if (def.userAgent !== undefined) out.userAgent = def.userAgent;
    return out;
  }

  async function withScoped<T>(userId: string, fn: (q: ReturnType<typeof makeQ>) => Promise<T>): Promise<T> {
    return db.transaction(userId, async (scoped) => {
      const q = makeQ(scoped);
      return fn(q);
    });
  }

  function makeQ(scoped: { query: <T = unknown>(sql: string, params?: ReadonlyArray<unknown>) => Promise<T[]> }) {
    return scoped;
  }

  return {
    async create(args) {
      if (args.prfEnabled !== false && !args.prfOutput) {
        // PRF day-zero: default-on, also wenn ENABLED ohne PRF-Output → reject.
        throw new HttpError(
          400,
          'invalid_request',
          'PRF_REQUIRED: prfOutput must be supplied when prfEnabled is true',
        );
      }
      const prfEnabled = args.prfEnabled ?? true;
      const credentialId = randomUuidV4();
      const kekRef = kekRefFor(args.userId);

      // 1. Random DEK
      const rawDek = randomBytes(32);

      // 2. PRF-XOR (nur fuer encrypt-key, wrapped_dek bleibt raw)
      const effectiveDek = prfEnabled && args.prfOutput ? xorPrfDek(rawDek, args.prfOutput) : rawDek;

      // 3. AAD
      const aad = buildAad({
        recordType: 'credentials',
        owner: args.userId,
        provider: args.provider,
        kind: args.kind,
        id: credentialId,
      });

      // 4. AES-GCM-Encrypt
      const { ciphertext, nonce } = await aesGcmEncrypt({
        key: effectiveDek,
        plaintext: enc.encode(args.secret),
        aad,
      });

      // 5. Wrap rawDek with KEK
      const wrappedDek = await kekProvider.wrap(rawDek, kekRef);

      // 6. Insert
      const createdAt = Date.now();
      const meta = await withScoped(args.userId, async (q) => {
        const rows = await q.query<CredentialRowRaw>(
          `INSERT INTO credentials
             (id, owner_id, provider, kind, label,
              ciphertext, nonce, wrapped_dek, aad, kek_ref, alg,
              prf_enabled, prf_credential_id,
              meta_json,
              created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'A256GCM',$11,$12,$13,$14)
           RETURNING ${SELECT_COLS}`,
          [
            credentialId,
            args.userId,
            args.provider,
            args.kind,
            args.label,
            ciphertext,
            nonce,
            wrappedDek,
            aad,
            kekRef,
            prfEnabled,
            args.prfCredentialId ?? null,
            args.metadata ? JSON.stringify(args.metadata) : null,
            createdAt,
          ],
        );
        const row = rows[0];
        if (!row) throw new HttpError(500, 'internal', 'credential insert returned no row');
        return rowToMeta(row);
      });

      await emitAudit(db, {
        action: 'credential.created',
        actorUserId: args.userId,
        result: 'success',
        ...auditExtras(),
        details: {
          credentialId: meta.id,
          provider: meta.provider,
          kind: meta.kind,
          label: meta.label,
          prfEnabled: meta.prfEnabled,
        },
      });
      return meta;
    },

    async read(args) {
      const result = await withScoped(args.userId, async (q) => {
        const rows = await q.query<CredentialRowRaw>(
          `SELECT ${SELECT_COLS} FROM credentials WHERE id = $1 LIMIT 1`,
          [args.credentialId],
        );
        const row = rows[0];
        if (!row) return null;

        if (row.prf_enabled && !args.prfOutput) {
          throw new PrfRequiredError(row.prf_credential_id ?? null);
        }

        const rawDek = await kekProvider.unwrap(row.wrapped_dek, row.kek_ref);
        const effectiveDek =
          row.prf_enabled && args.prfOutput ? xorPrfDek(rawDek, args.prfOutput) : rawDek;

        let plaintext: Uint8Array;
        try {
          plaintext = await aesGcmDecrypt({
            key: effectiveDek,
            ciphertext: row.ciphertext,
            nonce: row.nonce,
            aad: row.aad,
          });
        } catch (err) {
          throw new HttpError(500, 'internal', 'credential decrypt failed', {
            cause: err instanceof Error ? err.message : 'unknown',
          });
        }

        // last_used_at touchen
        await q.query(`UPDATE credentials SET last_used_at = $1 WHERE id = $2`, [
          Date.now(),
          row.id,
        ]);
        return { secret: dec.decode(plaintext), meta: rowToMeta(row) };
      });

      if (!result) throw HttpError.notFound('credential not found');

      await emitAudit(db, {
        action: 'credential.read',
        actorUserId: args.userId,
        result: 'success',
        ...auditExtras(),
        details: { credentialId: args.credentialId, provider: result.meta.provider, label: result.meta.label },
      });
      return result;
    },

    async list(args) {
      return withScoped(args.userId, async (q) => {
        const rows = args.provider
          ? await q.query<CredentialRowRaw>(
              `SELECT ${SELECT_COLS} FROM credentials
                 WHERE provider = $1
                 ORDER BY created_at DESC`,
              [args.provider],
            )
          : await q.query<CredentialRowRaw>(
              `SELECT ${SELECT_COLS} FROM credentials
                 ORDER BY created_at DESC`,
            );
        return rows.map(rowToMeta);
      });
    },

    async rotate(args) {
      // Wir loaden die Row, decrypten ggfs. um PRF zu validieren, und
      // schreiben dann frische ciphertext+nonce+wrapped_dek. AAD bleibt
      // stabil (id+provider+kind+owner unveraendert).
      await withScoped(args.userId, async (q) => {
        const rows = await q.query<CredentialRowRaw>(
          `SELECT ${SELECT_COLS} FROM credentials WHERE id = $1 LIMIT 1`,
          [args.credentialId],
        );
        const row = rows[0];
        if (!row) throw HttpError.notFound('credential not found');
        if (row.prf_enabled && !args.prfOutput) {
          throw new PrfRequiredError(row.prf_credential_id ?? null);
        }

        const rawDek = randomBytes(32);
        const effectiveDek =
          row.prf_enabled && args.prfOutput ? xorPrfDek(rawDek, args.prfOutput) : rawDek;
        const { ciphertext, nonce } = await aesGcmEncrypt({
          key: effectiveDek,
          plaintext: enc.encode(args.newSecret),
          aad: row.aad,
        });
        const wrappedDek = await kekProvider.wrap(rawDek, row.kek_ref);

        await q.query(
          `UPDATE credentials
             SET ciphertext = $1, nonce = $2, wrapped_dek = $3, rotated_at = $4
           WHERE id = $5`,
          [ciphertext, nonce, wrappedDek, Date.now(), row.id],
        );
      });

      await emitAudit(db, {
        action: 'credential.rotated',
        actorUserId: args.userId,
        result: 'success',
        ...auditExtras(),
        details: { credentialId: args.credentialId },
      });
    },

    async delete(args) {
      const deleted = await withScoped(args.userId, async (q) => {
        const rows = await q.query<{ id: string }>(
          `DELETE FROM credentials WHERE id = $1 RETURNING id`,
          [args.credentialId],
        );
        return rows.length > 0;
      });
      if (!deleted) throw HttpError.notFound('credential not found');

      await emitAudit(db, {
        action: 'credential.deleted',
        actorUserId: args.userId,
        result: 'success',
        ...auditExtras(),
        details: { credentialId: args.credentialId },
      });
    },

    async resolveForSubMcp(args) {
      const label = args.label ?? 'default';
      const result = await withScoped(args.userId, async (q) => {
        const rows = await q.query<CredentialRowRaw>(
          `SELECT ${SELECT_COLS} FROM credentials
             WHERE provider = $1 AND label = $2
             LIMIT 1`,
          [args.provider, label],
        );
        const row = rows[0];
        if (!row) return null;
        if (row.prf_enabled && !args.prfOutput) {
          throw new PrfRequiredError(row.prf_credential_id ?? null);
        }
        const rawDek = await kekProvider.unwrap(row.wrapped_dek, row.kek_ref);
        const effectiveDek =
          row.prf_enabled && args.prfOutput ? xorPrfDek(rawDek, args.prfOutput) : rawDek;
        const plaintext = await aesGcmDecrypt({
          key: effectiveDek,
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          aad: row.aad,
        });
        await q.query(`UPDATE credentials SET last_used_at = $1 WHERE id = $2`, [
          Date.now(),
          row.id,
        ]);
        return { row, secret: dec.decode(plaintext) };
      });
      if (!result) throw HttpError.notFound('credential not found');

      await emitAudit(db, {
        action: 'credential.resolved_for_submcp',
        actorUserId: args.userId,
        result: 'success',
        ...auditExtras(),
        details: { provider: args.provider, label },
      });
      return { secret: result.secret, expiresAt: toNumber(result.row.expires_at) };
    },
  };
}
