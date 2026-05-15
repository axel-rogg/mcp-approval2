/**
 * Lists-Tools — KC-Wrapper fuer subtype='list' Objekte.
 *
 * Plan-Ref: docs/plans/active/PLAN-wrapper-conventions.md §"Body-Formate /
 * subtype='list'", §"Drift-Prevention".
 *
 * Listen sind Markdown-Checkbox-Dokumente. Body-Format (strict):
 *
 *   # Title                  <- optional H1 (1. Zeile)
 *
 *   - [ ] Item 1
 *   - [x] Item 2 #tag        <- optional #tag-Suffix
 *
 * Toggle-Semantik: `lists.tick`/`lists.untick` lesen das doc mit body,
 * flippen `[ ]` ↔ `[x]` per Text-Substring-Match (case-insensitive) oder
 * Line-Index, schreiben den vollen Body zurueck.
 *
 * Body-Validator (validateListBody) wird vor jedem POST/PATCH gegen KC2
 * ausgefuehrt — Storage selbst akzeptiert opaque ciphertext.
 *
 * Tool-Inventar:
 *   - lists.create   (write)
 *   - lists.add_item (write)
 *   - lists.tick     (write)
 *   - lists.untick   (write)
 *   - lists.list     (read)
 *   - lists.get      (read)
 */
import type {
  CreateObjectArgs,
  KnowledgeObject,
  ObjectsList,
  UpdateObjectArgs,
} from '@mcp-approval2/adapters';
import type { Tool, ToolContext } from '../mcp/protocol/tool.js';
import { kcAuthFromCtx, type KnowledgeService } from '../services/knowledge.js';
import {
  LIST_SUBTYPE,
  ListsAddItemInput,
  ListsCreateInput,
  ListsGetInput,
  ListsListInput,
  ListsTickInput,
  ListsUntickInput,
  type ListsAddItemInput as ListsAddItemInputT,
  type ListsCreateInput as ListsCreateInputT,
  type ListsGetInput as ListsGetInputT,
  type ListsListInput as ListsListInputT,
  type ListsTickInput as ListsTickInputT,
  type ListsUntickInput as ListsUntickInputT,
} from './types.js';

export interface ListsToolsDeps {
  readonly knowledge: KnowledgeService;
}

// ---------------------------------------------------------------------------
// Body validators / helpers
// ---------------------------------------------------------------------------

const ITEM_LINE_RE = /^- \[[ xX]\] .+(\s+#[a-z0-9_-]{1,32})*$/;
const HEADER_LINE_RE = /^# .+$/;
const MAX_ITEMS = 120;

/**
 * Validiert das Markdown-Checkbox-Body-Format einer Liste.
 * Wirft Error mit Zeilen-Index bei Format-Verstoss.
 */
export function validateListBody(body: string): void {
  const lines = body.split('\n');
  let itemCount = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (i === 0 && HEADER_LINE_RE.test(line)) continue;
    if (line.trim() === '') continue;
    if (ITEM_LINE_RE.test(line)) {
      itemCount += 1;
      if (itemCount > MAX_ITEMS) {
        throw new Error(`lists: too many items (max ${MAX_ITEMS})`);
      }
      continue;
    }
    throw new Error(
      `lists: line ${i + 1} is not a valid checkbox item: ${JSON.stringify(line)}`,
    );
  }
}

/**
 * Baut den Markdown-Body aus title + items[].
 * Title wird als H1 vorangestellt; Items als `- [ ] <text>`-Zeilen.
 */
export function buildListBody(title: string, items: ReadonlyArray<string>): string {
  const itemLines = items.map((it) => `- [ ] ${it}`);
  return [`# ${title}`, '', ...itemLines].join('\n');
}

/**
 * Decoded body from KnowledgeObject — server liefert base64 wenn expandBody=true.
 * Wir behandeln plain-string (Test-Stubs) und base64-string transparent.
 */
