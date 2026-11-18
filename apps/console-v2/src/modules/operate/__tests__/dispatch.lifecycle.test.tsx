import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { clearToasts, getToasts } from '@/components/toastStore';
import {
  DispatchModule,
  buildRouteStopCloseoutPayload,
  fieldopsReassignRequestsForRun,
  parseProofGeostamp,
  routeStopCodPreview,
  routeRunDepartureConfirmedAt,
  routeRunAssignmentIsVisibleInDispatch,
  routeRunDispatchGateFingerprint,
  routeStopReassignOwnerTargetForRun,
  routeStopCloseoutActionMatches,
  routeStopCloseoutDisabledReason,
  routeStopLoadScanStatus,
  routeStopPodProofRequirements,
  sanitizeLast4,
} from '@/modules/operate/dispatch';
import * as api from '@/lib/api';
import * as ds from '@/lib/data-source';

const proofArtifactMocks = vi.hoisted(() => ({
  register: vi.fn(),
}));

vi.mock('@/lib/proof-artifacts', () => ({
  registerConsoleProofArtifact: proofArtifactMocks.register,
}));

function resetDispatchRoute() {
  window.history.pushState(null, '', '/operate/dispatch');
}

function expectInvalidatedResource(invalidate: { mock: { calls: unknown[][] } }, resource: string) {
  const calls = invalidate.mock.calls.map(([arg]) => JSON.stringify(arg));
  expect(calls.some((call) => call.includes(`"${resource}"`))).toBe(true);
}

function expectInvalidatedCompleteResource(invalidate: { mock: { calls: unknown[][] } }, resource: string) {
  const calls = invalidate.mock.calls.map(([arg]) => JSON.stringify(arg));
  expect(calls.some((call) => call.includes(`["list","${resource}","complete"]`))).toBe(true);
}

async function findScanOutResultDrawerClose(resultText: RegExp | string) {
  const drawer = await screen.findByRole('dialog', { name: /Scan-out reconciliation/i }, { timeout: 5000 });
  expect(await within(drawer).findByText(resultText, {}, { timeout: 5000 })).toBeInTheDocument();
  return within(drawer).getByRole('button', { name: /^Close$/i });
}

const SHIPMENT_CONTEXT_ID = 'shp_9381201';
const SHIPMENT_CONTEXT_READ_MARKER = 'READ-BACKED-SHP-9381201';
const REAL_GET_LOOKUPS = ds.getLookups;
const REAL_LOOKUP_ROW = ds.lookupRow;
const TASK_ACTION_RESOLVE_ROW = {
  value: 'resolve',
  label: 'Close as resolved',
  icon: 'check',
  tone: 'good',
  next_status: 'completed',
};

function defaultDispatchLookupRows(category: string) {
  if (category === 'delivery_completion_kind') {
    return [
      { value: 'full', label: 'Full delivery', tone: 'good', rank: 10, is_default: true },
      { value: 'partial', label: 'Partial delivery', tone: 'warn', rank: 20, is_default: false },
    ];
  }
  if (category === 'dispatch_exception_reason') {
    return [
      { value: 'no_answer', label: 'No answer', tone: 'warn', rank: 10, is_default: false },
      { value: 'phone_unreachable', label: 'Phone unreachable', tone: 'warn', rank: 20, is_default: false },
      { value: 'customer_refused', label: 'Customer refused', tone: 'danger', rank: 30, is_default: false },
    ];
  }
  if (category === 'delivery_handover_mode') {
    return [
      {
        value: 'named_recipient',
        label: 'Named recipient',
        tone: 'good',
        rank: 10,
        is_default: true,
        metadata: { requires_signature: true },
      },
      {
        value: 'safe_drop',
        label: 'Safe drop',
        tone: 'warn',
        rank: 30,
        is_default: false,
        metadata: { requires_signature: false },
      },
    ];
  }
  if (category === 'payment_collection_outcome') {
    return [
      { value: 'collected', label: 'Collected', tone: 'good', rank: 10, is_default: true },
      { value: 'refused', label: 'Refused', tone: 'danger', rank: 20, is_default: false },
    ];
  }
  if (category === 'payment_collection_method') {
    return [
      { value: 'cash', label: 'Cash', tone: 'good', rank: 10, is_default: true },
      { value: 'card', label: 'Card', tone: 'info', rank: 20, is_default: false },
    ];
  }
  if (category === 'task_action_kind') {
    return [TASK_ACTION_RESOLVE_ROW];
  }
  return REAL_GET_LOOKUPS(category);
}

function mockSuccessfulShipmentContextRead() {
  const realGet = ds.ui_get_resource_v1;
  return vi.spyOn(ds, 'ui_get_resource_v1').mockImplementation(async (resource, id) => {
    if (resource === 'shipments' && id === SHIPMENT_CONTEXT_ID) {
      return {
        id,
        tracking_number: 'SHP-9381201',
        status: 'in_transit',
        service_type: 'standard',
        carrier_reference_number: SHIPMENT_CONTEXT_READ_MARKER,
      };
    }
    return realGet<Record<string, unknown>>(resource, id);
  });
}

function mockDispatchScanReadback(scanEventId: string, options: { routeStopScanned?: boolean } = {}) {
  const realGet = ds.ui_get_resource_v1;
  return vi.spyOn(ds, 'ui_get_resource_v1').mockImplementation(async (resource, id) => {
    if (resource === 'scan_events' && id === scanEventId) {
      return {
        id,
        scan_type: 'load',
        created_at: '2026-05-07T10:00:00.000Z',
      };
    }
    if (resource === 'route_stops' && id === 'rs_44000' && options.routeStopScanned) {
      const row = await realGet<Record<string, unknown>>(resource, id);
      return {
        ...(row ?? {}),
        id,
        load_scan_count: 1,
        load_scan_status: 'scanned',
        last_load_scanned_at: '2026-05-07T10:00:00.000Z',
      };
    }
    return realGet<Record<string, unknown>>(resource, id);
  });
}

async function expectShipmentContextRead(
  drawer: HTMLElement,
  getResourceSpy: { mock: { calls: unknown[][] } },
) {
  await waitFor(() => {
    expect(
      getResourceSpy.mock.calls.some(([resource, id]) => resource === 'shipments' && id === SHIPMENT_CONTEXT_ID),
    ).toBe(true);
  });
  expect(await within(drawer).findByText(SHIPMENT_CONTEXT_READ_MARKER)).toBeInTheDocument();
}

