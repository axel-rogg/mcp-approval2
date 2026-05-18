/**
 * Audit-Sink-Adapter (multi-target, fail-soft).
 *
 * Plan-Ref: PLAN-architecture-v1.md §6 (Audit-Logging) + ADR-0019
 * (Audit-Schema-Day-Zero-Sink-Later).
 *
 * Verantwortung:
 *   - `AuditSink`-Interface: einzige Mount-Point fuer alle Audit-Writes.
 *   - `PostgresAuditSink`: schreibt in `audit_log` (Burst-1-Schema, immutable
 *     + append-only). Default + Pflicht-Sink fuer Compliance.
 *   - `OtelAuditSink`: zusaetzlicher Stream zu einem OTLP-/Webhook-Endpoint
 *     (SIEM-Forwarder). Env-gated via `AUDIT_OTEL_ENDPOINT`. Fail-soft —
 *     Pg-Sink ist die source-of-truth, Otel ist sekundaer.
 *   - `CombinedAuditSink`: fan-out auf N Sinks; Fehler einzelner Sinks
 *     blockieren NICHT die anderen.
 *   - `createAuditSink(config)`: Factory mit Mode 'pg' | 'otel' | 'combined'.
 *
 * Design-Entscheidungen:
 *   - Audit darf den Request niemals killen — alle Methoden catchen und loggen
 *     auf stderr (via pino-Logger), gleich wie `emitAudit` schon implementiert.
 *   - Reihenfolge der Sinks im CombinedSink ist Pflicht-Reihenfolge (Pg
 *     zuerst). Wenn Pg failt, geht's trotzdem in Otel — und ein operator-
 *     alarm darf in einem zweiten Iteration-Schritt drauf gesetzt werden.
 *   - SIEM-Format: das `AuditEvent` wird als JSON-NDJSON serialisiert mit
 *     `event_type: 'audit'` + `event_action: <action>` + dem Body. Damit
 *     unterscheidet der Splunk/Loki-Indexer Audit-Events von HTTP-Logs.
 */
import type { DbAdapter } from '@mcp-approval2/adapters';
import { baseLogger } from '../lib/logger.js';
import type { AuditEvent } from './audit.js';
import { emitAudit } from './audit.js';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface AuditSink {
  /**
   * Schreibt ein Audit-Event in den/die Backing-Store(s). Wirft niemals —
   * Implementierungen muessen alle Errors selbst behandeln + auf stderr loggen.
   */
  emit(event: AuditEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// PostgresAuditSink — Pflicht-Sink, schreibt in Burst-1 `audit_log`-Tabelle.
// ---------------------------------------------------------------------------

export class PostgresAuditSink implements AuditSink {
  constructor(private readonly db: DbAdapter) {}

  async emit(event: AuditEvent): Promise<void> {
    // `emitAudit` ist bereits fail-soft (try/catch + console.error). Wir
    // brauchen hier keinen zusaetzlichen Wrapper.
    await emitAudit(this.db, event);
  }
}

// ---------------------------------------------------------------------------
// OtelAuditSink — optionaler Forward an OTLP/Webhook-Endpoint.
// ---------------------------------------------------------------------------

export interface OtelAuditSinkConfig {
  /**
   * HTTPS-Endpoint, das JSON-POST entgegen nimmt. Kann ein OTLP/HTTP-Collector
   * sein, ein Splunk-HEC-Endpoint, ein Loki-Push-API oder ein generic-
   * Webhook. Pflicht.
   */
  readonly endpoint: string;
  /**
   * Bearer-Token fuer den Endpoint. Wenn gesetzt, wird er als
   * `Authorization: Bearer <token>` mitgeschickt.
   */
  readonly token?: string;
  /**
   * Request-Timeout in ms. Default 2000.
   */
  readonly timeoutMs?: number;
  /**
   * `fetch`-Impl — injectable fuer Tests. Default: globaler `fetch`.
   */
  readonly fetchImpl?: typeof fetch;
}

interface OtelPayload {
  readonly event_type: 'audit';
  readonly event_action: string;
  readonly emitted_at: string;
  readonly actor_user_id: string | null;
  readonly target_user_id: string | null;
  readonly result: AuditEvent['result'];
  readonly request_id: string | null;
  readonly ip: string | null;
  readonly user_agent: string | null;
  readonly details: Record<string, unknown> | null;
}

export class OtelAuditSink implements AuditSink {
  private readonly endpoint: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OtelAuditSinkConfig) {
    if (!/^https?:\/\//.test(config.endpoint)) {
      throw new Error('OtelAuditSink: endpoint must be a http(s) URL');
    }
    this.endpoint = config.endpoint;
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? 2000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async emit(event: AuditEvent): Promise<void> {
    const payload: OtelPayload = {
      event_type: 'audit',
      event_action: event.action,
      emitted_at: new Date().toISOString(),
      actor_user_id: event.actorUserId,
      target_user_id: event.targetUserId ?? null,
      result: event.result,
      request_id: event.requestId ?? null,
      ip: event.ip ?? null,
      user_agent: event.userAgent ?? null,
      details: event.details ?? null,
    };

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (this.token) headers['authorization'] = `Bearer ${this.token}`;
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        baseLogger.warn(
          { sink: 'otel', status: res.status, action: event.action },
          'audit.sink.otel.non_2xx',
        );
      }
    } catch (err) {
      baseLogger.warn(
        {
          sink: 'otel',
          action: event.action,
          err: err instanceof Error ? { name: err.name, message: err.message } : { value: String(err) },
        },
        'audit.sink.otel.failed',
      );
    } finally {
      clearTimeout(t);
    }
  }
}

