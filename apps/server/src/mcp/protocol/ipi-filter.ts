/**
 * IPI-Output-Sanitization.
 *
 * Plan-Ref: PLAN-architecture-v1.md §2 Request-Lifecycle Step 8 ("IPI-Output-
 * Filter"), §9 (Sub-MCP-Server — Outputs sind nicht trust-worthy).
 *
 * Indirect-Prompt-Injection: ein externer Datenkanal (Email-Body, Wiki-Page,
 * Tool-Output von Drittsystem) enthaelt Anweisungen, die das LLM zur
 * Ausfuehrung verleiten sollen. Mitigation:
 *
 *   1. Unicode-Normalize (NFC) + Strip Zero-Width / Bi-Di Override Chars.
 *      Verhindert "rendered text != raw text"-Attacken.
 *   2. Suspicious-Pattern-Detection — Heuristik fuer typische Prompt-Inject-
 *      Phrasen. Liefert Confidence-Score 0..1.
 *   3. Bei hoher Confidence: Replace mit Marker-Text + Audit-Log-Event. Das
 *      LLM bekommt nie den Raw-Inject.
 *
 * Wichtig: das ist KEIN Read-Approval-Eskalator. Read-Tools laufen weiter
 * ohne PWA-Click — wir filtern nur den OUTPUT-Strom (siehe Memory
 * `feedback_ipi_output_filter_not_approval`).
 *
 * Beibehaltung der MCP-Wire-Shape: `ToolsCallResult.content[]` bleibt
 * strukturell identisch. Nur die `text`-Felder werden ueberarbeitet.
 */
import type { ToolResultContent, ToolsCallResult } from './types.js';

// ============================================================================
// Konfiguration
// ============================================================================

/** Confidence-Schwelle ab der wir den Output ersetzen. */
const SANITIZE_THRESHOLD = 0.7;

/** Marker, der den Original-Output ersetzt. */
const SANITIZED_MARKER =
  '[Tool output was sanitized due to suspected prompt injection. Audit-Log enthaelt den Original-Output-Hash.]';

/**
 * Suspicious-Pattern. Jeder Treffer addiert `weight` zum Confidence-Score
 * (clamped auf 1.0).
 *
 * Quellen: OWASP LLM01 Prompt-Injection, Anthropic Constitutional-AI-Patterns,
 * eigene Heuristik aus mcp-approval-Erfahrung (2025-2026).
 */
interface SuspiciousPattern {
  readonly name: string;
  readonly regex: RegExp;
  readonly weight: number;
}

const PATTERNS: ReadonlyArray<SuspiciousPattern> = [
  // Direct override attempts
  { name: 'ignore_previous', regex: /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|preceding)\s+(instructions?|prompts?|messages?|rules?)/i, weight: 0.9 },
  { name: 'new_instructions', regex: /\b(new|updated|important)\s+instructions?:/i, weight: 0.6 },
  { name: 'system_prompt_leak', regex: /\b(reveal|show|print|display|repeat)\s+(your|the)\s+(system|initial|hidden)\s+(prompt|instructions?|rules?|message)/i, weight: 0.85 },

  // Role-impersonation / chat-template tokens
  { name: 'system_role_prefix', regex: /^\s*(system|assistant|user)\s*[:>]/im, weight: 0.5 },
  { name: 'im_start_token', regex: /<\|im_start\|>|<\|im_end\|>/i, weight: 0.95 },
  { name: 'inst_token', regex: /\[INST\]|\[\/INST\]/, weight: 0.8 },
  { name: 'claude_human_marker', regex: /\b(Human|Assistant):\s/m, weight: 0.4 },

  // Action-coercion
  { name: 'execute_command', regex: /\b(execute|run|invoke)\s+(the\s+)?(following|next)\s+(command|tool|function)/i, weight: 0.7 },
  { name: 'send_email_inject', regex: /\b(send|forward|exfiltrate)\s+(this|the|all)\s+(data|content|conversation|history)\s+to/i, weight: 0.85 },

  // Constraint-removal
  { name: 'admin_mode', regex: /\b(developer|admin|debug|jailbreak|dan)\s+mode\b/i, weight: 0.6 },
  { name: 'no_restrictions', regex: /\b(without|no)\s+(restrictions?|filters?|safety|limits?|guardrails?)/i, weight: 0.5 },

  // Hidden-instruction markers
  { name: 'sudo_marker', regex: /\bsudo\s+\(/i, weight: 0.4 },
  { name: 'pretend_you_are', regex: /\bpretend\s+(you\s+are|that\s+you\s+are)/i, weight: 0.5 },
];