beforeEach(() => {
  resetDispatchRoute();
  proofArtifactMocks.register.mockReset();
  proofArtifactMocks.register.mockResolvedValue('4d1fbd36-6b6e-4c35-acc4-5e3ad9043830');
  vi.spyOn(api, 'resolveMobilePolicy').mockResolvedValue(null);
  vi.spyOn(ds, 'resolveMobilePolicy').mockResolvedValue(null);
  vi.spyOn(ds, 'getLookups').mockImplementation(defaultDispatchLookupRows);
  vi.spyOn(ds, 'lookupRow').mockImplementation((category: string, value: string) => {
    if (category === 'task_action_kind' && value === 'resolve') return TASK_ACTION_RESOLVE_ROW;
    return REAL_LOOKUP_ROW(category, value);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.style.pointerEvents = '';
  resetDispatchRoute();
});

describe('DispatchModule lifecycle wiring', () => {
  it('builds canonical delivery closeout proof payloads for route-stop completion', () => {
    const signatureArtifactId = '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830';
    const photoArtifactId = '22222222-2222-4222-8222-222222222222';

    const { payload, deliveryCompletion, paymentCollection } = buildRouteStopCloseoutPayload({
      stopId: 'rs_44000',
      shipmentId: 'shp_9381201',
      completionKind: 'full',
      deliveredBoxNumbers: '1 2',
      expectedCod: 580,
      currency: 'SAR',
      paymentOutcome: 'collected',
      paymentMethod: 'cash',
      paymentAmount: '580',
      receiptContext: 'cashier-count-77',
      notes: 'Recipient signed at front door',
      handoverMode: 'named_recipient',
      handoverModeRow: {
        value: 'named_recipient',
        label: 'Named recipient',
        metadata: { requires_signature: true },
      },
      recipientName: 'Noura Al Saud',
      recipientIdentityKind: 'national_id',
      recipientIdentityLast4: 'ID-009876',
      otpLast4: 'OTP-4321',
      signatureArtifactId,
      photoArtifactId,
      capturedAt: '2026-05-07T09:30:00.000Z',
      latitude: '24.7136',
      longitude: '46.6753',
      accuracyM: '8',
    });

    expect(paymentCollection).toMatchObject({
      required: true,
      outcome: 'collected',
      method: 'cash',
      expected_amount: 580,
      collected_amount: 580,
      variance_amount: 0,
      has_discrepancy: false,
      discrepancy_kind: 'matched',
      currency: 'SAR',
      receipt_context: 'cashier-count-77',
    });
    expect(deliveryCompletion).toMatchObject({
      completion_kind: 'full',
      delivered_box_numbers: [1, 2],
      handover_mode: 'named_recipient',
      recipient_name: 'Noura Al Saud',
      recipient_identity_kind: 'national_id',
      recipient_identity_last4: '9876',
      otp_confirmed: true,
      otp_last4: '4321',
      signature_artifact_id: signatureArtifactId,
      photo_artifact_id: photoArtifactId,
      artifact_ids: [signatureArtifactId, photoArtifactId],
      captured_at: '2026-05-07T09:30:00.000Z',
      geostamp: { latitude: 24.7136, longitude: 46.6753, accuracy_m: 8 },
      notes: 'Recipient signed at front door',
      completion_notes: 'Recipient signed at front door',
    });
    expect(payload).toMatchObject({
      route_stop_id: 'rs_44000',
      shipment_id: 'shp_9381201',
      completion_kind: 'full',
      handover_mode: 'named_recipient',
      signature_artifact_id: signatureArtifactId,
      artifact_ids: [signatureArtifactId, photoArtifactId],
      pod: expect.objectContaining({
        signature_artifact_id: signatureArtifactId,
        recipient_identity_last4: '9876',
        otp_last4: '4321',
        geostamp: { latitude: 24.7136, longitude: 46.6753, accuracy_m: 8 },
      }),
      delivery_completion: expect.objectContaining({
        pod: expect.objectContaining({ signature_artifact_id: signatureArtifactId }),
      }),
      route_stop_completion: expect.objectContaining({
        payment_collection: expect.objectContaining({ collected_amount: 580 }),
      }),
    });
  });

  it('builds canonical failed-attempt payloads for route-stop exception closeout', () => {
    const { payload, deliveryCompletion, paymentCollection } = buildRouteStopCloseoutPayload({
      stopId: 'rs_44000',
      shipmentId: 'shp_9381201',
      failureReason: 'phone_unreachable',
      expectedCod: 580,
      handoverMode: 'named_recipient',
      handoverModeRow: {
        value: 'named_recipient',
        label: 'Named recipient',
        metadata: { requires_signature: true },
      },
      notes: 'Browser failed attempt proof',
      capturedAt: '2026-05-22T09:30:00.000Z',
    });

    expect(paymentCollection).toMatchObject({
      required: true,
      outcome: 'refused',
      expected_amount: 580,
      collected_amount: 0,
      variance_amount: 580,
      discrepancy_kind: 'refused',
    });
    expect(deliveryCompletion).toMatchObject({
      completion_kind: 'not_delivered',
      status_reason: 'phone_unreachable',
      exception_reason: 'phone_unreachable',
      delivery_attempt: expect.objectContaining({
        outcome: 'not_delivered',
        reason: 'phone_unreachable',
        dispatch_exception_reason: 'phone_unreachable',
        route_stop_outcome: 'attempted',
      }),
    });
    expect(payload).toMatchObject({
      route_stop_id: 'rs_44000',
      shipment_id: 'shp_9381201',
      route_stop_completion: expect.objectContaining({
        payment_collection: expect.objectContaining({
          outcome: 'refused',
          collected_amount: 0,
        }),
        delivery_attempt: expect.objectContaining({
          dispatch_exception_reason: 'phone_unreachable',
        }),
      }),
      status_reason: 'phone_unreachable',
      outcome_reason: 'phone_unreachable',
      exception_reason: 'phone_unreachable',
      payment_outcome: 'refused',
      delivery_attempt: expect.objectContaining({
        reason: 'phone_unreachable',
      }),
    });
    expect(payload.delivery_completion).toBeUndefined();
    expect(payload).not.toHaveProperty('handover_mode');
    expect(payload.pod).not.toHaveProperty('handover_mode');
    expect(payload.route_stop_completion).not.toHaveProperty('handover_mode');
    expect((payload.route_stop_completion as Record<string, unknown>).pod).not.toHaveProperty('handover_mode');
  });

  it('matches failed-attempt closeout shipment actions during backend readback', () => {
    expect(routeStopCloseoutActionMatches({
      shipment_id: 'shipment-1',
      action_data: {
        route_stop_completion: {
          route_stop_id: 'route-stop-1',
          completion_kind: 'not_delivered',
          delivery_attempt: {
            outcome: 'not_delivered',
            reason: 'phone_unreachable',
          },
        },
      },
    }, 'route-stop-1')).toBe(true);
  });

  it('keeps proof helpers strict for signatures, identity last-4, geostamp, and departure gating', () => {
    expect(sanitizeLast4('ID-009876')).toBe('9876');
    expect(parseProofGeostamp('24.7136', '46.6753', '8')).toEqual({
      latitude: 24.7136,
      longitude: 46.6753,
      accuracy_m: 8,
    });
    expect(() => parseProofGeostamp('24.7136', '', '')).toThrow(/both latitude and longitude/i);
    expect(() =>
      buildRouteStopCloseoutPayload({
        stopId: 'rs_44000',
        shipmentId: 'shp_9381201',
        completionKind: 'full',
        expectedCod: 580,
        handoverMode: 'named_recipient',
        handoverModeRow: {
          value: 'named_recipient',
          label: 'Named recipient',
          metadata: { requires_signature: true },
        },
      }),
    ).toThrow(/Payment outcome is required/i);
    expect(() =>
      buildRouteStopCloseoutPayload({
        stopId: 'rs_44000',
        shipmentId: 'shp_9381201',
        completionKind: 'full',
        expectedCod: 580,
        paymentOutcome: 'collected',
        paymentMethod: 'cash',
        paymentAmount: '580',
        handoverMode: 'named_recipient',
        handoverModeRow: {
          value: 'named_recipient',
          label: 'Named recipient',
          metadata: { requires_signature: true },
        },
      }),
    ).toThrow(/Receipt context is required/i);
    expect(() =>
      buildRouteStopCloseoutPayload({
        stopId: 'rs_44000',
        shipmentId: 'shp_9381201',
        completionKind: 'full',
        handoverMode: 'named_recipient',
        handoverModeRow: {
          value: 'named_recipient',
          label: 'Named recipient',
          metadata: { requires_signature: true },
        },
      }),
    ).toThrow(/requires a signature artifact ID/i);
    expect(routeStopCodPreview(580, 'SAR', 'collected', '580')).toMatchObject({
      label: expect.stringMatching(/Add receipt context/i),
      tone: 'warn',
    });
    expect(routeStopCodPreview(580, 'SAR', 'collected', '500', 'cashier-count-77')).toMatchObject({
      varianceAmount: 80,
      discrepancyKind: 'shortfall',
      hasDiscrepancy: true,
      tone: 'danger',
    });
    expect(routeStopCloseoutDisabledReason({
      task: { id: 'tsk_route_stop_44000' },
      departureConfirmedAt: null,
    })).toMatch(/Confirm route departure/i);
    expect(routeStopCloseoutDisabledReason({
      task: { id: 'tsk_route_stop_44000' },
      departureConfirmedAt: '2026-05-07T09:00:00.000Z',
    })).toBeNull();
    expect(routeStopCloseoutDisabledReason({
      task: { id: 'tsk_route_stop_44000', status: 'completed' },
      departureConfirmedAt: '2026-05-07T09:00:00.000Z',
    })).toMatch(/already closed/i);
  });

  it('derives route-stop proof requirements from row-driven POD policy', () => {
    expect(routeStopPodProofRequirements({
      requirements: {
        completed: {
          photo_required: true,
          signature_required: true,
          otp_required: false,
          identity_confirmation_required: true,
          min_artifact_count: 2,
        },
      },
    })).toEqual({
      photoRequired: true,
      signatureRequired: true,
      otpRequired: false,
      identityRequired: true,
      minArtifactCount: 2,
      label: 'POD policy requires photo proof, signature proof, recipient identity, 2 proof artifacts for full delivery.',
    });
  });

  it('requires assignment and route-stop execute task readback before assignment is visibly complete', () => {
    const assignments = [
      { route_run_id: 'run_1', assignment_status: 'assigned' },
    ];
    const tasks = [
      { task_type_key: 'route_stop_execute', resource_type: 'route_stop', resource_id: 'stop_1' },
    ];

    expect(routeRunAssignmentIsVisibleInDispatch('run_1', ['stop_1'], assignments, tasks)).toBe(true);
    expect(routeRunAssignmentIsVisibleInDispatch('run_1', ['stop_1', 'stop_2'], assignments, tasks)).toBe(false);
    expect(routeRunAssignmentIsVisibleInDispatch('run_1', ['stop_2'], assignments, tasks)).toBe(false);
    expect(routeRunAssignmentIsVisibleInDispatch('run_1', ['stop_1'], [], tasks)).toBe(false);
    expect(routeRunAssignmentIsVisibleInDispatch(
      'run_1',
      ['stop_1'],
      [{ route_run_id: 'run_1', assignment_status: 'cancelled' }],
      tasks,
    )).toBe(false);
  });

  it('surfaces only pending Mobile V2 reassignment recovery tasks for the active run', () => {
    const tasks = [
      {
        id: 'task_mobile_pending',
        task_type_key: 'dispatch_exception_review',
        resource_type: 'route_stop',
        resource_id: 'stop_1',
        status: 'open',
        created_at: '2026-06-01T08:00:00.000Z',
        metadata: {
          mobile_v2_reassign_request: true,
          source_route_run_id: 'run_1',
          target_driver_user_id: 'driver_2',
          reason: 'Vehicle issue',
        },
      },
      {
        id: 'task_mobile_done',
        task_type_key: 'dispatch_exception_review',
        resource_type: 'route_stop',
        resource_id: 'stop_2',
        status: 'completed',
        created_at: '2026-06-01T08:05:00.000Z',
        metadata: {
          mobile_v2_reassign_request: true,
          source_route_run_id: 'run_1',
        },
      },
      {
        id: 'task_ndr',
        task_type_key: 'dispatch_exception_review',
        resource_type: 'shipment',
        resource_id: 'shipment_1',
        status: 'open',
        metadata: { source_route_run_id: 'run_1' },
      },
    ];

    expect(fieldopsReassignRequestsForRun('run_1', tasks).map((task) => task.id)).toEqual([
      'task_mobile_pending',
    ]);
    expect(fieldopsReassignRequestsForRun('run_2', tasks)).toEqual([]);
  });

  it('derives visible stop-level load scan status for operators', () => {
    expect(routeStopLoadScanStatus({ load_scan_count: 0 })).toMatchObject({
      label: 'Missing',
      tone: 'neutral',
    });
    expect(routeStopLoadScanStatus({ load_scan_count: 1, last_load_scanned_at: '2026-05-07T10:00:00.000Z' })).toMatchObject({
      label: 'Scanned',
      tone: 'good',
    });
    expect(routeStopLoadScanStatus({ load_scan_count: 2, load_scan_status: 'duplicate' })).toMatchObject({
      label: 'Duplicate x2',
      tone: 'warn',
    });
  });

  it('keeps scan-out freshness tied to load-critical route changes only', () => {
    const assignedRun = {
      id: 'run_1',
      status: 'assigned',
      driver_user_id: 'driver_1',
      vehicle_id: 'veh_1',
    };
    const departedRun = { ...assignedRun, status: 'departed' };
    const assignment = {
      assignment_status: 'assigned',
      assignment_version: 2,
      driver_user_id: 'driver_1',
      vehicle_id: 'veh_1',
    };

    expect(routeRunDispatchGateFingerprint(assignedRun, assignment, 'stop_a')).toEqual(
      routeRunDispatchGateFingerprint(departedRun, assignment, 'stop_a'),
    );
    expect(routeRunDispatchGateFingerprint(assignedRun, assignment, 'stop_a')).not.toEqual(
      routeRunDispatchGateFingerprint(
        { ...assignedRun, driver_user_id: 'driver_2' },
        { ...assignment, driver_user_id: 'driver_2', assignment_version: 3 },
        'stop_a',
      ),
    );
    expect(routeRunDispatchGateFingerprint(assignedRun, assignment, 'stop_a')).not.toEqual(
      routeRunDispatchGateFingerprint(assignedRun, assignment, 'stop_a|stop_b'),
    );
  });

  it('builds stop reassignment targets from the target run owner contract', () => {
    expect(routeStopReassignOwnerTargetForRun(
      { driver_user_id: null, vehicle_id: null },
      {
        assignment_mode: 'internal_driver',
        driver_user_id: 'driver_2',
        vehicle_id: 'veh_2',
        partner: null,
      },
    )).toEqual({
      driver_user_id: 'driver_2',
      vehicle_id: 'veh_2',
    });

    expect(routeStopReassignOwnerTargetForRun(
      { driver_user_id: null, vehicle_id: null },
      {
        assignment_mode: 'internal_driver',
        driver_user_id: null,
        vehicle_id: null,
        partner: null,
      },
    )).toBeNull();
  });

  it('resolves departure confirmation from route departure metadata', () => {
    expect(routeRunDepartureConfirmedAt(null)).toBeNull();
    expect(routeRunDepartureConfirmedAt({ metadata: {} })).toBeNull();
    expect(
      routeRunDepartureConfirmedAt({
        metadata: { route_departure: { confirmed_at: '2026-05-07T14:59:00.000Z' } },
      }),
    ).toBe('2026-05-07T14:59:00.000Z');
  });

  it('locks stop closeout buttons until route departure is confirmed', async () => {
    const realComplete = ds.ui_list_resource_complete;
    const listSpy = vi.spyOn(ds, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      const result = await realComplete(resource, opts);
      if (resource !== 'route_stops' || result.rows.length > 0) return result;
      return {
        ...result,
        total: 3,
        rows: [0, 1, 2].map((index) => ({
          id: `rs_${44000 + index}`,
          organization_id: 'org_rashed',
          route_run_id: 'run_2841',
          client_id: 'client_demo',
          shipment_id: `shp_938${String(1201 + index).padStart(4, '0')}`,
          stop_kind: 'delivery',
          sequence_order: index + 1,
          planned_window_start_at: '2026-04-25T11:00:00Z',
          planned_window_end_at: '2026-04-25T13:00:00Z',
          metadata: {},
          created_at: '2026-04-25T07:30:00Z',
          updated_at: '2026-04-25T08:12:00Z',
        })),
      };
    });

    try {
      renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

      const closeoutButtons = await screen.findAllByRole('button', { name: /Close stop/i });
      expect(closeoutButtons[0]).toBeDisabled();
      expect(closeoutButtons[0]).toHaveAttribute('title', expect.stringMatching(/Confirm route departure/i));
    } finally {
      listSpy.mockRestore();
    }
  });

  it('keeps stop closeout permission-gated after route departure is confirmed', async () => {
    const user = userEvent.setup();
    vi.mocked(api.resolveMobilePolicy).mockResolvedValue({
      category: 'pod_policy',
      value: { requirements: {} },
      resolved_from: 'global',
      ladder_path: [],
      settings_resolution_id: 'srlv_pod_empty',
      override_of: null,
      resolver: 'resolve_pod_policy',
    });
    const realList = ds.ui_list_resource_complete;
    const listSpy = vi.spyOn(ds, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      const result = await realList(resource, opts);
      if (resource === 'route_runs') {
        return {
          ...result,
          rows: result.rows.map((row) => ({
            ...row,
            metadata: {
              ...((row as Record<string, unknown>).metadata as Record<string, unknown> | undefined),
              route_departure: { confirmed_at: '2026-05-07T09:00:00.000Z' },
            },
          })),
        };
      }
      if (resource !== 'tasks') return result;
      return {
        ...result,
        rows: result.rows.map((row) =>
          String((row as Record<string, unknown>).task_type ?? '') === 'route_stop_execute'
            ? { ...row, status: 'open' }
            : row,
        ),
      };
    });
    const transitionSpy = vi.spyOn(ds, 'transition_task_v1');

    try {
      renderWithProviders(<DispatchModule />, {
        capabilities: ['routes.read', 'routes.write', 'shipments.read'],
      });
      await waitFor(() => {
        expect(api.resolveMobilePolicy).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: /Close stop/i }).length).toBeGreaterThan(0);
      });
      const closeoutButtons = screen.getAllByRole('button', { name: /Close stop/i });
      expect(closeoutButtons.every((button) => button.hasAttribute('disabled'))).toBe(true);
      expect(screen.getAllByText(/Task Completion permission required/i).length).toBeGreaterThan(0);
      await user.click(closeoutButtons[0]);
      expect(screen.queryByTestId('route-stop-closeout-modal')).not.toBeInTheDocument();
      expect(transitionSpy).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
    }
  });

  it('exposes failed delivery attempt reasons in the stop closeout modal', async () => {
    clearToasts();
    const user = userEvent.setup();
    vi.mocked(api.resolveMobilePolicy).mockResolvedValue({
      category: 'pod_policy',
      value: {
        requirements: {
          completed: {
            photo_required: true,
            signature_required: true,
            min_artifact_count: 2,
          },
        },
      },
      resolved_from: 'global',
      ladder_path: [],
      settings_resolution_id: 'srlv_pod_strict',
      override_of: null,
      resolver: 'resolve_pod_policy',
    });
    const realList = ds.ui_list_resource_complete;
    const listSpy = vi.spyOn(ds, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      const result = await realList(resource, opts);
      if (resource === 'route_runs') {
        return {
          ...result,
          rows: result.rows.map((row) => ({
            ...row,
            metadata: {
              ...((row as Record<string, unknown>).metadata as Record<string, unknown> | undefined),
              route_departure: { confirmed_at: '2026-05-07T09:00:00.000Z' },
            },
          })),
        };
      }
      if (resource === 'shipment_actions') {
        return {
          ...result,
          rows: [{
            id: 'sact_failed_attempt_readback',
            shipment_id: 'shp_9381201',
            route_stop_id: 'rs_44000',
            action_data: {
              route_stop_id: 'rs_44000',
              delivery_attempt: {
                outcome: 'not_delivered',
                reason: 'phone_unreachable',
                dispatch_exception_reason: 'phone_unreachable',
              },
            },
            timestamp: '2026-05-22T09:05:00.000Z',
          }],
          total: 1,
        };
      }
      if (resource !== 'tasks') return result;
      return {
        ...result,
        rows: result.rows.map((row) =>
          String((row as Record<string, unknown>).task_type ?? '') === 'route_stop_execute'
            ? { ...row, task_type: undefined, task_type_key: 'route_stop_execute', status: 'open' }
            : row,
        ),
      };
    });

    try {
      renderWithProviders(<DispatchModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: /^Close stop$/i }).length).toBeGreaterThan(0);
      });
      const enabledCloseout = screen.getAllByRole('button', { name: /^Close stop$/i }).find((button) => !button.hasAttribute('disabled'));
      expect(enabledCloseout).toBeTruthy();
      await user.click(enabledCloseout!);
      const dialog = await screen.findByRole('dialog', { name: /close stop/i });
      const failureReasonSelect = within(dialog).getByTestId('route-stop-failure-reason') as HTMLSelectElement;
      expect(within(dialog).getByRole('option', { name: /Phone unreachable/i })).toBeInTheDocument();
      const failureReasonButton = within(dialog).getByTestId('route-stop-failure-reason-button-phone_unreachable');
      await user.click(failureReasonButton);
      expect(failureReasonSelect.value).toBe('phone_unreachable');
      expect(failureReasonButton).toHaveAttribute('aria-pressed', 'true');
      expect(dialog).toHaveAttribute('data-failure-reason', 'phone_unreachable');
      fireEvent.change(failureReasonSelect, { target: { value: 'phone_unreachable' } });
      expect(failureReasonSelect.value).toBe('phone_unreachable');
      expect(proofArtifactMocks.register).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
    }
  }, 15000);

  it('keeps cross-tenant dispatch lifecycle actions inspectable but not mutable', async () => {
    const user = userEvent.setup();
    const runReason = "Switch to this route run's tenant before changing dispatch lifecycle.";
    const stopReason = "Switch to this route stop's tenant before changing dispatch lifecycle.";
    const bulkStopReason = "Switch to each selected route stop's tenant before changing dispatch lifecycle.";
    const realComplete = ds.ui_list_resource_complete;
    vi.spyOn(ds, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      const result = await realComplete(resource, opts);
      if (resource === 'route_runs' || resource === 'route_run_directory') {
        return {
          ...result,
          rows: result.rows.map((row) => ({
            ...row,
            organization_id: 'org_other_tenant',
          })),
        };
      }
      if (resource === 'route_stops') {
        return {
          ...result,
          rows: result.rows.map((row) => ({
            ...row,
            organization_id: 'org_other_tenant',
          })),
        };
      }
      return result;
    });
    const reconcileSpy = vi.spyOn(ds, 'route_run_scan_out_reconciliation_v1');
    const confirmSpy = vi.spyOn(ds, 'ui_confirm_route_run_departure_v1');
    const assignSpy = vi.spyOn(ds, 'ui_execute_route_run_assign_v1');
    const reassignSpy = vi.spyOn(ds, 'ui_execute_route_stop_reassign_v1');
    const scanSpy = vi.spyOn(ds, 'record_scan_event_v1');
    const transitionSpy = vi.spyOn(ds, 'transition_task_v1');

    renderWithProviders(<DispatchModule />, {
      identity: {
        capabilities: ['all'],
        user: { organization_id: 'org_platform_home', access_scope_type: 'platform' },
        scope: { tenant: { id: 'org_rashed', label: 'First Tenant', rank: 2 } },
      },
    });

    const reconcile = await screen.findByRole('button', { name: /Reconcile scan-out/i });
    const confirm = screen.getByRole('button', { name: /Confirm departure/i });
    await waitFor(() => {
      expect(reconcile).toBeDisabled();
      expect(reconcile).toHaveAttribute('title', runReason);
      expect(confirm).toBeDisabled();
      expect(confirm).toHaveAttribute('title', runReason);
    });
    await user.click(reconcile).catch(() => undefined);
    await user.click(confirm).catch(() => undefined);

    const assignButtons = await screen.findAllByRole('button', { name: /Assign driver/i });
    expect(assignButtons.length).toBeGreaterThan(0);
    expect(assignButtons[0]).toBeDisabled();
    expect(assignButtons[0]).toHaveAttribute('title', runReason);
    await user.click(assignButtons[0]).catch(() => undefined);

    const scanButtons = await screen.findAllByRole('button', { name: /Scan load/i });
    expect(scanButtons.length).toBeGreaterThan(0);
    expect(scanButtons[0]).toBeDisabled();
    expect(scanButtons[0]).toHaveAttribute('title', stopReason);
    await user.click(scanButtons[0]).catch(() => undefined);

    const closeButtons = await screen.findAllByRole('button', { name: /^Close stop$/i });
    expect(closeButtons.length).toBeGreaterThan(0);
    expect(closeButtons[0]).toBeDisabled();
    expect(closeButtons[0]).toHaveAttribute('title', stopReason);
    await user.click(closeButtons[0]).catch(() => undefined);

    await user.click(screen.getAllByLabelText(/Select stop/i)[0]!);
    const reassign = screen.getByRole('button', { name: /Reassign/i });
    expect(reassign).toBeDisabled();
    expect(reassign).toHaveAttribute('title', bulkStopReason);
    await user.click(reassign).catch(() => undefined);

    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(reassignSpy).not.toHaveBeenCalled();
    expect(scanSpy).not.toHaveBeenCalled();
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: /Assign driver/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('route-stop-closeout-modal')).not.toBeInTheDocument();
  });

  it('keeps read-only dispatch operators visible but unable to mutate route runs or stops', async () => {
    const confirmSpy = vi.spyOn(ds, 'ui_confirm_route_run_departure_v1');
    const assignSpy = vi.spyOn(ds, 'ui_execute_route_run_assign_v1');
    const assignmentResponseSpy = vi.spyOn(ds, 'ui_execute_route_run_assignment_response_v1');
    const reassignSpy = vi.spyOn(ds, 'ui_execute_route_stop_reassign_v1');
    const scanSpy = vi.spyOn(ds, 'record_scan_event_v1');
    const transitionSpy = vi.spyOn(ds, 'transition_task_v1');

    renderWithProviders(<DispatchModule />, { capabilities: ['routes.read', 'shipments.read'] });

    await waitFor(() => {
      expect(document.querySelector('.run-row.is-active')).not.toBeNull();
    });

    const confirm = screen.getByRole('button', { name: /Confirm departure/i });
    expect(confirm).toBeDisabled();
    expect(screen.getAllByText(/Route update permission required/i).length).toBeGreaterThan(0);
    fireEvent.click(confirm);

    const assignButtons = await screen.findAllByRole('button', { name: /Assign driver/i });
    expect(assignButtons.length).toBeGreaterThan(0);
    expect(assignButtons.every((button) => button.hasAttribute('disabled'))).toBe(true);
    fireEvent.click(assignButtons[0]!);

    const capacityButtons = screen.queryAllByRole('button', { name: /Assign capacity|Capacity assigned/i });
    expect(capacityButtons.every((button) => button.hasAttribute('disabled'))).toBe(true);
    if (capacityButtons[0]) {
      fireEvent.click(capacityButtons[0]);
    }

    const scanButtons = await screen.findAllByRole('button', { name: /Scan load/i });
    expect(scanButtons.length).toBeGreaterThan(0);
    expect(scanButtons.every((button) => button.hasAttribute('disabled'))).toBe(true);
    fireEvent.click(scanButtons[0]!);

    const closeButtons = screen.queryAllByRole('button', { name: /^Close stop$/i });
    expect(closeButtons.every((button) => button.hasAttribute('disabled'))).toBe(true);
    if (closeButtons[0]) {
      fireEvent.click(closeButtons[0]);
    }

    fireEvent.click(screen.getAllByLabelText(/Select stop/i)[0]!);
    const reassign = screen.getByRole('button', { name: /Reassign/i });
    expect(reassign).toBeDisabled();
    expect(screen.getAllByText(/Route update permission required/i).length).toBeGreaterThan(0);
    fireEvent.click(reassign);
    const moveSelected = screen.getByRole('button', { name: /Move selected/i });
    expect(moveSelected).toBeDisabled();
    expect(moveSelected).toHaveAttribute('title', expect.stringMatching(/Routes Write permission required/i));
    fireEvent.click(moveSelected);

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(assignmentResponseSpy).not.toHaveBeenCalled();
    expect(reassignSpy).not.toHaveBeenCalled();
    expect(scanSpy).not.toHaveBeenCalled();
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: /Assign driver/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('route-stop-closeout-modal')).not.toBeInTheDocument();
  }, 10000);

  it('shows restricted stop details when route rows are readable but stop manifest rows are hidden', async () => {
    const reconcileSpy = vi.spyOn(ds, 'route_run_scan_out_reconciliation_v1');
    const realComplete = ds.ui_list_resource_complete;
    vi.spyOn(ds, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      const result = await realComplete(resource, opts);
      if (resource === 'route_stops') {
        return {
          ...result,
          rows: [],
          total: 0,
        };
      }
      if (resource === 'route_run_directory') {
        return {
          ...result,
          rows: result.rows.map((row) => ({
            ...row,
            stop_count: 2,
          })),
        };
      }
      return result;
    });

    renderWithProviders(<DispatchModule />, { capabilities: ['routes.read', 'shipments.read'] });

    expect(
      await screen.findByText('2 stops are listed for this run; stop details are restricted for this route context.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('No stops on this run.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reassign/i })).toBeDisabled();
    const reconcile = screen.getByRole('button', { name: /Reconcile scan-out/i });
    expect(reconcile).toBeDisabled();
    expect(reconcile).toHaveAttribute('title', 'Stop details are restricted for this route context.');
    expect(reconcile).toHaveTextContent(/Stop details restricted/i);
    fireEvent.click(reconcile);
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it('blocks full delivery closeout until required POD photo proof is selected', async () => {
    clearToasts();
    const user = userEvent.setup();
    vi.mocked(api.resolveMobilePolicy).mockResolvedValue({
      category: 'pod_policy',
      value: {
        requirements: {
          completed: {
            photo_required: true,
            min_artifact_count: 1,
          },
        },
      },
      resolved_from: 'global',
      ladder_path: [],
      settings_resolution_id: 'srlv_pod_photo_required',
      override_of: null,
      resolver: 'resolve_pod_policy',
    });
    const realList = ds.ui_list_resource_complete;
    const listSpy = vi.spyOn(ds, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      const result = await realList(resource, opts);
      if (resource === 'route_runs') {
        return {
          ...result,
          rows: result.rows.map((row) => ({
            ...row,
            metadata: {
              ...((row as Record<string, unknown>).metadata as Record<string, unknown> | undefined),
              route_departure: { confirmed_at: '2026-05-07T09:00:00.000Z' },
            },
          })),
        };
      }
      if (resource !== 'tasks') return result;
      return {
        ...result,
        rows: result.rows.map((row) =>
          String((row as Record<string, unknown>).task_type ?? '') === 'route_stop_execute'
            ? { ...row, status: 'open' }
            : row,
        ),
      };
    });
    const transitionSpy = vi.spyOn(ds, 'transition_task_v1');

    try {
      renderWithProviders(<DispatchModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: /^Close stop$/i }).length).toBeGreaterThan(0);
      });
      const enabledCloseout = screen.getAllByRole('button', { name: /^Close stop$/i }).find((button) => !button.hasAttribute('disabled'));
      expect(enabledCloseout).toBeTruthy();
      await user.click(enabledCloseout!);
      expect(await screen.findByTestId('route-stop-closeout-modal')).toBeInTheDocument();
      expect(await screen.findByTestId('route-stop-pod-policy-requirements')).toHaveTextContent(/photo proof/i);
      const paymentOutcome = screen.queryByTestId('route-stop-payment-outcome');
      if (paymentOutcome) {
        const previewText = screen.getByTestId('route-stop-cod-preview').textContent ?? '';
        const expectedCod = previewText.match(/\b(\d+(?:\.\d+)?)\b/)?.[1] ?? '0';
        await user.selectOptions(paymentOutcome, 'collected');
        await user.selectOptions(screen.getByTestId('route-stop-payment-method'), 'cash');
        await user.type(screen.getByTestId('route-stop-payment-amount'), expectedCod);
        await user.type(screen.getByTestId('route-stop-payment-receipt'), 'cashier-count-77');
      }
      await user.upload(
        screen.getByTestId('route-stop-signature-file'),
        new File(['signature-proof'], 'signature.png', { type: 'image/png' }),
      );
      fireEvent.click(within(screen.getByRole('dialog', { name: /close stop/i })).getByRole('button', { name: /^Close stop$/i }));

      await waitFor(() => {
        expect(getToasts().some((toast) => toast.message.includes('Photo proof is required by POD policy'))).toBe(true);
      });
      expect(proofArtifactMocks.register).not.toHaveBeenCalled();
      expect(transitionSpy).not.toHaveBeenCalled();
      clearToasts();
    } finally {
      listSpy.mockRestore();
    }
  }, 15000);

  it('validates handover signature proof before registering photo artifacts', async () => {
    clearToasts();
    const user = userEvent.setup();
    vi.mocked(api.resolveMobilePolicy).mockResolvedValue({
      category: 'pod_policy',
      value: {
        requirements: {
          completed: {
            photo_required: true,
            min_artifact_count: 1,
          },
        },
      },
      resolved_from: 'global',
      ladder_path: [],
      settings_resolution_id: 'srlv_pod_photo_required',
      override_of: null,
      resolver: 'resolve_pod_policy',
    });
    const realList = ds.ui_list_resource_complete;
    const listSpy = vi.spyOn(ds, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      const result = await realList(resource, opts);
      if (resource === 'route_runs') {
        return {
          ...result,
          rows: result.rows.map((row) => ({
            ...row,
            metadata: {
              ...((row as Record<string, unknown>).metadata as Record<string, unknown> | undefined),
              route_departure: { confirmed_at: '2026-05-07T09:00:00.000Z' },
            },
          })),
        };
      }
      if (resource !== 'tasks') return result;
      return {
        ...result,
        rows: result.rows.map((row) =>
          String((row as Record<string, unknown>).task_type ?? '') === 'route_stop_execute'
            ? { ...row, status: 'open' }
            : row,
        ),
      };
    });
    const transitionSpy = vi.spyOn(ds, 'transition_task_v1');

    try {
      renderWithProviders(<DispatchModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: /^Close stop$/i }).length).toBeGreaterThan(0);
      });
      const enabledCloseout = screen.getAllByRole('button', { name: /^Close stop$/i }).find((button) => !button.hasAttribute('disabled'));
      expect(enabledCloseout).toBeTruthy();
      await user.click(enabledCloseout!);
      expect(await screen.findByTestId('route-stop-closeout-modal')).toBeInTheDocument();
      const paymentOutcome = screen.queryByTestId('route-stop-payment-outcome');
      if (paymentOutcome) {
        const previewText = screen.getByTestId('route-stop-cod-preview').textContent ?? '';
        const expectedCod = previewText.match(/\b(\d+(?:\.\d+)?)\b/)?.[1] ?? '0';
        await user.selectOptions(paymentOutcome, 'collected');
        await user.selectOptions(screen.getByTestId('route-stop-payment-method'), 'cash');
        await user.type(screen.getByTestId('route-stop-payment-amount'), expectedCod);
        await user.type(screen.getByTestId('route-stop-payment-receipt'), 'cashier-count-77');
      }
      const proofFile = new File(['photo-proof'], 'pod-photo.png', { type: 'image/png' });
      await user.upload(screen.getByTestId('route-stop-photo-file'), proofFile);

      fireEvent.click(within(screen.getByRole('dialog', { name: /close stop/i })).getByRole('button', { name: /^Close stop$/i }));

      await waitFor(() => {
        expect(getToasts().some((toast) => toast.message.includes('Named recipient requires signature proof'))).toBe(true);
      });
      expect(proofArtifactMocks.register).not.toHaveBeenCalled();
      expect(transitionSpy).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
      clearToasts();
    }
  }, 15000);

  it('accepts pasted POD photo proof and sends it through the backend proof upload path', async () => {
    clearToasts();
    const user = userEvent.setup();
    vi.mocked(api.resolveMobilePolicy).mockResolvedValue({
      category: 'pod_policy',
      value: {
        requirements: {
          completed: {
            photo_required: true,
            min_artifact_count: 1,
          },
        },
      },
      resolved_from: 'global',
      ladder_path: [],
      settings_resolution_id: 'srlv_pod_photo_required',
      override_of: null,
      resolver: 'resolve_pod_policy',
    });
    const realList = ds.ui_list_resource_complete;
    const listSpy = vi.spyOn(ds, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'shipment_actions') {
        return {
          rows: [
            {
              id: 'shipment_action_route_stop_closeout_1',
              shipment_id: 'shp_9381201',
              route_stop_id: 'rs_44000',
              delivery_completion: {
                route_stop_id: 'rs_44000',
                proof_artifacts: [{ artifact_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830', kind: 'photo' }],
              },
            },
          ],
          total: 1,
        } as Awaited<ReturnType<typeof ds.ui_list_resource_complete>>;
      }
      const result = await realList(resource, opts);
      if (resource === 'route_runs') {
        return {
          ...result,
          rows: result.rows.map((row) => ({
            ...row,
            metadata: {
              ...((row as Record<string, unknown>).metadata as Record<string, unknown> | undefined),
              route_departure: { confirmed_at: '2026-05-07T09:00:00.000Z' },
            },
          })),
        };
      }
      if (resource !== 'tasks') return result;
      return {
        ...result,
        rows: result.rows.map((row) =>
          String((row as Record<string, unknown>).task_type ?? '') === 'route_stop_execute'
            ? { ...row, status: 'open' }
            : row,
        ),
      };
    });
    const transitionSpy = vi.spyOn(ds, 'transition_task_v1');

    try {
      renderWithProviders(<DispatchModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: /^Close stop$/i }).length).toBeGreaterThan(0);
      });
      const enabledCloseout = screen.getAllByRole('button', { name: /^Close stop$/i }).find((button) => !button.hasAttribute('disabled'));
      expect(enabledCloseout).toBeTruthy();
      await user.click(enabledCloseout!);
      expect(await screen.findByTestId('route-stop-closeout-modal')).toBeInTheDocument();
      const paymentOutcome = screen.queryByTestId('route-stop-payment-outcome');
      if (paymentOutcome) {
        const previewText = screen.getByTestId('route-stop-cod-preview').textContent ?? '';
        const expectedCod = previewText.match(/\b(\d+(?:\.\d+)?)\b/)?.[1] ?? '0';
        await user.selectOptions(paymentOutcome, 'collected');
        await user.selectOptions(screen.getByTestId('route-stop-payment-method'), 'cash');
        await user.type(screen.getByTestId('route-stop-payment-amount'), expectedCod);
        await user.type(screen.getByTestId('route-stop-payment-receipt'), 'cashier-count-77');
      }
      const proofFile = new File(['photo-proof'], 'pod-photo.png', { type: 'image/png' });
      await user.upload(
        screen.getByTestId('route-stop-signature-file'),
        new File(['signature-proof'], 'signature.png', { type: 'image/png' }),
      );
      fireEvent.paste(screen.getByTestId('route-stop-photo-proof-dropzone'), {
        clipboardData: { files: [proofFile] },
      });
      expect(screen.getByTestId('route-stop-photo-file-name')).toHaveTextContent('pod-photo.png selected');

      fireEvent.click(within(screen.getByRole('dialog', { name: /close stop/i })).getByRole('button', { name: /^Close stop$/i }));

      await waitFor(() => expect(proofArtifactMocks.register).toHaveBeenCalledTimes(2));
      expect(proofArtifactMocks.register).toHaveBeenCalledWith(
        expect.objectContaining({
          artifactKind: 'photo',
          file: proofFile,
          routeStopId: 'rs_44000',
          routeRunId: 'run_2841',
          shipmentId: 'shp_9381201',
        }),
      );
      await waitFor(() => expect(transitionSpy).toHaveBeenCalledTimes(1));
      expect(getToasts().some((toast) => toast.message.includes('Photo proof is required by POD policy'))).toBe(false);
    } finally {
      listSpy.mockRestore();
      clearToasts();
    }
  }, 15000);

  it('does not mark stop closeout saved until canonical backend read-back succeeds', async () => {
    clearToasts();
    const user = userEvent.setup();
    const realList = ds.ui_list_resource_complete;
    const listSpy = vi.spyOn(ds, 'ui_list_resource_complete');
    listSpy.mockImplementation(async (resource, opts) => {
      const result = await realList(resource, opts);
      if (resource === 'route_runs') {
        return {
          ...result,
          rows: result.rows.map((row) => ({
            ...row,
            metadata: {
              ...((row as Record<string, unknown>).metadata as Record<string, unknown> | undefined),
              route_departure: { confirmed_at: '2026-05-07T09:00:00.000Z' },
            },
          })),
        };
      }
      if (resource !== 'tasks') return result;
      return {
        ...result,
        rows: result.rows.map((row) =>
          String((row as Record<string, unknown>).task_type ?? '') === 'route_stop_execute'
            ? { ...row, status: 'open' }
            : row,
        ),
      };
    });
    const realGet = ds.ui_get_resource_v1;
    const readbackSpy = vi.spyOn(ds, 'ui_get_resource_v1').mockImplementation(async (resource, id) => {
      if (resource === 'route_stops') throw new Error('route stop read-back unavailable');
      return realGet<Record<string, unknown>>(resource, id);
    });
    const transitionSpy = vi.spyOn(ds, 'transition_task_v1');

    try {
      renderWithProviders(<DispatchModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: /^Close stop$/i }).length).toBeGreaterThan(0);
      });
      const enabledCloseout = screen.getAllByRole('button', { name: /^Close stop$/i }).find((button) => !button.hasAttribute('disabled'));
      expect(enabledCloseout).toBeTruthy();
      await user.click(enabledCloseout!);
      expect(await screen.findByTestId('route-stop-closeout-modal')).toBeInTheDocument();
      const paymentOutcome = screen.queryByTestId('route-stop-payment-outcome');
      if (paymentOutcome) {
        const previewText = screen.getByTestId('route-stop-cod-preview').textContent ?? '';
        const expectedCod = previewText.match(/\b(\d+(?:\.\d+)?)\b/)?.[1] ?? '0';
        await user.selectOptions(paymentOutcome, 'collected');
        await user.selectOptions(screen.getByTestId('route-stop-payment-method'), 'cash');
        await user.type(screen.getByTestId('route-stop-payment-amount'), expectedCod);
        await user.type(screen.getByTestId('route-stop-payment-receipt'), 'cashier-count-77');
      }
      const proofFile = new File(['signature-proof'], 'signature.png', { type: 'image/png' });
      await user.upload(screen.getByTestId('route-stop-signature-file'), proofFile);
      const dialog = screen.getByRole('dialog', { name: /close stop/i });
      const modalCloseButton = within(dialog).getByRole('button', { name: /^Close stop$/i });
      expect(modalCloseButton).not.toBeDisabled();
      fireEvent.click(modalCloseButton);

      await waitFor(() => expect(transitionSpy).toHaveBeenCalledTimes(1));
      await waitFor(() => {
        expect(readbackSpy.mock.calls.some(([resource]) => resource === 'tasks')).toBe(true);
        expect(readbackSpy.mock.calls.some(([resource]) => resource === 'route_stops')).toBe(true);
      });
      expect(await screen.findByTestId('route-stop-closeout-modal')).toBeInTheDocument();
      expect(getToasts().some((toast) => toast.message.includes('Stop closeout could not be saved. Try again.'))).toBe(true);
      expect(getToasts().some((toast) => toast.message.includes('Stop closeout saved'))).toBe(false);
      expect(proofArtifactMocks.register).toHaveBeenCalledTimes(1);
      expect(await screen.findByTestId('route-stop-closeout-modal')).toBeInTheDocument();
      clearToasts();
    } finally {
      listSpy.mockRestore();
      readbackSpy.mockRestore();
    }
  }, 15000);

  it('records route load scans through the reusable ops scanner panel', async () => {
    const user = userEvent.setup();
    const readbackSpy = mockDispatchScanReadback('scan_route_load_1', { routeStopScanned: true });
    const scanSpy = vi
      .spyOn(ds, 'record_scan_event_v1')
      .mockResolvedValue({
        ok: true,
        scan_event_id: 'scan_route_load_1',
        created: true,
      });

    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    const scanner = await screen.findByTestId('ops-scanner-panel');
    await user.type(within(scanner).getByTestId('ops-scanner-input'), 'SHP-9381201');
    await waitFor(() => {
      expect(within(scanner).getByTestId('ops-scanner-match')).toHaveTextContent('Shipment');
    });
    expect(within(scanner).getByRole('button', { name: /Record load scan/i })).toBeEnabled();

    await user.click(within(scanner).getByRole('button', { name: /Record load scan/i }));

    await waitFor(() => expect(scanSpy).toHaveBeenCalledTimes(1));
    const [payload] = scanSpy.mock.calls[0] as [Record<string, unknown>];
    expect(payload).toMatchObject({
      organization_id: expect.stringMatching(/^org_/),
      scan_type: 'load',
      route_run_id: 'run_2841',
      route_stop_id: 'rs_44000',
      shipment_id: 'shp_9381201',
      barcode: 'SHP-9381201',
    });
    expect(readbackSpy).toHaveBeenCalledWith('scan_events', 'scan_route_load_1');
    expect(readbackSpy).toHaveBeenCalledWith('route_stops', 'rs_44000');
  });

  it('does not mark scanner load scans recorded when the backend write fails', async () => {
    clearToasts();
    const user = userEvent.setup();
    const scanSpy = vi
      .spyOn(ds, 'record_scan_event_v1')
      .mockRejectedValue(new Error('backend unavailable'));

    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    const scanner = await screen.findByTestId('ops-scanner-panel');
    const input = within(scanner).getByTestId('ops-scanner-input');
    await user.type(input, 'SHP-9381201');
    await waitFor(() => {
      expect(within(scanner).getByTestId('ops-scanner-match')).toHaveTextContent('Shipment');
    });
    await user.click(within(scanner).getByRole('button', { name: /Record load scan/i }));

    await waitFor(() => expect(scanSpy).toHaveBeenCalledTimes(1));
    expect(await within(scanner).findByText('Scan action failed')).toBeInTheDocument();
    expect(input).toHaveValue('SHP-9381201');
    expect(getToasts().some((toast) => toast.message.includes('Load scan could not be recorded. Try again.'))).toBe(true);
    expect(within(scanner).queryByText('Shipment recorded')).not.toBeInTheDocument();
    clearToasts();
  });

  it('does not mark scanner load scans recorded when canonical read-back fails after the write', async () => {
    clearToasts();
    const user = userEvent.setup();
    let failReadback = false;
    const realGet = ds.ui_get_resource_v1;
    vi.spyOn(ds, 'ui_get_resource_v1').mockImplementation(async (resource, id) => {
      if (resource === 'scan_events' && id === 'scan_route_load_readback_gap') {
        return {
          id,
          scan_type: 'load',
          created_at: '2026-05-07T10:00:00.000Z',
        };
      }
      if (failReadback && resource === 'route_stops' && id === 'rs_44000') {
        throw new Error('route stop read-back unavailable');
      }
      return realGet(resource, id);
    });
    const scanSpy = vi.spyOn(ds, 'record_scan_event_v1').mockImplementation(async () => {
      return {
        ok: true,
        scan_event_id: 'scan_route_load_readback_gap',
        created: true,
      };
    });

    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    const scanner = await screen.findByTestId('ops-scanner-panel');
    const input = within(scanner).getByTestId('ops-scanner-input');
    await user.type(input, 'SHP-9381201');
    await waitFor(() => {
      expect(within(scanner).getByTestId('ops-scanner-match')).toHaveTextContent('Shipment');
    });
    failReadback = true;
    await user.click(within(scanner).getByRole('button', { name: /Record load scan/i }));

    await waitFor(() => expect(scanSpy).toHaveBeenCalledTimes(1));
    expect(await within(scanner).findByText('Scan action failed')).toBeInTheDocument();
    expect(input).toHaveValue('SHP-9381201');
    expect(getToasts().some((toast) => toast.message.includes('Load scan could not be recorded. Try again.'))).toBe(true);
    expect(getToasts().some((toast) => toast.message.includes('Load scan recorded'))).toBe(false);
    expect(within(scanner).queryByText('Shipment recorded')).not.toBeInTheDocument();
    clearToasts();
  });

  it('does not mark scanner load scans recorded when the backend returns no scan event id', async () => {
    clearToasts();
    const user = userEvent.setup();
    const scanSpy = vi
      .spyOn(ds, 'record_scan_event_v1')
      .mockResolvedValue({
        ok: true,
        scan_event_id: '',
        created: true,
      } as Awaited<ReturnType<typeof ds.record_scan_event_v1>>);

    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    const scanner = await screen.findByTestId('ops-scanner-panel');
    const input = within(scanner).getByTestId('ops-scanner-input');
    await user.type(input, 'SHP-9381201');
    await waitFor(() => {
      expect(within(scanner).getByTestId('ops-scanner-match')).toHaveTextContent('Shipment');
    });
    await user.click(within(scanner).getByRole('button', { name: /Record load scan/i }));

    await waitFor(() => expect(scanSpy).toHaveBeenCalledTimes(1));
    expect(await within(scanner).findByText('Scan action failed')).toBeInTheDocument();
    expect(input).toHaveValue('SHP-9381201');
    expect(getToasts().some((toast) => toast.message.includes('Load scan could not be recorded. Try again.'))).toBe(true);
    expect(within(scanner).queryByText('Shipment recorded')).not.toBeInTheDocument();
    clearToasts();
  });

  it('does not mark scanner load scans recorded when the route-stop scan projection stays missing', async () => {
    clearToasts();
    const user = userEvent.setup();
    const realGet = ds.ui_get_resource_v1;
    vi.spyOn(ds, 'ui_get_resource_v1').mockImplementation(async (resource, id) => {
      if (resource === 'scan_events' && id === 'scan_route_load_stale_projection') {
        return { id, scan_type: 'load', created_at: '2026-05-07T10:00:00.000Z' };
      }
      if (resource === 'route_stops' && id === 'rs_44000') {
        const row = await realGet<Record<string, unknown>>(resource, id);
        return {
          ...(row ?? {}),
          id,
          load_scan_count: 0,
          load_scan_status: null,
          last_load_scanned_at: null,
        };
      }
      return realGet<Record<string, unknown>>(resource, id);
    });
    const scanSpy = vi.spyOn(ds, 'record_scan_event_v1').mockResolvedValue({
      ok: true,
      scan_event_id: 'scan_route_load_stale_projection',
      created: true,
    });

    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    const scanner = await screen.findByTestId('ops-scanner-panel');
    const input = within(scanner).getByTestId('ops-scanner-input');
    await user.type(input, 'SHP-9381201');
    await waitFor(() => {
      expect(within(scanner).getByTestId('ops-scanner-match')).toHaveTextContent('Shipment');
    });
    await user.click(within(scanner).getByRole('button', { name: /Record load scan/i }));

    await waitFor(() => expect(scanSpy).toHaveBeenCalledTimes(1));
    expect(await within(scanner).findByText('Scan action failed')).toBeInTheDocument();
    expect(input).toHaveValue('SHP-9381201');
    expect(getToasts().some((toast) => toast.message.includes('Load scan could not be recorded. Try again.'))).toBe(true);
    expect(getToasts().some((toast) => toast.message.includes('Load scan recorded'))).toBe(false);
    expect(within(scanner).queryByText('Shipment recorded')).not.toBeInTheDocument();
    clearToasts();
  });

  it('locks route-stop scanner shipment matches until the shipment row reads back', async () => {
    const user = userEvent.setup();
    const realList = ds.ui_list_resource_complete;
    const realGet = ds.ui_get_resource_v1;
    vi.spyOn(ds, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      const result = await realList(resource, opts);
      if (resource !== 'shipments') return result;
      return {
        ...result,
        rows: result.rows.filter((row) => (row as Record<string, unknown>).id !== 'shp_9381201'),
        total: Math.max(0, result.total - 1),
      };
    });
    vi.spyOn(ds, 'ui_get_resource_v1').mockImplementation(async (resource, id) => {
      if (resource === 'shipments' && id === 'shp_9381201') return null;
      return realGet(resource, id);
    });

    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    const scanner = await screen.findByTestId('ops-scanner-panel');
    await user.type(within(scanner).getByTestId('ops-scanner-input'), 'shp_9381201');
    await waitFor(() => {
      expect(within(scanner).getByTestId('ops-scanner-match')).toHaveTextContent('Shipment');
    });
    expect(within(scanner).getByText('Shipment details must load before this route-stop scan can be recorded.')).toBeInTheDocument();
    expect(within(scanner).getByRole('button', { name: /Record load scan/i })).toBeDisabled();
    expect(
      within(scanner).queryByRole('button', { name: /Open Shipment context/i }),
    ).not.toBeInTheDocument();
  });

  it('keeps focused route-stop handoff visible when enrichment reads fail', async () => {
    const realList = ds.ui_list_resource_complete;
    vi.spyOn(ds, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      if (resource === 'vehicle_directory') {
        throw new Error('vehicle directory unavailable');
      }
      return realList(resource, opts);
    });
    window.history.pushState(null, '', '/operate/dispatch?route_stop=rs_44000');

    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    expect(await screen.findByTestId('ops-scanner-panel')).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelectorAll('.run-row').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText('Dispatch data did not load')).not.toBeInTheDocument();
    expect(screen.getByTestId('dispatch-enrichment-read-warning')).toHaveTextContent(
      'Route context is still available',
    );
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Select stop 1' })).toBeChecked();
    });
  });

  it('opens shipment context in place from the Dispatch scanner shipment reference', async () => {
    const user = userEvent.setup();
    const shipmentReadSpy = mockSuccessfulShipmentContextRead();
    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    const scanner = await screen.findByTestId('ops-scanner-panel');
    await user.type(within(scanner).getByTestId('ops-scanner-input'), 'SHP-9381201');
    const reference = await within(scanner).findByRole('button', {
      name: /Open Shipment context SHP-9381201/i,
    });

    await user.click(reference);

    const drawer = await waitFor(() => {
      const el = document.querySelector('.drawer') as HTMLElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    expect(window.location.pathname).toBe('/operate/dispatch');
    expect(window.location.search).toBe('');
    expect(within(drawer).getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true');
    await expectShipmentContextRead(drawer, shipmentReadSpy);
    expect(document.querySelector('.pane')).not.toBeNull();
  });

  it('does not render fallback shipment context when the live shipment read fails', async () => {
    const user = userEvent.setup();
    const realGet = ds.ui_get_resource_v1;
    let failDrawerShipmentRead = false;
    vi.spyOn(ds, 'ui_get_resource_v1').mockImplementation(async (resource, id) => {
      if (failDrawerShipmentRead && resource === 'shipments' && id === 'shp_9381201') {
        throw new Error('shipment read unavailable');
      }
      return realGet(resource, id);
    });

    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    const scanner = await screen.findByTestId('ops-scanner-panel');
    await user.type(within(scanner).getByTestId('ops-scanner-input'), 'SHP-9381201');
    await waitFor(() => {
      expect(within(scanner).getByTestId('ops-scanner-match')).toHaveTextContent('Shipment');
    });
    const reference = await within(scanner).findByRole('button', {
      name: /Open Shipment context SHP-9381201/i,
    });
    expect(reference).toBeEnabled();

    failDrawerShipmentRead = true;
    await user.click(reference);

    const drawer = await waitFor(() => {
      const el = document.querySelector('.drawer') as HTMLElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    expect(await within(drawer).findByText('Shipment context unavailable')).toBeInTheDocument();
    expect(within(drawer).getByText('shipment read unavailable')).toBeInTheDocument();
    expect(within(drawer).queryByRole('tab', { name: 'Timeline' })).not.toBeInTheDocument();
  });

  it.each([
    {
      code: 'bsk_ruh_north_001',
      action: /Open basket/i,
      drawerTestId: 'dispatch-basket-context-drawer',
      drawerText: /Shipments in this basket on the active route/i,
      kind: 'Basket',
      resource: 'baskets',
      resourceId: 'bsk_ruh_north_001',
      markerField: 'label',
      marker: 'READ-BACKED-BASKET-001',
    },
    {
      code: 'Khalid Al-Otaibi',
      action: /Open driver/i,
      drawerTestId: 'dispatch-driver-context-drawer',
      drawerText: /Driver shipments/i,
      kind: 'Driver',
      resource: 'drivers',
      resourceId: 'usr_dr_khalid',
      markerField: 'name',
      marker: 'READ-BACKED-DRIVER-001',
    },
    {
      code: 'veh_van_118',
      action: /Open vehicle/i,
      drawerTestId: 'dispatch-vehicle-context-drawer',
      drawerText: /Vehicle shipments/i,
      kind: 'Vehicle',
      resource: 'vehicle_directory',
      resourceId: 'veh_van_118',
      markerField: 'code',
      marker: 'READ-BACKED-VEHICLE-001',
    },
    {
      code: 'RUN-RUN284',
      action: /Open route/i,
      drawerTestId: 'dispatch-route-context-drawer',
      drawerText: /Run shipments/i,
      kind: 'Route',
      resource: 'route_runs',
      resourceId: 'run_2841',
      markerField: 'planned_date',
      marker: 'READ-BACKED-ROUTE-001',
    },
  ])('opens $kind scanner references as in-place Dispatch context instead of routing away', async ({ code, action, drawerTestId, drawerText, kind, resource, resourceId, markerField, marker }) => {
    const user = userEvent.setup();
    const realGet = ds.ui_get_resource_v1;
    const getResourceSpy = vi.spyOn(ds, 'ui_get_resource_v1').mockImplementation(async (requestedResource, id) => {
      const row = await realGet<Record<string, unknown>>(requestedResource, id);
      if (requestedResource === resource && id === resourceId && row) {
        return {
          ...row,
          [markerField]: marker,
        };
      }
      return row;
    });
    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    const scanner = await screen.findByTestId('ops-scanner-panel');
    await user.type(within(scanner).getByTestId('ops-scanner-input'), code);
    await waitFor(() => {
      expect(within(scanner).getByTestId('ops-scanner-match')).toHaveTextContent(kind);
    });

    const actionButtons = within(scanner).getAllByRole('button', { name: action });
    const submitAction = actionButtons.find((button) => button.getAttribute('type') === 'submit');
    expect(submitAction).toBeTruthy();
    expect(submitAction).toBeEnabled();
    await user.click(submitAction!);

    const drawer = await screen.findByTestId(drawerTestId);
    expect(drawer).toHaveTextContent(drawerText);
    await waitFor(() => {
      expect(
        getResourceSpy.mock.calls.some(([requestedResource, id]) => requestedResource === resource && id === resourceId),
      ).toBe(true);
    });
    expect(await within(drawer).findByText(marker)).toBeInTheDocument();
    expect(window.location.pathname).toBe('/operate/dispatch');
    expect(window.location.search).toBe('');
    expect(document.querySelector('.pane')).not.toBeNull();
  });

  it.each([
    {
      code: 'bsk_ruh_north_001',
      action: /Open basket/i,
      kind: 'Basket',
      resource: 'baskets',
      resourceId: 'bsk_ruh_north_001',
      unavailable: 'Basket context unavailable',
    },
    {
      code: 'Khalid Al-Otaibi',
      action: /Open driver/i,
      kind: 'Driver',
      resource: 'drivers',
      resourceId: 'usr_dr_khalid',
      unavailable: 'Driver context unavailable',
    },
    {
      code: 'veh_van_118',
      action: /Open vehicle/i,
      kind: 'Vehicle',
      resource: 'vehicle_directory',
      resourceId: 'veh_van_118',
      unavailable: 'Vehicle context unavailable',
    },
    {
      code: 'RUN-RUN284',
      action: /Open route/i,
      kind: 'Route',
      resource: 'route_runs',
      resourceId: 'run_2841',
      unavailable: 'Route context unavailable',
    },
  ])('fails closed when $kind context refetch fails', async ({ code, action, kind, resource, resourceId, unavailable }) => {
    const user = userEvent.setup();
    const realGet = ds.ui_get_resource_v1;
    let failContextRead = false;
    vi.spyOn(ds, 'ui_get_resource_v1').mockImplementation(async (requestedResource, id) => {
      if (failContextRead && requestedResource === resource && id === resourceId) {
        throw new Error(`${resource} read unavailable`);
      }
      return realGet(requestedResource, id);
    });

    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    const scanner = await screen.findByTestId('ops-scanner-panel');
    await user.type(within(scanner).getByTestId('ops-scanner-input'), code);
    await waitFor(() => {
      expect(within(scanner).getByTestId('ops-scanner-match')).toHaveTextContent(kind);
    });

    const actionButtons = within(scanner).getAllByRole('button', { name: action });
    const submitAction = actionButtons.find((button) => button.getAttribute('type') === 'submit');
    expect(submitAction).toBeTruthy();
    expect(submitAction).toBeEnabled();

    failContextRead = true;
    await user.click(submitAction!);

    const drawer = await waitFor(() => {
      const el = document.querySelector('.drawer') as HTMLElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    expect(await within(drawer).findByText(unavailable)).toBeInTheDocument();
    expect(within(drawer).getByText(`${resource} read unavailable`)).toBeInTheDocument();
    expect(within(drawer).queryByTestId(`dispatch-${kind.toLowerCase()}-context-drawer`)).not.toBeInTheDocument();
  });

  it('matches the active route scanner by backend directory run code', async () => {
    const user = userEvent.setup();
    const realList = ds.ui_list_resource_complete;
    const listSpy = vi.spyOn(ds, 'ui_list_resource_complete');
    listSpy.mockImplementation(async (resource, opts) => {
      const result = await realList(resource, opts);
      if (resource !== 'route_run_directory') return result;
      return {
        ...result,
        rows: result.rows.map((row) =>
          String((row as Record<string, unknown>).id) === 'run_2841'
            ? { ...row, run_display_id: 'DIR-ROUTE-2841' }
            : row,
        ),
      };
    });

    try {
      renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

      const scanner = await screen.findByTestId('ops-scanner-panel');
      await user.type(within(scanner).getByTestId('ops-scanner-input'), 'DIR-ROUTE-2841');

      await waitFor(() => {
        const match = within(scanner).getByTestId('ops-scanner-match');
        expect(match).toHaveTextContent('Route');
        expect(match).toHaveTextContent('DIR-ROUTE-2841');
      });
    } finally {
      listSpy.mockRestore();
    }
  });

  it('opens shipment context in place from the Dispatch stop shipment reference', async () => {
    const user = userEvent.setup();
    const shipmentReadSpy = mockSuccessfulShipmentContextRead();
    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    const firstStop = await waitFor(() => {
      const row = document.querySelector('.dnd-stop') as HTMLElement | null;
      expect(row).not.toBeNull();
      return row!;
    });
    const shipmentButtons = within(firstStop).getAllByRole('button').filter((button) => {
      const label = button.textContent ?? '';
      return /SHP-|shp_/i.test(label);
    });
    expect(shipmentButtons.length).toBeGreaterThan(0);

    await user.click(shipmentButtons[0]!);

    const drawer = await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
      return document.querySelector('.drawer') as HTMLElement;
    });
    expect(window.location.pathname).toBe('/operate/dispatch');
    expect(window.location.search).toBe('');
    expect(within(drawer).getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true');
    await expectShipmentContextRead(drawer, shipmentReadSpy);
    expect(document.querySelector('.pane')).not.toBeNull();
  });

  it('opens shipment evidence in the current Dispatch drawer instead of routing away', async () => {
    const user = userEvent.setup();
    const shipmentReadSpy = mockSuccessfulShipmentContextRead();
    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    const evidenceButtons = await screen.findAllByRole('button', { name: /^Evidence$/i });
    await user.click(evidenceButtons[0]!);

    const drawer = await waitFor(() => {
      const el = document.querySelector('.drawer') as HTMLElement | null;
      expect(el).not.toBeNull();
      expect(within(el!).getByRole('tab', { name: 'Evidence' })).toHaveAttribute('aria-selected', 'true');
      return el!;
    });
    expect(window.location.pathname).toBe('/operate/dispatch');
    expect(window.location.search).toBe('');
    await expectShipmentContextRead(drawer, shipmentReadSpy);
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/Proof of delivery|No proof of delivery/i);
    });
  });

  it('opens shipment proof from the stop closeout modal without leaving Dispatch', async () => {
    const user = userEvent.setup();
    const shipmentReadSpy = mockSuccessfulShipmentContextRead();
    const realList = ds.ui_list_resource_complete;
    const listSpy = vi.spyOn(ds, 'ui_list_resource_complete');
    listSpy.mockImplementation(async (resource, opts) => {
      const result = await realList(resource, opts);
      if (resource === 'route_runs') {
        return {
          ...result,
          rows: result.rows.map((row) => ({
            ...row,
            metadata: {
              ...((row as Record<string, unknown>).metadata as Record<string, unknown> | undefined),
              route_departure: { confirmed_at: '2026-05-07T09:00:00.000Z' },
            },
          })),
        };
      }
      if (resource !== 'tasks') return result;
      return {
        ...result,
        rows: result.rows.map((row) =>
          String((row as Record<string, unknown>).task_type ?? '') === 'route_stop_execute'
            ? { ...row, status: 'open' }
            : row,
        ),
      };
    });

    try {
      renderWithProviders(<DispatchModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: /^Close stop$/i }).length).toBeGreaterThan(0);
      });
      const enabledCloseout = screen.getAllByRole('button', { name: /^Close stop$/i }).find((button) => !button.hasAttribute('disabled'));
      expect(enabledCloseout).toBeTruthy();
      await user.click(enabledCloseout!);

      expect(await screen.findByTestId('route-stop-closeout-modal')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /View shipment proof/i }));

      const drawer = await waitFor(() => {
        const el = document.querySelector('.drawer') as HTMLElement | null;
        expect(el).not.toBeNull();
        expect(within(el!).getByRole('tab', { name: 'Evidence' })).toHaveAttribute('aria-selected', 'true');
        return el!;
      });
      expect(window.location.pathname).toBe('/operate/dispatch');
      expect(window.location.search).toBe('');
      await expectShipmentContextRead(drawer, shipmentReadSpy);
    } finally {
      listSpy.mockRestore();
      shipmentReadSpy.mockRestore();
    }
  }, 10000);

  it('records unmatched scanner codes as unexpected route-load scans', async () => {
    const user = userEvent.setup();
    const readbackSpy = mockDispatchScanReadback('scan_route_load_unexpected_1');
    const scanSpy = vi
      .spyOn(ds, 'record_scan_event_v1')
      .mockResolvedValue({
        ok: true,
        scan_event_id: 'scan_route_load_unexpected_1',
        created: true,
      });

    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    const scanner = await screen.findByTestId('ops-scanner-panel');
    await user.type(within(scanner).getByTestId('ops-scanner-input'), 'unexpected-box-9');
    await waitFor(() => {
      expect(within(scanner).getByTestId('ops-scanner-no-match')).toHaveTextContent('unexpected load scan');
    });
    await user.click(within(scanner).getByRole('button', { name: /Record unexpected load scan/i }));

    await waitFor(() => expect(scanSpy).toHaveBeenCalledTimes(1));
    const [payload] = scanSpy.mock.calls[0] as [Record<string, unknown>];
    expect(payload).toMatchObject({
      organization_id: expect.stringMatching(/^org_/),
      scan_type: 'load',
      route_run_id: 'run_2841',
      barcode: 'UNEXPECTED-BOX-9',
      metadata: expect.objectContaining({
        source: 'console_v2_dispatch',
        action: 'unexpected_route_load_scan',
        classification: 'unexpected',
      }),
    });
    expect(payload).not.toHaveProperty('route_stop_id');
    expect(payload).not.toHaveProperty('shipment_id');
    expect(readbackSpy).toHaveBeenCalledWith('scan_events', 'scan_route_load_unexpected_1');
  });

  it('does not mark unmatched scanner codes recorded when scan-event readback is missing', async () => {
    clearToasts();
    const user = userEvent.setup();
    const realGet = ds.ui_get_resource_v1;
    vi.spyOn(ds, 'ui_get_resource_v1').mockImplementation(async (resource, id) => {
      if (resource === 'scan_events' && id === 'scan_route_load_unexpected_missing') {
        return null;
      }
      return realGet<Record<string, unknown>>(resource, id);
    });
    const scanSpy = vi
      .spyOn(ds, 'record_scan_event_v1')
      .mockResolvedValue({
        ok: true,
        scan_event_id: 'scan_route_load_unexpected_missing',
        created: true,
      });

    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    const scanner = await screen.findByTestId('ops-scanner-panel');
    const input = within(scanner).getByTestId('ops-scanner-input');
    await user.type(input, 'unexpected-box-9');
    await waitFor(() => {
      expect(within(scanner).getByTestId('ops-scanner-no-match')).toHaveTextContent('unexpected load scan');
    });
    await user.click(within(scanner).getByRole('button', { name: /Record unexpected load scan/i }));

    await waitFor(() => expect(scanSpy).toHaveBeenCalledTimes(1));
    expect(await within(scanner).findByText('Scan action failed')).toBeInTheDocument();
    expect(input).toHaveValue('unexpected-box-9');
    expect(getToasts().some((toast) => toast.message.includes('Unexpected scan could not be recorded. Try again.'))).toBe(true);
    expect(within(scanner).queryByText('Unexpected scan recorded')).not.toBeInTheDocument();
    clearToasts();
  });

  it('confirms route-run departure through ui_confirm_route_run_departure_v1', async () => {
    const user = userEvent.setup();
    const reconcileSpy = vi
      .spyOn(ds, 'route_run_scan_out_reconciliation_v1')
      .mockResolvedValue({
        ok: true,
        expected: 3,
        scanned: 3,
        discrepancies: [],
        run_id: 'rr_test',
      });
    const confirmSpy = vi
      .spyOn(ds, 'ui_confirm_route_run_departure_v1')
      .mockResolvedValue({
        ok: true,
        departure_confirmed_at: '2026-05-06T08:00:00.000Z',
        run_id: 'rr_test',
      });

    const { queryClient } = renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    await waitFor(() => {
      expect(document.querySelector('.run-row.is-active')).not.toBeNull();
    });

    expect(screen.getByRole('button', { name: /Confirm departure/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Reconcile scan-out/i }));
    await waitFor(() => {
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
    });
    await user.click(await findScanOutResultDrawerClose(/None/i));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Confirm departure/i })).not.toBeDisabled();
    });

    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await user.click(screen.getByRole('button', { name: /Confirm departure/i }));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledTimes(1);
    });
    const [runId] = confirmSpy.mock.calls[0] as [string];
    expect(runId).toEqual(expect.any(String));
    expect(runId.length).toBeGreaterThan(0);
    await waitFor(() => {
      expectInvalidatedResource(invalidate, 'route_runs');
      expectInvalidatedResource(invalidate, 'route_stops');
      expectInvalidatedResource(invalidate, 'route_run_directory');
      expectInvalidatedResource(invalidate, 'route_run_assignments');
      expectInvalidatedResource(invalidate, 'route_run_assignment_events');
      expectInvalidatedCompleteResource(invalidate, 'route_runs');
      expectInvalidatedCompleteResource(invalidate, 'route_stops');
      expectInvalidatedCompleteResource(invalidate, 'route_run_directory');
      expectInvalidatedCompleteResource(invalidate, 'route_run_assignments');
    });
  }, 10000);

  it('shows backend scan-out detail when route-run departure is blocked', async () => {
    const user = userEvent.setup();
    vi.spyOn(ds, 'route_run_scan_out_reconciliation_v1').mockResolvedValue({
      ok: true,
      expected: 3,
      scanned: 3,
      discrepancies: [],
      run_id: 'rr_test',
    });
    vi.spyOn(ds, 'ui_confirm_route_run_departure_v1').mockRejectedValue(
      new Error(
        'confirm_route_run_departure_v1 route_run rr_test is not ready for departure (missing 1, duplicate 1, unexpected 1); missing_route_stop_ids ["stop_1"], duplicate_route_stop_ids ["stop_2"], unexpected_barcodes ["BOX-9"]',
      ),
    );

    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    await waitFor(() => {
      expect(document.querySelector('.run-row.is-active')).not.toBeNull();
    });
    await user.click(screen.getByRole('button', { name: /Reconcile scan-out/i }));
    await user.click(await findScanOutResultDrawerClose(/None/i));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Confirm departure/i })).not.toBeDisabled();
    });

    await user.click(screen.getByRole('button', { name: /Confirm departure/i }));

    await waitFor(() => {
      expect(
        getToasts().some((toast) =>
          toast.message.includes('missing stops stop_1') &&
          toast.message.includes('unexpected barcodes BOX-9'),
        ),
      ).toBe(true);
    });
  }, 10000);

  it('keeps departure blocked until the latest scan-out reconciliation is clear', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi
      .spyOn(ds, 'ui_confirm_route_run_departure_v1')
      .mockResolvedValue({
        ok: true,
        departure_confirmed_at: '2026-05-06T08:00:00.000Z',
        run_id: 'rr_test',
      });
    const reconcileSpy = vi
      .spyOn(ds, 'route_run_scan_out_reconciliation_v1')
      .mockResolvedValueOnce({
        ok: true,
        expected: 3,
        scanned: 2,
        discrepancies: ['Missing shipment SHP-1'],
        run_id: 'rr_test',
      })
      .mockResolvedValueOnce({
        ok: true,
        expected: 3,
        scanned: 3,
        discrepancies: [],
        run_id: 'rr_test',
      });

    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    await waitFor(() => {
      expect(document.querySelector('.run-row.is-active')).not.toBeNull();
    });

    expect(screen.getByRole('button', { name: /Confirm departure/i })).toBeDisabled();
    expect(screen.getByTestId('departure-gate-hint')).toHaveTextContent(/scan-out reconciliation first/i);

    await user.click(screen.getByRole('button', { name: /Reconcile scan-out/i }));
    await waitFor(() => expect(reconcileSpy).toHaveBeenCalledTimes(1));
    await user.click(await findScanOutResultDrawerClose('Missing shipment SHP-1'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Confirm departure/i })).toBeDisabled();
      expect(screen.getByTestId('departure-gate-hint')).toHaveTextContent(/Resolve scan-out discrepancies/i);
    });

    await user.click(screen.getByRole('button', { name: /Reconcile scan-out/i }));
    await waitFor(() => expect(reconcileSpy).toHaveBeenCalledTimes(2));
    await user.click(await findScanOutResultDrawerClose(/None/i));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Confirm departure/i })).not.toBeDisabled();
    });

    await user.click(screen.getByRole('button', { name: /Confirm departure/i }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
  }, 20000);

  it('keeps departure enabled when scan-out readback refreshes the assignment projection', async () => {
    const user = userEvent.setup();
    let scanOutCompleted = false;
    const realList = ds.ui_list_resource_complete;
    const listSpy = vi.spyOn(ds, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      const result = await realList(resource, opts);
      if (resource !== 'route_run_assignments') return result;
      return {
        ...result,
        rows: result.rows.map((row) => ({
          ...row,
          assignment_version: scanOutCompleted
            ? Number((row as Record<string, unknown>).assignment_version ?? 0) + 1
            : (row as Record<string, unknown>).assignment_version,
        })),
      };
    });
    const reconcileSpy = vi
      .spyOn(ds, 'route_run_scan_out_reconciliation_v1')
      .mockImplementation(async () => {
        scanOutCompleted = true;
        return {
          ok: true,
          expected: 3,
          scanned: 3,
          discrepancies: [],
          run_id: 'rr_test',
        };
      });

    try {
      renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

      await waitFor(() => {
        expect(document.querySelector('.run-row.is-active')).not.toBeNull();
      });
      await user.click(screen.getByRole('button', { name: /Reconcile scan-out/i }));
      await waitFor(() => expect(reconcileSpy).toHaveBeenCalledTimes(1));
      await user.click(await findScanOutResultDrawerClose(/None/i));

      await waitFor(() => {
        const confirmDeparture = screen.getByRole('button', { name: /Confirm departure/i });
        expect(confirmDeparture).not.toBeDisabled();
        expect(confirmDeparture).toHaveAttribute('title', 'Latest scan-out matched 3/3.');
        expect(screen.getByText(/Scan-out clear/i)).toBeInTheDocument();
      });
    } finally {
      listSpy.mockRestore();
    }
  }, 15000);

  it('keeps scan-out and departure permission-gated for read-scoped route operators', async () => {
    const user = userEvent.setup();
    const reconcileSpy = vi
      .spyOn(ds, 'route_run_scan_out_reconciliation_v1')
      .mockResolvedValue({
        ok: true,
        expected: 3,
        scanned: 3,
        discrepancies: [],
        run_id: 'rr_test',
      });
    const confirmSpy = vi
      .spyOn(ds, 'ui_confirm_route_run_departure_v1')
      .mockResolvedValue({
        ok: true,
        departure_confirmed_at: '2026-05-06T08:00:00.000Z',
        run_id: 'rr_test',
      });

    renderWithProviders(<DispatchModule />, { capabilities: ['routes.read'] });

    await waitFor(() => {
      expect(document.querySelector('.run-row.is-active')).not.toBeNull();
    });

    const reconcileButton = screen.getByRole('button', { name: /Reconcile scan-out/i });
    const confirmButton = screen.getByRole('button', { name: /Confirm departure/i });
    expect(reconcileButton).toBeDisabled();
    expect(confirmButton).toBeDisabled();
    expect(reconcileButton).toHaveAttribute('title', 'Route update permission required to reconcile scan-out.');

    await user.click(reconcileButton);
    await user.click(confirmButton);
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  }, 10000);

  it('bulk reassigns selected stops through ui_execute_route_stop_reassign_v1', async () => {
    const user = userEvent.setup();
    const reassignSpy = vi
      .spyOn(ds, 'ui_execute_route_stop_reassign_v1')
      .mockResolvedValue({
        ok: true,
        count: 1,
        target: { target_route_run_id: 'rr_target' },
        assignment_status: 'reassigned',
      });

    const { queryClient } = renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dnd-stop').length).toBeGreaterThan(0);
    });

    const firstStop = document.querySelector('.dnd-stop') as HTMLElement;
    const firstStopText = (firstStop.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(firstStopText.length).toBeGreaterThan(0);
    const checkbox = firstStop.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    await user.click(checkbox);

    const reassignButton = await screen.findByRole('button', { name: /Reassign/i });
    await waitFor(() => expect(reassignButton).not.toBeDisabled());
    await user.click(reassignButton);

    await waitFor(() => {
      expect(document.querySelector('.palette__item')).not.toBeNull();
    });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const targetRuns = Array.from(document.querySelectorAll('.palette__item')) as HTMLElement[];
    expect(targetRuns.length).toBeGreaterThan(1);
    const targetRun = targetRuns[1]!;
    await user.click(targetRun);

    await waitFor(() => {
      expect(reassignSpy).toHaveBeenCalledTimes(1);
    });
    const [stopIds, target] = reassignSpy.mock.calls[0] as [
      string[],
      { target_route_run_id?: string; driver_user_id?: string; vehicle_id?: string },
    ];
    expect(stopIds).toHaveLength(1);
    expect(stopIds[0]).toMatch(/^rs_/);
    expect(target.target_route_run_id).toBeUndefined();
    expect(target.driver_user_id).toEqual(expect.any(String));
    expect(target.driver_user_id?.length).toBeGreaterThan(0);
    await waitFor(() => {
      expectInvalidatedResource(invalidate, 'route_runs');
      expectInvalidatedResource(invalidate, 'route_stops');
      expectInvalidatedResource(invalidate, 'route_run_directory');
      expectInvalidatedResource(invalidate, 'route_stop_reassignment_events');
      expectInvalidatedResource(invalidate, 'tasks');
      expectInvalidatedCompleteResource(invalidate, 'route_runs');
      expectInvalidatedCompleteResource(invalidate, 'route_stops');
      expectInvalidatedCompleteResource(invalidate, 'route_run_directory');
      expectInvalidatedCompleteResource(invalidate, 'tasks');
    });
    await waitFor(() => {
      const visibleStops = Array.from(document.querySelectorAll('.dnd-stop'))
        .map((row) => (row.textContent ?? '').replace(/\s+/g, ' ').trim());
      expect(visibleStops.some((text) => text.includes(firstStopText))).toBe(true);
    });
  });

  it('blocks whole-route stop reassignment in favor of route takeover', async () => {
    const user = userEvent.setup();
    const reassignSpy = vi.spyOn(ds, 'ui_execute_route_stop_reassign_v1');

    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dnd-stop input[type="checkbox"]').length).toBeGreaterThan(0);
    });

    const checkboxes = Array.from(
      document.querySelectorAll('.dnd-stop input[type="checkbox"]'),
    ) as HTMLInputElement[];
    for (const checkbox of checkboxes) {
      await user.click(checkbox);
    }

    const reassignButton = await screen.findByRole('button', { name: /Reassign/i });
    expect(reassignButton).toBeDisabled();
    expect(reassignButton).toHaveAttribute(
      'title',
      'Use route takeover for whole-route reassignment; stop reassignment requires leaving at least one stop on the source run.',
    );
    expect(reassignSpy).not.toHaveBeenCalled();
  });

  it('moves selected stops from the inline target owner action', async () => {
    const user = userEvent.setup();
    const reassignSpy = vi
      .spyOn(ds, 'ui_execute_route_stop_reassign_v1')
      .mockResolvedValue({
        ok: true,
        count: 1,
        items: [{ target_route_run_id: 'rr_split_target' }],
        assignment_status: 'reassigned',
      } as never);

    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dnd-stop').length).toBeGreaterThan(0);
    });

    const firstStop = document.querySelector('.dnd-stop') as HTMLElement;
    const checkbox = firstStop.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await user.click(checkbox);

    const moveSelected = await screen.findByRole('button', { name: /^Move selected$/i });
    await waitFor(() => expect(moveSelected).not.toBeDisabled());
    await user.click(moveSelected);

    await waitFor(() => {
      expect(reassignSpy).toHaveBeenCalledTimes(1);
    });
    const [, target] = reassignSpy.mock.calls[0] as [
      string[],
      { target_route_run_id?: string; driver_user_id?: string; partner_id?: string },
    ];
    expect(target.target_route_run_id).toBeUndefined();
    expect(target.driver_user_id || target.partner_id).toEqual(expect.any(String));
  });

  it('moves selected stops from a target owner row without opening the picker', async () => {
    const user = userEvent.setup();
    const reassignSpy = vi
      .spyOn(ds, 'ui_execute_route_stop_reassign_v1')
      .mockResolvedValue({
        ok: true,
        count: 1,
        items: [{ target_route_run_id: 'rr_split_target' }],
        assignment_status: 'reassigned',
      } as never);

    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dnd-stop').length).toBeGreaterThan(0);
    });

    const firstStop = document.querySelector('.dnd-stop') as HTMLElement;
    const checkbox = firstStop.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await user.click(checkbox);

    const moveButtons = await screen.findAllByRole('button', { name: /Move to this owner/i });
    expect(moveButtons.length).toBeGreaterThan(0);
    await user.click(moveButtons[0]!);

    await waitFor(() => {
      expect(reassignSpy).toHaveBeenCalledTimes(1);
    });
    const [, target] = reassignSpy.mock.calls[0] as [
      string[],
      { target_route_run_id?: string; driver_user_id?: string; partner_id?: string },
    ];
    expect(target.target_route_run_id).toBeUndefined();
    expect(target.driver_user_id || target.partner_id).toEqual(expect.any(String));
  });

  it('clicking an eligible target run row moves selected stops', async () => {
    const user = userEvent.setup();
    const reassignSpy = vi
      .spyOn(ds, 'ui_execute_route_stop_reassign_v1')
      .mockResolvedValue({
        ok: true,
        count: 1,
        items: [{ target_route_run_id: 'rr_split_target' }],
        assignment_status: 'reassigned',
      } as never);

    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dnd-stop').length).toBeGreaterThan(0);
    });

    const firstStop = document.querySelector('.dnd-stop') as HTMLElement;
    const checkbox = firstStop.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await user.click(checkbox);

    const targetRow = Array.from(document.querySelectorAll('.run-row')).find((row) =>
      (row.textContent ?? '').includes('Move to this owner'),
    ) as HTMLElement | undefined;
    expect(targetRow).toBeTruthy();
    await user.click(targetRow!);

    await waitFor(() => {
      expect(reassignSpy).toHaveBeenCalledTimes(1);
    });
  });
});
