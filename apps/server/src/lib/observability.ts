/**
 * OpenTelemetry-Setup (Stub, env-gated).
 *
 * Plan-Ref: PLAN-architecture-v1.md §6 (Audit + Observability), Phase 7.
 *
 * Status: Stub. Aktivierung wird in Phase 7 (Production-Hardening) ausgebaut.
 * Bis dahin gilt:
 *   - Wenn `OTEL_EXPORTER_OTLP_ENDPOINT` nicht gesetzt: `initObservability()`
 *     ist ein No-Op. Kein @opentelemetry/*-Import wird tatsaechlich geladen.
 *   - Wenn gesetzt: logge nur eine Warnung dass der OTel-SDK-Wireup noch nicht
 *     fertig ist; ein zukuenftiger Patch wird hier ein NodeSDK booten +
 *     auto-instrumentations registrieren.
 *
 * Was hier NICHT passiert:
 *   - Tracing-SDK-Init (kommt mit Phase 7 / `@opentelemetry/sdk-node`).
 *   - Metrics-Export (kommt mit Phase 7 / Prometheus oder OTLP-Metrics).
 *   - Resource-Attribute-Setting (service.name, deployment.environment) — wird
 *     im SDK-Init gemacht.
 *
 * TODO(phase-7): NodeSDK + getNodeAutoInstrumentations + OTLPTraceExporter
 * verkabeln. Voraussichtliche Dependencies:
 *   - @opentelemetry/api
 *   - @opentelemetry/sdk-node
 *   - @opentelemetry/auto-instrumentations-node
 *   - @opentelemetry/exporter-trace-otlp-http
 *   - @opentelemetry/exporter-metrics-otlp-http
 *
 * Hinweis fuer Auditor: Audit-Log + HTTP-Request-Log laufen NICHT ueber OTel,
 * sie nutzen den pino-Logger / `audit-sink.ts`. OTel ist hier nur fuer
 * Distributed-Tracing + Performance-Metrics (Latenz, Tool-Call-Dauer,
 * DB-Roundtrips), nicht fuer Compliance-Events.
 */
import { baseLogger } from './logger.js';

export interface ObservabilityInitOptions {
  /**
   * Override fuer `process.env`. Tests/CLI koennen ein leeres Objekt
   * uebergeben um No-Op zu erzwingen.
   */
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

/**
 * Initialisiert (kuenftig) das OTel-SDK. Aktuell:
 *   - No-Op wenn `OTEL_EXPORTER_OTLP_ENDPOINT` fehlt.
 *   - Warnung wenn gesetzt aber SDK noch nicht fertig.
 *
 * Idempotent — mehrfacher Aufruf ist sicher (nur Logging passiert).
 */
export function initObservability(options: ObservabilityInitOptions = {}): void {
  const env = options.env ?? process.env;
  const endpoint = env['OTEL_EXPORTER_OTLP_ENDPOINT'];

  if (!endpoint) {
    // No-Op — production-default ist OTel-aus, weil Pilot keinen Collector hat.
    return;
  }

  // Phase-7-TODO siehe Datei-Header.
  baseLogger.warn(
    {
      endpoint,
      phase: 'observability-stub',
    },
    'observability.otel.not_yet_wired',
  );
}

/**
 * Re-Export fuer Compatibility — falls jemand schon einen Tracer importiert
 * (Burst-2 Subagent), liefern wir ihm ein No-Op-Shim. Wird in Phase 7
 * durch `@opentelemetry/api`.`trace.getTracer()` ersetzt.
 */
export interface NoopTracer {
  startSpan(name: string): NoopSpan;
}

export interface NoopSpan {
  end(): void;
  setAttribute(_key: string, _value: unknown): void;
}

export function getTracer(_name: string): NoopTracer {
  return {
    startSpan(_n: string): NoopSpan {
      return {
        end(): void {
          /* noop */
        },
        setAttribute(_k: string, _v: unknown): void {
          /* noop */
        },
      };
    },
  };
}
