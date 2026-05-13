/**
 * Tool-Input-Schemas (Zod).
 *
 * Plan-Ref: PLAN-architecture-v1.md §2 (Request-Lifecycle Step 4a),
 * §11 Burst 3 (Tool-Surface).
 *
 * Diese Schemas sind die Source-of-Truth fuer:
 *   - Runtime-Validation (Zod-parse in der Dispatcher-Pipeline)
 *   - JSON-Schema-Generation fuer MCP `tools/list`
 *
 * Wir halten die Schemas hier zentralisiert, damit:
 *   - Tests gegen dieselben Schemas validieren wie der Server
 *   - Type-Inference (`z.infer<typeof ...>`) im Tool-File konsistent ist
 */
import { z } from 'zod';

// =============================================================================
// User-Tools
// =============================================================================

export const UserProfileReadInput = z.object({}).strict();
export type UserProfileReadInput = z.infer<typeof UserProfileReadInput>;

export const UserProfileUpdateInput = z
  .object({
    displayName: z.string().min(1).max(120).optional(),
    email: z.string().email().max(254).optional(),
  })
  .strict()
  .refine(
    (v) => v.displayName !== undefined || v.email !== undefined,
    { message: 'at least one of displayName or email must be provided' },
  );
export type UserProfileUpdateInput = z.infer<typeof UserProfileUpdateInput>;

// =============================================================================
// Knowledge-Tools
// =============================================================================

const KnowledgeKind = z.enum(['doc', 'skill', 'app', 'memo']);

export const KnowledgeDocsCreateInput = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(1_000_000),
    description: z.string().max(2000).optional(),
    keywords: z.array(z.string().min(1).max(64)).max(32).optional(),
    subtype: z.string().min(1).max(64).optional(),
    visibility: z.enum(['private', 'shared']).optional(),
  })
  .strict();
export type KnowledgeDocsCreateInput = z.infer<typeof KnowledgeDocsCreateInput>;

export const KnowledgeDocsReadInput = z
  .object({
    id: z.string().min(1).max(128),
  })
  .strict();
export type KnowledgeDocsReadInput = z.infer<typeof KnowledgeDocsReadInput>;

export const KnowledgeDocsListInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    // D-4: cursor ist Integer (Unix-ms vom letzten updatedAt), nicht opaque string.
    cursor: z.number().int().nonnegative().optional(),
  })
  .strict();
export type KnowledgeDocsListInput = z.infer<typeof KnowledgeDocsListInput>;

export const KnowledgeSkillsListInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.number().int().nonnegative().optional(),
  })
  .strict();
export type KnowledgeSkillsListInput = z.infer<typeof KnowledgeSkillsListInput>;

