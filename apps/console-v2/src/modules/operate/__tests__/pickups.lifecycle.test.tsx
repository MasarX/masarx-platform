// pickups.lifecycle.test.tsx — closes OPERATIONS reaudit D2 for the
// pickups surface. The existing `pickups.test.tsx` covers Create wave +
// Assign driver; this file adds per-RPC assertions for the remaining
// lifecycle actions: Failures-tab "Retry now" (create_pickup_wave_v1) and
// Reschedule pickup (shipment_amend_cancel_v1 op=reschedule), plus
// negative capability gating.
//
// Asserted behavior:
//   1. mount + capability gate.
//   2. happy path — clicking the action fires the canonical RPC with the
//      expected payload shape (organization_id + shipment_ids for
//      create_pickup_wave_v1, op=reschedule + payload for amend).
//   3. failure mode — module does not crash when the RPC rejects
//      (Retry now path catches the error inline via try in onClick).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { PickupsModule } from '@/modules/operate/pickups';
import * as api from '@/lib/api';
import * as toastStore from '@/components/toastStore';

beforeEach(() => {
  vi.restoreAllMocks();
  toastStore.clearToasts();
});

afterEach(() => {
  toastStore.clearToasts();
  vi.restoreAllMocks();
});

async function mountAndWait(opts?: { capabilities?: string[] }) {
  const utils = renderWithProviders(<PickupsModule />, {
    capabilities: opts?.capabilities ?? ['all'],
  });
  await waitFor(() => {
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  }, { timeout: 3000 });
  return utils;
}

function mockShipmentReadback() {
  const realGetResource = api.ui_get_resource_v1;
  return vi.spyOn(api, 'ui_get_resource_v1').mockImplementation(async (key: string, id: string) => {
    if (key === 'shipments') {
      return {
        id,
        tracking_number: String(id),
        service_type: 'standard_delivery',
        status: 'pickup_requested',
      } as never;
    }
    return realGetResource(key, id);
  });
}

