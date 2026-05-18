/**
 * Admin → Groups Sub-Tab (Phase 1 sharing, Item 6f).
 *
 * Route: #/admin/groups
 * Auth: Cookie-Session (jeder eingeloggter User kann seine Groups managen —
 *   nicht admin-only, weil Group-Ownership eine User-Operation ist, kein
 *   Plattform-Admin. Aber UI lebt unter #/admin weil Group-Management
 *   eine Verwaltungs-Aktion ist).
 *
 * Funktionen (Phase 1, minimal):
 *   - Liste meiner Groups (Owner-of + Member-of)
 *   - "Neue Gruppe"-Button + Modal
 *   - Group-Detail-View: Members + Add/Remove
 *
 * UX-Decisions (Test-Plan-Review §5 + PLAN §9):
 *   - Member-Add zeigt explizit den Impact-Hinweis: "X kann ab dann alle
 *     Gruppen-Inhalte lesen". Nicht 'danger' (overkill PRF-Eval), aber UI-Warn.
 *   - Member-Remove zeigt Rotation-Hinweis: "Master-Key wird rotiert. X kann
 *     bereits gelesene Inhalte nicht zurückgerufen werden."
 */
import type { Session } from './api.js';
import { showToast } from './components/toast.js';
import {
  createGroupsApi,
  type Group,
  type GroupMember,
} from './api-groups.js';

const groupsApi = createGroupsApi();

function fmtDate(raw: number | string | null | undefined): string {
  if (raw === null || raw === undefined || raw === '' || raw === 0) return '—';
  const ms = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  try {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  } catch {
    return '—';
  }
}

export async function renderAdminGroupsSub(
  container: HTMLElement,
  session: Session,
): Promise<void> {
  container.innerHTML = '';

  const intro = document.createElement('p');
  intro.className = 'admin-section-intro';
  intro.textContent =
    'Verwalte Sharing-Gruppen. Du siehst Gruppen, die du besitzt oder in denen du Mitglied bist.';
  container.appendChild(intro);

  const newGroupRow = document.createElement('div');
  newGroupRow.className = 'admin-actions';
  const newGroupBtn = document.createElement('button');
  newGroupBtn.className = 'btn primary';
  newGroupBtn.textContent = '+ Neue Gruppe';
  newGroupBtn.onclick = () => {
    void openCreateGroupModal(container, session, () => void refresh());
  };
  newGroupRow.appendChild(newGroupBtn);
  container.appendChild(newGroupRow);

  // P2-5: "Shared with me"-Section (Inbound-Shares).
  const sharedWithMeSection = document.createElement('div');
  sharedWithMeSection.className = 'shared-with-me-section';
  sharedWithMeSection.innerHTML = `
    <details class="shared-with-me-details">
      <summary><strong>📥 Mit mir geteilt</strong> <span class="shared-with-me-count"></span></summary>
      <div class="shared-with-me-list"><p class="loading">Lade…</p></div>
    </details>
  `;
  container.appendChild(sharedWithMeSection);
  void loadSharedWithMe(sharedWithMeSection);

  const listHeader = document.createElement('h3');
  listHeader.className = 'groups-list-header';
  listHeader.textContent = 'Meine Gruppen';
  container.appendChild(listHeader);

  const listEl = document.createElement('div');
  listEl.className = 'groups-list';
  container.appendChild(listEl);

  async function refresh(): Promise<void> {
    listEl.innerHTML = '<p class="loading">Lade…</p>';
    try {
      const items = await groupsApi.list();
      renderList(items);
    } catch (err) {
      listEl.innerHTML = `<div class="card err"><strong>Fehler beim Laden:</strong> ${escape((err as Error).message)}</div>`;
    }
  }

  function renderList(items: ReadonlyArray<Group>): void {
    listEl.innerHTML = '';
    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Noch keine Gruppen. Lege oben eine neue Gruppe an.';
      listEl.appendChild(empty);
      return;
    }
    for (const g of items) {
      const isOwner = g.ownerId === session.userId;
      const card = document.createElement('div');
      card.className = 'card group-card';
      card.innerHTML = `
        <div class="group-card-head">
          <span class="group-name">${escape(g.name)}</span>
          <span class="group-role">${isOwner ? '👑 Owner' : '👤 Member'}</span>
        </div>
        <div class="group-card-meta">
          <span>angelegt: ${fmtDate(g.createdAt)}</span>
          ${g.readAuditEnabled ? '<span class="badge">Read-Audit aktiv</span>' : ''}
          ${g.archivedAt ? '<span class="badge warn">archiviert</span>' : ''}
        </div>
        ${g.description ? `<p class="group-desc">${escape(g.description)}</p>` : ''}
      `;
      card.onclick = () => {
        void openGroupDetail(container, session, g, () => void refresh());
      };
      listEl.appendChild(card);
    }
  }

  await refresh();
}

