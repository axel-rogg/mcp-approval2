/**
 * PrfSessionService — kurzlebige In-Memory-Speicherung von WebAuthn-PRF-Outputs.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.3.
 *
 * Flow:
 *   1. User triggert Tool-Call der ein PRF-Credential braucht.
 *   2. PWA prompted Approval → WebAuthn-Sign + PRF-Eval (gleicher Schritt).
 *   3. PWA postet prfOutput an `POST /v1/credentials/prf-session` → erhaelt
 *      `prfSessionId` zurueck.
 *   4. PWA reicht prfSessionId an den Tool-Aufruf weiter. Hub resolved
 *      `get(prfSessionId, userId)` → liefert die 32 Byte zurueck.
 *   5. Hub baut damit Credentials decrypt + ruft Sub-MCP.
 *   6. Nach TTL (5 min default) wird der Eintrag gesweept.
 *
 * Phase-1-Variante: simpler in-memory Map. Single-Instance-only.
 * TODO Phase 2 (Multi-Instance): Redis mit AES-GCM-wrapped storage + Subscribe-
 * Pub-Sub fuer cross-node invalidation. Dann Interface gleichbleibend, nur
 * der Backing-Store wechselt.
 *
 * Security:
 *   - prfOutput verlaesst niemals den Server-Heap (kein DB-Persist, kein Log).
 *   - `userId`-Binding: Reads MUESSEN userId angeben — verhindert dass ein
 *     leaked prfSessionId von einem anderen Account benutzt werden kann.
 *   - TTL hard-enforced (default 5 min). Periodischer Sweep cleanup'd
 *     expired entries.
 *   - revoke ist idempotent (returns void); ungueltige IDs sind silent no-ops.
 */
import { randomBytes } from '@mcp-approval2/core';

const DEFAULT_TTL_SEC = 5 * 60;

interface PrfSessionEntry {
  readonly prfOutput: Uint8Array;
  readonly userId: string;
  readonly credentialId: string | null;
  readonly expiresAt: number;
}

export interface PrfSessionStoreArgs {
  readonly userId: string;
  readonly prfOutput: Uint8Array;
  readonly ttlSec?: number;
  readonly credentialId?: string;
}

export interface PrfSessionService {
  store(args: PrfSessionStoreArgs): Promise<string>;
  get(prfSessionId: string, userId: string): Promise<Uint8Array | null>;
  revoke(prfSessionId: string): Promise<void>;
  sweep(): Promise<number>;
  /** Test-Hook: anzahl noch-aktiver entries. */
  size(): number;
}

function randomId(): string {
  // 24 Byte hex = 48 chars, ausreichend Entropie + URL-safe.
  const bytes = randomBytes(24);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i] ?? 0;
    out += v.toString(16).padStart(2, '0');
  }
  return out;
}

export class InMemoryPrfSessionService implements PrfSessionService {
  private readonly store_ = new Map<string, PrfSessionEntry>();

  constructor(
    private readonly opts: { defaultTtlSec?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  async store(args: PrfSessionStoreArgs): Promise<string> {
    if (args.prfOutput.byteLength !== 32) {
      throw new Error('prfOutput must be 32 bytes');
    }
    const id = randomId();
    const ttl = (args.ttlSec ?? this.opts.defaultTtlSec ?? DEFAULT_TTL_SEC) * 1000;
    this.store_.set(id, {
      prfOutput: args.prfOutput,
      userId: args.userId,
      credentialId: args.credentialId ?? null,
      expiresAt: this.now() + ttl,
    });
    return id;
  }

  async get(prfSessionId: string, userId: string): Promise<Uint8Array | null> {
    const entry = this.store_.get(prfSessionId);
    if (!entry) return null;
    if (entry.expiresAt < this.now()) {
      this.store_.delete(prfSessionId);
      return null;
    }
    if (entry.userId !== userId) return null;
    return entry.prfOutput;
  }

  async revoke(prfSessionId: string): Promise<void> {
    this.store_.delete(prfSessionId);
  }

  async sweep(): Promise<number> {
    const now = this.now();
    let removed = 0;
    for (const [id, entry] of this.store_) {
      if (entry.expiresAt < now) {
        this.store_.delete(id);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.store_.size;
  }
}

/** Factory matching the Phase-1 in-memory variant. */
export function createPrfSessionService(opts: { defaultTtlSec?: number } = {}): PrfSessionService {
  return new InMemoryPrfSessionService(opts);
}
