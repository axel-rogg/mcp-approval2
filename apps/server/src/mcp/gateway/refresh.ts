/**
 * Sub-MCP-Live-Refresh.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4, §9.
 *
 * Zentrale Refresh-Logik, die von zwei Pfaden aufgerufen wird:
 *   1. Cron `gateway-discovery` (siehe cron/gateway-discovery.ts)
 *   2. Admin-Tool `gateway_server_rediscover` (siehe tools/gateway-mgmt-tools.ts)
 *   3. Admin-HTTP `POST /v1/admin/gateways/rediscover`
 *
 * Workflow:
 *   1. `refreshSubMcpToolCache` updated `sub_mcp_servers.tools_cache` per
 *      `tools/list`-Roundtrip pro betroffenem Sub-MCP. Errors pro Server
 *      werden gesammelt (single broken sub-mcp != complete fail).
 *   2. Pro erfolgreich refreshed Server: de-registriere die zuvor regis-
 *      trierten Wrapper-Tools aus der in-memory ToolRegistry (Cache haelt
 *      die Name-Liste).
 *   3. Re-build Wrapper-Tools aus dem neuen `toolsCache` und registriere sie
 *      in der ToolRegistry. Cache wird mit den neuen Namen aktualisiert.
 *
 * Damit ist der Refresh-Pfad live — keine approval2-Restart noetig um
 * neue oder geaenderte Sub-MCP-Tools sichtbar zu machen.
 *
 * Analog `kc-manifest-refresh.ts` fuer den KC-Wrapper-Pfad — gleiche
 * Cache-Semantik (de-register-old-add-new), nur fuer Gateway-Wrapper.
 */
import type { AppConfig } from '../../lib/config.js';
import type { ToolRegistry } from '../protocol/registry.js';
import { buildForwardedToolDefs } from './discovery.js';
import { refreshSubMcpToolCache, type DiscoveryResult } from './discovery.js';
import type { SubMcpForwarder } from './forwarder.js';
import type { SubMcpRegistry } from './registry.js';
import { makeForwardingTool } from './wrapper_tools.js';

/**
 * Tracker fuer aktuell-registrierte Wrapper-Tool-Namen pro Sub-MCP-Server.
 * Wird ausserhalb der refresh-Logik instanziiert (typisch: module-scoped in
 * app-factory.ts, analog `kcWrappersCache`).
 *
 * Mutable — die Cache-Mutation findet als Side-Effect von
 * `applyGatewayDiscovery` statt.
 */
export class SubMcpWrappersCache {
  private readonly byServer = new Map<string, ReadonlySet<string>>();

  /** Setzt die Namen fuer einen Server (replaced alle alten Namen). */
  setForServer(name: string, toolNames: Iterable<string>): void {
    this.byServer.set(name, new Set(toolNames));
  }

  /** Holt die Namen fuer einen Server (leer wenn unbekannt). */
  getForServer(name: string): ReadonlySet<string> {
    return this.byServer.get(name) ?? new Set();
  }

  /** Loescht den Eintrag fuer einen Server (vor de-register). */
  delete(name: string): void {
    this.byServer.delete(name);
  }

  /** Alle bekannten Server-Namen (z.B. fuer Diagnostics). */
  serverNames(): ReadonlyArray<string> {
    return [...this.byServer.keys()];
  }

  /** Total-Count aller registrierten Wrapper-Tools. */
  totalCount(): number {
    let n = 0;
    for (const s of this.byServer.values()) n += s.size;
    return n;
  }

  /** Komplett-clear (Tests). */
  clear(): void {
    this.byServer.clear();
  }
}

export interface ApplyGatewayDiscoveryArgs {
  readonly registry: SubMcpRegistry;
  readonly toolRegistry: ToolRegistry;
  readonly forwarder: SubMcpForwarder;
  readonly config: Pick<AppConfig, 'JWT_SECRET' | 'JWT_ISSUER'>;
  readonly cache: SubMcpWrappersCache;
  readonly fetchImpl?: typeof fetch;
  /** Falls gesetzt: nur diese Sub-MCPs refreshen (sonst alle enabled). */
  readonly only?: ReadonlyArray<string>;
  /** OAuth-Bearer-Enricher fuer Sub-MCPs wie GitHub. */
  readonly authEnricher?: import('../../services/sub-mcp-auth-enricher.js').SubMcpAuthEnricher;
  /** User-ID dessen OAuth-Tokens fuer Discovery verwendet werden. */
  readonly operatorUserId?: string;
}

