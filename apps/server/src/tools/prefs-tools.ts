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
      "Read tool-default preferences. Optional filter by toolName/field. Read-only.",
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
      'Set a tool-default at (toolName, field). Future tool-calls auto-fill the field. Requires approval.',
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
      'Remove a previously-stored tool-default. Future calls will not auto-fill the field. Requires approval.',
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
