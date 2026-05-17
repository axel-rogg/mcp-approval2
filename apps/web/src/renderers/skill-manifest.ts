/**
 * Renderer für `skill_manifest` — Markdown mit YAML-Frontmatter zwischen
 * `---`-Delimitern am Anfang.
 *
 * Frontmatter (slug, description, version, trigger_hints) wird als `<dl>`
 * gerendert, der Body danach via renderMarkdown.
 *
 * Minimaler inline-YAML-Parser (keine dep) — unterstützt nur Skalare
 * (`key: value`) und Inline-Arrays (`key: [a, b, c]`). Reicht für die
 * ~4 Felder eines Skill-Manifests.
 */
import { renderMarkdown } from './markdown.js';

interface Frontmatter {
  readonly fields: ReadonlyArray<readonly [string, string]>;
  readonly body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseFrontmatter(text: string): Frontmatter {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { fields: [], body: text };
  const yaml = m[1] ?? '';
  const body = m[2] ?? '';
  const fields: Array<readonly [string, string]> = [];
  for (const line of yaml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const rawVal = trimmed.slice(colon + 1).trim();
    if (!key) continue;
    fields.push([key, formatYamlValue(rawVal)]);
  }
  return { fields, body };
}

function formatYamlValue(raw: string): string {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1);
    return inner
      .split(',')
      .map((s) => stripQuotes(s.trim()))
      .filter((s) => s.length > 0)
      .join(', ');
  }
  return stripQuotes(raw);
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export function renderSkillManifest(text: string): HTMLElement {
  const { fields, body } = parseFrontmatter(text ?? '');
  const wrapper = document.createElement('div');
  wrapper.className = 'skill-manifest-rendered';

  if (fields.length > 0) {
    const section = document.createElement('section');
    section.className = 'skill-manifest-frontmatter';
    const dl = document.createElement('dl');
    for (const [k, v] of fields) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    section.appendChild(dl);
    wrapper.appendChild(section);
  }

  if (body.trim().length > 0) {
    wrapper.appendChild(renderMarkdown(body));
  }
  return wrapper;
}
