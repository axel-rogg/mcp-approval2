/**
 * AppsService — Multi-User App-Lifecycle ueber KnowledgeService.
 *
 * Architektur (vs. Source-Repo mcp-approval):
 *   - mcp-approval (Single-User) speicherte app_state direkt in der lokalen
 *     `objects` Tabelle. State + Version waren D1-CAS-getrieben.
 *   - mcp-approval2 (Multi-User) forwarded ALLE Persistenz an mcp-knowledge2
 *     ueber `KnowledgeService`. JEDER Call uebergibt `userId` — KnowledgeService
 *     signt JWTs mit sub=userId, mcp-knowledge2 RLS filtert.
 *
 * Verantwortlichkeiten:
 *   - createApp: validate state via AppTypeDef, subtype='app:<appType>' in KC anlegen.
 *     (Schema-Note: KC2 nutzt subtype-Namespacing mit `app:`-Prefix nach
 *     ADR-0004 / §6.1 Option A — vorher zweistufig kind='app' + subtype=<appType>.)
 *   - readApp: lade Object + decodes body als JSON-State (auto-migration).
 *   - updateState: CAS via KC's expectedVersion → KCError 409 → CONCURRENT_UPDATE.
 *   - listApps: KC listObjects mit subtype='app:*' (client-side prefix-filter) +
 *     exakt-Match bei args.appType.
 *   - deleteApp: KC deleteObject.
 *   - invoke: routeAction + applyPatches + updateState (CAS-retry).
 *   - query: routeQuery (read-only, kein write).
 *   - updateLayout: full-replace state (Approval-pflichtig auf Tool-Schicht).
 *
 * KEIN R2-Fallback, KEINE Crypto-Detail-Knowledge im Service — das uebernimmt
 * KnowledgeService/KC2.
 */
import type {
  CreateObjectArgs,
  KnowledgeObject,
  UpdateObjectArgs,
} from '@mcp-approval2/adapters';
import type { KnowledgeService } from '../services/knowledge.js';
import type { AuditService } from '../mcp/protocol/tool.js';
import { applyPatches, routeAction, routeQuery } from './action_router.js';
import type { LayoutDoc } from './blocks/types.js';
import { getAppType, listAppTypes } from './types_registry.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AppsServiceError extends Error {
  constructor(
    public readonly code:
      | 'UNKNOWN_TYPE'
      | 'INVALID_STATE'
      | 'SINGLE_INSTANCE'
      | 'NOT_FOUND'
      | 'CONCURRENT_UPDATE'
      | 'INVALID_LAYOUT'
      | 'INVALID_ACTION'
      | 'INTERNAL',
    message: string,
    public readonly retriable: boolean = false,
  ) {
    super(message);
    this.name = 'AppsServiceError';
  }
}

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export interface AppInstance {
  readonly id: string;
  readonly userId: string;
  readonly type: string;
  readonly title: string;
  readonly state_version: number;
  readonly schema_version: number;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly created_at: number;
  readonly updated_at: number;
  readonly last_used_at: number | null;
}

export interface AppWithState<TState = unknown> {
  readonly app: AppInstance;
  readonly state: TState;
}

export interface InvokeResult {
  readonly app: AppInstance;
  readonly new_version: number;
  readonly result: unknown;
  readonly patches: ReadonlyArray<{ path: string; value: unknown }>;
}

// ---------------------------------------------------------------------------
// Service Interface
// ---------------------------------------------------------------------------

export interface AppsService {
  createApp(args: {
    userId: string;
    /** AS-3 OBO-Propagation: email als on_behalf_of-Subject fuer KC2-Resolve. */
    userEmail?: string;
    appType: string;
    slug?: string;
    title?: string;
    initialState?: unknown;
    summary?: string;
  }): Promise<AppInstance>;

  readApp<TState = unknown>(args: { userId: string; id: string }): Promise<AppWithState<TState>>;

  updateState(args: {
    userId: string;
    id: string;
    statePatch: unknown; // full new state — composable replaces wholesale
    expectedVersion: number;
  }): Promise<AppInstance>;

  listApps(args: { userId: string; type?: string; limit?: number }): Promise<AppInstance[]>;

  deleteApp(args: { userId: string; id: string }): Promise<void>;

  invoke(args: {
    userId: string;
    id: string;
    block_id: string;
    action: string;
    payload: Record<string, unknown>;
  }): Promise<InvokeResult>;

  query(args: {
    userId: string;
    id: string;
    block_id: string;
    query: string;
    args?: Record<string, unknown>;
  }): Promise<unknown>;

