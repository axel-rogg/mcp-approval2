/**
 * Apps-Tools — Wrapper auf AppsService.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2.1 (Storage-Boundary), §11 Burst 5
 * (Apps-Subsystem). Apps-State lebt als kind='app' in mcp-knowledge2 —
 * der AppsService kapselt das, die Tools forwarden.
 *
 * Tool-Inventar (8):
 *   - apps.create        (write,  Approval)
 *   - apps.read          (read)
 *   - apps.list          (read)
 *   - apps.delete        (danger, Approval) — soft-delete via KC
 *   - apps.update_state  (write,  Approval) — CAS via expectedVersion
 *   - apps.invoke        (write,  Approval) — block action dispatch
 *   - apps.query         (read)             — block computed-property
 *   - apps.update_layout (write,  Approval) — full LayoutDoc replace
 *
 * Sensitivity-Note: Block-actions in apps.invoke koennen iframe_auto_approve
 * tragen — das gilt aber NUR im HTTP-Routes-Pfad, nicht hier. Der MCP-Tool-
 * Pfad ist immer Approval-gated (LLM-driven calls).
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import type { AppsService, AppInstance, AppWithState, InvokeResult } from '../apps/api.js';
import type { LayoutDoc } from '../apps/blocks/types.js';

export interface AppsToolsDeps {
  readonly apps: AppsService;
}

// ---------------------------------------------------------------------------
// Input Schemas
// ---------------------------------------------------------------------------

export const AppsCreateInput = z
  .object({
    app_type: z.string().min(1).max(64),
    slug: z.string().min(1).max(64).optional(),
    title: z.string().min(1).max(200).optional(),
    initial_state: z.unknown().optional(),
    summary: z.string().min(1).max(500).optional(),
  })
  .strict();
export type AppsCreateInput = z.infer<typeof AppsCreateInput>;

export const AppsReadInput = z
  .object({ id: z.string().min(1).max(128) })
  .strict();
export type AppsReadInput = z.infer<typeof AppsReadInput>;

export const AppsListInput = z
  .object({
    type: z.string().min(1).max(64).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
export type AppsListInput = z.infer<typeof AppsListInput>;

export const AppsDeleteInput = z
  .object({ id: z.string().min(1).max(128) })
  .strict();
export type AppsDeleteInput = z.infer<typeof AppsDeleteInput>;

export const AppsUpdateStateInput = z
  .object({
    id: z.string().min(1).max(128),
    expected_version: z.number().int().nonnegative(),
    new_state: z.unknown(),
  })
  .strict();
export type AppsUpdateStateInput = z.infer<typeof AppsUpdateStateInput>;

export const AppsInvokeInput = z
  .object({
    id: z.string().min(1).max(128),
    block_id: z.string().min(1).max(64),
    action: z.string().min(1).max(128),
    payload: z.record(z.unknown()).optional(),
  })
  .strict();
export type AppsInvokeInput = z.infer<typeof AppsInvokeInput>;

export const AppsQueryInput = z
  .object({
    id: z.string().min(1).max(128),
    block_id: z.string().min(1).max(64),
    query: z.string().min(1).max(128),
    args: z.record(z.unknown()).optional(),
  })
  .strict();
export type AppsQueryInput = z.infer<typeof AppsQueryInput>;

export const AppsUpdateLayoutInput = z
  .object({
    id: z.string().min(1).max(128),
    expected_version: z.number().int().nonnegative(),
    layout_doc: z.unknown(),
  })
  .strict();
export type AppsUpdateLayoutInput = z.infer<typeof AppsUpdateLayoutInput>;

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

export function makeAppsCreateTool(deps: AppsToolsDeps): Tool<AppsCreateInput, AppInstance> {
  return {
    name: 'apps.create',
    description: 'Create a new app instance (kind=app in knowledge store). Requires approval.',
    sensitivity: 'write',
    displayTemplate: 'Create app: {{title}} (type={{app_type}})',
    inputSchema: AppsCreateInput,
    async execute(ctx: ToolContext, input): Promise<AppInstance> {
      const args: Parameters<AppsService['createApp']>[0] = {
        userId: ctx.userId,
        appType: input.app_type,
      };
      if (input.slug !== undefined) (args as { slug?: string }).slug = input.slug;
      if (input.title !== undefined) (args as { title?: string }).title = input.title;
      if (input.initial_state !== undefined) (args as { initialState?: unknown }).initialState = input.initial_state;
      if (input.summary !== undefined) (args as { summary?: string }).summary = input.summary;
      return deps.apps.createApp(args);
    },
  };
}

export function makeAppsReadTool(deps: AppsToolsDeps): Tool<AppsReadInput, AppWithState> {
  return {
    name: 'apps.read',
    description: 'Read an app instance (state + meta).',
    sensitivity: 'read',
    inputSchema: AppsReadInput,
    async execute(ctx: ToolContext, input): Promise<AppWithState> {
      return deps.apps.readApp({ userId: ctx.userId, id: input.id });
    },
  };
}

export function makeAppsListTool(
  deps: AppsToolsDeps,
): Tool<AppsListInput, { items: AppInstance[]; count: number }> {
  return {
    name: 'apps.list',
    description: "List the current user's apps. Optional type-filter.",
    sensitivity: 'read',
    inputSchema: AppsListInput,
    async execute(ctx: ToolContext, input): Promise<{ items: AppInstance[]; count: number }> {
      const args: Parameters<AppsService['listApps']>[0] = { userId: ctx.userId };
      if (input.type !== undefined) (args as { type?: string }).type = input.type;
      if (input.limit !== undefined) (args as { limit?: number }).limit = input.limit;
      const items = await deps.apps.listApps(args);
      return { items, count: items.length };
    },
  };
}

export function makeAppsDeleteTool(
  deps: AppsToolsDeps,
): Tool<AppsDeleteInput, { deleted: true; id: string }> {
  return {
    name: 'apps.delete',
    description: 'Delete an app instance. Destructive.',
    sensitivity: 'danger',
    displayTemplate: 'DELETE app {{id}}',
    inputSchema: AppsDeleteInput,
    async execute(ctx: ToolContext, input): Promise<{ deleted: true; id: string }> {
      await deps.apps.deleteApp({ userId: ctx.userId, id: input.id });
      return { deleted: true, id: input.id };
    },
  };
}

export function makeAppsUpdateStateTool(
  deps: AppsToolsDeps,
): Tool<AppsUpdateStateInput, { app: AppInstance; new_version: number }> {
  return {
    name: 'apps.update_state',
    description: 'Replace app state via CAS (expected_version match required).',
    sensitivity: 'write',
    displayTemplate: 'Update app {{id}} state (expected v{{expected_version}})',
    inputSchema: AppsUpdateStateInput,
    async execute(
      ctx: ToolContext,
      input,
    ): Promise<{ app: AppInstance; new_version: number }> {
      const inst = await deps.apps.updateState({
        userId: ctx.userId,
        id: input.id,
        statePatch: input.new_state,
        expectedVersion: input.expected_version,
      });
      return { app: inst, new_version: inst.state_version };
    },
  };
}

export function makeAppsInvokeTool(
  deps: AppsToolsDeps,
): Tool<AppsInvokeInput, InvokeResult> {
  return {
    name: 'apps.invoke',
    description: 'Invoke a block-action on a composable app. Persists patches via CAS.',
    sensitivity: 'write',
    displayTemplate: 'Invoke {{block_id}}.{{action}} on app {{id}}',
    inputSchema: AppsInvokeInput,
    async execute(ctx: ToolContext, input): Promise<InvokeResult> {
      return deps.apps.invoke({
        userId: ctx.userId,
        id: input.id,
        block_id: input.block_id,
        action: input.action,
        payload: input.payload ?? {},
      });
    },
  };
}

export function makeAppsQueryTool(deps: AppsToolsDeps): Tool<AppsQueryInput, { value: unknown }> {
  return {
    name: 'apps.query',
    description: 'Run a read-only block-query (computed-property dispatch).',
    sensitivity: 'read',
    inputSchema: AppsQueryInput,
    async execute(ctx: ToolContext, input): Promise<{ value: unknown }> {
      const qArgs: Parameters<AppsService['query']>[0] = {
        userId: ctx.userId,
        id: input.id,
        block_id: input.block_id,
        query: input.query,
      };
      if (input.args !== undefined) (qArgs as { args?: Record<string, unknown> }).args = input.args;
      const value = await deps.apps.query(qArgs);
      return { value };
    },
  };
}

export function makeAppsUpdateLayoutTool(
  deps: AppsToolsDeps,
): Tool<AppsUpdateLayoutInput, { app: AppInstance; new_version: number }> {
  return {
    name: 'apps.update_layout',
    description: 'Replace app LayoutDoc (components + state). Requires approval; CAS via expected_version.',
    sensitivity: 'write',
    displayTemplate: 'Update app {{id}} layout (expected v{{expected_version}})',
    inputSchema: AppsUpdateLayoutInput,
    async execute(
      ctx: ToolContext,
      input,
    ): Promise<{ app: AppInstance; new_version: number }> {
      const inst = await deps.apps.updateLayout({
        userId: ctx.userId,
        id: input.id,
        layoutDoc: input.layout_doc as LayoutDoc,
        expectedVersion: input.expected_version,
      });
      return { app: inst, new_version: inst.state_version };
    },
  };
}

// ---------------------------------------------------------------------------
// Bundle registrar
// ---------------------------------------------------------------------------

export function makeAppsTools(deps: AppsToolsDeps): Array<Tool<unknown, unknown>> {
  return [
    makeAppsCreateTool(deps),
    makeAppsReadTool(deps),
    makeAppsListTool(deps),
    makeAppsDeleteTool(deps),
    makeAppsUpdateStateTool(deps),
    makeAppsInvokeTool(deps),
    makeAppsQueryTool(deps),
    makeAppsUpdateLayoutTool(deps),
  ] as unknown as Array<Tool<unknown, unknown>>;
}
