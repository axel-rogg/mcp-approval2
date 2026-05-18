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

export interface GroupsApi {
  list(): Promise<ReadonlyArray<Group>>;
  get(groupId: string): Promise<{ group: Group; members: ReadonlyArray<GroupMember> }>;
  create(input: CreateGroupInput): Promise<Group>;
  archive(groupId: string): Promise<void>;
  addMember(input: AddMemberInput): Promise<GroupMember>;
  removeMember(groupId: string, userId: string): Promise<void>;
  setReadAudit(groupId: string, enabled: boolean): Promise<void>;
}

const BASE_PATH = '/admin/kc-proxy/v1/groups';

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
  };
}
