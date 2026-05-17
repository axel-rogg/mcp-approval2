/**
 * Tool/Server-Inventory-Route — Read-only Listing fuer die PWA-Tools-View.
 *
 * Plan-Ref: PWA-Tools-Surface (analog v1-mcp-approval `#/servers`-Route).
 *
 * Liefert:
 *   - Native Tools aus der `ToolRegistry` (hub-eigene + system-Tools)
 *   - mcp-knowledge2 als EIGENER Gateway-Eintrag (`name='knowledge2'`) mit
 *     allen kc_wrapper-Tools. Architektur-Wahrheit: KC2 ist ein
 *     unabhaengiger MCP-Server — er soll im UI als solcher erscheinen,
 *     nicht als interne wrapper-tools im native-Bucket. Die Wrapper-Tools
 *     der ToolRegistry werden hierfuer aus `native` ausgeschlossen +
 *     synthetisch zu einem Gateway-Eintrag umgehaengt.
 *   - Sub-MCP-Gateways aus dem `SubMcpRegistry` mit deren cached `tools/list`-
 *     Output (utils / gws / gcloud — opt-in via SUB_MCP_TOKEN_*-Doppler).
 *
 * Auth: authenticated User reicht (kein admin-only). Die Liste enthaelt keine
 * Operator-Secrets (kein baseUrl, kein authMode, kein serviceToken). Sensitivity-
 * Hint kommt aus `annotations.sensitivity` (Default 'write' fuer Sub-MCPs ohne
 * explizite Annotation — fail-closed, SEC-006-Pattern).
 */
import { Hono } from 'hono';
import type { AppBindings, ServerContext } from '../lib/context.js';
import { HttpError } from '../lib/errors.js';
import { auth } from '../middleware/auth.js';
import type { ToolRegistry } from '../mcp/protocol/registry.js';
import type { SubMcpRegistry } from '../mcp/gateway/registry.js';
import type { UserSubscriptionsService } from '../services/user-subscriptions.js';

/**
 * Liefert die Tool-Namen die zu mcp-knowledge2 gehoeren. Wird in app-factory.ts
 * aus dem module-scoped `kcWrappersCache` befuellt — Default ist eine leere
 * Snapshot wenn KC2 nicht verkabelt ist.
 */
export interface KcWrapperSnapshot {
  /** Namen der kc_wrapper-Tools die unter `native` registriert sind. */
  readonly toolNames: ReadonlySet<string>;
  /** Optional: letzter erfolgreicher Refresh-Zeitpunkt (UNIX-ms). */
  readonly refreshedAt: number | null;
  /** Optional: Display-Name (Default "Knowledge Core (mcp-knowledge2)"). */
  readonly displayName?: string;
}

export interface InventoryRouteDeps {
  readonly server: ServerContext;
  readonly registry: ToolRegistry;
  readonly subMcpRegistry?: SubMcpRegistry;
  /**
   * Per-User-Subscriptions. Wenn gesetzt: Inventory filtert sub_mcp_gateways
   * auf user-aktivierte Server + listet die nicht-aktivierten unter
   * `available`. Wenn nicht gesetzt (Tests, Bootstrap-Mode): Legacy-
   * Verhalten ohne Filter.
   */
  readonly subscriptions?: UserSubscriptionsService;
  /**
   * KC2-Tool-Snapshot-Getter. Wird pro-Request aufgerufen damit sich
   * KC-Manifest-Refresh-Changes propagieren ohne dass dieser Endpoint
   * neu gemountet werden muesste.
   */
  readonly kcSnapshot?: () => KcWrapperSnapshot;
}

interface NativeToolEntry {
  readonly name: string;
  readonly description: string;
  readonly sensitivity: 'read' | 'write' | 'danger';
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
}

interface GatewayToolEntry {
  readonly name: string;
  readonly description: string | null;
  readonly sensitivity: 'read' | 'write' | 'danger';
}

