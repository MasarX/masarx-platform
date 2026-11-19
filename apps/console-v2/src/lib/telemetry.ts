// telemetry.ts — production telemetry plumbing.
// Forwards web-vitals + ErrorBoundary catches + UI events to api.ui_log_event_v1.
// Development keeps the same no-console behavior as production.
// Sentry is opt-in via VITE_SENTRY_DSN — when set, errors and breadcrumbs are forwarded
// (but the SDK itself is dynamically imported only when DSN is set so the dev bundle stays small).
import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals';
import * as api from './api';

export interface TelemetryEvent {
  kind: string;
  // Free-form payload. Should not contain PII.
  payload: Record<string, unknown>;
  // Optional correlation. Useful for joining UI events to backend decision_log entries.
  correlation_id?: string;
}

export function reportEvent(event: TelemetryEvent) {
  try {
    api.ui_log_event_v1?.(event, 'console-v2');
  } catch {
    // never throw from telemetry
  }
}

export function reportError(error: Error, context?: Record<string, unknown>) {
  reportEvent({
    kind: 'ui.error',
    payload: { message: error.message, stack: error.stack, ...context },
  });
}

function handleVital(metric: Metric) {
  reportEvent({
    kind: `web_vital.${metric.name.toLowerCase()}`,
    payload: {
      value: metric.value,
      rating: metric.rating, // 'good' | 'needs-improvement' | 'poor'
      delta: metric.delta,
      navigation_type: metric.navigationType,
      id: metric.id,
    },
  });
}

export function startTelemetry() {
  // Core Web Vitals — always on.
  onCLS(handleVital);
  onFCP(handleVital);
  onINP(handleVital);
  onLCP(handleVital);
  onTTFB(handleVital);

  // Sentry — opt-in via env. The package is NOT in dependencies; consumers who want
  // Sentry must `npm install @sentry/react` themselves AND set VITE_SENTRY_DSN.
  // We construct the module name as a runtime string so Vite's static import-analysis
  // never sees the literal "@sentry/react" — that prevents both dev-mode resolution
  // failures and production bundling attempts when the package is absent.
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (dsn) {
    const moduleName = ['@', 'sentry', '/', 'react'].join('');
    const dynImport = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>;
    dynImport(moduleName)
      .then((mod) => {
        const Sentry = mod as { init?: (options: Record<string, unknown>) => void };
        Sentry.init?.({
          dsn,
          tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE) || 0.1,
          environment: import.meta.env.MODE,
        });
      })
      .catch(() => {
        // @sentry/react not installed — that's OK. We still log to api.ui_log_event_v1.
      });
  }
}