function decodeBody(obj: KnowledgeObject): string {
  const raw = obj.body;
  if (raw === undefined || raw === null) {
    throw new Error('lists: object body missing — expandBody?');
  }
  // Heuristik: wenn der String den `- [`-Pattern enthaelt, ist es plain.
  // Sonst versuchen wir base64-decode. Bei Misfit: plain interpretieren.
  if (raw.includes('- [')) return raw;
  try {
    const buf = Buffer.from(raw, 'base64');
    const decoded = buf.toString('utf-8');
    if (decoded.includes('- [') || HEADER_LINE_RE.test(decoded.split('\n')[0] ?? '')) {
      return decoded;
    }
    return raw;
  } catch {
    return raw;
  }
}

/**
 * Findet die Item-Zeilen-Indizes (0-based, im Bezug auf split('\n')) im
 * gegebenen Body. Optional erstes Element ist H1.
 */
function findItemLineIndices(body: string): { lines: string[]; itemIndices: number[] } {
  const lines = body.split('\n');
  const itemIndices: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (ITEM_LINE_RE.test(line)) itemIndices.push(i);
  }
  return { lines, itemIndices };
}

/**
 * Finde Zielzeile fuer tick/untick via text-match oder line_index.
 * Wirft falls nichts matched.
 */
function resolveTargetLineIndex(
  body: string,
  args: { match?: string; line_index?: number },
): number {
  const { lines, itemIndices } = findItemLineIndices(body);
  if (args.line_index !== undefined) {
    const target = itemIndices[args.line_index];
    if (target === undefined) {
      throw new Error(
        `lists: line_index ${args.line_index} out of range (have ${itemIndices.length} items)`,
      );
    }
    return target;
  }
  if (args.match !== undefined) {
    const needle = args.match.toLowerCase();
    for (const idx of itemIndices) {
      const line = lines[idx] ?? '';
      if (line.toLowerCase().includes(needle)) return idx;
    }
    throw new Error(`lists: no item matching ${JSON.stringify(args.match)}`);
  }
  throw new Error('lists: must provide match or line_index');
}

function toggleCheckbox(line: string, to: 'x' | ' '): string {
  return line.replace(/^- \[[ xX]\] /, `- [${to}] `);
}

// ---------------------------------------------------------------------------
// lists.create — write
// ---------------------------------------------------------------------------

export function makeListsCreateTool(deps: ListsToolsDeps): Tool<ListsCreateInputT, KnowledgeObject> {
  return {
    name: 'lists.create',
    description:
      'Create a new checkbox list with a title and optional initial items. Body is Markdown with `- [ ] item` lines.',
    sensitivity: 'write',
    displayTemplate: 'Create list: {{title}} ({{items.length}} items)',
    inputSchema: ListsCreateInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      const kcAuth = kcAuthFromCtx(ctx);
      const items = input.items ?? [];
      if (items.length > MAX_ITEMS) {
        throw new Error(`lists.create: too many items (max ${MAX_ITEMS})`);
      }
      const body = buildListBody(input.title, items);
      validateListBody(body);
      const args: CreateObjectArgs = {
        userId: ctx.userId,
        subtype: LIST_SUBTYPE,
        title: input.title,
        body,
        ...kcAuth,
      };
      return deps.knowledge.createObject(args);
    },
  };
}

// ---------------------------------------------------------------------------
// lists.add_item — write
// ---------------------------------------------------------------------------

