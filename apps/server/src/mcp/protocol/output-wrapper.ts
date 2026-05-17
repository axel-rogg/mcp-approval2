/**
 * IPI-Output-Wrapper for untrusted User-Content fields.
 *
 * Plan-Ref: PLAN-document-linking.md §10.5 D3, §3.4. Complements `ipi-filter.ts`:
 * the filter scans for injection patterns and sanitizes when confidence >= 0.7;
 * the wrapper marks every User-Content field with an `<external-content>` boundary
 * tag so the LLM can distinguish "data" from "instructions" even when the content
 * is below the injection-detection threshold.
 *
 * Defense-in-depth: filter (high-confidence injection → blocked) AND wrap (every
 * user-string is marked → LLM follows the wrap convention).
 *
 * Field-allowlist: only fields with known User-Content semantics get wrapped:
 *   - `title`        — user-provided object/skill/ref title
 *   - `description`  — user-provided summary (encrypted in KC2)
 *   - `summary`      — alias of description used in some ref-views
 *   - `body`         — full encrypted body when expanded
 *
 * Wrap is idempotent: an already-wrapped string passes through unchanged.
 * Non-string values and unknown field names pass through unchanged.
 */

const WRAP_OPEN = '<external-content source="kc:user-content" untrusted="true">';
const WRAP_CLOSE = '</external-content>';
const ALREADY_WRAPPED_RE = /^<external-content\b[^>]*>[\s\S]*<\/external-content>\s*$/;

/**
 * Field names whose string-typed values are User-Content and must be wrapped.
 * Conservative allow-list; only adding fields with proven User-Content semantics
 * keeps the wrap-cost predictable across the tool surface.
 */
const USER_CONTENT_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'description',
  'summary',
  'body',
]);

/** Wrap a single string in the boundary tag. No-op if empty or already wrapped. */
function wrapString(s: string): string {
  if (s.length === 0) return s;
  if (ALREADY_WRAPPED_RE.test(s)) return s;
  return `${WRAP_OPEN}${s}${WRAP_CLOSE}`;
}

/**
 * Recursively walk a value and wrap every string-typed field whose name is in
 * USER_CONTENT_FIELDS. Returns a new object — input is not mutated.
 *
 * Performance: walks every node once, O(N) where N = total leaf count. For a
 * typical KC2-Object response (~5-10 keys, ~3 nested arrays of 5 items each)
 * the walk is well under 1ms.
 */
export function wrapKcUntrusted<T>(value: T): T {
  return wrap(value) as T;
}

function wrap(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(wrap);
  if (typeof value !== 'object') return value;

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (USER_CONTENT_FIELDS.has(key) && typeof v === 'string') {
      out[key] = wrapString(v);
    } else {
      out[key] = wrap(v);
    }
  }
  return out;
}
