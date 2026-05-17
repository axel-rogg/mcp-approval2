/**
 * Code-Renderer mit Syntax-Highlighting via highlight.js.
 *
 * Wrapper-Konvention: `<div class="body-content code-rendered">` (unified
 * body-content-style — siehe styles.css). KEINE extra-Border/Background;
 * der Body-Card ist der einzige Rahmen, wir füllen ihn.
 *
 * Sicherheit: highlight.js läuft auf `textContent` (kein User-HTML rein),
 * setzt nur eigene class-Names + Text-Children. Kein XSS-Risiko.
 *
 * Language-Hint:
 *   - explicit (z.B. 'python') → `hljs.highlight(text, {language})`
 *   - undefined → `hljs.highlightAuto(text)` (autodetect)
 *   - fallback bei unknown lang → autodetect
 */
import hljs from 'highlight.js/lib/common';

export function renderCode(text: string, language?: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'body-content code-rendered';

  const pre = document.createElement('pre');
  pre.className = 'code-block';
  const codeEl = document.createElement('code');

  const safe = text || '';
  try {
    if (language && hljs.getLanguage(language)) {
      const result = hljs.highlight(safe, { language, ignoreIllegals: true });
      codeEl.innerHTML = result.value;
      codeEl.className = `hljs language-${language}`;
    } else {
      const result = hljs.highlightAuto(safe);
      codeEl.innerHTML = result.value;
      codeEl.className = `hljs language-${result.language ?? 'plaintext'}`;
    }
  } catch {
    // Highlighting fail → fall back to plain text (always renders)
    codeEl.textContent = safe;
    codeEl.className = 'hljs language-plaintext';
  }

  pre.appendChild(codeEl);
  wrapper.appendChild(pre);
  return wrapper;
}
