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

/**
 * Free-form Subtype-Discriminator (post-ADR-0004 Generic Object Model).
 * Storage akzeptiert beliebige Strings, der Form-Regex (mit `:`-Erlaubnis
 * fuer `app:`-Namespacing) ist Caller-Convention.
 */
export const KnowledgeSubtype = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_:-]*$/, {
    message: 'subtype must be lowercase alphanumeric with -, _, : separators (starts with a letter)',
  });

export const KnowledgeDocsCreateInput = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(1_000_000),
    description: z.string().max(2000).optional(),
    keywords: z.array(z.string().min(1).max(64)).max(32).optional(),
    subtype: KnowledgeSubtype.optional(),
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
    subtypes: z.array(KnowledgeSubtype).max(16).optional(),
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

export const SkillsDetachResourceInput = z
  .object({
    skill_id: z.string().min(1).max(128),
    doc_id: z.string().min(1).max(128),
  })
  .strict();
export type SkillsDetachResourceInput = z.infer<typeof SkillsDetachResourceInput>;

export const SkillsGetBundleInput = z
  .object({
    id: z.string().min(1).max(128),
    refs_limit: z.number().int().min(0).max(50).optional(),
  })
  .strict();
export type SkillsGetBundleInput = z.infer<typeof SkillsGetBundleInput>;

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
// Subtype-Konstanten (PLAN-wrapper-conventions §"Drift-Prevention")
//
// Wrapper exportieren Subtype-Strings als Konstanten statt String-Literals.
// Wer eine neue Wrapper-Familie anlegt MUSS einen Eintrag in
// docs/plans/active/PLAN-wrapper-conventions.md §"Subtype-Tabelle" machen
// und die Konstante hier hinzufuegen.
// =============================================================================

export const LIST_SUBTYPE = 'list' as const;
export const NOTE_SUBTYPE = 'note' as const;
// BOOKMARK_SUBTYPE + RECIPE_SUBTYPE entfernt 2026-05-17.

// =============================================================================
// Lists-Tools (subtype='list', Body=Markdown-Checkbox)
//
// Body-Format-Regex (validateListBody in lists-tools.ts):
//   - H1 optional als 1. Zeile: ^# .+$
//   - Item-Zeilen: ^- \[[ xX]\] .+(\s+#[a-z0-9_-]{1,32})*$
//   - Leerzeilen erlaubt
// Max 120 Items (siehe PLAN-wrapper-conventions §"Body-Formate / list").
// =============================================================================

export const ListsCreateInput = z
  .object({
    title: z.string().min(1).max(200),
    items: z.array(z.string().min(1).max(280)).max(120).optional(),
  })
  .strict();
export type ListsCreateInput = z.infer<typeof ListsCreateInput>;

export const ListsAddItemInput = z
  .object({
    id: z.string().min(1).max(128),
    item: z.string().min(1).max(280),
    tag: z.string().min(1).max(32).regex(/^[a-z0-9_-]+$/).optional(),
  })
  .strict();
export type ListsAddItemInput = z.infer<typeof ListsAddItemInput>;

export const ListsTickInput = z
  .object({
    id: z.string().min(1).max(128),
    /** Text-substring (case-insensitive) used to identify the item. */
    match: z.string().min(1).max(280).optional(),
    /** Zero-based line index alternative (counts only `- [ ]/[x]` rows). */
    line_index: z.number().int().nonnegative().max(120).optional(),
  })
  .strict()
  .refine(
    (v) => v.match !== undefined || v.line_index !== undefined,
    { message: 'one of match or line_index must be provided' },
  );
export type ListsTickInput = z.infer<typeof ListsTickInput>;

export const ListsUntickInput = ListsTickInput;
export type ListsUntickInput = z.infer<typeof ListsUntickInput>;

export const ListsListInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ListsListInput = z.infer<typeof ListsListInput>;

export const ListsGetInput = z
  .object({
    id: z.string().min(1).max(128),
  })
  .strict();
export type ListsGetInput = z.infer<typeof ListsGetInput>;

// =============================================================================
// Notes-Tools (subtype='note', Body=Markdown frei)
// =============================================================================

export const NotesCreateInput = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(16_384),
    description: z.string().min(1).max(2000).optional(),
    embed: z.boolean().optional(),
    keywords: z.array(z.string().min(1).max(64)).max(32).optional(),
  })
  .strict();
export type NotesCreateInput = z.infer<typeof NotesCreateInput>;

export const NotesUpdateInput = z
  .object({
    id: z.string().min(1).max(128),
    title: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(16_384).optional(),
    description: z.string().max(2000).optional(),
    keywords: z.array(z.string().min(1).max(64)).max(32).optional(),
    expected_version: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.title !== undefined ||
      v.body !== undefined ||
      v.description !== undefined ||
      v.keywords !== undefined,
    { message: 'at least one of title/body/description/keywords must be provided' },
  );
export type NotesUpdateInput = z.infer<typeof NotesUpdateInput>;

export const NotesListInput = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.number().int().nonnegative().optional(),
  })
  .strict();
export type NotesListInput = z.infer<typeof NotesListInput>;

export const NotesGetInput = z
  .object({
    id: z.string().min(1).max(128),
  })
  .strict();
export type NotesGetInput = z.infer<typeof NotesGetInput>;

export const NotesDeleteInput = z
  .object({
    id: z.string().min(1).max(128),
  })
  .strict();
export type NotesDeleteInput = z.infer<typeof NotesDeleteInput>;

// =============================================================================
// Bookmarks-Tools + Recipes-Tools — entfernt 2026-05-17.
// Soft-Delete unter apps/server/src/_to_delete/2026-05-17/.
// =============================================================================

// =============================================================================
// Objects-Tools  (technical view, all kinds)
// =============================================================================

export const ObjectsListInput = z
  .object({
    subtype: KnowledgeSubtype.optional(),
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
