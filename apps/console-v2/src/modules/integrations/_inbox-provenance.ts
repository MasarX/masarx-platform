// _inbox-provenance.ts — pure derivation of the webhook_inbox → workflow_run →
// shipment chain.
//
// Backend SSOT:
//   - `webhook_inbox.workflow_run_id` ← supabase/migrations/202510110004_webhook_integration.sql:214+
//   - `domain_events { resource_type, resource_id, workflow_run_id, event_type='shipment.*' }`
//     is the canonical projection that links a workflow_run to the resulting
//     shipment_id. Per `supabase/migrations/202511160100_domain_events_core.sql`,
//     the canonical convention is `resource_type + resource_id` (the FE used to
//     collapse this to `aggregate_id` pre-W14-4). We derive the resulting
//     shipment_id by joining on the run id and filtering domain_events whose
//     event_type starts with `shipment.` (shipment.created / shipment.updated / etc.).
//
// All functions here are pure so they can be unit-tested without React or any
// network seam — the React module composes them on top of `useResourceList`
// reads. Keeping the derivation pure also matches the canonical resolver
// pattern (one SSOT, no shadow joins in component code).
//
// Spec-Issue: trace lifecycle close. Step: lifecycle-link.

/* ---------- shapes ---------- */

export interface InboxRowLite {
  id: string;
  workflow_run_id?: string | null;
  shipment_id?: string | null;
  status?: string;
}

export interface WorkflowRunLite {
  id: string;
  status?: string;
  correlation_id?: string;
  template_id?: string;
  template_name?: string;
}

// W17-4: dropped FE-only `occurred_at?` alias. Canonical column on
// `public.domain_events` is `created_at` (per
// supabase/migrations/202511160100_domain_events_core.sql:13-28). The
// derivation helpers below filter by `workflow_run_id` + `event_type` only,
// so no time field is consumed here; the registry projection feeds
// `created_at` to consumers that need it (see W14-4 / W16-2 closure).
export interface DomainEventLite {
  id: string;
  event_type?: string;
  resource_type?: string;
  resource_id?: string;
  workflow_run_id?: string | null;
  correlation_id?: string;
}

export interface InboxProvenance {
  /** The original inbox row id (echoed for callers). */
  inbox_id: string;
  /** The workflow_run row, if the inbox row pointed at one. */
  workflow_run: WorkflowRunLite | null;
  /** The resulting shipment id, derived from domain_events. `null` until a
   * `shipment.*` aggregate has been emitted by the run. */
  shipment_id: string | null;
  /** Convenience: the run's correlation id (or the inbox id namespace fallback). */
  correlation_id: string | null;
}

/* ---------- pure derivations ---------- */

/**
 * Resolve the workflow_run that processed an inbox row.
 * Returns `null` when the row had no workflow_run_id (dead_letter or schema
 * validation failed before the workflow started) or when the run is not yet
 * visible in the runs projection.
 */
export function resolveWorkflowRun(
  inbox: InboxRowLite,
  runs: ReadonlyArray<WorkflowRunLite>,
): WorkflowRunLite | null {
  if (!inbox.workflow_run_id) return null;
  const found = runs.find((r) => r.id === inbox.workflow_run_id);
  return found ?? null;
}

/**
 * Resolve the resulting shipment_id from a workflow_run by inspecting
 * `domain_events` for `shipment.*` aggregates emitted by that run.
 * Returns `null` when the run is missing, no shipment event has fired yet, or
 * the run is for a non-shipment workflow (e.g. NDR resolution, shift close).
 *
 * Picks the FIRST `shipment.created` event when present, falling back to the
 * first `shipment.*` event (e.g. `shipment.amended`) so already-existing
 * shipments still surface a deep-link.
 */
export function resolveResultingShipmentId(
  run: WorkflowRunLite | null,
  events: ReadonlyArray<DomainEventLite>,
): string | null {
  if (!run?.id) return null;
  const matches = events.filter(
    (e) =>
      e.workflow_run_id === run.id &&
      typeof e.event_type === 'string' &&
      e.event_type.startsWith('shipment.') &&
      typeof e.resource_id === 'string' &&
      e.resource_id.length > 0,
  );
  if (!matches.length) return null;
  const created = matches.find((e) => e.event_type === 'shipment.created');
  return (created ?? matches[0]).resource_id ?? null;
}

/**
 * Compute the full provenance chain for a given inbox row.
 * Pure composition: callers feed pre-fetched runs + domain_events arrays.
 */
export function deriveInboxProvenance(
  inbox: InboxRowLite,
  runs: ReadonlyArray<WorkflowRunLite>,
  events: ReadonlyArray<DomainEventLite>,
): InboxProvenance {
  const workflow_run = resolveWorkflowRun(inbox, runs);
  const shipment_id =
    resolveResultingShipmentId(workflow_run, events) ??
    (typeof inbox.shipment_id === 'string' && inbox.shipment_id.length > 0
      ? inbox.shipment_id
      : null);
  return {
    inbox_id: inbox.id,
    workflow_run,
    shipment_id,
    correlation_id: workflow_run?.correlation_id ?? null,
  };
}

/**
 * Build a deep-link path that focuses the resulting shipment in the
 * Operate › Shipments registry.
 *
 * Convention: the shipments module honors `/operate/shipments?focus=<id>`
 * (see apps/console-v2/src/modules/operate/shipments.tsx — the deep-link
 * useEffect at the top of `ShipmentsModule`).
 */
export function buildShipmentDeepLink(shipment_id: string): string {
  return `/operate/shipments?focus=${encodeURIComponent(shipment_id)}`;
}

/**
 * Build a deep-link path that opens the trace explorer for a given
 * correlation id.
 *
 * Convention: insights/traces accepts `?cor=<correlation_id>` and renders
 * the spans graph for that correlation.
 */
export function buildTraceDeepLink(correlation_id: string): string {
  return `/insights/traces?cor=${encodeURIComponent(correlation_id)}`;
}
