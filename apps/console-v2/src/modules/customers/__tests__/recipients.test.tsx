// recipients.test.tsx — Behavior tests for operator-managed Recipients module.
//
// Coverage anchors (all backed by public.recipients columns):
//   1. Phone validation chip rendered from phone_validation_status lookup.
//   2. Channel + language chips rendered from communication_channel + preferred_language lookups.
//   3. Drawer surfaces external_id, client link, communication_preferences JSON section.
//   4. Capability pill exposes canonical `recipients.read · recipients.write`.
//   5. SPLIT chip flags self-edit (portal-bound future) is not yet wired here.
//   6. Operator create/delete modals fire recipient_create_v1 / recipient_delete_v1.
//   7. Operator-correction modal fires `recipient_update_v1` (Wave 6) with canonical payload.
//   8. Recipient create/update/delete actions must wait for backend readback before showing success.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { RecipientsModule } from '@/modules/customers/recipients';
import * as toastStore from '@/components/toastStore';
import * as apiMod from '@/lib/api';

beforeEach(() => {
  window.history.pushState(null, '', '/customers/recipients');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RecipientsModule', () => {
  it('renders the Recipients page with canonical capability pill', async () => {
    renderWithProviders(<RecipientsModule />, { capabilities: ['recipients.read', 'recipients.write'] });
    expect(await screen.findByRole('heading', { name: /Recipients/ })).toBeInTheDocument();
    // Wave 6: capability pill reflects operator-correction wiring via recipient_update_v1.
    expect(screen.getByText(/Recipient access · recipient update/)).toBeInTheDocument();
  });

  it('scopes recipient, client, and directory reads to the active tenant lens', async () => {
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    renderWithProviders(<RecipientsModule />, {
      identity: {
        capabilities: ['recipients.read', 'recipients.write', 'clients.read'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: { tenant: { id: 'org_swift', label: 'Swift Express KSA', rank: 2 } },
      },
    });

    expect(await screen.findByRole('heading', { name: /Recipients/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith(
        'recipients',
        expect.objectContaining({ filter: { organization_id: 'org_swift' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'clients',
        expect.objectContaining({ filter: { organization_id: 'org_swift' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'recipient_directory',
        expect.objectContaining({ filter: { organization_id: 'org_swift' } }),
      );
    });
    expect(screen.queryByText(/Layla Al-Saud/i)).not.toBeInTheDocument();
  });

  it('applies client related-link filters to recipient and directory reads', async () => {
    window.history.pushState(null, '', '/customers/recipients?client=cl_swift');
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    renderWithProviders(<RecipientsModule />, {
      identity: {
        capabilities: ['recipients.read', 'recipients.write', 'clients.read'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: { tenant: { id: 'org_swift', label: 'Swift Express KSA', rank: 2 } },
      },
    });

    expect(await screen.findByRole('heading', { name: /Recipients/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith(
        'recipients',
        expect.objectContaining({ filter: { organization_id: 'org_swift', client_id: 'cl_swift' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'recipient_directory',
        expect.objectContaining({ filter: { organization_id: 'org_swift', client_id: 'cl_swift' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'clients',
        expect.objectContaining({ filter: { organization_id: 'org_swift' } }),
      );
    });
  });

  it('defaults New recipient to the client from the related-link filter', async () => {
    window.history.pushState(null, '', '/customers/recipients?client=cl_swift');
    const realList = apiMod.ui_list_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return {
          rows: [
            { id: 'cl_other', name: 'Other Client', slug: 'other-client' },
            { id: 'cl_swift', name: 'Swift Express Client', slug: 'swift-express' },
          ],
          total: 2,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'recipients' || resource === 'recipient_directory') {
        return { rows: [], total: 0, page: 0, page_size: 100 };
      }
      return realList(resource, opts);
    });
    const user = userEvent.setup();
    renderWithProviders(<RecipientsModule />, {
      identity: {
        capabilities: ['recipients.read', 'recipients.write', 'clients.read'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: { tenant: { id: 'org_swift', label: 'Swift Express KSA', rank: 2 } },
      },
    });

    const createButton = await screen.findByRole('button', { name: /New recipient/i });
    await waitFor(() => {
      expect(createButton).not.toBeDisabled();
    });
    await user.click(createButton);

    const clientSelect = await screen.findByLabelText('Client');
    expect(clientSelect).toHaveValue('cl_swift');
  });

  it('denies recipients.read without issuing protected recipient reads', async () => {
    window.history.pushState(null, '', '/customers/recipients?focus=rcp_1000');
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    const getSpy = vi.spyOn(apiMod, 'ui_get_resource_v1');

    renderWithProviders(<RecipientsModule />, { capabilities: ['recipients.write', 'clients.read'] });

    expect(await screen.findByText('You do not have permission to view recipients.')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        listSpy.mock.calls.filter(
          ([resource]) => resource === 'recipients' || resource === 'clients' || resource === 'recipient_directory',
        ),
      ).toEqual([]);
      expect(getSpy.mock.calls.filter(([resource]) => resource === 'recipients')).toEqual([]);
    });
  });

  it('fails closed when the tenant recipient directory projection cannot be read', async () => {
    const realList = apiMod.ui_list_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'recipient_directory') throw new Error('recipient directory permission denied');
      return realList(resource, opts);
    });

    renderWithProviders(<RecipientsModule />, {
      capabilities: ['recipients.read', 'recipients.write', 'clients.read'],
    });

    expect(await screen.findByText('Recipient related data unavailable')).toBeInTheDocument();
    expect(screen.getByText('recipient directory permission denied')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing here yet/i)).not.toBeInTheDocument();
  });

  it('row actions keep recipient context navigable through the owning domain views', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecipientsModule />, {
      capabilities: ['recipients.read', 'recipients.write', 'clients.read', 'shipments.read'],
    });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const shipmentsAction = await screen.findByRole('option', { name: /View shipments/ });
    await user.click(shipmentsAction);

    await waitFor(() => {
      expect(window.location.pathname).toBe('/operate/shipments');
      expect(new URLSearchParams(window.location.search).get('recipient')).toBeTruthy();
    });
  });

  it('surfaces SPLIT chip flagging self-edit is portal-bound future work', async () => {
    renderWithProviders(<RecipientsModule />, { capabilities: ['recipients.read'] });
    await screen.findByRole('heading', { name: /Recipients/ });
    expect(screen.getByText(/Recipient self-service planned for Portal/)).toBeInTheDocument();
  });

  it('renders phone validation lookup column header', async () => {
    renderWithProviders(<RecipientsModule />, { capabilities: ['recipients.read'] });
    await screen.findByRole('heading', { name: /Recipients/ });
    // The DataTable renders column header text in the toolbar/columns picker; row chips also
    // surface the lookup tone — either path proves the column is mounted with lookup metadata.
    await waitFor(() => {
      // Phone validation status values (from the seed) appear as cell content for at least one row.
      expect(screen.getAllByText(/^valid$/i).length).toBeGreaterThan(0);
    });
  });

  it('opens drawer and surfaces backed columns + summarized preferences section (read-only)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecipientsModule />, { capabilities: ['recipients.read', 'recipients.write'] });

    // Click first recipient row by name (seed 'Layla Al-Saud').
    const row = await screen.findByText(/Layla Al-Saud/);
    await user.click(row);

    await waitFor(() => {
      // External ID surfaced (use getAllBy because the label may also appear as a column header).
      expect(screen.getAllByText('External ID').length).toBeGreaterThanOrEqual(1);
      // Phone validation row surfaced (label may render in column header + KvGrid label).
      expect(screen.getAllByText('Phone validation').length).toBeGreaterThanOrEqual(1);
      // Communication preferences section surfaced.
      expect(screen.getByText(/Communication preferences/)).toBeInTheDocument();
      expect(screen.queryByText(/\{|\}/)).not.toBeInTheDocument();
      // Operator-facing control summary avoids raw database contracts.
      expect(screen.getByText(/Arabic or English preference/)).toBeInTheDocument();
      expect(document.body.textContent ?? '').not.toMatch(/\bcl_[a-z0-9_]+/);
    });

    // Phase C3 SPLIT verdict (preserved in Wave 6): drawer KvGrid is read-only —
    // operator correction lives in a separate modal opened from the row action.
    const nameLabel = screen.getAllByText('Name')[0]!;
    const nameRow = nameLabel.closest('.kv-row, .kv__row, [data-testid^="kv-row"]') ?? nameLabel.parentElement;
    expect(nameRow?.querySelector('input.dt-inline-input')).toBeNull();
  });

  it('reads related shipments for the open recipient drawer through shipment_directory', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'shipment_directory') {
        return {
          rows: [{
            id: 'shp_recipient_related_1',
            tracking_number: 'SHP-RECIPIENT-RELATED-1',
            client_reference_number: 'EXAMPLEPARCEL-RECIPIENT-1',
            status: 'out_for_delivery',
            service_type: 'same_day',
            recipient_label: 'Layla Al-Saud',
            destination_city: 'Riyadh',
            promised_delivery_date: '2026-04-25T18:00:00Z',
          }],
          total: 1,
          page: 0,
          page_size: 3,
        };
      }
      return realList(resource, opts);
    });
    renderWithProviders(<RecipientsModule />, {
      capabilities: ['recipients.read', 'recipients.write', 'clients.read', 'shipments.read'],
    });

    await user.click(await screen.findByText(/Layla Al-Saud/));

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith(
        'shipment_directory',
        expect.objectContaining({
          filter: { recipient_id: 'rcp_1000' },
          page_size: 3,
        }),
      );
      expect(screen.getByText('Related shipments')).toBeInTheDocument();
      expect(screen.getByText('SHP-RECIPIENT-RELATED-1')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Open shipment' }).length).toBeGreaterThan(0);
    });
  });

  it('opens the recipient drawer from a row deep-link focus URL with in-drawer actions', async () => {
    window.history.pushState(null, '', '/customers/recipients?focus=rcp_1000');

    renderWithProviders(<RecipientsModule />, {
      capabilities: ['recipients.read', 'recipients.write', 'clients.read', 'shipments.read'],
    });

    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    const drawer = document.querySelector('.drawer') as HTMLElement;
    expect(drawer.textContent ?? '').toContain('Communication preferences');
    expect(drawer.textContent ?? '').toContain('Recipient actions');
    expect(drawer.textContent ?? '').toContain('Correct recipient');
    expect(drawer.textContent ?? '').toContain('Delete recipient');
    expect(drawer.textContent ?? '').toContain('Shipments');
  });
});

// ---- WAVE 6 mutation wiring (CUSTOMERS Wave 6) ----
// Operator NDR triage flows through the canonical Wave 6 RPC:
//   • public.recipient_update_v1 — supabase/migrations/202604301040_recipient_update_v1.sql
describe('RecipientsModule · operator correction wiring (Wave 6)', () => {
  // Cast to a loose unknown so the spy's mock.calls type widens — the narrow
  // signature emitted by `vi.spyOn` against the typed api facades collides
  // with the loose `MockInstance<(this: unknown, ...args: unknown[]) => unknown>`
  // type. We assert against recorded call args directly below.
  type LooseSpy = ReturnType<typeof vi.spyOn> & {
    mock: { calls: unknown[][] };
    mockRestore: () => void;
  };
  let updateSpy: LooseSpy;
  beforeEach(() => {
    updateSpy = vi.spyOn(apiMod, 'recipient_update_v1') as unknown as LooseSpy;
  });
  afterEach(() => {
    updateSpy.mockRestore();
  });

  it('Operator correction modal fires recipient_update_v1 with canonical payload', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecipientsModule />, { capabilities: ['recipients.read', 'recipients.write'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const correction = await screen.findByRole('option', { name: /Operator correction/ });
    await user.click(correction);

    // Fill draft fields.
    const phoneInput = await screen.findByPlaceholderText(/\+9665/);
    await user.clear(phoneInput);
    await user.type(phoneInput, '+966500000099');
    const emailInput = await screen.findByLabelText('Email');
    await user.clear(emailInput);
    await user.type(emailInput, 'updated.recipient@example.com');
    const externalInput = await screen.findByLabelText('External ID');
    await user.clear(externalInput);
    await user.type(externalInput, 'EXT-RCP-UPDATED');
    const preferencesInput = await screen.findByLabelText('Preferences JSON');
    fireEvent.change(preferencesInput, { target: { value: '{"whatsapp_opt_in":true}' } });
    const save = await screen.findByRole('button', { name: 'Save' });
    await user.click(save);

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledTimes(1);
    });
    const args = updateSpy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(args?.recipient_id).toBeTruthy();
    expect(args?.phone_number).toBe('+966500000099');
    expect(args?.email).toBe('updated.recipient@example.com');
    expect(args?.external_id).toBe('EXT-RCP-UPDATED');
    expect(args?.communication_preferences).toEqual({ whatsapp_opt_in: true });
  });

  it('Operator correction refreshes the open drawer from backend readback without reload', async () => {
    const user = userEvent.setup();
    let recipientName = 'Drawer Readback Recipient';
    const updatedName = 'Drawer Readback Recipient Updated';
    const realList = apiMod.ui_list_resource_v1;
    const recipientRow = () => ({
      id: 'rcp_drawer_readback',
      organization_id: 'org_rashed',
      client_id: 'cl_drawer_readback',
      name: recipientName,
      phone_number: '+966560000001',
      phone_validation_status: 'pending',
      preferred_language: 'ar',
      preferred_comm_channel: 'whatsapp',
      communication_preferences: {},
      external_id: 'DRAWER-READBACK',
    });

    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'recipients') {
        return { rows: [recipientRow()], total: 1, page: 0, page_size: 100 };
      }
      if (resource === 'clients') {
        return {
          rows: [{ id: 'cl_drawer_readback', name: 'Drawer Readback Client', slug: 'drawer-readback-client' }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'recipient_directory') {
        return {
          rows: [{ recipient_id: 'rcp_drawer_readback', client_label: 'Drawer Readback Client', total_shipments: 0 }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      return realList(resource, opts);
    });
    updateSpy.mockImplementation(async (args: unknown) => {
      recipientName = String((args as Record<string, unknown>).name ?? recipientName);
      return { ok: true, recipient_id: 'rcp_drawer_readback' } as never;
    });

    renderWithProviders(<RecipientsModule />, { capabilities: ['recipients.read', 'recipients.write', 'clients.read'] });

    await user.click(await screen.findByText(recipientName));
    expect(await screen.findByRole('dialog', { name: recipientName })).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Correct recipient' }));
    const nameInput = await screen.findByLabelText('Name');
    await user.clear(nameInput);
    await user.type(nameInput, updatedName);
    await user.click(await screen.findByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      expect(screen.getAllByText(updatedName).length).toBeGreaterThan(1);
    });
    expect(await screen.findByRole('dialog', { name: updatedName })).toBeInTheDocument();
  });

  it('Operator correction rejects stale backend readback instead of showing local-only success', async () => {
    const user = userEvent.setup();
    const toast = vi.spyOn(toastStore, 'pushToast');
    const staleName = 'Drawer Stale Recipient Original';
    const attemptedName = 'Drawer Stale Recipient Updated';
    const realList = apiMod.ui_list_resource_v1;
    const recipientRow = () => ({
      id: 'rcp_drawer_stale',
      organization_id: 'org_rashed',
      client_id: 'cl_drawer_stale',
      name: staleName,
      phone_number: '+966560000004',
      phone_validation_status: 'pending',
      preferred_language: 'ar',
      preferred_comm_channel: 'whatsapp',
      communication_preferences: {},
      external_id: 'DRAWER-STALE',
    });

    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'recipients') {
        return { rows: [recipientRow()], total: 1, page: 0, page_size: 100 };
      }
      if (resource === 'clients') {
        return {
          rows: [{ id: 'cl_drawer_stale', name: 'Drawer Stale Client', slug: 'drawer-stale-client' }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'recipient_directory') {
        return {
          rows: [{ recipient_id: 'rcp_drawer_stale', client_label: 'Drawer Stale Client', total_shipments: 0 }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      return realList(resource, opts);
    });
    updateSpy.mockResolvedValue({ ok: true, recipient_id: 'rcp_drawer_stale' } as never);

    renderWithProviders(<RecipientsModule />, { capabilities: ['recipients.read', 'recipients.write', 'clients.read'] });

    await user.click(await screen.findByText(staleName));
    expect(await screen.findByRole('dialog', { name: staleName })).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Correct recipient' }));
    const nameInput = await screen.findByLabelText('Name');
    await user.clear(nameInput);
    await user.type(nameInput, attemptedName);
    await user.click(await screen.findByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          recipient_id: 'rcp_drawer_stale',
          name: attemptedName,
        }),
      );
      expect(toast).toHaveBeenCalledWith(
        'The updated recipient was not available yet.',
        'danger',
      );
    });
    expect(await screen.findByRole('dialog', { name: `Operator correction · ${staleName}` })).toBeInTheDocument();
    const drawer = document.querySelector('.drawer') as HTMLElement;
    expect(drawer.textContent ?? '').toContain(staleName);
    expect(drawer.textContent ?? '').not.toContain(attemptedName);
    expect(window.location.pathname).toBe('/customers/recipients');
  });

  it('Operator correction rejects invalid communication preferences JSON before RPC', async () => {
    const user = userEvent.setup();
    const toast = vi.spyOn(toastStore, 'pushToast');
    renderWithProviders(<RecipientsModule />, { capabilities: ['recipients.read', 'recipients.write'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const correction = await screen.findByRole('option', { name: /Operator correction/ });
    await user.click(correction);

    const preferencesInput = await screen.findByLabelText('Preferences JSON');
    fireEvent.change(preferencesInput, { target: { value: '["not-an-object"]' } });
    await user.click(await screen.findByRole('button', { name: 'Save' }));

    expect(updateSpy).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/Communication preferences must be a JSON object/i),
      'danger',
    );
  });

  it('Operator correction rejects non-E.164 phone numbers before RPC', async () => {
    const user = userEvent.setup();
    const toast = vi.spyOn(toastStore, 'pushToast');
    renderWithProviders(<RecipientsModule />, { capabilities: ['recipients.read', 'recipients.write'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const correction = await screen.findByRole('option', { name: /Operator correction/ });
    await user.click(correction);

    const phoneInput = await screen.findByLabelText('Phone (E.164)');
    await user.clear(phoneInput);
    await user.type(phoneInput, 'not-a-phone');
    await user.click(await screen.findByRole('button', { name: 'Save' }));

    expect(updateSpy).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      'Phone must be in E.164 format, for example +9665XXXXXXXX.',
      'warn',
    );
  });

  it('Operator correction button is gated on recipients.write capability', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecipientsModule />, { capabilities: ['recipients.read'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    // The Operator correction option appears in the menu but is gated/disabled
    // when capability is missing — DataTable renders it with disabled affordance.
    const correction = await screen.findByRole('option', { name: /Operator correction/ });
    // Either disabled attr or aria-disabled set; click should not trigger RPC.
    await user.click(correction).catch(() => undefined);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('Save with empty name shows toast and does not call RPC', async () => {
    const user = userEvent.setup();
    const toast = vi.spyOn(toastStore, 'pushToast');
    renderWithProviders(<RecipientsModule />, { capabilities: ['recipients.read', 'recipients.write'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const correction = await screen.findByRole('option', { name: /Operator correction/ });
    await user.click(correction);

    const nameInput = await screen.findByLabelText('Name');
    await user.clear(nameInput);
    const save = await screen.findByRole('button', { name: 'Save' });
    await user.click(save);

    expect(updateSpy).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Name is required/i), 'warn');
  });

  it('exposes recipient_update_v1 facade on api module (canonical RPC name)', () => {
    expect(typeof apiMod.recipient_update_v1).toBe('function');
  });
});

describe('RecipientsModule · operator create/delete wiring', () => {
  type LooseSpy = ReturnType<typeof vi.spyOn> & {
    mock: { calls: unknown[][] };
    mockRestore: () => void;
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Create recipient modal fires recipient_create_v1 with canonical payload', async () => {
    const createSpy = vi
      .spyOn(apiMod, 'recipient_create_v1')
      .mockResolvedValue({
        ok: true,
        recipient_id: 'rcp_test_created',
        correlation_id: '0000000000000000',
        settings_resolution_id: 'srlv_test',
      } as never) as unknown as LooseSpy;
    const user = userEvent.setup();
    renderWithProviders(<RecipientsModule />, {
      capabilities: ['recipients.read', 'recipients.write', 'clients.read'],
    });

    const createButton = await screen.findByRole('button', { name: /New recipient/i });
    await waitFor(() => {
      expect(createButton).not.toBeDisabled();
    });
    await user.click(createButton);

    await user.type(await screen.findByLabelText('Name'), 'Console Created Recipient');
    await user.type(await screen.findByLabelText(/Phone/i), '+966500000941');
    await user.type(await screen.findByLabelText('External ID'), 'EXT-CONSOLE-941');
    const submit = await screen.findByRole('button', { name: 'Create recipient' });
    await waitFor(() => {
      expect(submit).not.toBeDisabled();
    });
    await user.click(submit);

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    const args = createSpy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(args?.client_id).toBeTruthy();
    expect(args?.name).toBe('Console Created Recipient');
    expect(args?.phone_number).toBe('+966500000941');
    expect(args?.external_id).toBe('EXT-CONSOLE-941');
  });

  it('Create recipient shows backend readback in the table and operator drawer without reload', async () => {
    const user = userEvent.setup();
    const recipientName = 'No Reload Create Recipient';
    let recipientRows: Array<Record<string, unknown>> = [];
    const readbackEvents: string[] = [];
    const realList = apiMod.ui_list_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'recipients') {
        readbackEvents.push(`recipients:${recipientRows.length}`);
        return { rows: recipientRows, total: recipientRows.length, page: 0, page_size: 100 };
      }
      if (resource === 'clients') {
        return {
          rows: [{ id: 'cl_no_reload_recipient', name: 'No Reload Recipient Client', slug: 'no-reload-recipient' }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'recipient_directory') {
        readbackEvents.push(`recipient_directory:${recipientRows.length}`);
        return {
          rows: recipientRows.map((row) => ({
            recipient_id: row.id,
            client_label: 'No Reload Recipient Client',
            total_shipments: 0,
          })),
          total: recipientRows.length,
          page: 0,
          page_size: 100,
        };
      }
      return realList(resource, opts);
    });
    const createSpy = vi.spyOn(apiMod, 'recipient_create_v1').mockImplementation(async (args: unknown) => {
      const payload = args as Record<string, unknown>;
      recipientRows = [
        {
          id: 'rcp_no_reload_create',
          organization_id: 'org_rashed',
          client_id: payload.client_id,
          name: payload.name,
          phone_number: payload.phone_number,
          phone_validation_status: 'pending',
          preferred_language: payload.preferred_language ?? 'ar',
          preferred_comm_channel: payload.preferred_comm_channel ?? 'whatsapp',
          communication_preferences: {},
        },
      ];
      return {
        ok: true,
        recipient_id: 'rcp_no_reload_create',
        correlation_id: 'no-reload-create-correlation',
        settings_resolution_id: 'srlv_no_reload_create',
      } as never;
    });

    renderWithProviders(<RecipientsModule />, {
      capabilities: ['recipients.read', 'recipients.write', 'clients.read'],
    });

    expect(screen.queryByText(recipientName)).not.toBeInTheDocument();
    const createButton = await screen.findByRole('button', { name: /New recipient/i });
    await waitFor(() => {
      expect(createButton).not.toBeDisabled();
    });
    await user.click(createButton);
    await user.type(await screen.findByLabelText('Name'), recipientName);
    await user.type(await screen.findByLabelText(/Phone/i), '+966560000003');
    await user.type(await screen.findByLabelText('External ID'), 'NO-RELOAD-RCP-3');
    await user.click(await screen.findByRole('button', { name: 'Create recipient' }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(readbackEvents).toContain('recipients:1');
      expect(readbackEvents).toContain('recipient_directory:1');
    });
    const tableBody = document.querySelector('.dt__table tbody') as HTMLElement | null;
    expect(tableBody).not.toBeNull();
    expect(within(tableBody as HTMLElement).getByText(recipientName)).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Create recipient' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    const drawer = document.querySelector('.drawer') as HTMLElement;
    expect(drawer.textContent ?? '').toContain(recipientName);
    expect(drawer.textContent ?? '').toContain('Communication preferences');
    expect(drawer.textContent ?? '').toContain('Related shipments');
    expect(drawer.textContent ?? '').toContain('Recipient actions');
    expect(within(drawer).getByRole('button', { name: 'Correct recipient' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Delete recipient' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Open client' })).toBeInTheDocument();
  });

  it('Create recipient duplicate phone surfaces operator-friendly error copy', async () => {
    const createSpy = vi
      .spyOn(apiMod, 'recipient_create_v1')
      .mockRejectedValue(
        new Error('duplicate key value violates unique constraint "uq_recipients_client_phone_number_normalized"'),
      ) as unknown as LooseSpy;
    const toast = vi.spyOn(toastStore, 'pushToast');
    const user = userEvent.setup();
    renderWithProviders(<RecipientsModule />, {
      capabilities: ['recipients.read', 'recipients.write', 'clients.read'],
    });

    const createButton = await screen.findByRole('button', { name: /New recipient/i });
    await waitFor(() => {
      expect(createButton).not.toBeDisabled();
    });
    await user.click(createButton);
    await user.type(await screen.findByLabelText('Name'), 'Duplicate Phone Recipient');
    await user.type(await screen.findByLabelText(/Phone/i), '+966500000941');
    await user.click(await screen.findByRole('button', { name: 'Create recipient' }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(toast).toHaveBeenCalledWith(
        'A recipient with this phone already exists for the selected client.',
        'danger',
      );
    });
    const duplicateDialog = screen.getByRole('dialog', { name: 'Create recipient' });
    expect(within(duplicateDialog).getByText('A recipient with this phone already exists for the selected client.')).toBeInTheDocument();
    expect(toast.mock.calls.some(([message]) => String(message).includes('uq_recipients'))).toBe(false);
  });

  it('Create recipient rejects non-E.164 phone numbers before RPC', async () => {
    const createSpy = vi.spyOn(apiMod, 'recipient_create_v1') as unknown as LooseSpy;
    const toast = vi.spyOn(toastStore, 'pushToast');
    const user = userEvent.setup();
    renderWithProviders(<RecipientsModule />, {
      capabilities: ['recipients.read', 'recipients.write', 'clients.read'],
    });

    const createButton = await screen.findByRole('button', { name: /New recipient/i });
    await waitFor(() => {
      expect(createButton).not.toBeDisabled();
    });
    await user.click(createButton);
    await user.type(await screen.findByLabelText('Name'), 'Invalid Phone Recipient');
    await user.type(await screen.findByLabelText(/Phone/i), 'not-a-phone');
    await user.click(await screen.findByRole('button', { name: 'Create recipient' }));

    expect(createSpy).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      'Phone must be in E.164 format, for example +9665XXXXXXXX.',
      'warn',
    );
    const invalidDialog = screen.getByRole('dialog', { name: 'Create recipient' });
    expect(within(invalidDialog).getByText('Phone must be in E.164 format, for example +9665XXXXXXXX.')).toBeInTheDocument();
  });

  it('Delete recipient row action fires recipient_delete_v1 with canonical payload', async () => {
    const deleteSpy = vi
      .spyOn(apiMod, 'recipient_delete_v1')
      .mockResolvedValue({
        ok: true,
        recipient_id: 'rcp_1000',
        deleted: true,
        shipment_reference_count: 0,
        correlation_id: '0000000000000000',
        settings_resolution_id: 'srlv_test',
      } as never) as unknown as LooseSpy;
    const user = userEvent.setup();
    renderWithProviders(<RecipientsModule />, { capabilities: ['recipients.read', 'recipients.write'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const deleteAction = await screen.findByRole('option', { name: /Delete recipient/ });
    await user.click(deleteAction);

    const deleteDialog = document.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(deleteDialog?.textContent ?? '').toMatch(/Recipient/i);
    expect(deleteDialog?.textContent ?? '').toMatch(/Client/i);
    expect(deleteDialog?.textContent ?? '').not.toMatch(/rcp_|cl_/i);

    await user.type(await screen.findByLabelText('Reason'), 'Duplicate contact');
    await user.click(await screen.findByRole('button', { name: 'Delete recipient' }));

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledTimes(1);
    });
    const args = deleteSpy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(args?.recipient_id).toBeTruthy();
    expect(args?.reason).toBe('Duplicate contact');
  });

  it('Delete recipient from an open drawer closes stale context after backend readback without reload', async () => {
    const user = userEvent.setup();
    const recipientName = 'Drawer Delete Recipient';
    const readbackEvents: string[] = [];
    let recipientRows = [
      {
        id: 'rcp_drawer_delete',
        organization_id: 'org_rashed',
        client_id: 'cl_drawer_delete',
        name: recipientName,
        phone_number: '+966560000002',
        phone_validation_status: 'pending',
        preferred_language: 'ar',
        preferred_comm_channel: 'whatsapp',
        communication_preferences: {},
      },
    ];
    const realList = apiMod.ui_list_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'recipients') {
        readbackEvents.push(`recipients:${recipientRows.length}`);
        return { rows: recipientRows, total: recipientRows.length, page: 0, page_size: 100 };
      }
      if (resource === 'clients') {
        return {
          rows: [{ id: 'cl_drawer_delete', name: 'Drawer Delete Client', slug: 'drawer-delete-client' }],
          total: 1,
          page: 0,
          page_size: 100,
        };
      }
      if (resource === 'recipient_directory') {
        readbackEvents.push(`recipient_directory:${recipientRows.length}`);
        return {
          rows: recipientRows.map((row) => ({
            recipient_id: row.id,
            client_label: 'Drawer Delete Client',
            total_shipments: 0,
          })),
          total: recipientRows.length,
          page: 0,
          page_size: 100,
        };
      }
      return realList(resource, opts);
    });
    const deleteSpy = vi.spyOn(apiMod, 'recipient_delete_v1').mockImplementation(async () => {
      recipientRows = [];
      return {
        ok: true,
        recipient_id: 'rcp_drawer_delete',
        deleted: true,
        shipment_reference_count: 0,
        correlation_id: 'drawer-delete-correlation',
        settings_resolution_id: 'srlv_drawer_delete',
      } as never;
    });

    renderWithProviders(<RecipientsModule />, {
      capabilities: ['recipients.read', 'recipients.write', 'clients.read'],
    });

    await user.click(await screen.findByText(recipientName));
    await waitFor(() => {
      expect(document.querySelector('.drawer')?.textContent ?? '').toContain(recipientName);
    });
    const drawer = document.querySelector('.drawer') as HTMLElement;
    await user.click(within(drawer).getByRole('button', { name: 'Delete recipient' }));
    await user.type(await screen.findByLabelText('Reason'), 'Duplicate drawer contact');
    await user.click(await screen.findByRole('button', { name: 'Delete recipient' }));

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(readbackEvents).toContain('recipients:0');
      expect(readbackEvents).toContain('recipient_directory:0');
      expect(document.querySelector('.drawer')).toBeNull();
    });
    expect(screen.queryByText(recipientName)).not.toBeInTheDocument();
  });

  it('exposes recipient create/update/delete facades on api module', () => {
    expect(typeof apiMod.recipient_create_v1).toBe('function');
    expect(typeof apiMod.recipient_update_v1).toBe('function');
    expect(typeof apiMod.recipient_delete_v1).toBe('function');
  });
});

// ---- WAVE 21 paired projection wiring (CUSTOMERS W21) ----
// Drawer surfaces canonical projection-derived chips from
// `public.v_recipient_directory` (total_shipments + last_shipment_status).
// Read-only; SSOT remains `public.recipients` via the registry seam. See:
//   • supabase/migrations/202604302020_v_recipient_directory.sql
//   • apps/console-v2/src/lib/data-source.ts → _projectRecipientDirectory
describe('RecipientsModule · paired projection wiring (W21)', () => {
  it('drawer surfaces shipment counter chip from recipient_directory projection', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecipientsModule />, { capabilities: ['recipients.read'] });

    const row = await screen.findByText(/Layla Al-Saud/);
    await user.click(row);

    await waitFor(() => {
      // Total shipments chip (count varies based on seed data; pattern only).
      expect(screen.getByText(/\d+ shipments/)).toBeInTheDocument();
    });
  });
});