// ---------------------------------------------------------------------------
// GcsWormSink — P2-8: schreibt Audit-Events als immutable NDJSON-Files in
// einen GCS-Bucket mit Object-Retention-Policy (WORM). Compliance-Use-Case:
// SOC-2 / ISO-27001 fordern manipulationsfreie Audit-Trails.
//
// Wire-Format: ein Event pro File unter `<prefix>/<yyyy>/<mm>/<dd>/<ts>-<rand>.json`.
// Operator-Setup (separat via gcloud/Terraform):
//   gcloud storage buckets update gs://<bucket> \
//     --retention-period=7776000s \                      # 90 days
//     --uniform-bucket-level-access \
//     --public-access-prevention=enforced
// Plus: Bucket-Versioning + Soft-Delete-Policy aktivieren damit nichts
// in den ersten 90 Tagen ueberschreibbar/loeschbar ist.
//
// Auth: re-uses ein injectedes `getAccessToken()`-Provider (gleicher Shape
// wie VertexAuth). Im Production-Deploy ist das ein VertexAuth-Instance
// mit Service-Account-JSON; im Dev ein Mock.
//
// Fail-soft: Errors werden auf stderr geloggt, aber nicht geworfen.
// Pg-Sink bleibt source-of-truth — GCS ist defense-in-depth fuer
// Tamper-Evidence ueber lange Zeitraeume.
// ---------------------------------------------------------------------------

export interface GcsWormSinkConfig {
  /** GCS-Bucket-Name (NUR Name, ohne `gs://`). */
  readonly bucket: string;
  /** Pfad-Prefix innerhalb des Buckets. Default: 'audit'. */
  readonly prefix?: string;
  /** Token-Provider — getAccessToken() liefert OAuth2-Access-Token fuer scope `https://www.googleapis.com/auth/devstorage.read_write`. */
  readonly authProvider: { getAccessToken(): Promise<string> };
  /** Request-Timeout in ms. Default 5000. */
  readonly timeoutMs?: number;
  /** Custom fetch (Tests). Default globaler fetch. */
  readonly fetchImpl?: typeof fetch;
}

interface GcsAuditPayload {
  readonly event_type: 'audit';
  readonly event_action: string;
  readonly emitted_at: string;
  readonly actor_user_id: string | null;
  readonly target_user_id: string | null;
  readonly result: AuditEvent['result'];
  readonly request_id: string | null;
  readonly ip: string | null;
  readonly user_agent: string | null;
  readonly details: Record<string, unknown> | null;
}

