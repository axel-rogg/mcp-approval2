/**
 * API-Client fuer das Groups-Sub-Tab (Phase 1 sharing, Item 6f).
 *
 * Routes: /admin/kc-proxy/v1/groups/* (proxied an KC2 mit OBO-JWT).
 * Auth: Cookie-Session (PWA same-origin).
 */
type DbBigInt = number | string | null;

function baseUrl(): string {
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8787';
}

export interface Group {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly description: string | null;
  readonly masterVersion: number;
  readonly readAuditEnabled: boolean;
  readonly cascadeOnShareDefault: boolean;
  readonly createdAt: DbBigInt;
  readonly archivedAt: DbBigInt;
}

export interface GroupMember {
  readonly groupId: string;
  readonly userId: string;
  readonly role: 'admin' | 'member';
  readonly joinedAt: DbBigInt;
  readonly removedAt: DbBigInt;
}

export interface CreateGroupInput {
  readonly name: string;
  readonly description?: string;
  readonly readAuditEnabled?: boolean;
}

export interface AddMemberInput {
  readonly groupId: string;
  readonly userId: string;
  readonly role?: 'admin' | 'member';
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; detail?: string };
      detail = parsed.error?.message ?? parsed.detail ?? detail;
    } catch {
      /* keep raw */
    }
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  if (res.status === 204) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

export interface GroupShare {
  readonly id: string;
  readonly resourceId: string;
  readonly grantedBy: string;
  readonly grantedTo: string | null;
  readonly grantedToGroupId?: string;
  readonly scope: 'read' | 'write';
  readonly grantedAt: number;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
  readonly viaCascadeFromObjectId?: string | null;
}

export interface ShareWithGroupInput {
  readonly resourceId: string;
  readonly groupId: string;
  readonly scope?: 'read' | 'write';
  readonly expiresAt?: number | null;
}

export interface CascadePreview {
  /** Anzahl outgoing-resource-refs vom Object, oder -1 wenn unbekannt. */
  readonly cascadedCount: number;
  /** True wenn KC2-Default-refsLimit erreicht ist; tatsaechliche Zahl koennte hoeher sein. */
  readonly truncated: boolean;
}

export interface GroupsApi {
  list(): Promise<ReadonlyArray<Group>>;
  get(groupId: string): Promise<{ group: Group; members: ReadonlyArray<GroupMember> }>;
  create(input: CreateGroupInput): Promise<Group>;
  archive(groupId: string): Promise<void>;
  addMember(input: AddMemberInput): Promise<GroupMember>;
  removeMember(groupId: string, userId: string): Promise<void>;
  setReadAudit(groupId: string, enabled: boolean): Promise<void>;
  /** P2-4: Owner-Transfer (danger). */
  transferOwnership(groupId: string, newOwnerUserId: string): Promise<void>;
  /** P2-3: Object mit Group teilen (read|write). */
  shareWithGroup(input: ShareWithGroupInput): Promise<GroupShare>;
  /** P2-1: Revoke einen Share-Grant. */
  revokeShare(shareId: string): Promise<void>;
  /** P2-1/P2-5: "Shared with me"-Inbound-View. */
  listSharedWithMe(): Promise<ReadonlyArray<GroupShare>>;
  /**
   * P2-5: Cascade-Preview — wie viele Resources werden mitgeteilt wenn man
   * dieses Object (typisch Skill) mit einer Group teilt?
   *
   * Implementiert ueber existierendes /v1/objects/:id?expand=refs — zaehlt
   * outgoing-Refs mit role='resource' und reportet truncated-Flag wenn
   * KC2-Default-refsLimit erreicht ist.
   */
  cascadePreview(objectId: string): Promise<CascadePreview>;
}

const BASE_PATH = '/admin/kc-proxy/v1/groups';
const KC_PROXY = '/admin/kc-proxy/v1';

