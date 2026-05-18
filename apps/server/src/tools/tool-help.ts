/**
 * tools.help — natives Read-Tool fuer LLM-Initiation der Tool-Defaults.
 *
 * Plan-Ref: docs/plans/active/PLAN-tool-defaults-v2.md (Phase D).
 *
 * Use-Case: LLM ruft `tools.help({name: 'gws.calendar.list'})` bevor es das
 * Tool ausfuehrt → bekommt Schema + currently-effective Defaults + Hints
 * + verfuegbare Profile. Damit kann es:
 *   - dem User vorschlagen "soll ich X als Default speichern?"
 *   - referenzieren welcher Wert aus welchem Profil kommt
 *   - mit `__profile`-Override gezielt ein anderes Profil ansprechen
 *
 * Sensitivity: 'read' — kein Approval. Liefert nur User-eigene Daten
 * (RLS-isoliert via Service-Layer).
 *
 * Plus: Skill-Bundle (agent-onboarding) kann LLM anweisen, `tools.help`
 * vor unbekannten Tools aufzurufen — pattern aus v1 PLAN-prefs § "Hint-
 * driven elicitation".
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import type { ToolRegistry } from '../mcp/protocol/registry.js';
import { toToolMetadata } from '../mcp/protocol/tool.js';
import {
  subMcpFromToolName,
  type ToolDefaultsService,
} from '../services/tool-defaults.js';
import type {
  ToolDefaultProfilesService,
  ToolDefaultProfile,
} from '../services/tool-default-profiles.js';
import type {
  UserServerToolDefaultsService,
  ToolDefault,
} from '../services/user-server-tool-defaults.js';
import type { ToolDefaultHintsService } from '../services/tool-default-hints.js';

// ---------------------------------------------------------------------------
// Public schema + result
// ---------------------------------------------------------------------------

export const ToolHelpInput = z
  .object({
    name: z.string().min(1).max(128),
  })
  .strict();
export type ToolHelpInputT = z.infer<typeof ToolHelpInput>;

export interface ToolHelpProfileSummary {
  readonly name: string;
  readonly description: string;
  readonly active: boolean;
}

export interface ToolHelpResult {
  /**
   * Tool-Metadata: name, description, JSON-Schema des Inputs, annotations.
   * `null` wenn `name` nicht in der Registry registriert ist (Caller sieht
   * `tool: null` statt 404 damit das LLM sauber unterscheidet: "Tool
   * existiert nicht" vs "Tool existiert aber kein Schema").
   */
  readonly tool: {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
    readonly sensitivity: 'read' | 'write' | 'danger';
  } | null;
  readonly subMcpName: string;
  readonly defaults: {
    readonly active_profile: string;
    /** effective values aus dem aktiven Profil — pro field der typed value. */
    readonly effective: Record<string, unknown>;
    readonly fields_with_defaults: ReadonlyArray<string>;
    readonly fields_without_defaults: ReadonlyArray<string>;
    /** Felder mit `orphan_since≠null` — Schema-Drift sichtbar fuer LLM/User. */
    readonly orphan_fields: ReadonlyArray<string>;
  };
  /**
   * Hint-Texts pro Feld (Phase E befuellt). Phase D liefert leeres Object
   * — Stub damit das Wire-Format stable bleibt.
   */
  readonly hints: Record<string, string>;
  readonly available_profiles: ReadonlyArray<ToolHelpProfileSummary>;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ToolHelpDeps {
  readonly registry: ToolRegistry;
  readonly toolDefaults: ToolDefaultsService;
  readonly userServerToolDefaults: UserServerToolDefaultsService;
  readonly toolDefaultProfiles: ToolDefaultProfilesService;
  /**
   * Phase E: Hints-Service fuer hints[]-Befuellung im Response.
   * Optional damit Phase-D-Aufrufer ohne Hints durchlaufen (BC).
   */
  readonly toolDefaultHints?: ToolDefaultHintsService;
  /** Optional Sub-MCP-Server-Namen-Set fuer subMcpFromToolName. */
  readonly subMcpServerNames?: () => Promise<ReadonlySet<string>>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function makeToolHelpTool(deps: ToolHelpDeps): Tool<ToolHelpInputT, ToolHelpResult> {
  return {
    name: 'tools.help',
    description:
      'Inspect a tool: schema, currently-effective defaults for the active profile, hints (when configured), and available profiles. Read-only. Call before invoking an unfamiliar tool to learn what defaults are already set.',
    sensitivity: 'read',
    inputSchema: ToolHelpInput,
    async execute(ctx: ToolContext, input: ToolHelpInputT): Promise<ToolHelpResult> {
      const subMcpSet = deps.subMcpServerNames ? await deps.subMcpServerNames() : undefined;
      const subMcpName = subMcpFromToolName(input.name, subMcpSet);

      // Tool-Metadata (oder null wenn Tool nicht existiert)
      const tool = deps.registry.get(input.name);
      const meta = tool
        ? (() => {
            const m = toToolMetadata(tool);
            return {
              name: m.name,
              description: m.description,
              inputSchema: m.inputSchema,
              sensitivity: tool.sensitivity,
            };
          })()
        : null;

      // Profile-Lookup pro Sub-MCP
      const profiles: ReadonlyArray<ToolDefaultProfile> = await deps.toolDefaultProfiles.list(
        ctx.userId,
        subMcpName,
      );
      const activeProfile =
        profiles.find((p) => p.isActive)?.profileName ?? 'default';

      // Defaults im aktiven Profil
      const allInProfile: ReadonlyArray<ToolDefault> =
        await deps.userServerToolDefaults.listByTool(
          ctx.userId,
          subMcpName,
          input.name,
          activeProfile,
        );

      const effective: Record<string, unknown> = {};
      const fieldsWith: string[] = [];
      const orphanFields: string[] = [];
      for (const d of allInProfile) {
        if (d.orphanSince !== null) {
          orphanFields.push(d.fieldName);
          continue;
        }
        effective[d.fieldName] = d.value;
        fieldsWith.push(d.fieldName);
      }

      // Schema-Properties extrahieren um fields_without_defaults zu bauen.
      const allSchemaFields = tool ? extractTopLevelFields(tool.inputSchema) : [];
      const withSet = new Set(fieldsWith);
      const fieldsWithout = allSchemaFields.filter((f) => !withSet.has(f));

      const availableProfiles: ToolHelpProfileSummary[] = profiles.map((p) => ({
        name: p.profileName,
        description: p.description,
        active: p.isActive,
      }));
      // Wenn keine Profile in der DB sind, ist 'default' implizites Profil.
      if (availableProfiles.length === 0) {
        availableProfiles.push({ name: 'default', description: '', active: true });
      }

      // Phase E: Hints pro Field laden (Frei-Text, ≤500 chars).
      const hintsMap: Record<string, string> = {};
      if (deps.toolDefaultHints) {
        const hintRows = await deps.toolDefaultHints.listByTool(
          ctx.userId,
          subMcpName,
          input.name,
        );
        for (const h of hintRows) {
          hintsMap[h.fieldName] = h.hintText;
        }
      }

      return {
        tool: meta,
        subMcpName,
        defaults: {
          active_profile: activeProfile,
          effective,
          fields_with_defaults: fieldsWith,
          fields_without_defaults: fieldsWithout,
          orphan_fields: orphanFields,
        },
        hints: hintsMap,
        available_profiles: availableProfiles,
      };
    },
  };
}

/**
 * Best-effort Top-Level-Property-Lookup auf einem Zod-Schema. Spiegelt
 * `extractTopLevelSchemaFields` in app-factory — wir duplizieren das hier
 * lokal um den tool-help-Code self-contained zu halten.
 */
function extractTopLevelFields(inputSchema: unknown): string[] {
  const schema = inputSchema as { _def?: { shape?: () => Record<string, unknown> | undefined } };
  const shapeFn = schema._def?.shape;
  if (typeof shapeFn !== 'function') return [];
  try {
    const shape = shapeFn();
    if (!shape || typeof shape !== 'object') return [];
    return Object.keys(shape).sort();
  } catch {
    return [];
  }
}