/**
 * Pro-Gateway Credential-Bedarf, aggregiert aus den Tool-Annotations.
 * Sub-MCP-Worker deklarieren in `tools/list[].annotations.requires_credential`
 * was sie brauchen — wir dedupen pro Provider hier am Inventory-Endpoint.
 */
interface RequiredCredentialEntry {
  readonly provider: string;
  readonly kind: string | null;
}

interface GatewayEntry {
  readonly name: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly toolsCachedAt: number | null;
  readonly tools: ReadonlyArray<GatewayToolEntry>;
  /** Credentials die der Sub-MCP-Worker fuer mind. eines seiner Tools braucht. */
  readonly requiredCredentials: ReadonlyArray<RequiredCredentialEntry>;
  /**
   * Config-Schema vom Worker via tools/list._meta. PWA rendert die Felder
   * im Config-Drawer. null = kein Schema deklariert.
   */
  readonly configSchema: Record<string, unknown> | null;
  /**
   * Phase 4: TRUE wenn dieser Server vom aktuellen User selbst angelegt wurde
   * (owner_user_id = userId). PWA zeigt Delete-Button nur fuer user-owned.
   */
  readonly isUserOwned: boolean;
}

interface AvailableServerEntry {
  readonly name: string;
  readonly displayName: string;
  readonly toolsCount: number;
  readonly requiredCredentials: ReadonlyArray<RequiredCredentialEntry>;
}

interface InventoryResponse {
  readonly native: ReadonlyArray<NativeToolEntry>;
  readonly gateways: ReadonlyArray<GatewayEntry>;
  /**
   * Catalog-Default-Server die der User noch NICHT aktiviert hat. PWA
   * zeigt das als "Verfuegbar"-Sektion mit [Aktivieren]-Knopf.
   * Leer wenn keine Subscriptions-Service verkabelt ist (Legacy-Mode).
   */
  readonly available: ReadonlyArray<AvailableServerEntry>;
}

function sensitivityFromAnnotations(annotations: unknown): 'read' | 'write' | 'danger' {
  if (annotations && typeof annotations === 'object') {
    const a = annotations as Record<string, unknown>;
    const s = a['sensitivity'];
    if (s === 'read' || s === 'write' || s === 'danger') return s;
    if (a['readOnlyHint'] === true) return 'read';
    if (a['destructiveHint'] === true) return 'danger';
  }
  // SEC-006: fail-closed default
  return 'write';
}

/**
 * Liest `annotations.requires_credential` aus einer Tool-Annotation.
 * Akzeptiert beide Shapes:
 *   - Einzel: `{ provider: 'github', kind?: 'api_token' }`
 *   - Array:  `[ { provider, kind? }, ... ]` (Tool braucht mehrere)
 */
function extractRequiredCredentials(
  annotations: unknown,
): ReadonlyArray<RequiredCredentialEntry> {
  if (!annotations || typeof annotations !== 'object') return [];
  const a = annotations as Record<string, unknown>;
  const raw = a['requires_credential'];
  if (!raw) return [];
  const entries: RequiredCredentialEntry[] = [];
  const items = Array.isArray(raw) ? raw : [raw];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const provider = typeof rec['provider'] === 'string' ? rec['provider'] : null;
    if (!provider || provider.length === 0) continue;
    const kind = typeof rec['kind'] === 'string' ? rec['kind'] : null;
    entries.push({ provider, kind });
  }
  return entries;
}

/**
 * Aggregiert die `requires_credential`-Annotation ueber alle Tools eines
 * Gateways. Dedupe per `provider` — pro Provider gewinnt der erste explizit
 * gesetzte `kind`-Wert.
 */
