/**
 * A2UI v0.10 Wire-Format-Adapter — wandelt Layout-JSON in A2UI-Messages
 * und A2UI-Action-Envelopes in Block-Invocations.
 *
 * Multi-User-Hinweis: das Adapter-File ist state-frei. Per-User-Scoping
 * passiert auf der API-Schicht — der Adapter sieht nur Layout + Block-Catalog.
 */
import { getBlock } from './blocks/catalog.js';
import type { LayoutDoc } from './blocks/types.js';

export interface A2uiMessage {
  [key: string]: unknown;
}

export interface ActionEnvelope {
  readonly version: 'v0.10';
  readonly action: {
    readonly name: string;
    readonly surfaceId: string;
    readonly sourceComponentId: string;
    readonly timestamp: string;
    readonly context: Record<string, unknown>;
    readonly wantResponse?: boolean;
    readonly actionId?: string;
  };
}

export interface BlockInvocation {
  readonly block_id: string;
  readonly action: string;
  readonly payload: Record<string, unknown>;
  readonly actionId: string;
  readonly wantResponse: boolean;
}

/**
 * Initial-Sequenz fuer's iframe-Setup.
 */
export function layoutToA2uiInitMessages(layout: LayoutDoc, surfaceId: string): A2uiMessage[] {
  const sendDataModel = layout.meta?.sendDataModel ?? false;
  return [
    { createSurface: { surfaceId, sendDataModel } },
    { updateDataModel: { surfaceId, path: '/', value: layout.state } },
    {
      updateComponents: {
        surfaceId,
        components: layout.components.map((c) => {
          const def = getBlock(c.block);
          return {
            id: c.id,
            component: def?.a2ui_component ?? c.block,
            ...(c.config ?? {}),
          };
        }),
      },
    },
  ];
}

/**
 * Patches → updateDataModel-Messages. Pro Patch eine Message.
 */
export function patchesToA2uiMessages(
  surfaceId: string,
  blockId: string,
  patches: ReadonlyArray<{ path: string; value: unknown }>,
): A2uiMessage[] {
  return patches.map((p) => ({
    updateDataModel: {
      surfaceId,
      path: `/${blockId}${p.path === '/' ? '' : p.path}`,
      value: p.value,
    },
  }));
}

export function buildActionResponse(
  actionId: string,
  outcome: { value?: unknown; error?: { code: string; message: string } },
): A2uiMessage {
  return {
    actionResponse: {
      actionId,
      ...(outcome.error ? { error: outcome.error } : { value: outcome.value }),
    },
    version: 'v0.10',
  };
}

export function envelopeToBlockInvocation(envelope: ActionEnvelope): BlockInvocation | null {
  if (!envelope || !envelope.action) return null;
  const a = envelope.action;
  if (typeof a.name !== 'string' || a.name.length === 0) return null;
  if (typeof a.sourceComponentId !== 'string' || a.sourceComponentId.length === 0) return null;
  if (typeof a.actionId !== 'string' || a.actionId.length === 0) return null;
  return {
    block_id: a.sourceComponentId,
    action: a.name,
    payload: a.context ?? {},
    actionId: a.actionId,
    wantResponse: Boolean(a.wantResponse),
  };
}