export function makeListsAddItemTool(deps: ListsToolsDeps): Tool<ListsAddItemInputT, KnowledgeObject> {
  return {
    name: 'lists.add_item',
    description:
      'Append a single item to an existing list. Body is read+rewritten; tag is appended as ` #tag` if provided.',
    sensitivity: 'write',
    displayTemplate: 'Add to list {{id}}: "{{item}}"{{#tag}} #{{tag}}{{/tag}}',
    inputSchema: ListsAddItemInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      const kcAuth = kcAuthFromCtx(ctx);
      const current = await deps.knowledge.getObject({
        id: input.id,
        userId: ctx.userId,
        expandBody: true,
        ...kcAuth,
      });
      const body = decodeBody(current);
      const { itemIndices } = findItemLineIndices(body);
      if (itemIndices.length >= MAX_ITEMS) {
        throw new Error(`lists.add_item: list already at max items (${MAX_ITEMS})`);
      }
      const tagSuffix = input.tag !== undefined ? ` #${input.tag}` : '';
      const newLine = `- [ ] ${input.item}${tagSuffix}`;
      const nextBody = body.endsWith('\n') ? body + newLine : body + '\n' + newLine;
      validateListBody(nextBody);
      const patch: UpdateObjectArgs['patch'] = { body: nextBody };
      return deps.knowledge.updateObject({
        id: input.id,
        userId: ctx.userId,
        patch,
        ...kcAuth,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// lists.tick / lists.untick — write
// ---------------------------------------------------------------------------

function makeToggleTool(
  name: 'lists.tick' | 'lists.untick',
  target: 'x' | ' ',
  description: string,
  display: string,
  schema:
    | typeof ListsTickInput
    | typeof ListsUntickInput,
): (deps: ListsToolsDeps) => Tool<ListsTickInputT | ListsUntickInputT, KnowledgeObject> {
  return (deps) => ({
    name,
    description,
    sensitivity: 'write',
    displayTemplate: display,
    inputSchema: schema,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      const kcAuth = kcAuthFromCtx(ctx);
      const current = await deps.knowledge.getObject({
        id: input.id,
        userId: ctx.userId,
        expandBody: true,
        ...kcAuth,
      });
      const body = decodeBody(current);
      const args: { match?: string; line_index?: number } = {};
      if (input.match !== undefined) args.match = input.match;
      if (input.line_index !== undefined) args.line_index = input.line_index;
      const idx = resolveTargetLineIndex(body, args);
      const lines = body.split('\n');
      const original = lines[idx] ?? '';
      lines[idx] = toggleCheckbox(original, target);
      const nextBody = lines.join('\n');
      validateListBody(nextBody);
      const patch: UpdateObjectArgs['patch'] = { body: nextBody };
      return deps.knowledge.updateObject({
        id: input.id,
        userId: ctx.userId,
        patch,
        ...kcAuth,
      });
    },
  });
}

export const makeListsTickTool = makeToggleTool(
  'lists.tick',
  'x',
  'Mark a list item as done. Match by text substring (case-insensitive) or zero-based line_index.',
  'Tick {{id}}: {{match}}{{^match}}line {{line_index}}{{/match}}',
  ListsTickInput,
);

export const makeListsUntickTool = makeToggleTool(
  'lists.untick',
  ' ',
  'Mark a list item as not-done. Match by text substring (case-insensitive) or zero-based line_index.',
  'Untick {{id}}: {{match}}{{^match}}line {{line_index}}{{/match}}',
  ListsUntickInput,
);

// ---------------------------------------------------------------------------
// lists.list — read
// ---------------------------------------------------------------------------

export function makeListsListTool(deps: ListsToolsDeps): Tool<ListsListInputT, ObjectsList> {
  return {
    name: 'lists.list',
    description: "List the current user's lists (subtype=list). Supports paging via limit/cursor.",
    sensitivity: 'read',
    inputSchema: ListsListInput,
    async execute(ctx: ToolContext, input): Promise<ObjectsList> {
      const args: Parameters<KnowledgeService['listObjects']>[0] = {
        userId: ctx.userId,
        subtype: LIST_SUBTYPE,
      };
      if (input.limit !== undefined) (args as { limit?: number }).limit = input.limit;
      if (input.cursor !== undefined) (args as { cursor?: number }).cursor = input.cursor;
      return deps.knowledge.listObjects(args);
    },
  };
}

// ---------------------------------------------------------------------------
// lists.get — read
// ---------------------------------------------------------------------------

export function makeListsGetTool(deps: ListsToolsDeps): Tool<ListsGetInputT, KnowledgeObject> {
  return {
    name: 'lists.get',
    description: 'Fetch a single list by id (with body expanded).',
    sensitivity: 'read',
    inputSchema: ListsGetInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      return deps.knowledge.getObject({
        id: input.id,
        userId: ctx.userId,
        expandBody: true,
      });
    },
  };
}
