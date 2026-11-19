import { lookupRow } from '@/lib/api';

export interface WebhookTesterPlugin {
  id: string;
  [key: string]: unknown;
}

export interface TraceStep {
  name: string;
  ms: number;
  ok: boolean;
  [k: string]: unknown;
}

export type ForcedStatus = string;

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

  const name = String(failed.name).toLowerCase();
  if (name.includes('parse') || name.includes('verify')) return 400;
  if (name.includes('validate') || name.includes('mapping')) return 422;
  return 500;
}

export function buildRequestEnvelope(plugin: WebhookTesterPlugin | undefined, payloadJson: string) {
  return {
    method: 'POST',
    url: 'https://<project>.supabase.co/functions/v1/webhook-receiver',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': '<unique-event-id>',
      'x-correlation-id': '<uuid>',
      'x-webhook-token': '<source-token>',
      'x-plugin-diagnostic': plugin?.id ?? '',
    },
    body: payloadJson,
  };
}

export function buildResponseEnvelope(
  steps: TraceStep[],
  durationMs: number,
  forcedStatus: ForcedStatus,
) {
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