function aggregateRequiredCredentials(
  tools: ReadonlyArray<{ annotations?: unknown }>,
): RequiredCredentialEntry[] {
  const byProvider = new Map<string, RequiredCredentialEntry>();
  for (const t of tools) {
    for (const req of extractRequiredCredentials(t.annotations)) {
      const existing = byProvider.get(req.provider);
      if (!existing) byProvider.set(req.provider, req);
      else if (existing.kind === null && req.kind !== null) {
        byProvider.set(req.provider, req);
      }
    }
  }
  return [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

function mapNative(
  registry: ToolRegistry,
  excludeNames: ReadonlySet<string>,
): NativeToolEntry[] {
  return registry
    .list()
    .filter((meta) => !excludeNames.has(meta.name))
    .map((meta) => {
      const sens = sensitivityFromAnnotations(meta.annotations);
      return {
        name: meta.name,
        description: meta.description,
        sensitivity: sens,
        readOnlyHint: sens === 'read',
        destructiveHint: sens === 'danger',
      };
    });
}

/**
 * Tools die zu mcp-knowledge2 gehoeren — per Namens-Prefix identifiziert.
 *
 * Hintergrund: es gibt ZWEI Code-Pfade die KC-Tools registrieren:
 *   1. registerKcWrapperTools (statisch, in tools/kc-wrappers-index.ts) —
 *      registriert `docs.`-, `skills.`-, `memorize.`-, `objects.`-Tools
 *      IMMER beim Boot in die Haupt-Registry. Rufen approval2's
 *      KnowledgeService der KC2 anpingt.
 *   2. buildKcWrappers (dynamisch, in tools/kc_wrappers/) — fetcht aus KC2's
 *      tools/list-Manifest. Nutzt kcWrappersCache. Fail't bei KC2-Unreachable.
 *
 * Beide Pfade lassen die Tools im selben native-Bucket landen. Fuer die
 * Inventory-Trennung muessen wir per Pattern identifizieren — `kcWrappersCache`
 * deckt nur Pfad 2 ab.
 */
const KC_TOOL_PREFIXES = [
  'docs.',
  'skills.',
  'memorize.',
  'objects.',
  'knowledge.',
] as const;
const KC_TOOL_EXACT = new Set(['search']);

function isKcTool(name: string): boolean {
  if (KC_TOOL_EXACT.has(name)) return true;
  for (const p of KC_TOOL_PREFIXES) {
    if (name.startsWith(p)) return true;
  }
  return false;
}

function mapKnowledge2Gateway(
  registry: ToolRegistry,
  snapshot: KcWrapperSnapshot,
): { gateway: GatewayEntry | null; kcToolNames: Set<string> } {
  // Pattern-basierte Identifizierung (kcWrappersCache alone reicht NICHT,
  // weil registerKcWrapperTools statisch laeuft auch ohne KC2-Manifest).
  // Plus: wenn kcWrappersCache befuellt ist, werden die dortigen Namen mit
  // aufgenommen — DRY-Union.
  const kcToolNames = new Set<string>(snapshot.toolNames);
  const tools: GatewayToolEntry[] = [];
  const annotationsForAgg: Array<{ annotations?: unknown }> = [];

  for (const meta of registry.list()) {
    if (!isKcTool(meta.name) && !snapshot.toolNames.has(meta.name)) continue;
    kcToolNames.add(meta.name);
    tools.push({
      name: meta.name,
      description: meta.description ?? null,
      sensitivity: sensitivityFromAnnotations(meta.annotations),
    });
    annotationsForAgg.push({ annotations: meta.annotations });
  }

  if (tools.length === 0) {
    return { gateway: null, kcToolNames };
  }

  tools.sort((a, b) => a.name.localeCompare(b.name));
  const gateway: GatewayEntry = {
    name: 'knowledge2',
    displayName: snapshot.displayName ?? 'Knowledge Core (mcp-knowledge2)',
    enabled: true,
    toolsCachedAt: snapshot.refreshedAt,
    tools,
    requiredCredentials: aggregateRequiredCredentials(annotationsForAgg),
    configSchema: null,
    isUserOwned: false,
  };
  return { gateway, kcToolNames };
}

async function mapGateways(
  subMcpRegistry: SubMcpRegistry,
  userId: string,
): Promise<GatewayEntry[]> {
  const servers = await subMcpRegistry.listAll();
  return servers.map((s) => {
    const toolsCache = s.toolsCache ?? [];
    const tools: GatewayToolEntry[] = toolsCache.map((t) => ({
      name: t.name,
      description: t.description ?? null,
      sensitivity: sensitivityFromAnnotations(t.annotations),
    }));
    // alphabetisch sortiert — analog zu native registry.list()
    tools.sort((a, b) => a.name.localeCompare(b.name));
    return {
      name: s.name,
      displayName: s.displayName,
      enabled: s.enabled,
      toolsCachedAt: s.toolsCachedAt,
      tools,
      requiredCredentials: aggregateRequiredCredentials(
        toolsCache.map((t) => ({ annotations: t.annotations })),
      ),
      configSchema: s.configSchema,
      isUserOwned: s.ownerUserId === userId,
    };
  });
}

export function inventoryRoutes(deps: InventoryRouteDeps): Hono<AppBindings> {
  const { server, registry, subMcpRegistry, kcSnapshot, subscriptions } = deps;
  const app = new Hono<AppBindings>();
  const guard = auth(server);

  app.get('/v1/inventory', guard, async (c) => {
    const user = c.get('user');
    if (!user) throw HttpError.unauthorized('authentication required');

    const kc = kcSnapshot
      ? kcSnapshot()
      : ({ toolNames: new Set<string>(), refreshedAt: null } satisfies KcWrapperSnapshot);
    // KC2-Gateway FIRST bauen damit wir die effektive Exclude-Liste fuer
    // native haben (Pattern-basiert + kcWrappersCache-Union).
    const { gateway: knowledge2Entry, kcToolNames } = mapKnowledge2Gateway(registry, kc);
    const native = mapNative(registry, kcToolNames);
    const allRaw = subMcpRegistry ? await subMcpRegistry.listAll() : [];
    // Filter: catalog-defaults (owner NULL) ODER vom aktuellen User selbst.
    const allFiltered = allRaw.filter(
      (s) => s.ownerUserId === null || s.ownerUserId === user.userId,
    );
    const allSubMcpGateways = subMcpRegistry
      ? (await mapGateways(subMcpRegistry, user.userId)).filter((g) =>
          allFiltered.some((f) => f.name === g.name),
        )
      : [];

    // Per-User-Subscription-Filter (Phase 1). Wenn subscriptions verkabelt:
    // - seed catalog-rows lazy beim first read
    // - subscribed-Liste filtert die Gateway-Cards
    // - available-Liste sammelt catalog-defaults die User noch nicht aktiviert hat
    // Wenn nicht verkabelt (Bootstrap/Tests): Legacy-mode, alle Gateways sichtbar.
    let visibleGateways = allSubMcpGateways;
    const available: AvailableServerEntry[] = [];
    if (subscriptions) {
      await subscriptions.ensureCatalogRows(user.userId);
      const subs = await subscriptions.list(user.userId);
      const enabledNames = new Set(subs.filter((s) => s.enabled).map((s) => s.subMcpName));
      const knownNames = new Set(subs.map((s) => s.subMcpName));

      visibleGateways = allSubMcpGateways.filter((g) => enabledNames.has(g.name));
      for (const g of allSubMcpGateways) {
        if (!enabledNames.has(g.name) && knownNames.has(g.name)) {
          available.push({
            name: g.name,
            displayName: g.displayName,
            toolsCount: g.tools.length,
            requiredCredentials: g.requiredCredentials,
          });
        }
      }
    }

    // KC2 ist embedded (Phase 1 Decision: nicht subscribable, immer aktiv
    // wenn kc_wrappers booted). Erscheint also IMMER, ohne Subscription-Toggle.
    const gateways: GatewayEntry[] = [];
    if (knowledge2Entry) gateways.push(knowledge2Entry);
    gateways.push(...visibleGateways);

    const body: InventoryResponse = { native, gateways, available };
    return c.json(body);
  });

  return app;
}
