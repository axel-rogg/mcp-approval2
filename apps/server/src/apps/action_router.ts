/**
 * Action-Router — Worker-side Dispatch von BlockInvocations an Block-Handler.
 *
 * Multi-User: Router ist pure (Layout + Catalog). Per-User-Scoping in
 * AppsService.invoke().
 */
import { getBlock } from './blocks/catalog.js';
import type { BlockSensitivity, LayoutDoc } from './blocks/types.js';

export interface ActionExecutionResult {
  readonly block_id: string;
  readonly block_type: string;
  readonly action: string;
  readonly sensitivity: BlockSensitivity;
  readonly iframe_auto_approve: boolean;
  readonly patches: ReadonlyArray<{ path: string; value: unknown }>;
  readonly result: unknown;
  readonly approval_display?: string;
}

export interface QueryExecutionResult {
  readonly block_id: string;
  readonly block_type: string;
  readonly query: string;
  readonly value: unknown;
}

export class ActionRoutingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ActionRoutingError';
  }
}

/**
 * Resolves block, runs handler, returns patches + result + sensitivity.
 * Does NOT persist anything.
 */
export function routeAction(
  layout: LayoutDoc,
  block_id: string,
  action_name: string,
  payload: Record<string, unknown>,
): ActionExecutionResult {
  const component = layout.components.find((c) => c.id === block_id);
  if (!component) {
    throw new ActionRoutingError('UNKNOWN_BLOCK_ID', `Block id "${block_id}" not in layout`);
  }
  const blockDef = getBlock(component.block);
  if (!blockDef) {
    throw new ActionRoutingError('UNKNOWN_BLOCK_TYPE', `Block type "${component.block}" not in catalog`);
  }
  const actionDef = blockDef.actions[action_name];
  if (!actionDef) {
    throw new ActionRoutingError('UNKNOWN_ACTION', `Block "${component.block}" has no action "${action_name}"`);
  }
  const blockState = (layout.state as Record<string, unknown>)[block_id] ?? blockDef.initial_state();
  let outcome: { patches: ReadonlyArray<{ path: string; value: unknown }>; result?: unknown };
  try {
    outcome = actionDef.handler(blockState, payload);
  } catch (e) {
    throw new ActionRoutingError('HANDLER_ERROR', e instanceof Error ? e.message : String(e));
  }
  const out: ActionExecutionResult = {
    block_id,
    block_type: component.block,
    action: action_name,
    sensitivity: actionDef.sensitivity,
    iframe_auto_approve: actionDef.iframe_auto_approve ?? false,
    patches: outcome.patches,
    result: outcome.result,
    ...(actionDef.approval_display_template !== undefined
      ? { approval_display: actionDef.approval_display_template }
      : {}),
  };
  return out;
}

/**
 * Read-only query-Dispatch fuer apps.query Tool.
 */
export function routeQuery(
  layout: LayoutDoc,
  block_id: string,
  query_name: string,
  args: Record<string, unknown>,
): QueryExecutionResult {
  const component = layout.components.find((c) => c.id === block_id);
  if (!component) {
    throw new ActionRoutingError('UNKNOWN_BLOCK_ID', `Block id "${block_id}" not in layout`);
  }
  const blockDef = getBlock(component.block);
  if (!blockDef) {
    throw new ActionRoutingError('UNKNOWN_BLOCK_TYPE', `Block type "${component.block}" not in catalog`);
  }
  const queryDef = blockDef.queries[query_name];
  if (!queryDef) {
    throw new ActionRoutingError('UNKNOWN_QUERY', `Block "${component.block}" has no query "${query_name}"`);
  }
  const blockState = (layout.state as Record<string, unknown>)[block_id] ?? blockDef.initial_state();
  let value: unknown;
  try {
    value = queryDef.compute(blockState, args);
  } catch (e) {
    throw new ActionRoutingError('QUERY_ERROR', e instanceof Error ? e.message : String(e));
  }
  return { block_id, block_type: component.block, query: query_name, value };
}

/**
 * Apply patches into the layout's state-tree. Patches sind block-relativ.
 */
export function applyPatches(
  layout: LayoutDoc,
  block_id: string,
  patches: ReadonlyArray<{ path: string; value: unknown }>,
): LayoutDoc {
  const state: Record<string, unknown> = { ...(layout.state as Record<string, unknown>) };
  const blockSlot = state[block_id];
  let blockState: unknown =
    blockSlot != null && typeof blockSlot === 'object' && !Array.isArray(blockSlot)
      ? { ...(blockSlot as Record<string, unknown>) }
      : blockSlot;
  for (const p of patches) {
    blockState = setAtPath(blockState, p.path, p.value);
  }
  state[block_id] = blockState;
  return { ...layout, state };
}

function setAtPath(root: unknown, path: string, value: unknown): unknown {
  if (path === '/' || path === '') return value;
  if (!path.startsWith('/')) {
    throw new ActionRoutingError('BAD_PATCH_PATH', `Patch path must start with "/" (got "${path}")`);
  }
  const segs = path
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (segs.length === 0) return value;
  if (segs.length === 1) {
    const out: Record<string, unknown> =
      root && typeof root === 'object' && !Array.isArray(root)
        ? { ...(root as Record<string, unknown>) }
        : {};
    if (value === undefined) delete out[segs[0]!];
    else out[segs[0]!] = value;
    return out;
  }
  const head = segs[0]!;
  const restPath = '/' + segs.slice(1).join('/');
  const rootObj: Record<string, unknown> =
    root && typeof root === 'object' && !Array.isArray(root)
      ? { ...(root as Record<string, unknown>) }
      : {};
  rootObj[head] = setAtPath(rootObj[head] ?? (/^\d+$/.test(segs[1]!) ? [] : {}), restPath, value);
  return rootObj;
}
