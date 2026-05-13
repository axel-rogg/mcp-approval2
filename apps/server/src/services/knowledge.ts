/**
 * KnowledgeService — Wrapper um den KnowledgeAdapter mit Audit-Logging.
 *
 * Plan-Reference: PLAN-architecture-v1.md §2.1 + §6 + §7.
 *
 * Verantwortlichkeiten:
 *   1. Adapter-Methoden mit Audit-Log-Eintraegen umhuellen
 *      (action=knowledge.{kind}.{op}, result=success|failure)
 *   2. JWT-Signing-Konfiguration (RS256 mit mcp-approval2-Private-Key)
 *      ueber `createKnowledgeService` als Factory
 *   3. Fehler an den Caller durchreichen (KnowledgeError-Hierarchie), aber
 *      audit failure events emitten bevor die Exception bubbled
 *
 * Sicherheits-Hinweis:
 *   - Adapter sieht die userId — wir trusten Caller (Auth-Middleware), dass
 *     diese korrekt ist. RLS-Filter passiert serverseitig in mcp-knowledge2.
 *   - `eraseUser` ist admin-only — wir loggen `actorUserId=admin` separat
 *     vom `targetUserId`.
 */
import { signJwt } from '@mcp-approval2/core/crypto';
import { getSigningKey } from '../auth/jwt-signing.js';
import {
  HttpKnowledgeAdapter,
  type CreateObjectArgs,
  type CreateShareArgs,
  type EraseUserArgs,
  type EraseUserResult,
  type JwtSigner,
  type KnowledgeAdapter,
  type KnowledgeObject,
  type ListObjectsArgs,
  type ObjectsList,
  type RevokeShareArgs,
  type SearchArgs,
  type SearchHit,
  type Share,
  type UpdateObjectArgs,
} from '@mcp-approval2/adapters';

/**
 * Lokaler Audit-Service-Contract.
 *
 * Format-kompatibel mit `AuditService` aus src/mcp/protocol/tool.ts — wir
 * deklarieren hier nochmal, damit dieser Service-File keine Cross-Layer-
 * Dependency auf mcp/protocol hat. Caller koennen denselben AuditService
 * an beide weitergeben.
 */
export interface AuditService {
  emit(event: {
    readonly action: string;
    readonly actorUserId: string | null;
    readonly result: 'success' | 'failure' | 'noop';
    readonly resourceKind?: string;
    readonly resourceId?: string;
    readonly requestId?: string;
    readonly details?: Record<string, unknown>;
  }): Promise<void>;
}

export interface KnowledgeServiceOptions {
  readonly adapter: KnowledgeAdapter;
  readonly audit: AuditService;
  /** Optional: Override fuer Request-ID-Propagation (Tests). */
  readonly requestIdProvider?: () => string | undefined;
}

export class KnowledgeService {
  private readonly adapter: KnowledgeAdapter;
  private readonly audit: AuditService;
  private readonly requestIdProvider: () => string | undefined;

