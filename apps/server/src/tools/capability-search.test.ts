/**
 * capability-search + federated-search tests.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  KnowledgeAdapter,
  KnowledgeObject,
  ObjectsList,
  SearchHit,
  Share,
} from '@mcp-approval2/adapters';
import { z } from 'zod';
import { KnowledgeService } from '../services/knowledge.js';
import { createCapabilitySearchService } from '../services/capability-search.js';
import { createFederatedSearchService } from '../services/federated-search.js';
import { ToolRegistry } from '../mcp/protocol/registry.js';
import type { AuditService, Tool } from '../mcp/protocol/tool.js';
import { makeCapabilitySearchTool } from './capability-search-tool.js';
import { makeFederatedSearchTool } from './federated-search-tool.js';

const USER_ID = '00000000-0000-0000-0000-000000000001';

function makeAuditStub(): AuditService {
  return { async emit() {} };
}

function makeKnowledgeAdapterStub(hits: ReadonlyArray<SearchHit> = []): KnowledgeAdapter {
  const obj: KnowledgeObject = {
    id: 'obj-1',
    ownerId: USER_ID,
    subtype: 'skill_manifest',
    title: 'My Skill',
    description: 'a skill',
    keywords: [],
    triggerHints: null,
    meta: null,
    bodySize: 0,
    bodyHash: null,
    mimeType: null,
    filename: null,
    visibility: 'private',
    pinned: false,
    archived: false,
    refcount: 0,
    currentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
  };
  const list: ObjectsList = { items: [obj], nextCursor: null };
  const share: Share = {
    id: 's',
    resourceId: 'obj-1',
    grantedBy: USER_ID,
    grantedTo: 'u',
    scope: 'read',
    grantedAt: 1,
    expiresAt: null,
    revokedAt: null,
  };
  return {
    async createObject() {
      return obj;
    },
    async getObject() {
      return obj;
    },
    async listObjects() {
      return list;
    },
    async updateObject() {
      return obj;
    },
    async deleteObject() {},
    async createShare() {
      return share;
    },
    async listShares() {
      return [share];
    },
    async revokeShare() {},
    async search() {
      return hits;
    },
    async eraseUser() {
      return {
        status: 'ok',
        deleted: {
          objects: 0,
          shares: 0,
          idempotency: 0,
          uploads: 0,
          auditPseudonymised: 0,
          blobsDeleted: 0,
          blobsPending: 0,
        },
        deletedRows: 0,
      };
    },
    async syncUser() {
      return { status: 'created', kcUserId: 'kc-stub-1' };
    },
  };
}

function makeKnowledgeService(hits: ReadonlyArray<SearchHit> = []): KnowledgeService {
  return new KnowledgeService({
    adapter: makeKnowledgeAdapterStub(hits),
    audit: makeAuditStub(),
  });
}

function makeToolRegistryWithStubs(): ToolRegistry {
  const r = new ToolRegistry();
  const stubA: Tool<{ q: string }, { ok: true }> = {
    name: 'docs.put',
    description: 'put a document into knowledge store',
    sensitivity: 'write',
    inputSchema: z.object({ q: z.string() }),
    async execute() {
      return { ok: true };
    },
  };
  const stubB: Tool<{ q: string }, { ok: true }> = {
    name: 'docs.list',
    description: 'list documents',
    sensitivity: 'read',
    inputSchema: z.object({ q: z.string() }),
    async execute() {
      return { ok: true };
    },
  };
  r.register(stubA);
  r.register(stubB);
  return r;
}

describe('capability-search', () => {
  it('returns ranked tools matching the query', async () => {
    const reg = makeToolRegistryWithStubs();
    const knowledge = makeKnowledgeService([]);
    const svc = createCapabilitySearchService({ toolRegistry: reg, knowledge });
    const result = await svc.search({ userId: USER_ID, query: 'documents' });
    expect(result.tools.length).toBeGreaterThan(0);
    expect(result.tools[0]?.id).toMatch(/^docs\./);
  });

  it('returns empty when neither side hits', async () => {
    const reg = makeToolRegistryWithStubs();
    const knowledge = makeKnowledgeService([]);
    const svc = createCapabilitySearchService({ toolRegistry: reg, knowledge });
    const result = await svc.search({ userId: USER_ID, query: 'zzzzzz-no-match' });
    expect(result.tools).toHaveLength(0);
    expect(result.skills).toHaveLength(0);
  });

  it('respects per-kind quotas', async () => {
    const reg = makeToolRegistryWithStubs();
    const knowledge = makeKnowledgeService([]);
    const svc = createCapabilitySearchService({ toolRegistry: reg, knowledge });
    const result = await svc.search({
      userId: USER_ID,
      query: 'documents',
      toolQuota: 1,
      skillQuota: 0,
    });
    expect(result.tools).toHaveLength(1);
    expect(result.skills).toHaveLength(0);
  });

  it('integrates skills from knowledge.search', async () => {
    const skillHit: SearchHit = {
      id: 'sk-1',
      subtype: 'skill_manifest',
      title: 'Writing helper',
      score: 0.9,
      ftsRank: 1,
      vectorScore: 0.8,
    };
    const reg = makeToolRegistryWithStubs();
    const knowledge = makeKnowledgeService([skillHit]);
    const svc = createCapabilitySearchService({ toolRegistry: reg, knowledge });
    const result = await svc.search({ userId: USER_ID, query: 'writing' });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.title).toBe('Writing helper');
  });

  it('capability_search tool wraps the service', async () => {
    const reg = makeToolRegistryWithStubs();
    const knowledge = makeKnowledgeService([]);
    const svc = createCapabilitySearchService({ toolRegistry: reg, knowledge });
    const tool = makeCapabilitySearchTool({ capabilitySearch: svc });
    expect(tool.name).toBe('capability_search');
    expect(tool.sensitivity).toBe('read');
  });
});

describe('federated-search', () => {
  it('returns hits with sub-doc annotation', async () => {
    const docHit: SearchHit = {
      id: 'doc-1',
      subtype: 'doc',
      title: 'A doc',
      score: 0.7,
      ftsRank: 1,
      vectorScore: 0.5,
    };
    const knowledge = makeKnowledgeService([docHit]);
    // docUsages: stub returns empty incoming.
    const original = knowledge.docUsages.bind(knowledge);
    vi.spyOn(knowledge, 'docUsages').mockResolvedValue({
      incoming: [{ subtype: 'skill_manifest', id: 'sk-1', title: 'Skill A' }],
      outgoing: [],
    });
    const svc = createFederatedSearchService({ knowledge });
    const result = await svc.search({ userId: USER_ID, query: 'doc' });
    expect(result.hits).toHaveLength(1);
    const annotated = result.hits[0] as { used_by?: ReadonlyArray<{ id: string }> };
    expect(annotated.used_by).toEqual([{ subtype: 'skill_manifest', id: 'sk-1', title: 'Skill A' }]);
    expect(typeof original).toBe('function');
  });

  it('skips sub-doc annotation when include_subdocs=false', async () => {
    const docHit: SearchHit = {
      id: 'doc-1',
      subtype: 'doc',
      title: 'A doc',
      score: 0.7,
      ftsRank: null,
      vectorScore: null,
    };
    const knowledge = makeKnowledgeService([docHit]);
    const usageSpy = vi.spyOn(knowledge, 'docUsages');
    const svc = createFederatedSearchService({ knowledge });
    const result = await svc.search({
      userId: USER_ID,
      query: 'doc',
      include_subdocs: false,
    });
    expect(result.hits).toHaveLength(1);
    expect(usageSpy).not.toHaveBeenCalled();
  });

  it('search tool wraps the service', async () => {
    const knowledge = makeKnowledgeService([]);
    const svc = createFederatedSearchService({ knowledge });
    const tool = makeFederatedSearchTool({ federatedSearch: svc });
    expect(tool.name).toBe('search');
    expect(tool.sensitivity).toBe('read');
  });
});
