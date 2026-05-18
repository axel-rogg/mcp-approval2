/**
 * Prefs-Tools — `prefs.get` / `prefs.set` / `prefs.remove`.
 *
 * Plan-Ref: docs/plans/done/PLAN-prefs.md (mcp-approval), Burst 3.
 *
 *   prefs.get    — Read-only, dispatch sofort ausfuehrbar.
 *   prefs.set    — Write-Tool, geht durch Approval-Gate (WYSIWYS-Display).
 *   prefs.remove — Write-Tool, geht durch Approval-Gate.
 *
 * Backend: `PrefsService` (services/prefs.ts) → user_tool_prefs Tabelle.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import type {
  PrefsService,
  PrefScope,
  ToolDefault,
} from '../services/prefs.js';

const ScopeSchema = z.enum(['user', 'tenant', 'session']);

export const PrefsGetInput = z
  .object({
    toolName: z.string().min(1).max(128).optional(),
    field: z.string().min(1).max(128).optional(),
  })
  .strict();
export type PrefsGetInputT = z.infer<typeof PrefsGetInput>;

export const PrefsSetInput = z
  .object({
    toolName: z.string().min(1).max(128),
    field: z.string().min(1).max(128),
    value: z.unknown(),
    scope: ScopeSchema.optional(),
  })
  .strict();
export type PrefsSetInputT = z.infer<typeof PrefsSetInput>;

export const PrefsRemoveInput = z
  .object({
    toolName: z.string().min(1).max(128),
    field: z.string().min(1).max(128),
    scope: ScopeSchema.optional(),
  })
  .strict();
export type PrefsRemoveInputT = z.infer<typeof PrefsRemoveInput>;

export interface PrefsToolsDeps {
  readonly prefs: PrefsService;
}

export interface PrefsGetResult {
  readonly defaults: ToolDefault[];
  readonly count: number;
}

export interface PrefsSetResult {
  readonly toolName: string;
  readonly field: string;
  readonly scope: PrefScope;
  readonly updatedAt: number;
}

export interface PrefsRemoveResult {
  readonly toolName: string;
  readonly field: string;
  readonly scope: PrefScope;
  readonly removedAt: number;
}

export function makePrefsGetTool(
  deps: PrefsToolsDeps,
): Tool<PrefsGetInputT, PrefsGetResult> {
  return {
    name: 'prefs.get',
    description:
      "[DEPRECATED 2026-06-15: use tools.help / tool_defaults.*] Read tool-default preferences from legacy user_tool_prefs. New surface: tools.help (read) + tool_defaults.* (write) — they operate on the typed user_server_tool_defaults table with profile support. This tool stays available for read-only BC until the user_tool_prefs table is dropped (Mig 0030, deferred).",
    sensitivity: 'read',
    inputSchema: PrefsGetInput,
    async execute(ctx: ToolContext, input): Promise<PrefsGetResult> {
      const args: Parameters<PrefsService['get']>[0] = {
        userId: ctx.userId,
        ...(input.toolName !== undefined && { toolName: input.toolName }),
        ...(input.field !== undefined && { field: input.field }),
      };
      const defaults = await deps.prefs.get(args);
      return { defaults, count: defaults.length };
    },
  };
}

export function makePrefsSetTool(
  deps: PrefsToolsDeps,
): Tool<PrefsSetInputT, PrefsSetResult> {
  return {
    name: 'prefs.set',
    description:
      '[DEPRECATED 2026-06-15: use PWA #/tools/servers/<srv>/defaults for typed defaults + Profile, or PUT /v1/me/servers/:srv/tool-defaults/:tool/:field via REST] Set a tool-default at (toolName, field) in legacy user_tool_prefs. Future tool-calls auto-fill the field — BUT: the Phase-A resolver merges from user_server_tool_defaults (Mig 0024+0028), NOT from user_tool_prefs. So values set here are stored but NOT applied. Use the new surface for actual effect.',
    sensitivity: 'write',
    displayTemplate:
      'Set default for {{toolName}}.{{field}} (scope={{scope}}) to: {{value}}',
    inputSchema: PrefsSetInput,
    async execute(ctx: ToolContext, input): Promise<PrefsSetResult> {
      const scope: PrefScope = input.scope ?? 'user';
      const setArgs: Parameters<PrefsService['set']>[0] = {
        userId: ctx.userId,
        toolName: input.toolName,
        field: input.field,
        value: input.value,
        scope,
      };
      await deps.prefs.set(setArgs);
      return {
        toolName: input.toolName,
        field: input.field,
        scope,
        updatedAt: Date.now(),
      };
    },
  };
}

export function makePrefsRemoveTool(
  deps: PrefsToolsDeps,
): Tool<PrefsRemoveInputT, PrefsRemoveResult> {
  return {
    name: 'prefs.remove',
    description:
      '[DEPRECATED 2026-06-15: use PWA defaults-tab or DELETE /v1/me/servers/:srv/tool-defaults/:tool/:field] Remove a previously-stored tool-default from legacy user_tool_prefs. No-op if not present. Note: this only affects user_tool_prefs (Mig 0009), NOT the active resolver-table user_server_tool_defaults — see prefs.set deprecation note.',
    sensitivity: 'write',
    displayTemplate:
      'Remove default for {{toolName}}.{{field}} (scope={{scope}})',
    inputSchema: PrefsRemoveInput,
    async execute(ctx: ToolContext, input): Promise<PrefsRemoveResult> {
      const scope: PrefScope = input.scope ?? 'user';
      const removeArgs: Parameters<PrefsService['remove']>[0] = {
        userId: ctx.userId,
        toolName: input.toolName,
        field: input.field,
        scope,
      };
      await deps.prefs.remove(removeArgs);
      return {
        toolName: input.toolName,
        field: input.field,
        scope,
        removedAt: Date.now(),
      };
    },
  };
}
