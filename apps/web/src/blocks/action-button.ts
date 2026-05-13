/**
 * Renderer fuer action_button block.
 *
 * State: { label: string; kind: 'primary'|'secondary'|'danger'; payload: object }
 * Action: trigger (mit payload)
 */
import type { BlockRenderer, RenderArgs } from './types.js';
import { el, safeString } from './types.js';

interface ActionButtonState {
  readonly label?: string;
  readonly kind?: string;
  readonly payload?: Record<string, unknown>;
}

export const actionButtonRenderer: BlockRenderer<ActionButtonState> = {
  type: 'action_button',
  render({ state, onAction }: RenderArgs<ActionButtonState>) {
    const label = safeString(state.label, 'Trigger');
    const kind = safeString(state.kind, 'primary');
    const cls =
      kind === 'danger'
        ? 'btn btn-danger'
        : kind === 'secondary'
          ? 'btn btn-secondary'
          : 'btn';

    const btn = el('button', {
      type: 'button',
      class: cls,
      text: label,
      onclick: async () => {
        const prev = btn.textContent;
        btn.disabled = true;
        btn.textContent = '…';
        try {
          await onAction('trigger', state.payload ?? {});
        } finally {
          btn.disabled = false;
          btn.textContent = prev ?? label;
        }
      },
    });

    return el('div', { class: 'block block-action-button' }, [btn]);
  },
};
