/**
 * Renderer fuer reminder block.
 *
 * State: { entries: ReminderEntry[] }
 * Actions: addEntry(cron, message, channels?), updateEntry, removeEntry, setEnabled, markFired
 */
import type { BlockRenderer, RenderArgs } from './types.js';
import { el, safeArray, safeString, safeBool } from './types.js';

interface ReminderEntry {
  readonly id: string;
  readonly cron: string;
  readonly message: string;
  readonly enabled: boolean;
  readonly last_fired?: number | null;
  readonly channels?: string[];
}

interface ReminderState {
  readonly entries?: ReminderEntry[];
}

function fmtAge(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export const reminderRenderer: BlockRenderer<ReminderState> = {
  type: 'reminder',
  render({ state, onAction }: RenderArgs<ReminderState>) {
    const entries = safeArray<ReminderEntry>(state.entries);

    async function dispatch(action: string, payload?: Record<string, unknown>): Promise<void> {
      try {
        await onAction(action, payload);
      } catch (e) {
        console.error('reminder dispatch', action, e);
      }
    }

    // time-picker → cron generator (single daily reminder; user can paste full
    // cron-expression in the cron input field if they want more)
    const timeInput = el('input', {
      type: 'time',
      class: 'block-reminder-time',
      value: '09:00',
    }) as HTMLInputElement;
    const cronInput = el('input', {
      type: 'text',
      class: 'block-reminder-cron',
      placeholder: 'or cron: 0 9 * * *',
      maxlength: 64,
    }) as HTMLInputElement;
    const msgInput = el('input', {
      type: 'text',
      class: 'block-reminder-msg',
      placeholder: 'Message',
      maxlength: 200,
    }) as HTMLInputElement;

    async function addEntry(): Promise<void> {
      const msg = msgInput.value.trim();
      if (!msg) return;
      let cron = cronInput.value.trim();
      if (!cron) {
        const t = timeInput.value || '09:00';
        const [hStr, mStr] = t.split(':');
        const h = parseInt(hStr ?? '9', 10);
        const m = parseInt(mStr ?? '0', 10);
        cron = `${m} ${h} * * *`;
      }
      msgInput.value = '';
      cronInput.value = '';
      await dispatch('addEntry', { cron, message: msg });
    }

    const addBtn = el('button', {
      type: 'button',
      class: 'btn btn-small',
      text: 'Add',
      onclick: () => void addEntry(),
    });

    const ul = el('ul', { class: 'block-reminder-entries' });
    for (const e of entries) {
      const toggle = el('input', {
        type: 'checkbox',
        onchange: () =>
          void dispatch('setEnabled', { id: e.id, enabled: !safeBool(e.enabled, true) }),
      }) as HTMLInputElement;
      toggle.checked = safeBool(e.enabled, true);

      ul.appendChild(
        el('li', { class: 'block-reminder-entry' }, [
          toggle,
          el('div', { class: 'block-reminder-entry-main' }, [
            el('div', { class: 'block-reminder-entry-msg', text: safeString(e.message, '') }),
            el('div', {
              class: 'muted small',
              text: `${safeString(e.cron, '')} · last: ${fmtAge(e.last_fired ?? null)}`,
            }),
          ]),
          el('button', {
            type: 'button',
            class: 'btn btn-secondary btn-small',
            text: '×',
            onclick: () => void dispatch('removeEntry', { id: e.id }),
          }),
        ]),
      );
    }

    return el('div', { class: 'block block-reminder' }, [
      el('div', { class: 'row block-reminder-add' }, [timeInput, cronInput, msgInput, addBtn]),
      entries.length === 0 ? el('p', { class: 'muted small', text: 'No reminders.' }) : ul,
    ]);
  },
};
