/**
 * App-Type-Registry — derzeit nur `composable` (Block-Catalog-getrieben).
 *
 * Multi-User: app-types sind global shared. Schema-Versionierung via
 * `current_schema_version` ist user-agnostic. Migration on-read passiert in
 * `AppsService.readApp()`.
 */
import { bootBlockCatalog, getBlock, listBlocks } from './blocks/index.js';
import type { LayoutDoc } from './blocks/types.js';

export interface AppTypeDef<TState = unknown> {
  readonly type: string;
  readonly title_default: string;
  readonly pin_on_create: boolean;
  readonly single_instance: boolean;
  readonly current_schema_version: number;
  validate(state: unknown): { valid: boolean; errors?: string };
  initial_state(): TState;
  migrate(state: unknown, fromVersion: number): TState;
  state_schema(): {
    type: 'object';
    title: string;
    properties: Record<string, unknown>;
    required: string[];
    examples?: unknown[];
  };
}

function validateLayoutDoc(state: unknown): { valid: boolean; errors?: string } {
  // Side-effect: ensure blocks are registered.
  bootBlockCatalog();
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { valid: false, errors: 'state must be a LayoutDoc object' };
  }
  const layout = state as LayoutDoc;
  if (layout.version !== 'v0.10') {
    return { valid: false, errors: `LayoutDoc.version must be "v0.10" (got "${layout.version}")` };
  }
  if (!Array.isArray(layout.components)) {
    return { valid: false, errors: 'LayoutDoc.components must be array' };
  }
  if (layout.components.length > 100) {
    return { valid: false, errors: 'LayoutDoc.components max 100 entries' };
  }
  const seen = new Set<string>();
  for (let i = 0; i < layout.components.length; i++) {
    const c = layout.components[i]!;
    if (!c || typeof c !== 'object') {
      return { valid: false, errors: `components[${i}] must be object` };
    }
    if (typeof c.id !== 'string' || c.id.length === 0 || c.id.length > 64) {
      return { valid: false, errors: `components[${i}].id must be 1..64 chars` };
    }
    if (seen.has(c.id)) {
      return { valid: false, errors: `components[${i}].id "${c.id}" duplicated` };
    }
    seen.add(c.id);
    if (typeof c.block !== 'string' || c.block.length === 0) {
      return { valid: false, errors: `components[${i}].block missing` };
    }
    if (!getBlock(c.block)) {
      return {
        valid: false,
        errors: `components[${i}].block "${c.block}" not in registered Block-Catalog (available: ${listBlocks().map((b) => b.type).join(', ')})`,
      };
    }
  }
  if (layout.state == null || typeof layout.state !== 'object' || Array.isArray(layout.state)) {
    return { valid: false, errors: 'LayoutDoc.state must be object' };
  }
  // Per-Block state slot light-validation.
  for (const c of layout.components) {
    const blockDef = getBlock(c.block);
    if (!blockDef || !blockDef.validate) continue;
    const slot = (layout.state as Record<string, unknown>)[c.id];
    if (slot == null) continue;
    try {
      blockDef.validate(slot);
    } catch (e) {
      return {
        valid: false,
        errors: `state.${c.id} (block=${c.block}): ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
  return { valid: true };
}

export const composableType: AppTypeDef<LayoutDoc> = {
  type: 'composable',
  title_default: 'Composable App',
  pin_on_create: false,
  single_instance: false,
  current_schema_version: 1,
  validate: validateLayoutDoc,
  initial_state: () => ({ version: 'v0.10', components: [], state: {} }),
  migrate: (state, _fromVersion) => state as LayoutDoc,
  state_schema: () => ({
    type: 'object',
    title: 'Composable App LayoutDoc',
    properties: {
      version: { type: 'string', const: 'v0.10' },
      components: {
        type: 'array',
        maxItems: 100,
        items: {
          type: 'object',
          required: ['id', 'block'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 64 },
            block: { type: 'string', description: 'Block-Type aus apps.blocks.catalog' },
            config: { type: 'object' },
          },
        },
      },
      state: { type: 'object' },
      meta: { type: 'object' },
    },
    required: ['version', 'components', 'state'],
  }),
};

const APP_TYPES: Record<string, AppTypeDef> = {
  [composableType.type]: composableType,
};

export function getAppType(type: string): AppTypeDef | undefined {
  return APP_TYPES[type];
}

export function listAppTypes(): AppTypeDef[] {
  return Object.values(APP_TYPES);
}
