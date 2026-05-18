/**
 * Share-With-Group-Modal (P2-5 final UI).
 *
 * Aufgerufen vom Storage-Detail-View ueber den Share-Icon-Button. Loaded:
 *   - Group-Dropdown via groupsApi.list() (eigene + mitgliedschaft-Groups)
 *   - Cascade-Preview via groupsApi.cascadePreview() — zeigt wie viele
 *     verknuepfte Dokumente bei einem Skill mitgeteilt werden
 *   - Scope-Toggle (read/write, write = Co-Edit aktiv ab P2-3)
 *
 * Submit triggert ein Approval-pflichtiges write-Tool (skills.share_with_group
 * fuer subtype='skill_manifest', sonst docs.share_with_group). Approval-Inbox
 * zeigt das im Write-Mode automatisch-Bypass oder explicit-Approve-Pfad.
 */
import { createGroupsApi, type Group } from './api-groups.js';
import type { KnowledgeObject } from './api-storage.js';
import { showToast } from './components/toast.js';

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

export async function openShareWithGroupModal(obj: KnowledgeObject): Promise<void> {
  const api = createGroupsApi();
  const isSkill = obj.subtype === 'skill_manifest';

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal modal-share">
      <h2>${isSkill ? '🧠 Skill' : '📘 Dokument'} mit Gruppe teilen</h2>
      <p class="share-modal-target">
        <strong>${escape(obj.title ?? obj.filename ?? obj.id)}</strong>
        <code class="share-modal-id">${escape(obj.id.slice(0, 8))}…</code>
      </p>
      <div class="share-modal-section">
        <label class="share-modal-label">Gruppe</label>
        <select class="share-modal-group" disabled>
          <option>Lade…</option>
        </select>
      </div>
      <div class="share-modal-section">
        <label class="share-modal-label">Berechtigung</label>
        <div class="share-modal-scope">
          <label><input type="radio" name="scope" value="read" checked> 👁 Read (nur Lesen)</label>
          <label><input type="radio" name="scope" value="write"> ✏️ Write (Co-Edit)</label>
        </div>
      </div>
      ${
        isSkill
          ? `<div class="share-modal-section share-modal-cascade">
              <label class="share-modal-label">Cascade-Preview</label>
              <p class="share-modal-cascade-info">Lade…</p>
            </div>`
          : ''
      }
      <div class="share-modal-warning">
        ⚠ Empfaenger koennen den Inhalt sofort lesen.
        Beim Entfernen aus der Gruppe rotiert der Master-Key,
        aber bereits gelesener Inhalt kann nicht zurueckgerufen werden.
      </div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-action="cancel">Abbrechen</button>
        <button type="button" class="btn primary" data-action="submit" disabled>Teilen</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.onclick = close;
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });

  const submitBtn = modal.querySelector<HTMLButtonElement>('[data-action="submit"]')!;
  const groupSelect = modal.querySelector<HTMLSelectElement>('.share-modal-group')!;
  const cascadeEl = modal.querySelector<HTMLElement>('.share-modal-cascade-info');

  // Load groups
  try {
    const groups = await api.list();
    if (groups.length === 0) {
      groupSelect.innerHTML =
        '<option value="">Keine Gruppen — leg erst eine unter #/admin/groups an.</option>';
      submitBtn.disabled = true;
      return;
    }
    groupSelect.innerHTML = '';
    for (const g of groups) {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = `${g.name}${g.archivedAt ? ' (archiviert)' : ''}`;
      if (g.archivedAt) opt.disabled = true;
      groupSelect.appendChild(opt);
    }
    groupSelect.disabled = false;
    submitBtn.disabled = false;
  } catch (err) {
    groupSelect.innerHTML = `<option>${escape((err as Error).message)}</option>`;
    submitBtn.disabled = true;
    return;
  }

  // Cascade-Preview (nur Skills)
  if (isSkill && cascadeEl) {
    try {
      const preview = await api.cascadePreview(obj.id);
      if (preview.cascadedCount === 0) {
        cascadeEl.textContent = 'Kein Cascade — nur dieses Skill.';
      } else {
        cascadeEl.textContent = preview.truncated
          ? `📎 ${preview.cascadedCount}+ verknuepfte Dokumente werden ebenfalls geteilt`
          : `📎 ${preview.cascadedCount} verknuepfte Dokumente werden ebenfalls geteilt`;
      }
    } catch {
      cascadeEl.textContent = 'Cascade-Preview nicht verfuegbar';
    }
  }

  // Submit handler
  submitBtn.onclick = async () => {
    const groupId = groupSelect.value;
    const scopeInput = modal.querySelector<HTMLInputElement>(
      'input[name="scope"]:checked',
    );
    const scope = (scopeInput?.value as 'read' | 'write') ?? 'read';
    if (!groupId) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Teile…';
    try {
      await api.shareWithGroup({
        resourceId: obj.id,
        groupId,
        scope,
      });
      const group = Array.from(groupSelect.options).find((o) => o.value === groupId);
      showToast(
        `Mit Gruppe "${group?.textContent ?? groupId.slice(0, 8)}" geteilt (${scope === 'write' ? 'Co-Edit' : 'read-only'})`,
        'success',
      );
      close();
    } catch (err) {
      showToast(`Fehler: ${(err as Error).message}`, 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Teilen';
    }
  };
}

// Re-export Group type fuer Caller (defensive — sollten Caller nicht
// explizit brauchen, aber falls jemand eine Pre-Filter-Liste machen will).
export type { Group };