describe('PickupsModule · failure + reschedule lifecycle (OPERATIONS reaudit D2)', () => {
  it('mounts and shows Requests / Waves / Failures tabs (cap-positive)', async () => {
    await mountAndWait();
    expect(screen.getByText('Requests')).toBeInTheDocument();
    expect(screen.getByText('Waves')).toBeInTheDocument();
    expect(screen.getByText('Failures')).toBeInTheDocument();
  });

  it('Requests row opens the shipment context in place', async () => {
    window.history.pushState(null, '', '/operate/pickups');
    const user = userEvent.setup();
    const getSpy = mockShipmentReadback();
    await mountAndWait();
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    const firstRow = document.querySelector('.dt__table tbody tr') as HTMLElement | null;
    expect(firstRow).not.toBeNull();
    await user.click(firstRow!);

    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    expect(window.location.pathname).toBe('/operate/pickups');
    expect(window.location.search).toBe('');
    await waitFor(() => {
      expect(getSpy.mock.calls.some(([key]) => key === 'shipments')).toBe(true);
    });
    expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true');
  });

  it('Failures tab "Retry now" gates on fleet.write (negative)', async () => {
    const user = userEvent.setup();
    await mountAndWait({ capabilities: ['shipments.read', 'pickups.read'] });
    await user.click(screen.getByText('Failures'));
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    // The row-actions overflow opens a palette — fleet.write-gated entries
    // are present but disabled. Open the first row's overflow.
    const overflowButtons = screen.getAllByRole('button', { name: /Row actions/i });
    if (!overflowButtons[0]) throw new Error('No row-actions overflow button');
    await user.click(overflowButtons[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('.palette__item').length).toBeGreaterThan(0);
    });
    // CapabilityLock chip surfaces the missing fleet.write capability inside
    // the palette row for "Retry now".
    expect(screen.getAllByText(/Fleet update permission required/i).length).toBeGreaterThan(0);
  });

  it('Failures tab "Retry now" fires create_pickup_wave_v1 with canonical shipment_ids payload', async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, 'create_pickup_wave_v1')
      .mockResolvedValue({ ok: true, wave_id: 'pwv_retry_test' });
    await mountAndWait();
    await user.click(screen.getByText('Failures'));
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    // Open the first row's overflow palette.
    const overflowButtons = screen.getAllByRole('button', { name: /Row actions/i });
    if (!overflowButtons[0]) throw new Error('No row-actions overflow button');
    await user.click(overflowButtons[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('.palette__item').length).toBeGreaterThan(0);
    });
    const labels = Array.from(
      document.querySelectorAll('.palette__item .palette__item-label'),
    ) as HTMLElement[];
    const retryItem = labels.find((el) => /Retry now/i.test(el.textContent ?? ''));
    if (!retryItem) throw new Error('Retry now palette item not found');
    await user.click(retryItem);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const readback = await screen.findByLabelText('Pickup retry status');
    expect(readback).toHaveTextContent('Confirmation saved and pickup queues refreshed');
    expect(readback).toHaveTextContent('pwv_retry_test');
    expect(readback).toHaveTextContent('Retry failed pickup');
    expect(readback).toHaveTextContent('Pickup orchestration');
    expect(readback).not.toHaveTextContent(/Backend readback|backend readback|RPC|Source|create_pickup_wave_v1|failure_retry/);
    const payload = spy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    expect(payload).toHaveProperty('organization_id');
    expect(payload).toHaveProperty('shipment_ids');
    expect(Array.isArray((payload as { shipment_ids: unknown }).shipment_ids)).toBe(true);
    expect(((payload as { shipment_ids: string[] }).shipment_ids).length).toBeGreaterThan(0);
  });

  it('Failures tab "Open original request" opens shipment context in place', async () => {
    window.history.pushState(null, '', '/operate/pickups');
    const user = userEvent.setup();
    const getSpy = mockShipmentReadback();
    await mountAndWait();
    await user.click(screen.getByText('Failures'));
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    const overflowButtons = screen.getAllByRole('button', { name: /Row actions/i });
    if (!overflowButtons[0]) throw new Error('No row-actions overflow button');
    await user.click(overflowButtons[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('.palette__item').length).toBeGreaterThan(0);
    });
    const labels = Array.from(
      document.querySelectorAll('.palette__item .palette__item-label'),
    ) as HTMLElement[];
    const openItem = labels.find((el) => /Open original request/i.test(el.textContent ?? ''));
    if (!openItem) throw new Error('Open original request palette item not found');
    await user.click(openItem);

    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    expect(window.location.pathname).toBe('/operate/pickups');
    expect(window.location.search).toBe('');
    await waitFor(() => {
      expect(getSpy.mock.calls.some(([key]) => key === 'shipments')).toBe(true);
    });
    expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true');
  });

  it('Failures tab Bulk retry fires create_pickup_wave_v1 with all selected request IDs', async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, 'create_pickup_wave_v1')
      .mockResolvedValue({ ok: true, wave_id: 'pwv_bulk_test' });
    await mountAndWait();
    await user.click(screen.getByText('Failures'));
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    // Select all visible rows by clicking each row checkbox.
    const rowCheckboxes = screen
      .getAllByRole('checkbox')
      .filter((cb) => cb.getAttribute('aria-label') === 'Select row');
    expect(rowCheckboxes.length).toBeGreaterThan(0);
    if (!rowCheckboxes[0]) throw new Error('No row checkbox');
    await user.click(rowCheckboxes[0]);
    const bulkBtn = await screen.findByRole('button', { name: /Bulk retry/i });
    await user.click(bulkBtn);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const readback = await screen.findByLabelText('Pickup retry status');
    expect(readback).toHaveTextContent('pwv_bulk_test');
    expect(readback).toHaveTextContent('Bulk retry failed pickups');
    expect(readback).not.toHaveTextContent(/Backend readback|backend readback|RPC|Source|create_pickup_wave_v1|failure_bulk_retry/);
    const payload = spy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(payload).toHaveProperty('organization_id');
    expect(payload).toHaveProperty('shipment_ids');
    expect(((payload as { shipment_ids: string[] }).shipment_ids).length).toBeGreaterThan(0);
  });

  it('Reschedule pickup fires shipment_amend_cancel_v1 with op=reschedule + window payload', async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, 'shipment_amend_cancel_v1')
      .mockResolvedValue({ ok: true, status: 'completed', workflow_run_id: 'wfr_resched' } as never);
    await mountAndWait();
    // Requests tab is the default. Open the first row's overflow palette.
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const overflowButtons = screen.getAllByRole('button', { name: /Row actions/i });
    if (!overflowButtons[0]) throw new Error('No row-actions overflow button');
    await user.click(overflowButtons[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('.palette__item').length).toBeGreaterThan(0);
    });
    const labels = Array.from(
      document.querySelectorAll('.palette__item .palette__item-label'),
    ) as HTMLElement[];
    const item = labels.find((el) => /Reschedule pickup/i.test(el.textContent ?? ''));
    if (!item) throw new Error('Reschedule pickup palette item not found');
    await user.click(item);
    // Modal opens with the reschedule form. Click the primary "Reschedule"
    // button to submit (defaults are pre-populated).
    await waitFor(() => {
      expect(screen.getByText(/Preview or apply a pickup reschedule/i)).toBeInTheDocument();
    });
    // The footer renders Preview + "Apply reschedule" buttons. Click the
    // primary "Apply reschedule" to fire the non-dryRun call.
    const submitBtn = await waitFor(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => {
        const span = b.querySelector('span');
        return /^Apply reschedule$/.test((span?.textContent ?? b.textContent ?? '').trim());
      });
      expect(btn).toBeTruthy();
      return btn as HTMLElement;
    });
    await user.click(submitBtn);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const callArgs = spy.mock.calls[spy.mock.calls.length - 1] as
      | [string, string, Record<string, unknown>, { dryRun?: boolean }?]
      | undefined;
    if (!callArgs) throw new Error('amend spy not called');
    const [shipmentId, op, payload, opts] = callArgs;
    expect(typeof shipmentId).toBe('string');
    expect(shipmentId.length).toBeGreaterThan(0);
    expect(op).toBe('reschedule');
    expect(payload).toBeDefined();
    expect(!!opts?.dryRun).toBe(false);
  });

  it('Failures tab "Retry now" treats `{ ok:false }` as failure and does not show fake success', async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, 'create_pickup_wave_v1')
      .mockResolvedValue({ ok: false, error_code: 'rate_limited' } as never);
    await mountAndWait();
    await user.click(screen.getByText('Failures'));
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const overflowButtons = screen.getAllByRole('button', { name: /Row actions/i });
    if (!overflowButtons[0]) throw new Error('No row-actions overflow button');
    await user.click(overflowButtons[0]);
    await waitFor(() => {
      expect(document.querySelectorAll('.palette__item').length).toBeGreaterThan(0);
    });
    const labels = Array.from(
      document.querySelectorAll('.palette__item .palette__item-label'),
    ) as HTMLElement[];
    const retryItem = labels.find((el) => /Retry now/i.test(el.textContent ?? ''));
    if (!retryItem) throw new Error('Retry now palette item not found');
    await user.click(retryItem);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const payload = spy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(payload).toHaveProperty('shipment_ids');
    await waitFor(() => {
      expect(
        toastStore.getToasts().some(
          (toast) =>
            toast.tone === 'danger'
            && /Pickup wave could not be created\. Try again\./i.test(toast.message),
        ),
      ).toBe(true);
    });
    expect(
      toastStore.getToasts().some(
        (toast) => toast.tone === 'good' && /Pickup retry wave/i.test(toast.message),
      ),
    ).toBe(false);
  });

  it('Failures tab Bulk retry treats Supabase error envelopes as failure and does not show fake success', async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(api, 'create_pickup_wave_v1')
      .mockResolvedValue({ data: null, error: { message: 'permission denied', code: '42501' } } as never);
    await mountAndWait();
    await user.click(screen.getByText('Failures'));
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const rowCheckboxes = screen
      .getAllByRole('checkbox')
      .filter((cb) => cb.getAttribute('aria-label') === 'Select row');
    expect(rowCheckboxes.length).toBeGreaterThan(0);
    if (!rowCheckboxes[0]) throw new Error('No row checkbox');
    await user.click(rowCheckboxes[0]);
    const bulkBtn = await screen.findByRole('button', { name: /Bulk retry/i });
    await user.click(bulkBtn);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await waitFor(() => {
      expect(
        toastStore.getToasts().some(
          (toast) =>
            toast.tone === 'danger'
            && /Pickup wave could not be created\. Try again\./i.test(toast.message),
        ),
      ).toBe(true);
    });
    expect(
      toastStore.getToasts().some(
        (toast) => toast.tone === 'good' && /Pickup retry waves/i.test(toast.message),
      ),
    ).toBe(false);
  });
});