export const KnowledgeSearchInput = z
  .object({
    query: z.string().min(1).max(1024),
    kinds: z.array(KnowledgeKind).max(4).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type KnowledgeSearchInput = z.infer<typeof KnowledgeSearchInput>;

// =============================================================================
// Docs-Tools  (kind='doc' KC-Wrapper)
//
// Diese Schemas sind die Wire-Source-of-Truth fuer die docs.* MCP-Tools, die
// als Approval-Gateway zu mcp-knowledge2 forwarden. Body wird in der
// KnowledgeService-Schicht base64-encoded — wir akzeptieren hier String oder
// Uint8Array (Uint8Array via Tool-Input ist heute Hub-intern; PWA reicht
// String).
// =============================================================================

const TagsArray = z.array(z.string().min(1).max(64)).max(32).optional();

export const DocsPutInput = z
  .object({
    id: z.string().min(1).max(128).optional(),
    filename: z.string().min(1).max(256),
    body: z.union([z.string().min(0).max(8_000_000), z.instanceof(Uint8Array)]),
    summary: z.string().min(1).max(2000).optional(),
    mime_type: z.string().min(1).max(128).optional(),
    namespace: z.string().min(1).max(64).optional(),
    category: z.string().min(1).max(64).optional(),
    tags: TagsArray,
    expected_version: z.number().int().nonnegative().optional(),
  })
  .strict();
export type DocsPutInput = z.infer<typeof DocsPutInput>;

export const DocsGetInput = z
  .object({
    id: z.string().min(1).max(128),
    expand_body: z.boolean().optional(),
  })
  .strict();
export type DocsGetInput = z.infer<typeof DocsGetInput>;

export const DocsListInput = z
  .object({
    namespace: z.string().min(1).max(64).optional(),
    category: z.string().min(1).max(64).optional(),
    tags: TagsArray,
    mime_type: z.string().min(1).max(128).optional(),
    sort: z.enum(['updated_at_desc', 'updated_at_asc', 'created_at_desc']).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.number().int().nonnegative().optional(),
  })
  .strict();
export type DocsListInput = z.infer<typeof DocsListInput>;

export const DocsDeleteInput = z
  .object({
    id: z.string().min(1).max(128),
    force: z.boolean().optional(),
  })
  .strict();
export type DocsDeleteInput = z.infer<typeof DocsDeleteInput>;

export const DocsUsagesInput = z
  .object({
    id: z.string().min(1).max(128),
  })
  .strict();
export type DocsUsagesInput = z.infer<typeof DocsUsagesInput>;

export const DocsAttachToInput = z
  .object({
    doc_id: z.string().min(1).max(128),
    skill_ids: z.array(z.string().min(1).max(128)).min(1).max(32),
  })
  .strict();
export type DocsAttachToInput = z.infer<typeof DocsAttachToInput>;

export const DocsUpdateSummaryInput = z
  .object({
    id: z.string().min(1).max(128),
    summary: z.string().min(0).max(2000),
    re_embed: z.boolean().optional(),
  })
  .strict();
export type DocsUpdateSummaryInput = z.infer<typeof DocsUpdateSummaryInput>;

// =============================================================================
// Skills-Tools  (kind='skill' KC-Wrapper)
// =============================================================================

export const SkillsPutInput = z
  .object({
    id: z.string().min(1).max(128).optional(),
    title: z.string().min(1).max(200),
    manifest: z.string().min(1).max(500_000),
    description: z.string().max(2000).optional(),
    keywords: z.array(z.string().min(1).max(64)).max(32).optional(),
    trigger_hints: z.string().max(2000).optional(),
    groups: z.array(z.string().min(1).max(64)).max(16).optional(),
    resource_ids: z.array(z.string().min(1).max(128)).max(32).optional(),
    expected_version: z.number().int().nonnegative().optional(),
  })
  .strict();
export type SkillsPutInput = z.infer<typeof SkillsPutInput>;

export const SkillsGetInput = z
  .object({
    id: z.string().min(1).max(128),
    expand_body: z.boolean().optional(),
  })
  .strict();
export type SkillsGetInput = z.infer<typeof SkillsGetInput>;

export const SkillsListInput = z
  .object({
    group: z.string().min(1).max(64).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.number().int().nonnegative().optional(),
  })
  .strict();
export type SkillsListInput = z.infer<typeof SkillsListInput>;

export const SkillsDeleteInput = z
  .object({
    id: z.string().min(1).max(128),
    force: z.boolean().optional(),
  })
  .strict();
export type SkillsDeleteInput = z.infer<typeof SkillsDeleteInput>;

export const SkillsSearchInput = z
  .object({
    query: z.string().min(1).max(1024),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type SkillsSearchInput = z.infer<typeof SkillsSearchInput>;

export const SkillsReadResourceInput = z
  .object({
    skill_id: z.string().min(1).max(128),
    resource_id: z.string().min(1).max(128),
  })
  .strict();
export type SkillsReadResourceInput = z.infer<typeof SkillsReadResourceInput>;

export const SkillsAttachResourceInput = z
  .object({
    skill_id: z.string().min(1).max(128),
    doc_id: z.string().min(1).max(128),
  })
  .strict();
export type SkillsAttachResourceInput = z.infer<typeof SkillsAttachResourceInput>;

// =============================================================================
// Memorize-Tools  (kind='memo', subtype=scope)
// =============================================================================

export const MemorizeAddInput = z
  .object({
    text: z.string().min(1).max(2000),
    scope: z.string().min(1).max(128),
    keywords: z.array(z.string().min(1).max(64)).max(32).optional(),
  })
  .strict();
export type MemorizeAddInput = z.infer<typeof MemorizeAddInput>;

export const MemorizeSearchInput = z
  .object({
    query: z.string().min(1).max(1024),
    scope: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export type MemorizeSearchInput = z.infer<typeof MemorizeSearchInput>;

export const MemorizeListRecentInput = z
  .object({
    scope: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.number().int().nonnegative().optional(),
  })
  .strict();
export type MemorizeListRecentInput = z.infer<typeof MemorizeListRecentInput>;

export const MemorizeDeleteInput = z
  .object({
    id: z.string().min(1).max(128),
  })
  .strict();
export type MemorizeDeleteInput = z.infer<typeof MemorizeDeleteInput>;

// =============================================================================
// Objects-Tools  (technical view, all kinds)
// =============================================================================

export const ObjectsListInput = z
  .object({
    kind: KnowledgeKind.optional(),
    subtype: z.string().min(1).max(64).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ObjectsListInput = z.infer<typeof ObjectsListInput>;

export const ObjectsReadInput = z
  .object({
    id: z.string().min(1).max(128),
    expand_body: z.boolean().optional(),
  })
  .strict();
export type ObjectsReadInput = z.infer<typeof ObjectsReadInput>;

export const ObjectsBulkDeleteInput = z
  .object({
    ids: z.array(z.string().min(1).max(128)).min(1).max(100),
    dry_run: z.boolean().optional(),
  })
  .strict();
export type ObjectsBulkDeleteInput = z.infer<typeof ObjectsBulkDeleteInput>;

// =============================================================================
// Credentials-Tools
// =============================================================================

const CredentialKind = z.enum([
  'oauth_refresh',
  'api_token',
  'password',
  'service_account',
]);

export const CredentialsListInput = z
  .object({
    provider: z.string().min(1).max(64).optional(),
  })
  .strict();
export type CredentialsListInput = z.infer<typeof CredentialsListInput>;

export const CredentialsAddInput = z
  .object({
    provider: z.string().min(1).max(64),
    kind: CredentialKind,
    label: z.string().min(1).max(120),
    secret: z.string().min(1).max(16_384),
    prfEnabled: z.boolean().optional(),
    /** Hex-encoded prfSessionId (resolved via PrfSessionService). */
    prfSessionId: z.string().min(1).max(256).optional(),
    expiresAt: z.number().int().nonnegative().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();
export type CredentialsAddInput = z.infer<typeof CredentialsAddInput>;

export const CredentialsDeleteInput = z
  .object({
    credentialId: z.string().min(1).max(128),
  })
  .strict();
export type CredentialsDeleteInput = z.infer<typeof CredentialsDeleteInput>;

// =============================================================================
// System-Tools
// =============================================================================

export const SystemHealthInput = z.object({}).strict();
export type SystemHealthInput = z.infer<typeof SystemHealthInput>;

export const SystemEchoInput = z
  .object({
    message: z.string().min(1).max(1024),
  })
  .strict();
export type SystemEchoInput = z.infer<typeof SystemEchoInput>;