async function openCreateGroupModal(
  parent: HTMLElement,
  _session: Session,
  onDone: () => void,
): Promise<void> {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal">
      <h2>Neue Gruppe</h2>
      <form class="modal-form">
        <label>Name<input type="text" name="name" required maxlength="200" /></label>
        <label>Beschreibung (optional)<textarea name="description" maxlength="2000" rows="3"></textarea></label>
        <label class="checkbox">
          <input type="checkbox" name="read_audit_enabled" />
          Read-Audit aktivieren (Mitglieder sehen, wer was wann gelesen hat)
        </label>
        <div class="modal-actions">
          <button type="button" class="btn ghost" data-action="cancel">Abbrechen</button>
          <button type="submit" class="btn primary">Anlegen</button>
        </div>
      </form>
    </div>
  `;
  parent.appendChild(modal);
  const close = () => {
    modal.remove();
  };
  modal.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.onclick = close;
  const form = modal.querySelector<HTMLFormElement>('.modal-form')!;
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const data = new FormData(form);
    const name = String(data.get('name') ?? '').trim();
    if (!name) {
      showToast('Name darf nicht leer sein', 'error');
      return;
    }
    try {
      const description = String(data.get('description') ?? '').trim();
      await groupsApi.create({
        name,
        ...(description ? { description } : {}),
        readAuditEnabled: data.get('read_audit_enabled') === 'on',
      });
      showToast(`Gruppe "${name}" angelegt`, 'success');
      close();
      onDone();
    } catch (err) {
      showToast(`Fehler: ${(err as Error).message}`, 'error');
    }
  };
}

async function loadSharedWithMe(section: HTMLElement): Promise<void> {
  const listEl = section.querySelector<HTMLElement>('.shared-with-me-list');
  const countEl = section.querySelector<HTMLElement>('.shared-with-me-count');
  if (!listEl || !countEl) return;
  try {
    const items = await groupsApi.listSharedWithMe();
    countEl.textContent = `(${items.length})`;
    if (items.length === 0) {
      listEl.innerHTML = '<p class="empty">Niemand hat dir Inhalte direkt geteilt.</p>';
      return;
    }
    listEl.innerHTML = '';
    const ul = document.createElement('ul');
    ul.className = 'shared-with-me-ul';
    for (const s of items) {
      const li = document.createElement('li');
      const via = s.grantedToGroupId
        ? `via Group <code>${escape(s.grantedToGroupId.slice(0, 8))}…</code>`
        : 'direkt';
      const scope = s.scope === 'write' ? '✏️ write' : '👁 read';
      li.innerHTML = `
        <a href="#/storage/${escape(s.resourceId)}" class="shared-with-me-link">
          ${escape(s.resourceId.slice(0, 8))}…
        </a>
        <span class="shared-with-me-meta">${scope} · ${via} · von ${escape(s.grantedBy.slice(0, 8))}…</span>
      `;
      ul.appendChild(li);
    }
    listEl.appendChild(ul);
  } catch (err) {
    listEl.innerHTML = `<div class="card err">${escape((err as Error).message)}</div>`;
  }
}

// Cascade-Preview-Helper, in Use bei spaeteren share-skill-modal-Surfaces.
// API-Surface bereits in api-groups.ts.cascadePreview(skillId).
export async function cascadePreviewLabel(objectId: string): Promise<string> {
  try {
    const r = await groupsApi.cascadePreview(objectId);
    if (r.cascadedCount === 0) return 'Kein Cascade — nur dieses Objekt.';
    return r.truncated
      ? `Cascade: ${r.cascadedCount}+ verknüpfte Dokumente`
      : `Cascade: ${r.cascadedCount} verknüpfte Dokumente`;
  } catch {
    return 'Cascade-Preview nicht verfügbar';
  }
}

async function openGroupDetail(
  parent: HTMLElement,
  session: Session,
  group: Group,
  onDone: () => void,
): Promise<void> {
  const isOwner = group.ownerId === session.userId;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal modal-wide">
      <h2>${escape(group.name)} <span class="group-role">${isOwner ? '👑 Owner' : '👤 Member'}</span></h2>
      ${group.description ? `<p class="group-desc">${escape(group.description)}</p>` : ''}
      <div class="group-detail-section">
        <h3>Mitglieder</h3>
        <div class="members-list"><p class="loading">Lade…</p></div>
        ${isOwner ? '<div class="add-member-row"><input type="text" placeholder="User-ID (UUID)" class="member-userid" /><select class="member-role"><option value="member">Member</option><option value="admin">Admin</option></select><button class="btn primary add-member-btn">+ Hinzufügen</button></div>' : ''}
        ${isOwner ? '<p class="warn-text">⚠ Mitglieder können nach dem Hinzufügen ALLE in der Gruppe geteilten Inhalte lesen. Das ist umkehrbar (Master-Key rotiert), aber bereits gelesene Inhalte können nicht zurückgerufen werden.</p>' : ''}
      </div>
      ${isOwner && !group.archivedAt ? '<div class="group-detail-section danger-zone"><h3>Gefahrenzone</h3><button class="btn danger transfer-btn">Eigentümer-Transfer</button><button class="btn danger archive-btn">Gruppe archivieren</button></div>' : ''}
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-action="close">Schließen</button>
      </div>
    </div>
  `;
  parent.appendChild(modal);
  const close = () => {
    modal.remove();
  };
  modal.querySelector<HTMLButtonElement>('[data-action="close"]')!.onclick = close;

  const membersEl = modal.querySelector<HTMLElement>('.members-list')!;

  async function refreshMembers(): Promise<void> {
    membersEl.innerHTML = '<p class="loading">Lade…</p>';
    try {
      const data = await groupsApi.get(group.id);
      renderMembers(data.members);
    } catch (err) {
      membersEl.innerHTML = `<div class="card err">${escape((err as Error).message)}</div>`;
    }
  }

  function renderMembers(members: ReadonlyArray<GroupMember>): void {
    membersEl.innerHTML = '';
    const active = members.filter((m) => !m.removedAt);
    const removed = members.filter((m) => m.removedAt);
    if (active.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Keine aktiven Mitglieder.';
      membersEl.appendChild(empty);
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'members-ul';
    for (const m of active) {
      const li = document.createElement('li');
      const isSelf = m.userId === session.userId;
      li.innerHTML = `
        <span class="member-id">${escape(m.userId)}</span>
        <span class="member-role-tag">${m.role}</span>
        ${isOwner && !isSelf ? '<button class="btn small danger remove-member-btn" data-user-id="' + escape(m.userId) + '">Entfernen</button>' : ''}
        ${isSelf ? '<span class="badge">du</span>' : ''}
      `;
      ul.appendChild(li);
    }
    membersEl.appendChild(ul);

    if (removed.length > 0) {
      const details = document.createElement('details');
      details.className = 'removed-members';
      details.innerHTML = `<summary>${removed.length} entfernte Mitglieder anzeigen</summary>`;
      const ul2 = document.createElement('ul');
      for (const m of removed) {
        const li = document.createElement('li');
        li.className = 'removed';
        li.innerHTML = `<span class="member-id">${escape(m.userId)}</span><span>entfernt: ${fmtDate(m.removedAt)}</span>`;
        ul2.appendChild(li);
      }
      details.appendChild(ul2);
      membersEl.appendChild(details);
    }

    // Wire remove-buttons
    membersEl.querySelectorAll<HTMLButtonElement>('.remove-member-btn').forEach((btn) => {
      btn.onclick = async () => {
        const userId = btn.dataset['userId'] ?? '';
        if (!confirm(`Mitglied ${userId} entfernen?\n\nDer Master-Key wird rotiert. Bereits gelesene Inhalte können nicht zurückgerufen werden.`)) {
          return;
        }
        try {
          await groupsApi.removeMember(group.id, userId);
          showToast('Mitglied entfernt + Master-Key rotiert', 'success');
          await refreshMembers();
        } catch (err) {
          showToast(`Fehler: ${(err as Error).message}`, 'error');
        }
      };
    });
  }

  if (isOwner) {
    const addBtn = modal.querySelector<HTMLButtonElement>('.add-member-btn');
    addBtn!.onclick = async () => {
      const userIdInput = modal.querySelector<HTMLInputElement>('.member-userid')!;
      const roleSelect = modal.querySelector<HTMLSelectElement>('.member-role')!;
      const userId = userIdInput.value.trim();
      if (!userId) {
        showToast('User-ID darf nicht leer sein', 'error');
        return;
      }
      try {
        await groupsApi.addMember({
          groupId: group.id,
          userId,
          role: roleSelect.value as 'admin' | 'member',
        });
        showToast(`Mitglied ${userId} hinzugefügt`, 'success');
        userIdInput.value = '';
        await refreshMembers();
      } catch (err) {
        showToast(`Fehler: ${(err as Error).message}`, 'error');
      }
    };

    const archiveBtn = modal.querySelector<HTMLButtonElement>('.archive-btn');
    if (archiveBtn) {
      archiveBtn.onclick = async () => {
        if (!confirm(`Gruppe "${group.name}" archivieren? Mitglieder verlieren ab jetzt den Zugriff. Diese Aktion kann nicht rückgängig gemacht werden.`)) {
          return;
        }
        try {
          await groupsApi.archive(group.id);
          showToast('Gruppe archiviert', 'success');
          close();
          onDone();
        } catch (err) {
          showToast(`Fehler: ${(err as Error).message}`, 'error');
        }
      };
    }

    // P2-4: Eigentümer-Transfer
    const transferBtn = modal.querySelector<HTMLButtonElement>('.transfer-btn');
    if (transferBtn) {
      transferBtn.onclick = () => {
        const newOwnerUserId = prompt(
          `Eigentümer von "${group.name}" auf welchen User übertragen?\n\n` +
            `Hinweis: Der neue Owner MUSS bereits aktives Mitglied dieser Gruppe sein.\n` +
            `Du behältst Admin-Status, verlierst aber Owner-Privilegien (Mitglieder hinzu/entfernen, archivieren).\n\n` +
            `Gib die User-ID (UUID) ein:`,
          '',
        );
        if (!newOwnerUserId || newOwnerUserId.trim() === '') return;
        const target = newOwnerUserId.trim();
        if (
          !confirm(
            `Wirklich Eigentümer auf ${target} übertragen?\n\nDiese Aktion ist nur durch den neuen Owner rücktransferierbar.`,
          )
        ) {
          return;
        }
        void (async () => {
          try {
            await groupsApi.transferOwnership(group.id, target);
            showToast(`Eigentum auf ${target.slice(0, 8)}… übertragen`, 'success');
            close();
            onDone();
          } catch (err) {
            showToast(`Fehler: ${(err as Error).message}`, 'error');
          }
        })();
      };
    }
  }

  await refreshMembers();
}

function escape(s: string): string {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}
