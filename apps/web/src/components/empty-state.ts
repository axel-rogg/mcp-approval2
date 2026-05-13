/**
 * Reusable empty-state component.
 *
 * Used by approval-list, credentials-list, and other render paths that need
 * to show a "nothing here yet" message with an optional CTA.
 */

export interface EmptyStateOptions {
  readonly title: string;
  readonly body: string;
  readonly actionLabel?: string;
  readonly actionHref?: string;
  readonly onAction?: () => void;
}

export function renderEmptyState(opts: EmptyStateOptions): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card empty-state';

  const h = document.createElement('h3');
  h.textContent = opts.title;
  card.appendChild(h);

  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = opts.body;
  card.appendChild(p);

  if (opts.actionLabel) {
    if (opts.actionHref) {
      const a = document.createElement('a');
      a.className = 'btn';
      a.href = opts.actionHref;
      a.textContent = opts.actionLabel;
      card.appendChild(a);
    } else if (opts.onAction) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = opts.actionLabel;
      btn.addEventListener('click', opts.onAction);
      card.appendChild(btn);
    }
  }

  return card;
}
