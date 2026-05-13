/**
 * Renderer fuer text_field block.
 *
 * State: { value: string; placeholder?: string|null; multiline?: boolean; maxLength?: number|null }
 * Action: setValue(value)
 */
import type { BlockRenderer, RenderArgs } from './types.js';
import { el, safeString, safeBool } from './types.js';

interface TextFieldState {
  readonly value?: string;
  readonly placeholder?: string | null;
  readonly multiline?: boolean;
  readonly maxLength?: number | null;
}

export const textFieldRenderer: BlockRenderer<TextFieldState> = {
  type: 'text_field',
  render({ state, onAction }: RenderArgs<TextFieldState>) {
    const value = safeString(state.value, '');
    const placeholder = safeString(state.placeholder ?? undefined, '');
    const multiline = safeBool(state.multiline, false);
    const maxLength =
      typeof state.maxLength === 'number' && state.maxLength > 0 ? state.maxLength : undefined;

    const input = multiline
      ? el('textarea', {
          class: 'block-text-field-input',
          rows: 4,
          placeholder,
          ...(maxLength !== undefined ? { maxlength: maxLength } : {}),
        })
      : el('input', {
          type: 'text',
          class: 'block-text-field-input',
          placeholder,
          ...(maxLength !== undefined ? { maxlength: maxLength } : {}),
        });
    (input as HTMLInputElement | HTMLTextAreaElement).value = value;

    const saveBtn = el('button', {
      type: 'button',
      class: 'btn btn-small',
      text: 'Save',
      onclick: async () => {
        const next = (input as HTMLInputElement | HTMLTextAreaElement).value;
        if (next === value) return;
        saveBtn.disabled = true;
        try {
          await onAction('setValue', { value: next });
        } finally {
          saveBtn.disabled = false;
        }
      },
    });

    return el('div', { class: 'block block-text-field' }, [
      input,
      el('div', { class: 'row block-text-field-actions' }, [saveBtn]),
    ]);
  },
};