  constructor(opts: KnowledgeServiceOptions) {
    this.adapter = opts.adapter;
    this.audit = opts.audit;
    this.requestIdProvider = opts.requestIdProvider ?? (() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Objects
  // ---------------------------------------------------------------------------

  async createObject(args: CreateObjectArgs): Promise<KnowledgeObject> {
    return this.audited(
      `knowledge.${args.kind}.created`,
      args.userId,
      args.kind,
      undefined,
      () => this.adapter.createObject(args),
      (result) => ({ resourceId: result.id, details: { kind: result.kind, subtype: result.subtype } }),
    );
  }

  async getObject(args: { id: string; userId: string }): Promise<KnowledgeObject> {
    return this.audited(
      'knowledge.object.read',
      args.userId,
      undefined,
      args.id,
      () => this.adapter.getObject(args),
      (result) => ({ resourceKind: result.kind, details: { kind: result.kind } }),
    );
  }

  async listObjects(args: ListObjectsArgs): Promise<ObjectsList> {
    return this.audited(
      'knowledge.object.list',
      args.userId,
      args.kind,
      undefined,
      () => this.adapter.listObjects(args),
      (result) => ({ details: { kind: args.kind, count: result.items.length, hasMore: result.hasMore } }),
    );
  }

  async updateObject(args: UpdateObjectArgs): Promise<KnowledgeObject> {
    return this.audited(
      'knowledge.object.updated',
      args.userId,
      undefined,
      args.id,
      () => this.adapter.updateObject(args),
      (result) => ({
        resourceKind: result.kind,
        details: { patchedFields: Object.keys(args.patch) },
      }),
    );
  }

  async deleteObject(args: { id: string; userId: string }): Promise<void> {
    await this.audited(
      'knowledge.object.deleted',
      args.userId,
      undefined,
      args.id,
      async () => {
        await this.adapter.deleteObject(args);
        return undefined;
      },
      () => ({}),
    );
  }

  // ---------------------------------------------------------------------------
  // Sharing
  // ---------------------------------------------------------------------------

  async createShare(args: CreateShareArgs): Promise<Share> {
    return this.audited(
      'knowledge.share.created',
      args.userId,
      args.resourceKind,
      args.resourceId,
      () => this.adapter.createShare(args),
      (result) => ({
        details: { grantedTo: result.grantedTo, scope: result.scope, shareId: result.id },
      }),
    );
  }

  async listShares(args: { resourceId: string; userId: string }): Promise<ReadonlyArray<Share>> {
    return this.audited(
      'knowledge.share.list',
      args.userId,
      undefined,
      args.resourceId,
      () => this.adapter.listShares(args),
      (result) => ({ details: { count: result.length } }),
    );
  }

  async revokeShare(args: RevokeShareArgs): Promise<void> {
    await this.audited(
      'knowledge.share.revoked',
      args.userId,
      undefined,
      args.shareId,
      async () => {
        await this.adapter.revokeShare(args);
        return undefined;
      },
      () => ({}),
    );
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  async search(args: SearchArgs): Promise<ReadonlyArray<SearchHit>> {
    return this.audited(
      'knowledge.search',
      args.userId,
      undefined,
      undefined,
      () => this.adapter.search(args),
      (result) => ({
        details: { count: result.length, kinds: args.kinds, queryLength: args.query.length },
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Admin: GDPR Erase
  //
  // Hier ist `args.userId` der TARGET-User (zu loeschen), nicht der actor.
  // Der Caller (Admin-Route) muss den Audit-Eintrag mit dem echten Actor
  // vorab/nachgelagert erweitern.
  // ---------------------------------------------------------------------------

  async eraseUser(args: EraseUserArgs & { actorUserId: string }): Promise<EraseUserResult> {
    const requestId = this.requestIdProvider();
    try {
      const result = await this.adapter.eraseUser({
        userId: args.userId,
        confirmationToken: args.confirmationToken,
      });
      await this.audit.emit({
        action: 'knowledge.user.erased',
        actorUserId: args.actorUserId,
        result: 'success',
        ...(requestId !== undefined ? { requestId } : {}),
        details: { targetUserId: args.userId, deletedRows: result.deletedRows },
      });
      return result;
    } catch (err) {
      await this.audit.emit({
        action: 'knowledge.user.erased',
        actorUserId: args.actorUserId,
        result: 'failure',
        ...(requestId !== undefined ? { requestId } : {}),
        details: { targetUserId: args.userId, error: errorMessage(err) },
      });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async audited<T>(
    action: string,
    actorUserId: string,
    resourceKind: string | undefined,
    resourceId: string | undefined,
    op: () => Promise<T>,
    enrich: (result: T) => { resourceId?: string; resourceKind?: string; details?: Record<string, unknown> },
  ): Promise<T> {
    const requestId = this.requestIdProvider();
    try {
      const result = await op();
      const extra = enrich(result);
      await this.audit.emit({
        action,
        actorUserId,
        result: 'success',
        ...(resourceKind !== undefined ? { resourceKind } : {}),
        ...(extra.resourceKind !== undefined ? { resourceKind: extra.resourceKind } : {}),
        ...(resourceId !== undefined ? { resourceId } : {}),
        ...(extra.resourceId !== undefined ? { resourceId: extra.resourceId } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
        ...(extra.details !== undefined ? { details: extra.details } : {}),
      });
      return result;
    } catch (err) {
      await this.audit.emit({
        action,
        actorUserId,
        result: 'failure',
        ...(resourceKind !== undefined ? { resourceKind } : {}),
        ...(resourceId !== undefined ? { resourceId } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
        details: { error: errorMessage(err) },
      });
      throw err;
    }
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// =============================================================================
// Factory: createKnowledgeService
// =============================================================================

export interface KnowledgeServiceEnv {
  /** Base-URL des mcp-knowledge2-Service (z.B. https://knowledge.firma.de). */
  readonly KNOWLEDGE_URL: string;
  /**
   * RSA-Private-Key (PEM, PKCS8) zum Signieren der Service-Boundary-JWTs.
   * Aequivalente Public-Half liegt im JWKS-Endpoint von mcp-approval2.
   *
   * Backwards-Compat-Alias: vor dem JWKS-Live-Cutover hiess das Env-Var
   * `JWT_PRIVATE_KEY`. Neue Deploys sollten `JWT_RS256_PRIVATE_KEY_PEM`
   * setzen — der ServerContext liest beide, der Wert hier ist optional
   * solange einer von beiden zur Boot-Zeit verfuegbar ist.
   */
  readonly JWT_PRIVATE_KEY?: string;
  /** Identisch zu `JWT_PRIVATE_KEY` (kanonischer Name nach dem Cutover). */
  readonly JWT_RS256_PRIVATE_KEY_PEM?: string;
  /** Optional: Custom Issuer (default 'mcp-approval2'). */
  readonly JWT_ISSUER?: string;
  /** Optional: Custom Audience (default 'mcp-knowledge2'). */
  readonly JWT_AUDIENCE?: string;
  /** Optional: kid-Header fuer JWKS-Key-Selection. */
  readonly JWT_KID?: string;
}

/**
 * Hoehere-Ebenen-Factory: erzeugt einen vollkonfigurierten KnowledgeService
 * gegen mcp-knowledge2 inklusive JWT-Signer.
 *
 * Die Konkrete `JWT_PRIVATE_KEY`-Pflege uebernimmt der ServerContext (KEK-
 * entschluesselt). Der Loader (`getSigningKey()`) cached die importierten
 * CryptoKey-Handles auf module-level — gleicher PEM-string wird nur einmal
 * importiert, egal wie oft die Factory laeuft.
 */
export async function createKnowledgeService(args: {
  env: KnowledgeServiceEnv;
  audit: AuditService;
  fetchImpl?: typeof fetch;
  requestIdProvider?: () => string | undefined;
}): Promise<KnowledgeService> {
  const issuer = args.env.JWT_ISSUER ?? 'mcp-approval2';
  const audience = args.env.JWT_AUDIENCE ?? 'mcp-knowledge2';

  const pem = args.env.JWT_RS256_PRIVATE_KEY_PEM ?? args.env.JWT_PRIVATE_KEY;
  if (!pem || pem.trim().length === 0) {
    throw new Error(
      'createKnowledgeService: JWT_RS256_PRIVATE_KEY_PEM (or legacy JWT_PRIVATE_KEY) required',
    );
  }
  const signingEnv: { JWT_RS256_PRIVATE_KEY_PEM: string; JWT_KID?: string } = {
    JWT_RS256_PRIVATE_KEY_PEM: pem,
  };
  if (args.env.JWT_KID !== undefined) signingEnv.JWT_KID = args.env.JWT_KID;
  const privateKey = await getSigningKey(signingEnv);
  if (!privateKey) {
    // getSigningKey only returns null when PEM is empty/blank — we already
    // guarded above, so this branch is defense-in-depth.
    throw new Error('createKnowledgeService: failed to load private key');
  }

  const signer: JwtSigner = {
    async sign({ sub, scope, ttlSec = 60 }) {
      const payload: Record<string, unknown> = {};
      if (scope !== undefined) payload['scope'] = scope;
      const signArgs: Parameters<typeof signJwt>[0] = {
        payload,
        privateKey,
        alg: 'RS256',
        expiresInSec: ttlSec,
        issuer,
        audience,
        subject: sub,
      };
      if (args.env.JWT_KID !== undefined) signArgs.kid = args.env.JWT_KID;
      return signJwt(signArgs);
    },
  };

  const baseAdapterOpts = {
    baseUrl: args.env.KNOWLEDGE_URL,
    jwtSigner: signer,
  };
  const fetchImpl = args.fetchImpl;
  const adapter = new HttpKnowledgeAdapter(
    fetchImpl
      ? {
          ...baseAdapterOpts,
          fetchImpl: (input: string | URL, init?: RequestInit) => fetchImpl(input, init),
        }
      : baseAdapterOpts,
  );

  const svcOpts: KnowledgeServiceOptions = args.requestIdProvider !== undefined
    ? { adapter, audit: args.audit, requestIdProvider: args.requestIdProvider }
    : { adapter, audit: args.audit };
  return new KnowledgeService(svcOpts);
}

