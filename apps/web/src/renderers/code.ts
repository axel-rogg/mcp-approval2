/**
 * Code-Renderer fuer subtype='doc' mit non-markdown text-Inhalt.
 *
 * Plaintext mit monospace + (optional) Sprach-Hint im Header.
 * Syntax-Highlighting kommt in separater Folge-PR.
 */

export function renderCode(text: string, language?: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'code-rendered';

  if (language) {
    const hint = document.createElement('div');
    hint.className = 'code-lang-hint muted small';
    hint.textContent = language;
    wrapper.appendChild(hint);
  }

  const pre = document.createElement('pre');
  pre.className = 'code-block';
  const codeEl = document.createElement('code');
  codeEl.textContent = text || '(empty)';
  if (language) {
    codeEl.className = `language-${language}`;
  }
  pre.appendChild(codeEl);
  wrapper.appendChild(pre);

  return wrapper;
}