/** Zero-Width / Bi-Di-Control Chars die wir aus Texten strippen. */
const INVISIBLE_RANGES_RE =
  /[​-‏‪-‮⁠-⁯﻿]/g;

// ============================================================================
// Public API
// ============================================================================

export interface IpiScanResult {
  readonly confidence: number;
  readonly matches: ReadonlyArray<{ pattern: string; snippet: string }>;
  readonly sanitized: boolean;
}

export interface SanitizedToolResult {
  readonly result: ToolsCallResult;
  readonly scan: IpiScanResult;
}

/**
 * Filtert einen `ToolsCallResult`. Returns das gefilterte Ergebnis + den
 * Scan-Report (fuer Audit-Logging).
 */
export function ipiFilter(result: ToolsCallResult): SanitizedToolResult {
  let totalConfidence = 0;
  const matches: Array<{ pattern: string; snippet: string }> = [];
  const filteredContent: ToolResultContent[] = [];

  for (const item of result.content) {
    if (item.type !== 'text' || !item.text) {
      filteredContent.push(item);
      continue;
    }

    const { normalized, invisibleStripped } = normalizeText(item.text);
    const scan = scanText(normalized);

    if (invisibleStripped > 0) {
      // Schwacher Indicator: zero-width-Chars allein triggern nicht den
      // High-Confidence-Replace, aber wir bumpen das Confidence um 0.1.
      scan.confidence = Math.min(1, scan.confidence + 0.1);
    }

    totalConfidence = Math.max(totalConfidence, scan.confidence);
    matches.push(...scan.matches);

    if (scan.confidence >= SANITIZE_THRESHOLD) {
      filteredContent.push({ type: 'text', text: SANITIZED_MARKER });
    } else {
      filteredContent.push({ type: 'text', text: normalized });
    }
  }

  const sanitized = totalConfidence >= SANITIZE_THRESHOLD;
  return {
    result: {
      content: filteredContent,
      ...(sanitized ? { isError: false } : result.isError !== undefined ? { isError: result.isError } : {}),
      _meta: {
        ...(result._meta ?? {}),
        ipi_scan: {
          confidence: round3(totalConfidence),
          match_count: matches.length,
          sanitized,
        },
      },
    },
    scan: {
      confidence: round3(totalConfidence),
      matches,
      sanitized,
    },
  };
}

/**
 * Standalone Text-Scan — exportiert fuer Unit-Tests.
 */
export function scanText(input: string): {
  confidence: number;
  matches: Array<{ pattern: string; snippet: string }>;
} {
  let confidence = 0;
  const matches: Array<{ pattern: string; snippet: string }> = [];
  for (const p of PATTERNS) {
    const m = p.regex.exec(input);
    if (m) {
      confidence = Math.min(1, confidence + p.weight);
      const start = Math.max(0, (m.index ?? 0) - 20);
      const end = Math.min(input.length, (m.index ?? 0) + m[0].length + 20);
      matches.push({
        pattern: p.name,
        snippet: input.slice(start, end),
      });
    }
  }
  return { confidence, matches };
}

/**
 * Unicode-Normalize (NFC) + strip invisible chars. Returns (normalized,
 * count-of-stripped-invisibles).
 */
export function normalizeText(input: string): {
  normalized: string;
  invisibleStripped: number;
} {
  const nfc = input.normalize('NFC');
  let stripped = 0;
  const cleaned = nfc.replace(INVISIBLE_RANGES_RE, () => {
    stripped += 1;
    return '';
  });
  return { normalized: cleaned, invisibleStripped: stripped };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
