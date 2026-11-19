// _helpers.ts — pure derivation helpers shared across the integrations modules.
// Keeping these out of the *.tsx component files satisfies react-refresh
// (a module that exports anything other than components disables fast refresh).

import { lookupRow } from '@/lib/api';

// ---------- credentials ----------

export interface ProviderAuthConfigDerivable {
  status?: string;
  expires_at?: string;
  created_at?: string;
  last_rotated_at?: string;
}

export type DerivedCredStatus = 'active' | 'expiring' | 'expired' | 'revoked' | 'unknown';

/**
 * Derive a credential status from `expires_at` / `created_at`.
 * Background: `provider_auth_configs` (supabase/migrations/202510110004) does NOT carry
 * a `status` column. Rotation time is backend-maintained as `last_rotated_at`
 * and this helper keeps the create-time fallback for older rows.
 *
 * Cycle E P1 #9 closure (AGENTS.md §2 ZERO HARDCODING): the canonical
 * resolver lives in `modules/integrations/credentials.tsx` and reads
 * `provider_credential_policy.expiring_days_threshold` via
 * `useResolveSettings`. This shared helper accepts the threshold as a
 * parameter so call sites (and tests) stay deterministic.
 *
 * W69 Cycle F-R-9 P2-6 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT +
 * §6 row-driven by configuration): `expiringDaysThreshold` is now a
 * REQUIRED parameter — the legacy `30` default literal has been removed.
 * Callers must explicitly pass the threshold resolved through
 * `useResolveSettings('provider_credential_policy')` (live component) or
 * the canonical `DEFAULT_EXPIRING_DAYS_THRESHOLD` constant exported from
 * `modules/integrations/credentials.tsx` (test seam / fallback when the
 * resolved policy row is unavailable). The signature itself now enforces
 * the SSOT boundary at the type system level.
 */
export function deriveCredStatus(
  row: ProviderAuthConfigDerivable,
  expiringDaysThreshold: number,
  nowMs: number = Date.now(),
): DerivedCredStatus {
  // W71-Integrations (Cycle F-R-11) closure — lifecycle resolution flows
  // through the canonical `provider_auth_status.metadata.lifecycle` token
  // instead of inline `row.status === 'revoked'|'active'` literal compares.
  // AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven).
  const lifecycle = lookupRow('provider_auth_status', row.status ?? '')?.metadata?.lifecycle;
  if (lifecycle === 'revoked') return 'revoked';
  if (!row.expires_at) return lifecycle === 'active' ? 'active' : 'unknown';
  const exp = Date.parse(row.expires_at);
  if (Number.isNaN(exp)) return 'unknown';
  if (exp <= nowMs) return 'expired';
  const daysLeft = Math.floor((exp - nowMs) / (1000 * 60 * 60 * 24));
  if (daysLeft <= expiringDaysThreshold) return 'expiring';
  return 'active';
}

export function deriveLastRotatedAt(row: ProviderAuthConfigDerivable): string | undefined {
  return row.last_rotated_at ?? row.created_at;
}

// ---------- webhook tester ----------

export interface TraceStep {
  name: string;
  ms: number;
  ok: boolean;
  [k: string]: unknown;
}

// Cycle E P1 #10 closure: `ForcedStatus` is a `string` alias rather than a
// literal-union — the canonical seed (`webhook_forced_status` lookup) drives
// the valid values, so adding/removing an HTTP code doesn't require changing
// a TS literal here.
export type ForcedStatus = string;

export interface RequestEnvelope {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface ResponseEnvelope {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Map a step trace to a derived HTTP status code:
 * - 200 when all steps ok
 * - 0 when no steps recorded (idle)
 * - canonical-first: when the failed step carries `failure_class`, resolve
 *   `lookups.trace_step_failure_class[failure_class].metadata.http_status`.
 * - TODO (P3-deferred): legacy substring-on-step-name fallback (parse/verify
 *   → 400, validate/mapping → 422, else 500) until the trace emitter ships
 *   `failure_class` consistently across plugin runs.
 */
export function deriveResponseStatus(steps: TraceStep[]): number {
  if (!steps.length) return 0;
  const failed = steps.find((s) => !s.ok);
  if (!failed) return 200;

  const failureClass = (failed as { failure_class?: string }).failure_class;
  if (failureClass) {
    const row = lookupRow('trace_step_failure_class', String(failureClass)) as
      | { metadata?: { http_status?: number } }
      | null;
    const code = row?.metadata?.http_status;
    if (typeof code === 'number') return code;
  }

  // TODO (P3-deferred): drop this substring fallback once the trace emitter
  // ships `failure_class` consistently. Tracked in
  // __audit__/SCHEMA-DRIFT/INTEGRATIONS.md.
  const name = String(failed.name).toLowerCase();
  if (name.includes('parse') || name.includes('verify')) return 400;
  if (name.includes('validate') || name.includes('mapping')) return 422;
  return 500;
}

export function buildRequestEnvelope(
  plugin: { id: string; name?: string; version?: string } | undefined,
  payloadJson: string,
): RequestEnvelope {
  // Cycle E P3 #19 closure: when no plugin is selected, surface the gap
  // explicitly via the URL path (`<no-plugin>`) rather than the silent
  // `unknown` fallback that previously masked it. The header still
  // strips empty `x-webhook-source` so downstream stays well-formed.
  const id = plugin?.id ?? '<no-plugin>';
  return {
    method: 'POST',
    url: `https://<project>.supabase.co/functions/v1/webhook-receiver/${id}`,
    headers: {
      'content-type': 'application/json',
      'x-correlation-id': '<uuid>',
      'x-webhook-source': plugin?.id ?? '',
    },
    body: payloadJson,
  };
}

export function buildResponseEnvelope(
  steps: TraceStep[],
  durationMs: number,
  forcedStatus: ForcedStatus,
): ResponseEnvelope {
  const status = forcedStatus === 'auto' ? deriveResponseStatus(steps) : Number(forcedStatus);
  const ok = status >= 200 && status < 300;
  const body =
    status === 0
      ? { ok: false, message: 'no run yet' }
      : ok
      ? { accepted: true, processed_steps: steps.length, duration_ms: durationMs }
      : {
          accepted: false,
          status,
          failed_step: steps.find((s) => !s.ok)?.name ?? null,
          duration_ms: durationMs,
        };
  return {
    status,
    ok,
    headers: {
      'content-type': 'application/json',
      'x-correlation-id': '<uuid>',
      'x-trace-step-count': String(steps.length),
    },
    body,
  };
}
