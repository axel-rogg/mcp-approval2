/**
 * Recipes-Tools — KC-Wrapper fuer subtype='recipe' Objekte.
 *
 * Plan-Ref: docs/plans/active/PLAN-wrapper-conventions.md §"Body-Formate /
 * subtype='recipe'".
 *
 * Recipes sind Markdown-Dokumente mit optional YAML-Frontmatter (servings,
 * prep_time, cook_time). Body-Format-Validator macht nur shape-check — kein
 * Inhalts-Check der Zutaten/Schritte.
 *
 * Tool-Inventar:
 *   - recipes.create (write)
 *   - recipes.update (write) — full-replace
 *   - recipes.list   (read)
 *   - recipes.get    (read)
 *   - recipes.delete (danger) — soft-delete
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
  RECIPE_SUBTYPE,
  RecipesCreateInput,
  RecipesDeleteInput,
  RecipesGetInput,
  RecipesListInput,
  RecipesUpdateInput,
  type RecipesCreateInput as RecipesCreateInputT,
  type RecipesDeleteInput as RecipesDeleteInputT,
  type RecipesGetInput as RecipesGetInputT,
  type RecipesListInput as RecipesListInputT,
  type RecipesUpdateInput as RecipesUpdateInputT,
} from './types.js';

export interface RecipesToolsDeps {
  readonly knowledge: KnowledgeService;
}

// ---------------------------------------------------------------------------
// Optional YAML-Frontmatter — shape-check only.
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

/**
 * Wenn der Body mit `---\n` startet, muss vor dem zweiten `---\n` ein
 * Frontmatter-Block stehen. Kein Inhaltscheck — nur, dass das Closing-`---`
 * vorhanden ist.
 */
export function validateRecipeFrontmatter(body: string): void {
  if (!body.startsWith('---')) return;
  if (!FRONTMATTER_RE.test(body)) {
    throw new Error('recipes: malformed YAML frontmatter — missing closing `---`');
  }
}

// ---------------------------------------------------------------------------
// recipes.create — write
// ---------------------------------------------------------------------------

export function makeRecipesCreateTool(
  deps: RecipesToolsDeps,
): Tool<RecipesCreateInputT, KnowledgeObject> {
  return {
    name: 'recipes.create',
    description:
      'Create a recipe (Markdown, optional YAML frontmatter with servings/prep_time/cook_time). Body holds ingredients + steps.',
    sensitivity: 'write',
    // SEC-020: body-Preview im signed display (Ingredients/Steps sind das was zaehlt).
    displayTemplate: 'Recipe: {{title}} — {{body|preview:120}}',
    inputSchema: RecipesCreateInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      const kcAuth = kcAuthFromCtx(ctx);
      validateRecipeFrontmatter(input.body);
      const args: CreateObjectArgs = {
        userId: ctx.userId,
        subtype: RECIPE_SUBTYPE,
        title: input.title,
        body: input.body,
        ...kcAuth,
      };
      if (input.description !== undefined) {
        (args as { description?: string }).description = input.description;
      }
      if (input.keywords !== undefined) {
        (args as { keywords?: ReadonlyArray<string> }).keywords = input.keywords;
      }
      return deps.knowledge.createObject(args);
    },
  };
}

// ---------------------------------------------------------------------------
// recipes.update — write (full-replace of provided fields)
// ---------------------------------------------------------------------------

export function makeRecipesUpdateTool(
  deps: RecipesToolsDeps,
): Tool<RecipesUpdateInputT, KnowledgeObject> {
  return {
    name: 'recipes.update',
    description:
      'Update a recipe (full-replace of provided fields). At least one of title/body/description/keywords required.',
    sensitivity: 'write',
    // SEC-020: title+body-Preview damit User die Konsequenz eines Updates sieht.
    displayTemplate: 'Update recipe {{id}} — title:{{title|preview:60}} body:{{body|preview:120}}',
    inputSchema: RecipesUpdateInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      const kcAuth = kcAuthFromCtx(ctx);
      if (input.body !== undefined) validateRecipeFrontmatter(input.body);
      const patch: UpdateObjectArgs['patch'] = {};
      if (input.title !== undefined) (patch as { title?: string }).title = input.title;
      if (input.body !== undefined) (patch as { body?: string }).body = input.body;
      if (input.description !== undefined) {
        (patch as { description?: string | null }).description = input.description;
      }
      if (input.keywords !== undefined) {
        (patch as { keywords?: ReadonlyArray<string> | null }).keywords = input.keywords;
      }
      if (input.expected_version !== undefined) {
        (patch as { expectedVersion?: number }).expectedVersion = input.expected_version;
      }
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
// recipes.list — read
// ---------------------------------------------------------------------------

export function makeRecipesListTool(
  deps: RecipesToolsDeps,
): Tool<RecipesListInputT, ObjectsList> {
  return {
    name: 'recipes.list',
    description: "List the current user's recipes (subtype=recipe). Supports paging via limit/cursor.",
    sensitivity: 'read',
    inputSchema: RecipesListInput,
    async execute(ctx: ToolContext, input): Promise<ObjectsList> {
      const args: Parameters<KnowledgeService['listObjects']>[0] = {
        userId: ctx.userId,
        subtype: RECIPE_SUBTYPE,
      };
      if (input.limit !== undefined) (args as { limit?: number }).limit = input.limit;
      if (input.cursor !== undefined) (args as { cursor?: number }).cursor = input.cursor;
      return deps.knowledge.listObjects(args);
    },
  };
}

// ---------------------------------------------------------------------------
// recipes.get — read
// ---------------------------------------------------------------------------

export function makeRecipesGetTool(
  deps: RecipesToolsDeps,
): Tool<RecipesGetInputT, KnowledgeObject> {
  return {
    name: 'recipes.get',
    description: 'Fetch a single recipe by id (with body expanded).',
    sensitivity: 'read',
    inputSchema: RecipesGetInput,
    async execute(ctx: ToolContext, input): Promise<KnowledgeObject> {
      return deps.knowledge.getObject({
        id: input.id,
        userId: ctx.userId,
        expandBody: true,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// recipes.delete — danger
// ---------------------------------------------------------------------------

export function makeRecipesDeleteTool(
  deps: RecipesToolsDeps,
): Tool<RecipesDeleteInputT, { deleted: true; id: string }> {
  return {
    name: 'recipes.delete',
    description: 'Soft-delete a recipe by id.',
    sensitivity: 'danger',
    displayTemplate: 'DELETE recipe {{id}}',
    inputSchema: RecipesDeleteInput,
    async execute(ctx: ToolContext, input): Promise<{ deleted: true; id: string }> {
      const kcAuth = kcAuthFromCtx(ctx);
      await deps.knowledge.deleteObject({ id: input.id, userId: ctx.userId, ...kcAuth });
      return { deleted: true, id: input.id };
    },
  };
}
