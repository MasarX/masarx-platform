// inbox-provenance-helpers.test.ts — unit tests for the pure derivation
// helpers backing the integrations/intake module.
//
// These run without React or any network seam; the helpers compose pre-fetched
// arrays of inbox rows, workflow_runs, and domain_events to derive the
// resulting shipment_id deep-link target.

import { describe, it, expect } from 'vitest';
import {
  resolveWorkflowRun,
  resolveResultingShipmentId,
  deriveInboxProvenance,
  buildShipmentDeepLink,
  buildTraceDeepLink,
  type InboxRowLite,
  type WorkflowRunLite,
  type DomainEventLite,
} from '../_inbox-provenance';

const RUNS: WorkflowRunLite[] = [
  { id: 'wfr_3221', status: 'running', correlation_id: 'cor_9821' },
  { id: 'wfr_3218', status: 'succeeded', correlation_id: 'cor_9815' },
  { id: 'wfr_3217', status: 'failed', correlation_id: 'cor_9814' },
  { id: 'wfr_3215', status: 'succeeded', correlation_id: 'cor_9810' },
  { id: 'wfr_3220', status: 'succeeded', correlation_id: 'cor_9819' },
];

const EVENTS: DomainEventLite[] = [
  { id: 'evt_1', event_type: 'shipment.created', resource_type: 'shipment', resource_id: 'shp_9381502', workflow_run_id: 'wfr_3215' },
  { id: 'evt_2', event_type: 'shipment.amended', resource_type: 'shipment', resource_id: 'shp_9381301', workflow_run_id: 'wfr_3220' },
  { id: 'evt_3', event_type: 'route_run.assigned', resource_type: 'route_run', resource_id: 'run_2843', workflow_run_id: 'wfr_3221' },
  // 3221 also emits a shipment event later — the helper should still pick it
  { id: 'evt_4', event_type: 'shipment.created', resource_type: 'shipment', resource_id: 'shp_9381999', workflow_run_id: 'wfr_3221' },
];

describe('_inbox-provenance · resolveWorkflowRun', () => {
  it('returns the matching run when workflow_run_id is set', () => {
    const inbox: InboxRowLite = { id: 'wbk_1', workflow_run_id: 'wfr_3215' };
    expect(resolveWorkflowRun(inbox, RUNS)?.id).toBe('wfr_3215');
  });

  it('returns null when workflow_run_id is missing on the row', () => {
    const inbox: InboxRowLite = { id: 'wbk_1' };
    expect(resolveWorkflowRun(inbox, RUNS)).toBeNull();
  });

  it('returns null when workflow_run_id is explicitly null', () => {
    const inbox: InboxRowLite = { id: 'wbk_1', workflow_run_id: null };
    expect(resolveWorkflowRun(inbox, RUNS)).toBeNull();
  });

  it('returns null when the run is not yet visible in the projection', () => {
    const inbox: InboxRowLite = { id: 'wbk_1', workflow_run_id: 'wfr_unknown' };
    expect(resolveWorkflowRun(inbox, RUNS)).toBeNull();
  });
});

describe('_inbox-provenance · resolveResultingShipmentId', () => {
  it('returns the shipment.created aggregate when present', () => {
    const run = RUNS.find((r) => r.id === 'wfr_3215')!;
    expect(resolveResultingShipmentId(run, EVENTS)).toBe('shp_9381502');
  });

  it('prefers shipment.created over other shipment.* events for the same run', () => {
    // wfr_3221 emits both route_run.assigned (ignored) and shipment.created (selected)
    const run = RUNS.find((r) => r.id === 'wfr_3221')!;
    expect(resolveResultingShipmentId(run, EVENTS)).toBe('shp_9381999');
  });

  it('falls back to the first shipment.* event when no shipment.created exists', () => {
    const run = RUNS.find((r) => r.id === 'wfr_3220')!;
    expect(resolveResultingShipmentId(run, EVENTS)).toBe('shp_9381301');
  });

  it('returns null when run is missing', () => {
    expect(resolveResultingShipmentId(null, EVENTS)).toBeNull();
  });

  it('returns null when run has no shipment-resource events (e.g. NDR resolution run)', () => {
    const eventsNoShipment: DomainEventLite[] = [
      { id: 'evt_x', event_type: 'task.resolved', resource_type: 'task', resource_id: 'tsk_1', workflow_run_id: 'wfr_3217' },
    ];
    const run = RUNS.find((r) => r.id === 'wfr_3217')!;
    expect(resolveResultingShipmentId(run, eventsNoShipment)).toBeNull();
  });

  it('ignores shipment.* events from other workflow runs', () => {
    const run: WorkflowRunLite = { id: 'wfr_other', status: 'running' };
    expect(resolveResultingShipmentId(run, EVENTS)).toBeNull();
  });
});

describe('_inbox-provenance · deriveInboxProvenance', () => {
  it('composes the full chain when everything is present', () => {
    const inbox: InboxRowLite = { id: 'wbk_7738', workflow_run_id: 'wfr_3215' };
    const out = deriveInboxProvenance(inbox, RUNS, EVENTS);
    expect(out.inbox_id).toBe('wbk_7738');
    expect(out.workflow_run?.id).toBe('wfr_3215');
    expect(out.shipment_id).toBe('shp_9381502');
    expect(out.correlation_id).toBe('cor_9810');
  });

  it('returns inbox_id with null fields when the inbox has no run', () => {
    const inbox: InboxRowLite = { id: 'wbk_dead' };
    const out = deriveInboxProvenance(inbox, RUNS, EVENTS);
    expect(out).toEqual({
      inbox_id: 'wbk_dead',
      workflow_run: null,
      shipment_id: null,
      correlation_id: null,
    });
  });

  it('returns the run but null shipment when no shipment events have fired', () => {
    const inbox: InboxRowLite = { id: 'wbk_processing', workflow_run_id: 'wfr_3217' };
    const out = deriveInboxProvenance(inbox, RUNS, EVENTS);
    expect(out.workflow_run?.id).toBe('wfr_3217');
    expect(out.shipment_id).toBeNull();
    expect(out.correlation_id).toBe('cor_9814');
  });
});

describe('_inbox-provenance · deep-link builders', () => {
  it('builds the canonical router deep-link to a shipment', () => {
    expect(buildShipmentDeepLink('shp_9381502')).toBe('/operate/shipments?focus=shp_9381502');
  });

  it('builds the canonical router deep-link to a trace by correlation id', () => {
    expect(buildTraceDeepLink('cor_9821')).toBe('/insights/traces?cor=cor_9821');
  });
});