export interface ApplyGatewayDiscoveryResult {
  readonly results: ReadonlyArray<DiscoveryResult>;
  readonly registered: number;
  readonly deregistered: number;
  /** Pro Sub-MCP die Anzahl jetzt-registrierter Wrapper-Tools. */
  readonly perSubMcp: ReadonlyMap<string, number>;
  /** Tool-Namen die wegen ungueltigem Naming-Pattern uebersprungen wurden. */
  readonly skipped: ReadonlyArray<string>;
  /** Fehlgeschlagene Server (Discovery-Error) — diese werden NICHT de-/re-registered. */
  readonly failed: ReadonlyArray<string>;
}

/**
 * Live-Refresh-Hook. Aktualisiert sowohl `tools_cache` in der DB als auch
 * die in-memory ToolRegistry.
 *
 * Failure-Semantik: pro-Server fail-soft.
 *   - Discovery-Fail bei Server X → tools_cache fuer X bleibt wie es war,
 *     Wrapper-Tools von X bleiben unveraendert in der Registry. Audit-Event
 *     mit `error: ...`.
 *   - Discovery-OK bei Server X aber keine Tools (leeres tools_cache) →
 *     alle X.* Wrapper-Tools werden deregistered, keine neuen registriert.
 *   - Discovery-OK bei Server X mit N Tools → de-register old X.*, register
 *     N neue X.* (oder den Subset der valid-named ist).
 */
export async function applyGatewayDiscovery(
  args: ApplyGatewayDiscoveryArgs,
): Promise<ApplyGatewayDiscoveryResult> {
  // Schritt 1: DB-Cache refreshen. refreshSubMcpToolCache invalidiert
  // intern den registry-Cache via updateToolsCache().
  const refreshArgs: Parameters<typeof refreshSubMcpToolCache>[0] = {
    registry: args.registry,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    ...(args.only ? { only: args.only } : {}),
    ...(args.authEnricher ? { authEnricher: args.authEnricher } : {}),
    ...(args.operatorUserId ? { operatorUserId: args.operatorUserId } : {}),
  };
  const results = await refreshSubMcpToolCache(refreshArgs);

  // Welche Server haben Discovery erfolgreich durchlaufen? Nur diese
  // bekommen ihre Wrapper-Tools neu gebaut. Bei Errors lassen wir den
  // existierenden Stand stehen.
  const affected = new Set<string>();
  const failed: string[] = [];
  for (const r of results) {
    if (r.error) failed.push(r.subMcpName);
    else affected.add(r.subMcpName);
  }

  // Schritt 2: De-register old wrapper-tools fuer affected servers.
  let deregistered = 0;
  for (const name of affected) {
    const oldNames = args.cache.getForServer(name);
    for (const tn of oldNames) {
      if (args.toolRegistry.unregister(tn)) deregistered += 1;
    }
    args.cache.delete(name);
  }

  // Schritt 3: Re-build + register wrapper-tools aus dem frischen
  // toolsCache. Wir muessen die enabled-Liste neu lesen (Cache wurde
  // durch updateToolsCache() oben invalidated).
  const enabledServers = await args.registry.listEnabled();
  const perSubMcp = new Map<string, number>();
  const skipped: string[] = [];
  let registered = 0;
  for (const cfg of enabledServers) {
    if (!affected.has(cfg.name)) continue;
    const { defs, skipped: defSkipped } = buildForwardedToolDefs(cfg);
    skipped.push(...defSkipped);
    const toolNames: string[] = [];
    for (const def of defs) {
      const tool = makeForwardingTool({ def, forwarder: args.forwarder, config: args.config });
      if (args.toolRegistry.has(tool.name)) {
        // Defensive — sollte nicht passieren weil wir oben de-registered haben.
        // Falls doch (z.B. eine andere Quelle hat denselben Namen registered),
        // ueberspringen wir + zaehlen als skipped.
        skipped.push(tool.name);
        continue;
      }
      args.toolRegistry.register(tool);
      toolNames.push(tool.name);
      registered += 1;
    }
    args.cache.setForServer(cfg.name, toolNames);
    perSubMcp.set(cfg.name, toolNames.length);
  }

  return { results, registered, deregistered, perSubMcp, skipped, failed };
}
