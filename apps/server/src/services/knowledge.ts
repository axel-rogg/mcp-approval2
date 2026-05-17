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
 * AS-3 (§1.2 + §1.5): User-Identity-Trio fuer KC-Calls.
 *
 * Tools koennen das per-Aufruf mitgeben — der Adapter forwarded es in den
 * OBO-JWT (`on_behalf_of` + `approval_id`-Claim). Im Legacy-Pfad (kein
 * SERVICE_TOKEN konfiguriert) werden die Felder ignoriert.
 *
 * Konvention: tools/kc_wrappers/* sollten `kcAuthFromCtx(ctx)` aufrufen
 * und das Resultat in die Service-Args spreizen. So bleibt der Auth-
 * Flow konsistent ueber alle KC-Wrapper.
 */
export interface KcAuthFields {
  readonly userEmail?: string;
  readonly approvalId?: string;
}

/**
 * Hilfsfunktion: extrahiert die KC-Auth-Felder aus einem ToolContext.
 *
 * Caller-Pattern:
 *   ```ts
 *   const auth = kcAuthFromCtx(ctx);
 *   return deps.knowledge.updateObject({ userId: ctx.userId, ...auth, ... });
 *   ```
 */
export function kcAuthFromCtx(ctx: {
  email?: string;
  approvalId?: string;
}): KcAuthFields {
  const out: { userEmail?: string; approvalId?: string } = {};
  if (ctx.email) out.userEmail = ctx.email;
  if (ctx.approvalId) out.approvalId = ctx.approvalId;
  return out;
}

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
  private readonly _adapter: KnowledgeAdapter;
  private readonly audit: AuditService;
  private readonly requestIdProvider: () => string | undefined;

  /**
   * AS-3 (A11): Adapter-Exposure fuer den UserSyncService (push-pattern).
   * Andere Caller sollten weiterhin die Service-Methoden nutzen — die
   * machen Audit-Logging mit.
   */
  get adapter(): KnowledgeAdapter {
    return this._adapter;
  }

  constructor(opts: KnowledgeServiceOptions) {
    this._adapter = opts.adapter;
    this.audit = opts.audit;
    this.requestIdProvider = opts.requestIdProvider ?? (() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Objects
  // ---------------------------------------------------------------------------

  async createObject(args: CreateObjectArgs): Promise<KnowledgeObject> {
    const subtype = args.subtype ?? 'object';
    return this.audited(
      `knowledge.${subtype}.created`,
      args.userId,
      subtype,
      undefined,
      () => this.adapter.createObject(args),
      (result) => ({ resourceId: result.id, details: { subtype: result.subtype } }),
    );
  }

  async getObject(args: {
    id: string;
    userId: string;
    userEmail?: string;
    approvalId?: string;
    expandBody?: boolean;
    /** PLAN-doc-linking §10.5 D1: cap auf refs-Block (0..50, default KC2=5). */
    refsLimit?: number;
    /** PLAN-doc-linking §9 P9: roles deren outgoing-refs eager-embedded werden. */
    includeRefBodies?: ReadonlyArray<string>;
  }): Promise<KnowledgeObject> {
    return this.audited(
      'knowledge.object.read',
      args.userId,
      undefined,
      args.id,
      () => this.adapter.getObject(args),
      (result) => ({
        ...(result.subtype ? { resourceKind: result.subtype } : {}),
        details: { subtype: result.subtype ?? null },
      }),
    );
  }

  async listObjects(args: ListObjectsArgs): Promise<ObjectsList> {
    return this.audited(
      'knowledge.object.list',
      args.userId,
      args.subtype,
      undefined,
      () => this.adapter.listObjects(args),
      (result) => ({
        details: {
          subtype: args.subtype ?? null,
          count: result.items.length,
          hasMore: result.nextCursor !== null,
        },
      }),
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
        ...(result.subtype ? { resourceKind: result.subtype } : {}),
        details: { patchedFields: Object.keys(args.patch) },
      }),
    );
  }

  async deleteObject(args: {
    id: string;
    userId: string;
    userEmail?: string;
    approvalId?: string;
  }): Promise<void> {
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
  // Native KC2-Refs (PLAN-document-linking §10.5).
  //
  // Diese Methoden delegieren direkt an `object_refs` in KC2 — die kanonische
  // Storage für den Knowledge-Graph. Cycle-Detection + Refcount + is_subdoc-
  // Toggle laufen KC2-seitig. Approval-Audit-Trail ist hier verkabelt.
  // ---------------------------------------------------------------------------

  async addRef(args: {
    userId: string;
    userEmail?: string;
    approvalId?: string;
    fromId: string;
    toId: string;
    role: string;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    await this.audited(
      'knowledge.ref.add',
      args.userId,
      undefined,
      args.fromId,
      () =>
        this.adapter.addRef({
          userId: args.userId,
          ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
          ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
          fromId: args.fromId,
          toId: args.toId,
          role: args.role,
          ...(args.meta !== undefined ? { meta: args.meta } : {}),
        }),
      () => ({ details: { toId: args.toId, role: args.role } }),
    );
  }

  async removeRef(args: {
    userId: string;
    userEmail?: string;
    approvalId?: string;
    fromId: string;
    toId: string;
    role: string;
  }): Promise<void> {
    await this.audited(
      'knowledge.ref.remove',
      args.userId,
      undefined,
      args.fromId,
      () =>
        this.adapter.removeRef({
          userId: args.userId,
          ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
          ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
          fromId: args.fromId,
          toId: args.toId,
          role: args.role,
        }),
      () => ({ details: { toId: args.toId, role: args.role } }),
    );
  }

  // ---------------------------------------------------------------------------
  // Knowledge-Graph: skill ↔ doc resource-refs (LEGACY meta.resource_ids-Pfad).
  //
  // PLAN-document-linking §10.5: dieser Pfad ist seit native `addRef`-Support
  // deprecated und sollte durch `addRef(role='resource')` ersetzt werden
  // (P7). Heute koexistieren beide Pfade; bei Migration in P7 wird die
  // meta.resource_ids-Verkabelung entfernt.
  // ---------------------------------------------------------------------------

  /**
   * Haengt `doc` als Resource an `skill` an (Idempotent).
   * Returns: updated skill object.
   */
  async attachDocToSkill(args: {
    userId: string;
    skillId: string;
    docId: string;
  }): Promise<KnowledgeObject> {
    const skill = await this.adapter.getObject({ id: args.skillId, userId: args.userId });
    const current = readResourceIds(skill.meta);
    if (current.includes(args.docId)) {
      return skill; // idempotent
    }
    const next = [...current, args.docId];
    return this.audited(
      'knowledge.skill.attach_resource',
      args.userId,
      'skill_manifest',
      args.skillId,
      () =>
        this.adapter.updateObject({
          id: args.skillId,
          userId: args.userId,
          patch: { meta: mergeMeta(skill.meta, { resource_ids: next }) },
        }),
      () => ({ details: { docId: args.docId, count: next.length } }),
    );
  }

  /**
   * Batch-attach: ein doc an N skills haengen (ein Audit-Event pro skill —
   * Approval-Tooling buendelt das in einen einzigen Approval-Click).
   */
  async attachDocToSkills(args: {
    userId: string;
    docId: string;
    skillIds: ReadonlyArray<string>;
  }): Promise<{ attached: ReadonlyArray<string>; alreadyPresent: ReadonlyArray<string> }> {
    const attached: string[] = [];
    const alreadyPresent: string[] = [];
    for (const skillId of args.skillIds) {
      const skill = await this.adapter.getObject({ id: skillId, userId: args.userId });
      const current = readResourceIds(skill.meta);
      if (current.includes(args.docId)) {
        alreadyPresent.push(skillId);
        continue;
      }
      const next = [...current, args.docId];
      await this.adapter.updateObject({
        id: skillId,
        userId: args.userId,
        patch: { meta: mergeMeta(skill.meta, { resource_ids: next }) },
      });
      attached.push(skillId);
    }
    await this.audit.emit({
      action: 'knowledge.doc.attach_to',
      actorUserId: args.userId,
      result: 'success',
      resourceKind: 'doc',
      resourceId: args.docId,
      details: {
        attached: attached.length,
        alreadyPresent: alreadyPresent.length,
        targets: args.skillIds.length,
      },
    });
    return { attached, alreadyPresent };
  }

  /**
   * Berechnet incoming/outgoing refs fuer ein doc:
   *   - incoming: alle skills mit `meta.resource_ids` containing docId
   *   - outgoing: leer (docs verweisen heute nicht out)
   *
   * Implementation: list skills (paginiert), client-side filter. Bei
   * grossen Skill-Inventaren ist das suboptimal; KC2 muss eine refs-Route
   * bekommen (TODO). Fuer < 200 skills akzeptabel.
   */
  async docUsages(args: { userId: string; docId: string }): Promise<{
    incoming: ReadonlyArray<{ subtype: 'skill_manifest'; id: string; title: string | null }>;
    outgoing: ReadonlyArray<{ subtype: string; id: string }>;
  }> {
    return this.audited(
      'knowledge.doc.usages',
      args.userId,
      'doc',
      args.docId,
      async () => {
        const incoming: Array<{ subtype: 'skill_manifest'; id: string; title: string | null }> = [];
        let cursor: number | null = null;
        // Hard limit: max 5 pages * 200 = 1000 skills scanned.
        for (let page = 0; page < 5; page += 1) {
          const listArgs: ListObjectsArgs =
            cursor === null
              ? { userId: args.userId, subtype: 'skill_manifest', limit: 200 }
              : { userId: args.userId, subtype: 'skill_manifest', limit: 200, cursor };
          const list = await this.adapter.listObjects(listArgs);
          for (const skill of list.items) {
            const ids = readResourceIds(skill.meta);
            if (ids.includes(args.docId)) {
              incoming.push({ subtype: 'skill_manifest', id: skill.id, title: skill.title });
            }
          }
          if (list.nextCursor === null) break;
          cursor = list.nextCursor;
        }
        return { incoming, outgoing: [] };
      },
      (r) => ({ details: { incoming: r.incoming.length } }),
    );
  }

  /**
   * Read attached doc — Convenience-Wrapper: verifiziert, dass docId in
   * skill.meta.resource_ids steht (gegen ID-Probing), dann liest das doc
   * mit body.
   */
  async readSkillResource(args: {
    userId: string;
    skillId: string;
    resourceId: string;
  }): Promise<KnowledgeObject> {
    const skill = await this.adapter.getObject({ id: args.skillId, userId: args.userId });
    const ids = readResourceIds(skill.meta);
    if (!ids.includes(args.resourceId)) {
      throw new Error(`resource '${args.resourceId}' not attached to skill '${args.skillId}'`);
    }
    return this.audited(
      'knowledge.skill.read_resource',
      args.userId,
      'doc',
      args.resourceId,
      () => this.adapter.getObject({ id: args.resourceId, userId: args.userId, expandBody: true }),
      () => ({ details: { skillId: args.skillId } }),
    );
  }

  /**
   * Update encrypted summary fuer ein doc; triggert Vectorize-Re-Embed.
   * Mapping: description-Feld haelt den Summary-Text (KC2-side wird das
   * fuer FTS + ggf. Vector-Embedding benutzt).
   */
  async updateDocSummary(args: {
    userId: string;
    docId: string;
    summary: string;
    reEmbed?: boolean;
  }): Promise<KnowledgeObject> {
    const patch: Parameters<KnowledgeAdapter['updateObject']>[0]['patch'] = {
      description: args.summary,
      reEmbed: args.reEmbed ?? true,
    };
    return this.audited(
      'knowledge.doc.update_summary',
      args.userId,
      'doc',
      args.docId,
      () => this.adapter.updateObject({ id: args.docId, userId: args.userId, patch }),
      () => ({ details: { summaryLength: args.summary.length, reEmbed: args.reEmbed ?? true } }),
    );
  }

  /**
   * Bulk-Delete: sequenziell (KC2 hat kein /v1/objects/bulk_delete).
   * Mit `dryRun=true` werden nur die IDs verifiziert (getObject), ohne zu
   * loeschen — fuer Preview-Listing in der PWA.
   */
  async bulkDelete(args: {
    userId: string;
    ids: ReadonlyArray<string>;
    dryRun?: boolean;
  }): Promise<{
    deleted: ReadonlyArray<string>;
    notFound: ReadonlyArray<string>;
    failed: ReadonlyArray<{ id: string; error: string }>;
    dryRun: boolean;
  }> {
    const deleted: string[] = [];
    const notFound: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of args.ids) {
      try {
        if (args.dryRun) {
          // Verify existence — getObject throws on 404.
          await this.adapter.getObject({ id, userId: args.userId });
          deleted.push(id);
        } else {
          await this.adapter.deleteObject({ id, userId: args.userId });
          deleted.push(id);
        }
      } catch (err) {
        const msg = errorMessage(err);
        if (msg.toLowerCase().includes('not found') || msg.includes('404')) {
          notFound.push(id);
        } else {
          failed.push({ id, error: msg });
        }
      }
    }
    await this.audit.emit({
      action: args.dryRun ? 'knowledge.bulk_delete.preview' : 'knowledge.bulk_delete',
      actorUserId: args.userId,
      result: failed.length === 0 ? 'success' : 'failure',
      details: {
        requested: args.ids.length,
        deleted: deleted.length,
        notFound: notFound.length,
        failed: failed.length,
      },
    });
    return { deleted, notFound, failed, dryRun: args.dryRun ?? false };
  }

  // ---------------------------------------------------------------------------
  // Sharing
  // ---------------------------------------------------------------------------

  async createShare(args: CreateShareArgs): Promise<Share> {
    return this.audited(
      'knowledge.share.created',
      args.userId,
      undefined,
      args.resourceId,
      () => this.adapter.createShare(args),
      (result) => ({
        details: { grantedTo: result.grantedTo, scope: result.scope, shareId: result.id },
      }),
    );
  }

  async listShares(args: {
    resourceId: string;
    userId: string;
    userEmail?: string;
    approvalId?: string;
  }): Promise<ReadonlyArray<Share>> {
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
        details: { count: result.length, subtypes: args.subtypes, queryLength: args.query.length },
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

function readResourceIds(meta: Record<string, unknown> | null | undefined): string[] {
  if (!meta) return [];
  const v = meta['resource_ids'];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function mergeMeta(
  existing: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(existing ?? {}), ...patch };
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
  /**
   * AS-3: shared SERVICE_TOKEN fuer S2S-Calls an KC2. Wenn gesetzt, baut die
   * Factory den HttpKnowledgeAdapter mit OBO-Pattern auf (alle user-Routes
   * senden `Authorization: Bearer <service-token>` + `X-On-Behalf-Of: <obo-jwt>`).
   * Wenn ungesetzt: Legacy-Pfad (`Authorization: Bearer <user-jwt>`).
   *
   * SEC-K-009: Internal-Routes nutzen die scope-spezifischen Tokens unten
   * wenn gesetzt. Legacy SERVICE_TOKEN bleibt der Fallback bis KC2 das
   * legacy master-Secret unsetzt.
   */
  readonly SERVICE_TOKEN?: string;
  readonly SERVICE_TOKEN_ERASE?: string;
  readonly SERVICE_TOKEN_SYNC?: string;
  readonly SERVICE_TOKEN_OPS?: string;
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

  const signer: JwtSigner = makeRs256Signer({
    privateKey,
    issuer,
    audience,
    ...(args.env.JWT_KID !== undefined ? { kid: args.env.JWT_KID } : {}),
  });

  const baseAdapterOpts: {
    baseUrl: string;
    jwtSigner: JwtSigner;
    serviceToken?: string;
    serviceTokens?: { erase?: string; sync?: string; ops?: string };
  } = {
    baseUrl: args.env.KNOWLEDGE_URL,
    jwtSigner: signer,
  };
  // AS-3: wenn SERVICE_TOKEN gesetzt ist, schaltet der Adapter intern auf den
  // OBO-Pfad um. Ohne den Token gilt der Legacy-Bearer-JWT-Pfad.
  if (args.env.SERVICE_TOKEN !== undefined && args.env.SERVICE_TOKEN.length > 0) {
    baseAdapterOpts.serviceToken = args.env.SERVICE_TOKEN;
  }
  // SEC-K-009: scope-spezifische Tokens. Wenn gesetzt nimmt pickServiceToken
  // in HttpKnowledgeAdapter sie pro path; sonst Fallback auf master-token.
  const scopedTokens: { erase?: string; sync?: string; ops?: string } = {};
  if (args.env.SERVICE_TOKEN_ERASE !== undefined && args.env.SERVICE_TOKEN_ERASE.length > 0) {
    scopedTokens.erase = args.env.SERVICE_TOKEN_ERASE;
  }
  if (args.env.SERVICE_TOKEN_SYNC !== undefined && args.env.SERVICE_TOKEN_SYNC.length > 0) {
    scopedTokens.sync = args.env.SERVICE_TOKEN_SYNC;
  }
  if (args.env.SERVICE_TOKEN_OPS !== undefined && args.env.SERVICE_TOKEN_OPS.length > 0) {
    scopedTokens.ops = args.env.SERVICE_TOKEN_OPS;
  }
  if (Object.keys(scopedTokens).length > 0) {
    baseAdapterOpts.serviceTokens = scopedTokens;
  }
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

// =============================================================================
// JWT-Signer-Factory (AS-3)
// =============================================================================

interface Rs256SignerArgs {
  readonly privateKey: CryptoKey;
  readonly issuer: string;
  readonly audience: string;
  readonly kid?: string;
}

/**
 * Konstruiert einen `JwtSigner` der beide Methoden bedient — `sign` (legacy)
 * und `signOBO` (AS-3). Beide nutzen denselben RS256-Private-Key, nur
 * unterschiedliche Claim-Sets.
 *
 * Plan-Ref: PLAN-as3-autonomous.md §1.2 + §2.1.
 *
 * Behavior:
 *   - `sign(sub, scope, ttlSec=60)`: Legacy-Pfad, traegt `iss/aud/sub/iat/exp`
 *     und optional `scope`. Wird heute nur noch fuer den Internal-Erase-Route
 *     gebraucht — der OBO-Pfad ersetzt alle User-Routes-Calls.
 *   - `signOBO(SignOboArgs)`: AS-3-Pattern. Audience-Override moeglich (default
 *     bleibt die Factory-Audience). Setzt:
 *         `iss=issuer, aud=args.aud, sub=args.sub, on_behalf_of, request_id?, approval_id?, jti, iat, exp`.
 *     `jti` wird hier generiert (crypto.randomUUID) damit KC2 Replay-
 *     Detection in Phase 2 leicht nachruesten kann.
 *
 * `kid` wird im Protected-Header gesetzt wenn vorhanden — KC2's JWKS-Lookup
 * matched darueber den Public-Key.
 */
export function makeRs256Signer(args: Rs256SignerArgs): JwtSigner {
  const { privateKey, issuer, audience, kid } = args;

  return {
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
      if (kid !== undefined) signArgs.kid = kid;
      return signJwt(signArgs);
    },

    async signOBO({ sub, aud, on_behalf_of, approval_id, request_id, ttlSec = 120 }) {
      const payload: Record<string, unknown> = {
        on_behalf_of,
      };
      if (approval_id !== undefined) payload['approval_id'] = approval_id;
      if (request_id !== undefined) payload['request_id'] = request_id;
      const signArgs: Parameters<typeof signJwt>[0] = {
        payload,
        privateKey,
        alg: 'RS256',
        expiresInSec: ttlSec,
        issuer,
        audience: aud,
        subject: sub,
        jti: randomUuid(),
      };
      if (kid !== undefined) signArgs.kid = kid;
      return signJwt(signArgs);
    },

    // SEC-K-016 + MUSS-§4.1.2: Erase-Receipt-JWS. Selber RS256-Key + Issuer
    // wie OBO; KC2 verifiziert beide ueber das gleiche JWKS-Endpoint.
    // Audience fest 'mcp-knowledge2:erase' → KC2 unterscheidet daran von
    // OBO. payload.sub === user-id-to-erase; KC2 enforced sub===body.user_id.
    async signEraseReceipt({ sub, approvalId, ttlSec = 60 }) {
      const payload: Record<string, unknown> = {};
      if (approvalId !== undefined) payload['approval_id'] = approvalId;
      const signArgs: Parameters<typeof signJwt>[0] = {
        payload,
        privateKey,
        alg: 'RS256',
        expiresInSec: ttlSec,
        issuer,
        audience: 'mcp-knowledge2:erase',
        subject: sub,
        jti: randomUuid(),
      };
      if (kid !== undefined) signArgs.kid = kid;
      return signJwt(signArgs);
    },
  };
}

function randomUuid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  // Fallback Pseudo-UUID (sehr unwahrscheinlich genutzt, Node 20+/CF haben randomUUID).
  const rand = () => Math.floor(Math.random() * 0xffff_ffff).toString(16);
  return `${rand()}-${rand()}-${rand()}-${rand()}`;
}