  updateLayout(args: {
    userId: string;
    id: string;
    layoutDoc: LayoutDoc;
    expectedVersion: number;
  }): Promise<AppInstance>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateAppsServiceDeps {
  readonly knowledge: KnowledgeService;
  readonly audit?: AuditService;
}

export function createAppsService(deps: CreateAppsServiceDeps): AppsService {
  return new AppsServiceImpl(deps);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

const APP_SUBTYPE_PREFIX = 'app:';

/** Build canonical subtype for an app of type `appType` (e.g. 'composable' → 'app:composable'). */
function appSubtype(appType: string): string {
  return `${APP_SUBTYPE_PREFIX}${appType}`;
}

/** Reverse: 'app:composable' → 'composable'. Empty/non-app → ''. */
function appTypeFromSubtype(subtype: string | null | undefined): string {
  if (!subtype || !subtype.startsWith(APP_SUBTYPE_PREFIX)) return '';
  return subtype.slice(APP_SUBTYPE_PREFIX.length);
}

/** Type-guard: is this object an app (subtype starts with `app:`)? */
function isAppObject(obj: KnowledgeObject): boolean {
  return typeof obj.subtype === 'string' && obj.subtype.startsWith(APP_SUBTYPE_PREFIX);
}

function metaSchemaVersion(meta: Record<string, unknown> | null | undefined, fallback: number): number {
  if (!meta) return fallback;
  const v = (meta as { schema_version?: unknown }).schema_version;
  return typeof v === 'number' ? v : fallback;
}

function toAppInstance(obj: KnowledgeObject): AppInstance {
  return {
    id: obj.id,
    userId: obj.ownerId,
    type: appTypeFromSubtype(obj.subtype),
    title: obj.title ?? '',
    state_version: obj.currentVersion,
    schema_version: metaSchemaVersion(obj.meta, 1),
    pinned: obj.pinned,
    archived: obj.archived,
    created_at: obj.createdAt,
    updated_at: obj.updatedAt,
    last_used_at: obj.lastUsedAt,
  };
}

class AppsServiceImpl implements AppsService {
  private readonly knowledge: KnowledgeService;
  private readonly audit: AuditService | undefined;

  constructor(deps: CreateAppsServiceDeps) {
    this.knowledge = deps.knowledge;
    this.audit = deps.audit;
  }

  async createApp(args: {
    userId: string;
    userEmail?: string;
    appType: string;
    slug?: string;
    title?: string;
    initialState?: unknown;
    summary?: string;
  }): Promise<AppInstance> {
    const typeDef = getAppType(args.appType);
    if (!typeDef) {
      throw new AppsServiceError('UNKNOWN_TYPE', `Unknown app type: ${args.appType}`);
    }
    const initialState = args.initialState ?? typeDef.initial_state();
    const validation = typeDef.validate(initialState);
    if (!validation.valid) {
      throw new AppsServiceError('INVALID_STATE', `initial_state invalid: ${validation.errors}`);
    }
    if (typeDef.single_instance) {
      const existing = await this.knowledge.listObjects({
        userId: args.userId,
        subtype: appSubtype(args.appType),
        limit: 1,
      });
      const live = existing.items.find((o) => !o.archived);
      if (live) {
        throw new AppsServiceError(
          'SINGLE_INSTANCE',
          `app type "${args.appType}" allows only one active instance (existing: ${live.id})`,
        );
      }
    }
    const title = args.title?.trim() || typeDef.title_default;
    const description =
      args.summary && args.summary.trim().length > 0
        ? args.summary.trim().slice(0, 500)
        : `${args.appType} app: ${title}`;
    const bodyBytes = enc.encode(JSON.stringify(initialState));

    const createArgs: CreateObjectArgs = {
      userId: args.userId,
      ...(args.userEmail !== undefined ? { userEmail: args.userEmail } : {}),
      subtype: appSubtype(args.appType),
      title,
      description,
      meta: {
        type: args.appType,
        schema_version: typeDef.current_schema_version,
        ...(args.slug ? { slug: args.slug } : {}),
      },
      body: bodyBytes,
      mimeType: 'application/json',
    };
    const created = await this.knowledge.createObject(createArgs);
    await this.emitAudit('apps.create', args.userId, 'app', created.id, {
      type: args.appType,
      title,
    });
    return toAppInstance(created);
  }

  async readApp<TState = unknown>(args: { userId: string; id: string }): Promise<AppWithState<TState>> {
    let obj: KnowledgeObject;
    try {
      obj = await this.knowledge.getObject({ id: args.id, userId: args.userId });
    } catch (e) {
      throw mapNotFound(e, args.id);
    }
    if (!isAppObject(obj)) {
      throw new AppsServiceError(
        'NOT_FOUND',
        `object ${args.id} is not an app (subtype=${obj.subtype ?? 'null'})`,
      );
    }
    // Fetch body explicitly via adapter call expandBody.
    // KnowledgeService.getObject doesn't accept expandBody — we work around by
    // reading body from the same getObject (KC returns body when ?expand=body).
    // For tests, the in-memory adapter respects expandBody flag too.
    // We re-fetch with expand if needed.
    if (!obj.body) {
      const adapter = (this.knowledge as unknown as { adapter: { getObject: (a: { id: string; userId: string; expandBody: boolean }) => Promise<KnowledgeObject> } }).adapter;
      if (adapter && typeof adapter.getObject === 'function') {
        obj = await adapter.getObject({ id: args.id, userId: args.userId, expandBody: true });
      }
    }
    const bodyB64 = obj.body ?? null;
    if (!bodyB64) {
      throw new AppsServiceError('INTERNAL', `app ${args.id}: empty body`);
    }
    const bodyBytes = base64ToBytes(bodyB64);
    let state: unknown;
    try {
      state = JSON.parse(dec.decode(bodyBytes));
    } catch (e) {
      throw new AppsServiceError(
        'INTERNAL',
        `app ${args.id}: body is not valid JSON (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    // Lazy migration on-read.
    const appInstance = toAppInstance(obj);
    const typeDef = getAppType(appInstance.type);
    let migrated: unknown = state;
    if (typeDef && appInstance.schema_version < typeDef.current_schema_version) {
      migrated = typeDef.migrate(state, appInstance.schema_version);
    }
    return { app: appInstance, state: migrated as TState };
  }

  async updateState(args: {
    userId: string;
    id: string;
    statePatch: unknown;
    expectedVersion: number;
  }): Promise<AppInstance> {
    // Read current to verify type + current_version baseline.
    let cur: KnowledgeObject;
    try {
      cur = await this.knowledge.getObject({ id: args.id, userId: args.userId });
    } catch (e) {
      throw mapNotFound(e, args.id);
    }
    if (!isAppObject(cur)) {
      throw new AppsServiceError('NOT_FOUND', `object ${args.id} is not an app`);
    }
    const curAppType = appTypeFromSubtype(cur.subtype);
    const typeDef = getAppType(curAppType);
    if (!typeDef) {
      throw new AppsServiceError('UNKNOWN_TYPE', `Unknown app type: ${curAppType || '(empty)'}`);
    }
    const validation = typeDef.validate(args.statePatch);
    if (!validation.valid) {
      throw new AppsServiceError('INVALID_STATE', `new_state invalid: ${validation.errors}`);
    }
    const newBody = enc.encode(JSON.stringify(args.statePatch));
    const patch: UpdateObjectArgs['patch'] = {
      body: newBody,
      meta: {
        ...(cur.meta ?? {}),
        type: curAppType,
        schema_version: typeDef.current_schema_version,
      },
      expectedVersion: args.expectedVersion,
    };
    let updated: KnowledgeObject;
    try {
      updated = await this.knowledge.updateObject({
        id: args.id,
        userId: args.userId,
        patch,
      });
    } catch (e) {
      throw mapCasConflict(e, args.expectedVersion, cur.currentVersion);
    }
    return toAppInstance(updated);
  }

  async listApps(args: { userId: string; type?: string; limit?: number }): Promise<AppInstance[]> {
    const listArgs: Parameters<KnowledgeService['listObjects']>[0] = {
      userId: args.userId,
    };
    // Bei explizitem appType → exakte Subtype-Anfrage (`app:<typ>`). Ohne
    // appType → server-side prefix-match via `subtypePrefix: 'app:'` (index-
    // friendly LIKE 'app:%' im B-Tree-Index). Frueher haben wir hier
    // ohne Filter geladen und client-side genarrowt — bei wachsendem
    // Dataset kostete das je nach Forderung 10x mehr Storage-Roundtrip.
    if (args.type !== undefined) {
      (listArgs as { subtype?: string }).subtype = appSubtype(args.type);
    } else {
      (listArgs as { subtypePrefix?: string }).subtypePrefix = APP_SUBTYPE_PREFIX;
    }
    if (args.limit !== undefined) (listArgs as { limit?: number }).limit = args.limit;
    const list = await this.knowledge.listObjects(listArgs);
    // Server hat schon gefiltert (exact-match oder prefix-match). isAppObject
    // bleibt als zusaetzliche Defense-Layer falls KC2 trotz Filter ein
    // fremdes Object schickt (sollte nicht passieren — defensive).
    return list.items.filter(isAppObject).map((o) => toAppInstance(o));
  }

  async deleteApp(args: { userId: string; id: string }): Promise<void> {
    await this.knowledge.deleteObject({ id: args.id, userId: args.userId });
    await this.emitAudit('apps.delete', args.userId, 'app', args.id, {});
  }

  async invoke(args: {
    userId: string;
    id: string;
    block_id: string;
    action: string;
    payload: Record<string, unknown>;
  }): Promise<InvokeResult> {
    // Read fresh state.
    const read = await this.readApp<LayoutDoc>({ userId: args.userId, id: args.id });
    if (read.app.type !== 'composable') {
      throw new AppsServiceError(
        'INVALID_ACTION',
        `invoke only valid for type=composable (got ${read.app.type})`,
      );
    }
    const layout = read.state;
    // Route the action — pure compute, throws ActionRoutingError on lookup-fail.
    const exec = routeAction(layout, args.block_id, args.action, args.payload);
    const newLayout = applyPatches(layout, args.block_id, exec.patches);
    // Persist via CAS (1 retry on CONCURRENT_UPDATE — KC might race on rapid clicks).
    let updated: AppInstance;
    try {
      updated = await this.updateState({
        userId: args.userId,
        id: args.id,
        statePatch: newLayout,
        expectedVersion: read.app.state_version,
      });
    } catch (e) {
      if (e instanceof AppsServiceError && e.code === 'CONCURRENT_UPDATE' && e.retriable) {
        // Re-read & re-apply once.
        const fresh = await this.readApp<LayoutDoc>({ userId: args.userId, id: args.id });
        const freshExec = routeAction(fresh.state, args.block_id, args.action, args.payload);
        const freshLayout = applyPatches(fresh.state, args.block_id, freshExec.patches);
        updated = await this.updateState({
          userId: args.userId,
          id: args.id,
          statePatch: freshLayout,
          expectedVersion: fresh.app.state_version,
        });
        return {
          app: updated,
          new_version: updated.state_version,
          result: freshExec.result,
          patches: freshExec.patches,
        };
      }
      throw e;
    }
    return {
      app: updated,
      new_version: updated.state_version,
      result: exec.result,
      patches: exec.patches,
    };
  }

  async query(args: {
    userId: string;
    id: string;
    block_id: string;
    query: string;
    args?: Record<string, unknown>;
  }): Promise<unknown> {
    const read = await this.readApp<LayoutDoc>({ userId: args.userId, id: args.id });
    if (read.app.type !== 'composable') {
      throw new AppsServiceError(
        'INVALID_ACTION',
        `query only valid for type=composable (got ${read.app.type})`,
      );
    }
    const result = routeQuery(read.state, args.block_id, args.query, args.args ?? {});
    return result.value;
  }

  async updateLayout(args: {
    userId: string;
    id: string;
    layoutDoc: LayoutDoc;
    expectedVersion: number;
  }): Promise<AppInstance> {
    // updateState does the validation via composable.validate already.
    return this.updateState({
      userId: args.userId,
      id: args.id,
      statePatch: args.layoutDoc,
      expectedVersion: args.expectedVersion,
    });
  }

  private async emitAudit(
    action: string,
    userId: string,
    resourceKind: string,
    resourceId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.emit({
        action,
        actorUserId: userId,
        result: 'success',
        resourceKind,
        resourceId,
        details,
      });
    } catch {
      // audit failure must not break the operation
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  // node + browser-runtime safe path.
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function mapNotFound(err: unknown, id: string): AppsServiceError {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.toLowerCase().includes('not found') || msg.includes('404')) {
    return new AppsServiceError('NOT_FOUND', `app ${id} not found`);
  }
  return new AppsServiceError('INTERNAL', msg);
}

function mapCasConflict(err: unknown, sent: number, current: number): AppsServiceError {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('409') || msg.toLowerCase().includes('cas') || msg.toLowerCase().includes('conflict')) {
    return new AppsServiceError(
      'CONCURRENT_UPDATE',
      `state_version mismatch: sent=${sent}, current=${current}`,
      true,
    );
  }
  if (msg.toLowerCase().includes('not found') || msg.includes('404')) {
    return new AppsServiceError('NOT_FOUND', msg);
  }
  return new AppsServiceError('INTERNAL', msg);
}

// Re-export for tools/route layer
export { listAppTypes };