export class GcsWormSink implements AuditSink {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly authProvider: { getAccessToken(): Promise<string> };
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: GcsWormSinkConfig) {
    if (!config.bucket || /^gs:\/\//.test(config.bucket)) {
      throw new Error(
        'GcsWormSink: bucket must be a bare name (no `gs://`-prefix)',
      );
    }
    this.bucket = config.bucket;
    this.prefix = (config.prefix ?? 'audit').replace(/^\/+|\/+$/g, '');
    this.authProvider = config.authProvider;
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async emit(event: AuditEvent): Promise<void> {
    const payload: GcsAuditPayload = {
      event_type: 'audit',
      event_action: event.action,
      emitted_at: new Date().toISOString(),
      actor_user_id: event.actorUserId,
      target_user_id: event.targetUserId ?? null,
      result: event.result,
      request_id: event.requestId ?? null,
      ip: event.ip ?? null,
      user_agent: event.userAgent ?? null,
      details: event.details ?? null,
    };
    const body = JSON.stringify(payload);
    const objectName = this.buildObjectName(event);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const token = await this.authProvider.getAccessToken();
      const url = new URL(
        `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`,
      );
      url.searchParams.set('uploadType', 'media');
      url.searchParams.set('name', objectName);
      // ifGenerationMatch=0: nur INSERT, nie OVERWRITE. Defense-in-depth
      // falls zwei Sinks parallel die gleiche Object-Name vergeben.
      url.searchParams.set('ifGenerationMatch', '0');
      const res = await this.fetchImpl(url.toString(), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        baseLogger.warn(
          {
            sink: 'gcs-worm',
            bucket: this.bucket,
            objectName,
            status: res.status,
            action: event.action,
          },
          'audit.sink.gcs.non_2xx',
        );
      }
    } catch (err) {
      baseLogger.warn(
        {
          sink: 'gcs-worm',
          bucket: this.bucket,
          action: event.action,
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : { value: String(err) },
        },
        'audit.sink.gcs.failed',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private buildObjectName(event: AuditEvent): string {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const ts = now.getTime();
    // 12 chars random (avoid Math.random for cryptographic-grade IDs in
    // tamper-evident audit context — use crypto.randomUUID and take a slice)
    const rand = (
      (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
        ?.randomUUID?.() ?? `${Math.random()}-${Date.now()}`
    )
      .replace(/-/g, '')
      .slice(0, 12);
    const safeAction = event.action.replace(/[^a-zA-Z0-9._-]+/g, '_');
    return `${this.prefix}/${yyyy}/${mm}/${dd}/${ts}-${rand}-${safeAction}.json`;
  }
}

// ---------------------------------------------------------------------------
// CombinedAuditSink — fan-out auf mehrere Sinks, sequential + fail-soft.
// ---------------------------------------------------------------------------

export class CombinedAuditSink implements AuditSink {
  constructor(private readonly sinks: ReadonlyArray<AuditSink>) {
    if (sinks.length === 0) {
      throw new Error('CombinedAuditSink: at least one sink required');
    }
  }

  async emit(event: AuditEvent): Promise<void> {
    // Sequential statt parallel: die einzelnen Sinks sind bereits fail-soft,
    // aber sequenziell vermeiden wir, dass ein langsamer Otel-Endpoint den
    // schnellen Pg-Write blockiert (Pg ist immer erster Eintrag).
    for (const sink of this.sinks) {
      try {
        await sink.emit(event);
      } catch (err) {
        // Sollte nie passieren (Sinks fangen selbst), aber als Belt+Suspenders.
        baseLogger.error(
          {
            sink: sink.constructor.name,
            action: event.action,
            err: err instanceof Error ? { name: err.name, message: err.message } : { value: String(err) },
          },
          'audit.sink.combined.failed',
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type AuditSinkMode = 'pg' | 'otel' | 'combined' | 'gcs' | 'pg+gcs' | 'combined+gcs';

export interface CreateAuditSinkConfig {
  readonly mode: AuditSinkMode;
  readonly pgDb?: DbAdapter;
  readonly otelEndpoint?: string;
  readonly otelToken?: string;
  readonly otelFetchImpl?: typeof fetch;
  /** P2-8: GCS-WORM-Sink Config. */
  readonly gcs?: {
    readonly bucket: string;
    readonly prefix?: string;
    readonly authProvider: { getAccessToken(): Promise<string> };
    readonly timeoutMs?: number;
    readonly fetchImpl?: typeof fetch;
  };
}

/**
 * Factory. Mode-Mapping:
 *   - 'pg' → PostgresAuditSink (Pflicht-Sink, Default).
 *   - 'otel' → OtelAuditSink (NUR Otel; nur Single-User-Dev sinnvoll, weil
 *     Compliance einen persistenten Postgres-Eintrag verlangt).
 *   - 'combined' → CombinedAuditSink([Postgres, Otel]) — Production-Recommended.
 *
 * Bei mode='pg' + 'combined' muss `pgDb` gesetzt sein.
 * Bei mode='otel' + 'combined' muss `otelEndpoint` gesetzt sein.
 */
export function createAuditSink(config: CreateAuditSinkConfig): AuditSink {
  switch (config.mode) {
    case 'pg': {
      if (!config.pgDb) throw new Error('createAuditSink(pg): pgDb required');
      return new PostgresAuditSink(config.pgDb);
    }
    case 'otel': {
      if (!config.otelEndpoint) {
        throw new Error('createAuditSink(otel): otelEndpoint required');
      }
      const otelCfg: OtelAuditSinkConfig = {
        endpoint: config.otelEndpoint,
        ...(config.otelToken !== undefined ? { token: config.otelToken } : {}),
        ...(config.otelFetchImpl !== undefined ? { fetchImpl: config.otelFetchImpl } : {}),
      };
      return new OtelAuditSink(otelCfg);
    }
    case 'combined': {
      if (!config.pgDb) throw new Error('createAuditSink(combined): pgDb required');
      if (!config.otelEndpoint) {
        throw new Error('createAuditSink(combined): otelEndpoint required');
      }
      const otelCfg: OtelAuditSinkConfig = {
        endpoint: config.otelEndpoint,
        ...(config.otelToken !== undefined ? { token: config.otelToken } : {}),
        ...(config.otelFetchImpl !== undefined ? { fetchImpl: config.otelFetchImpl } : {}),
      };
      return new CombinedAuditSink([
        new PostgresAuditSink(config.pgDb),
        new OtelAuditSink(otelCfg),
      ]);
    }
    case 'gcs': {
      if (!config.gcs) throw new Error('createAuditSink(gcs): gcs config required');
      return buildGcsSink(config.gcs);
    }
    case 'pg+gcs': {
      if (!config.pgDb) throw new Error('createAuditSink(pg+gcs): pgDb required');
      if (!config.gcs) throw new Error('createAuditSink(pg+gcs): gcs config required');
      return new CombinedAuditSink([
        new PostgresAuditSink(config.pgDb),
        buildGcsSink(config.gcs),
      ]);
    }
    case 'combined+gcs': {
      if (!config.pgDb) throw new Error('createAuditSink(combined+gcs): pgDb required');
      if (!config.otelEndpoint) {
        throw new Error('createAuditSink(combined+gcs): otelEndpoint required');
      }
      if (!config.gcs) throw new Error('createAuditSink(combined+gcs): gcs config required');
      const otelCfg: OtelAuditSinkConfig = {
        endpoint: config.otelEndpoint,
        ...(config.otelToken !== undefined ? { token: config.otelToken } : {}),
        ...(config.otelFetchImpl !== undefined ? { fetchImpl: config.otelFetchImpl } : {}),
      };
      return new CombinedAuditSink([
        new PostgresAuditSink(config.pgDb),
        new OtelAuditSink(otelCfg),
        buildGcsSink(config.gcs),
      ]);
    }
    default: {
      const exhaustive: never = config.mode;
      throw new Error(`createAuditSink: unknown mode ${String(exhaustive)}`);
    }
  }
}

function buildGcsSink(gcs: NonNullable<CreateAuditSinkConfig['gcs']>): GcsWormSink {
  const cfg: GcsWormSinkConfig = {
    bucket: gcs.bucket,
    authProvider: gcs.authProvider,
    ...(gcs.prefix !== undefined ? { prefix: gcs.prefix } : {}),
    ...(gcs.timeoutMs !== undefined ? { timeoutMs: gcs.timeoutMs } : {}),
    ...(gcs.fetchImpl !== undefined ? { fetchImpl: gcs.fetchImpl } : {}),
  };
  return new GcsWormSink(cfg);
}
