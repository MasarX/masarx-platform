import { describe, expect, it } from 'vitest';
import { normalizeShipmentTimelineRows } from './shipment-timeline';

describe('normalizeShipmentTimelineRows', () => {
  it('keeps the seed timeline array shape renderable', () => {
    expect(
      normalizeShipmentTimelineRows([
        {
          time: '2026-04-24T08:14Z',
          action: 'Shipment created',
          detail: 'Inbound webhook',
          status: 'done',
        },
      ]),
    ).toEqual([
      {
        time: '2026-04-24T08:14Z',
        action: 'Shipment created',
        detail: 'Inbound webhook',
        status: 'done',
      },
    ]);
  });

  it('normalizes the backend ui_get_shipment_timeline_v1 JSON object', () => {
    expect(
      normalizeShipmentTimelineRows({
        shipment_id: 'shipment-1',
        timeline_events: [
          {
            event_id: 'event-1',
            event_source: 'shipment_action',
            event_type: 'route_stop_finalize',
            event_time: '2026-04-25T13:30:00Z',
            summary: 'Delivered with COD collected',
            status: 'completed',
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        event_id: 'event-1',
        time: '2026-04-25T13:30:00Z',
        action: 'Route stop finalize',
        detail: 'Delivered with COD collected',
        status: 'completed',
      }),
    ]);
  });

  it('humanizes action tokens and operator-facing backend detail text', () => {
    expect(
      normalizeShipmentTimelineRows([
        {
          time: '2026-04-24T08:14Z',
          action: 'campaign_enrollment',
          detail: 'recipient_missing',
          status: 'done',
        },
        {
          time: '2026-04-24T08:15Z',
          action: 'workflow',
          detail: 'Inbound webhook · Exampleparcel KSA · mapping_config exampleparcel_ksa_v3.shipment_inbound',
          status: 'done',
        },
        {
          time: '2026-04-24T08:16Z',
          action: 'sorted_to_wave',
          detail: 'route.allow_partial_publish=true · wave RUH-N-W2',
          status: 'done',
        },
        {
          time: '2026-04-25T07:48Z',
          action: 'picked_up',
          detail: 'Driver Khalid Al-Otaibi · VAN-118 · scan_event verified',
          status: 'done',
        },
        {
          time: '2026-04-25T13:30Z',
          action: 'on_approach',
          detail: 'Driving lock active (driver_safety_policy)',
          status: 'pending',
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        action: 'Campaign enrollment',
        detail: 'Recipient missing',
      }),
      expect.objectContaining({
        action: 'Workflow',
        detail: 'Inbound webhook · Exampleparcel KSA · mapping profile Exampleparcel KSA V3 Shipment Inbound',
      }),
      expect.objectContaining({
        action: 'Sorted to wave',
        detail: 'Partial route publish allowed · wave RUH-N-W2',
      }),
      expect.objectContaining({
        action: 'Picked up',
        detail: 'Driver Khalid Al-Otaibi · VAN-118 · scan verified',
      }),
      expect.objectContaining({
        action: 'On approach',
        detail: 'Driving lock active (driver safety policy)',
      }),
    ]);
  });

  it('does not expose raw timeline implementation terms', () => {
    const rows = normalizeShipmentTimelineRows([
      {
        time: '2026-04-24T08:14Z',
        action: 'shipment_created',
        detail: 'mapping_config exampleparcel_ksa_v3.shipment_inbound · scan_event verified · driver_safety_policy · route.allow_partial_publish=true',
        status: 'done',
      },
    ]);

    expect(rows[0]?.detail).not.toMatch(/mapping_config|scan_event|driver_safety_policy|route\.allow_partial_publish/i);
  });

  it('normalizes noisy policy and provider exception details', () => {
    const rows = normalizeShipmentTimelineRows([
      {
        time: '2026-04-24T08:14Z',
        action: 'workflow_policy',
        detail: 'policy_not_found',
        status: 'failed',
      },
      {
        time: '2026-04-24T08:15Z',
        action: 'comms_sms',
        detail: 'Invalid URL',
        status: 'failed',
      },
    ]);

    expect(rows[0]?.detail).toBe('Policy configuration needs review');
    expect(rows[1]?.detail).toBe('Communication provider endpoint needs configuration');
    expect(rows.map((row) => row.detail).join(' ')).not.toMatch(/policy_not_found|policy not found|invalid url/i);
  });

  it('fails closed for malformed payloads', () => {
    expect(normalizeShipmentTimelineRows({ timeline_events: { bad: true } })).toEqual([]);
    expect(normalizeShipmentTimelineRows(null)).toEqual([]);
  });
});
