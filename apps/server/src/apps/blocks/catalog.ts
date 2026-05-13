/**
 * Block-Catalog Registry — in-process Map keyed by block-type.
 *
 * Bloecke registrieren sich via registerBlock() beim Worker-Boot. Pattern
 * 1:1 vom alten mcp-approval portiert; idempotent fuer Test-Isolation.
 */

import type { BlockDef } from './types.js';

const BLOCKS = new Map<string, BlockDef>();

export function registerBlock<S>(def: BlockDef<S>): void {
  if (BLOCKS.has(def.type)) {
    throw new Error(`Block type "${def.type}" already registered — duplicate import?`);
  }
  if (!def.type || typeof def.type !== 'string') {
    throw new Error('Block type must be a non-empty string');
  }
  if (!def.state_schema || typeof def.state_schema !== 'object') {
    throw new Error(`Block "${def.type}": state_schema must be an object`);
  }
  if (typeof def.initial_state !== 'function') {
    throw new Error(`Block "${def.type}": initial_state must be a function`);
  }
  if (!def.actions || typeof def.actions !== 'object') {
    throw new Error(`Block "${def.type}": actions must be an object (can be empty)`);
  }
  if (!def.queries || typeof def.queries !== 'object') {
    throw new Error(`Block "${def.type}": queries must be an object (can be empty)`);
  }
  if (!def.a2ui_component || typeof def.a2ui_component !== 'string') {
    throw new Error(`Block "${def.type}": a2ui_component must be a non-empty string`);
  }
  BLOCKS.set(def.type, def as BlockDef);
}

export function getBlock(type: string): BlockDef | undefined {
  return BLOCKS.get(type);
}

export function listBlocks(): ReadonlyArray<BlockDef> {
  return [...BLOCKS.values()].sort((a, b) => a.type.localeCompare(b.type));
}

export function isBlockType(type: string): boolean {
  return BLOCKS.has(type);
}

/**
 * Test-only: clear the catalog. Used by vitest to reset between tests
 * since registerBlock is idempotency-strict (throws on duplicate).
 */
export function _resetCatalogForTesting(): void {
  BLOCKS.clear();
}