export function createGroupsApi(): GroupsApi {
  return {
    async list() {
      const res = await fetch(`${baseUrl()}${BASE_PATH}`, {
        credentials: 'include',
      });
      const data = await jsonOrThrow<{ items: ReadonlyArray<Group> }>(res);
      return data.items;
    },

    async get(groupId) {
      const res = await fetch(`${baseUrl()}${BASE_PATH}/${encodeURIComponent(groupId)}`, {
        credentials: 'include',
      });
      return jsonOrThrow<{ group: Group; members: ReadonlyArray<GroupMember> }>(res);
    },

    async create(input) {
      const body: Record<string, unknown> = { name: input.name };
      if (input.description !== undefined) body['description'] = input.description;
      if (input.readAuditEnabled !== undefined) {
        body['read_audit_enabled'] = input.readAuditEnabled;
      }
      const res = await fetch(`${baseUrl()}${BASE_PATH}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return jsonOrThrow<Group>(res);
    },

    async archive(groupId) {
      const res = await fetch(`${baseUrl()}${BASE_PATH}/${encodeURIComponent(groupId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      await jsonOrThrow<void>(res);
    },

    async addMember(input) {
      const body: Record<string, unknown> = { user_id: input.userId };
      if (input.role !== undefined) body['role'] = input.role;
      const res = await fetch(
        `${baseUrl()}${BASE_PATH}/${encodeURIComponent(input.groupId)}/members`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      return jsonOrThrow<GroupMember>(res);
    },

    async removeMember(groupId, userId) {
      const res = await fetch(
        `${baseUrl()}${BASE_PATH}/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      await jsonOrThrow<void>(res);
    },

    async setReadAudit(groupId, enabled) {
      const res = await fetch(
        `${baseUrl()}${BASE_PATH}/${encodeURIComponent(groupId)}/read-audit`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        },
      );
      await jsonOrThrow<void>(res);
    },

    async transferOwnership(groupId, newOwnerUserId) {
      const res = await fetch(
        `${baseUrl()}${BASE_PATH}/${encodeURIComponent(groupId)}/transfer-ownership`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ new_owner_user_id: newOwnerUserId }),
        },
      );
      await jsonOrThrow<void>(res);
    },

    async shareWithGroup(input) {
      const body: Record<string, unknown> = {
        group_id: input.groupId,
        scope: input.scope ?? 'read',
      };
      if (input.expiresAt !== undefined) body['expires_at'] = input.expiresAt;
      const res = await fetch(
        `${baseUrl()}${KC_PROXY}/objects/${encodeURIComponent(input.resourceId)}/share-with-group`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      return jsonOrThrow<GroupShare>(res);
    },

    async revokeShare(shareId) {
      const res = await fetch(
        `${baseUrl()}${KC_PROXY}/shares/${encodeURIComponent(shareId)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      await jsonOrThrow<void>(res);
    },

    async listSharedWithMe() {
      const res = await fetch(`${baseUrl()}${KC_PROXY}/shared-with-me`, {
        credentials: 'include',
      });
      const data = await jsonOrThrow<{ items: ReadonlyArray<GroupShare> }>(res);
      return data.items;
    },

    async cascadePreview(objectId) {
      // GET /v1/objects/:id?expand=refs zaehlt outgoing role='resource' Refs.
      // KC2-Default refsLimit=5; bei >5 ist `refs.truncated.outgoing=true`
      // → wir reportieren truncated und der Caller zeigt "5+" statt exakter Zahl.
      const res = await fetch(
        `${baseUrl()}${KC_PROXY}/objects/${encodeURIComponent(objectId)}?expand=refs`,
        { credentials: 'include' },
      );
      type RefView = { readonly role: string };
      type Resp =
        | {
            item?: {
              refs?: {
                outgoing?: ReadonlyArray<RefView>;
                truncated?: { outgoing?: boolean };
              };
            };
            refs?: {
              outgoing?: ReadonlyArray<RefView>;
              truncated?: { outgoing?: boolean };
            };
          }
        | undefined;
      const parsed = await jsonOrThrow<Resp>(res);
      const obj = parsed && 'item' in parsed && parsed.item ? parsed.item : parsed;
      const outgoing = obj?.refs?.outgoing ?? [];
      const truncated = obj?.refs?.truncated?.outgoing === true;
      const resourceCount = outgoing.filter((r) => r.role === 'resource').length;
      return { cascadedCount: resourceCount, truncated };
    },
  };
}
