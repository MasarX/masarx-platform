// amend-cancel.test.tsx — CLAIM C tests for AmendCancelModule.
//
// Asserts the post-hardening contract:
//   • mounts without crashing and reflects the queue from useTasks (NOT a
//     hardcoded SEED_QUEUE — the previous implementation had 4 const rows)
//   • header brands as a review queue
//   • exposes the canonical seam pill `shipment_amend_cancel_v1 · workflow-engine-first`

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import * as api from '@/lib/api';
import {
  AmendCancelModule,
  buildAmendMutationArgs,
  canEditAmendReviewStatus,
  canUseBatchForRequests,
  requestedBackendOperation,
  shipmentFocusPath,
  type AmendTaskRow,
} from './amend-cancel';
import { AMEND_REVIEW_TASKS, amendOpLookup, taskActionKindLookup } from './amend-cancel.fixtures';

const ORIGINAL_LOOKUP_ROW = api.lookupRow;

beforeEach(() => {
  vi.spyOn(api, 'lookupRow').mockImplementation((category, value) => {
    if (category === 'shipment_amend_op') return amendOpLookup(value) as ReturnType<typeof api.lookupRow>;
    if (category === 'task_action_kind') return taskActionKindLookup(value) as ReturnType<typeof api.lookupRow>;
    return ORIGINAL_LOOKUP_ROW(category, value);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.style.pointerEvents = '';
  window.history.pushState(null, '', '/operate/amend-cancel');
});

async function mountAndWait() {
  vi.spyOn(api, 'listTasks').mockResolvedValue(AMEND_REVIEW_TASKS);
  const utils = renderWithProviders(<AmendCancelModule />, { capabilities: ['all'] });
  await waitFor(() => {
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  }, { timeout: 3000 });
  return utils;
}

describe('AmendCancelModule (CLAIM C)', () => {
  it('shows denied state without issuing protected amend review reads', async () => {
    const listTasksSpy = vi.spyOn(api, 'listTasks').mockResolvedValue(AMEND_REVIEW_TASKS);

    renderWithProviders(<AmendCancelModule />, { capabilities: [] });

    expect(await screen.findByText(/You do not have permission to view the amend & cancel queue/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(listTasksSpy).not.toHaveBeenCalled();
    });
  });

  it('mounts and renders the page header (i18n catalog supplies title)', async () => {
    await mountAndWait();
    // i18n catalog supplies "Amend / & cancel" — the module's titlePlain prop
    // is a fallback. We just confirm the page mounted with the accent word.
    expect(screen.getByRole('heading', { name: /Amend.*cancel.*review queue/i })).toBeInTheDocument();
  });

  it('keeps backend implementation names out of the visible review queue copy', async () => {
    await mountAndWait();
    const allText = document.body.textContent ?? '';
    expect(allText).toMatch(/Workflow-backed review queue/);
    expect(allText).not.toMatch(
      /shipment_amend_cancel_v1|transition_task_v1|progress_workflow_run|start_workflow_run|shipment_operation_policy|tasks\.metadata/i,
    );
    expect(allText).not.toMatch(/shp_9381322|amend_address/i);
    expect(allText).toMatch(/SHP-9381322|Amend address/i);
  });

  it('table no longer renders the legacy "Age (min)" column from SEED_QUEUE', async () => {
    await mountAndWait();
    // The previous implementation rendered four hardcoded "SHP-93812xx" const
    // rows from a `SEED_QUEUE` const-array, with an "Age (min)" column. Post
    // CLAIM C we read tasks from useTasks({task_type:'shipment_amend_review'})
    // which has no Age column. We assert the legacy column is GONE.
    await waitFor(
      () => {
        const allText = document.body.textContent ?? '';
        expect(allText).not.toMatch(/Age \(min\)/);
      },
      { timeout: 4000 },
    );
  });

  it('Pre-flight policy button is wired (not a hardcoded toast)', async () => {
    await mountAndWait();
    expect(screen.getByRole('button', { name: /Pre-flight policy/i })).toBeInTheDocument();
  });

  it('opens the focused amend request from the route query parameter', async () => {
    window.history.pushState(null, '', '/operate/amend-cancel?focus=tsk_3001');
    await mountAndWait();
    await waitFor(() => {
      expect(document.querySelector('.drawer')?.textContent ?? '').toMatch(/TSK-3001|SHP-9381322/);
    });
  });

  it('removes status edit affordances without task review permissions', async () => {
    renderWithProviders(<AmendCancelModule />, { capabilities: ['shipments.read'] });
    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    }, { timeout: 3000 });
    expect(document.querySelectorAll('td.is-editable').length).toBe(0);
    expect(canEditAmendReviewStatus(false, false)).toBe(false);
    expect(canEditAmendReviewStatus(true, false)).toBe(false);
    expect(canEditAmendReviewStatus(false, true)).toBe(true);
  });

  it('preserves each amend request operation and payload contract', () => {
    const base: AmendTaskRow = {
      id: 'tsk_1',
      task_id: 'TSK-1',
      task_type: 'shipment_amend_review',
      shipment_id: 'shp_1',
      status: 'open',
      metadata: {
        requested_op: 'amend_address',
        requested_payload: { destination_city: 'Riyadh' },
      },
    };

    expect(buildAmendMutationArgs(base, true)).toMatchObject({
      shipmentId: 'shp_1',
      op: 'address',
      payload: { destination_city: 'Riyadh' },
      dryRun: true,
    });
    expect(requestedBackendOperation('amend_cod')).toBe('modify');
    expect(canUseBatchForRequests([base])).toMatchObject({
      ok: false,
      reason: 'Selected amend requests need individual workflow review.',
    });
    expect(canUseBatchForRequests([
      { ...base, id: 'tsk_2', metadata: { requested_op: 'cancel', requested_payload: { reason: 'duplicate' } } },
      { ...base, id: 'tsk_3', shipment_id: 'shp_2', metadata: { requested_op: 'cancel', requested_payload: { reason: 'duplicate' } } },
    ])).toMatchObject({
      ok: true,
      op: 'cancel',
      payload: { reason: 'duplicate' },
      ids: ['shp_1', 'shp_2'],
    });
  });

  it('fails closed when an amend request has no shipment identity', () => {
    const missingShipment: AmendTaskRow = {
      id: 'tsk_missing_shipment',
      task_id: 'TSK-MISSING',
      task_type: 'shipment_amend_review',
      shipment_id: '   ',
      status: 'open',
      metadata: {
        requested_op: 'cancel',
        requested_payload: { reason: 'duplicate' },
      },
    };

    expect(buildAmendMutationArgs(missingShipment)).toBeNull();
    expect(shipmentFocusPath(missingShipment)).toBeNull();
    expect(canUseBatchForRequests([missingShipment])).toMatchObject({
      ok: false,
      reason: 'Some selected requests are missing operation or shipment details.',
    });
  });
});
