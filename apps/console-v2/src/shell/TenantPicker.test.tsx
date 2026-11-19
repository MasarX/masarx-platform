// TenantPicker.test.tsx — verifies the picker is platform-only, lists
// organizations from the canonical reads contract, switches the active scope,
// and surfaces a "Platform" badge so platform users can tell they have
// cross-tenant reach.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { TenantPicker } from './TenantPicker';
import * as api from '../lib/api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shell/TenantPicker — visibility (platform-only)', () => {
  it('renders nothing for a tenant user (non-platform)', () => {
    const { container } = renderWithProviders(<TenantPicker />, {
      identity: {
        user: { access_scope_type: 'tenant', access_scope_id: null },
        capabilities: ['shipments.read'],
      },
    });
    expect(container.querySelector('[data-testid="tenant-picker"]')).toBeNull();
  });

  it('renders nothing for a portal (client) user', () => {
    const { container } = renderWithProviders(<TenantPicker />, {
      identity: {
        user: { access_scope_type: 'client', access_scope_id: 'cl_test' },
        capabilities: ['shipments.read'],
      },
    });
    expect(container.querySelector('[data-testid="tenant-picker"]')).toBeNull();
  });

  it('renders nothing for a portal (sender) user', () => {
    const { container } = renderWithProviders(<TenantPicker />, {
      identity: {
        user: { access_scope_type: 'sender', access_scope_id: 'snd_test' },
        capabilities: ['shipments.read'],
      },
    });
    expect(container.querySelector('[data-testid="tenant-picker"]')).toBeNull();
  });

  it('renders for a platform user with the "Platform" badge', () => {
    renderWithProviders(<TenantPicker />, {
      identity: {
        user: { access_scope_type: 'platform', access_scope_id: null },
        capabilities: ['all'],
      },
    });
    expect(screen.getByTestId('tenant-picker')).toBeInTheDocument();
    expect(screen.getByText('Platform')).toBeInTheDocument();
  });
});

describe('shell/TenantPicker — interaction', () => {
  it('lists organizations from the canonical reads contract when the picker opens', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TenantPicker />, {
      identity: {
        user: { access_scope_type: 'platform', access_scope_id: null },
        capabilities: ['all'],
        // Pin scope to a label that does NOT collide with org names so the
        // assertion below targets only the listbox option, not the trigger.
        scope: { tenant: { id: 'org_unknown', label: '—', rank: 2 } },
      },
    });
    const trigger = screen.getByRole('button', { name: /active tenant/i });
    await user.click(trigger);
    // The seed (`apps/console-v2/src/lib/seed-raw/domain-shipments.js`) ships
    // 2 organizations: Rashed Logistics + Swift Express KSA. Both should
    // surface in the listbox once useResourceList resolves (~40ms in adapter).
    await waitFor(() => {
      expect(
        screen.getByRole('option', { name: /rashed logistics/i }),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole('option', { name: /swift express ksa/i }),
    ).toBeInTheDocument();
  });

  it('loads the complete organization list and filters by name or id', async () => {
    const user = userEvent.setup();
    const orgs = Array.from({ length: 65 }, (_, index) => ({
      id: `org_bulk_${String(index).padStart(2, '0')}`,
      name: `Bulk Tenant ${String(index).padStart(2, '0')}`,
      billing_status: 'active',
    }));
    orgs.push({
      id: '6b02b133-d9fa-4cf0-905f-45a721aab9a1',
      name: 'onboarding rehearsal 1780087431982',
      billing_status: 'active',
    });
    const completeListSpy = vi.spyOn(api, 'ui_list_resource_complete').mockResolvedValue({
      rows: orgs,
      total: orgs.length,
    });

    renderWithProviders(<TenantPicker />, {
      identity: {
        user: { access_scope_type: 'platform', access_scope_id: null },
        capabilities: ['all'],
        scope: { tenant: { id: 'org_bulk_00', label: 'Bulk Tenant 00', rank: 2 } },
      },
    });

    await user.click(screen.getByRole('button', { name: /active tenant/i }));
    await waitFor(() => {
      expect(screen.getByLabelText(/search tenants/i)).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText(/search tenants/i), '6b02b133');

    await waitFor(() => {
      expect(
        screen.getByRole('option', { name: /onboarding rehearsal 1780087431982/i }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByRole('option', { name: /bulk tenant 00/i })).not.toBeInTheDocument();
    expect(completeListSpy).toHaveBeenCalledWith(
      'organizations',
      expect.objectContaining({ sort: { key: 'name', dir: 'asc' } }),
    );
    expect(completeListSpy.mock.calls[0]?.[1]).not.toHaveProperty('page_size');
  });

  it('selecting an organization closes the picker (switchScope dispatched)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TenantPicker />, {
      identity: {
        user: { access_scope_type: 'platform', access_scope_id: null },
        capabilities: ['all'],
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });
    await user.click(screen.getByRole('button', { name: /active tenant/i }));
    await waitFor(() => {
      expect(screen.getByText('Swift Express KSA')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('option', { name: /swift express ksa/i }));
    // Picker closes after selection.
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull();
    });
  });

  it('marks the active organization as aria-selected', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TenantPicker />, {
      identity: {
        user: { access_scope_type: 'platform', access_scope_id: null },
        capabilities: ['all'],
        scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
      },
    });
    await user.click(screen.getByRole('button', { name: /active tenant/i }));
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /rashed logistics/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('option', { name: /rashed logistics/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('option', { name: /swift express ksa/i })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('Escape closes the popover', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TenantPicker />, {
      identity: {
        user: { access_scope_type: 'platform', access_scope_id: null },
        capabilities: ['all'],
      },
    });
    await user.click(screen.getByRole('button', { name: /active tenant/i }));
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });
    await act(async () => {
      await user.keyboard('{Escape}');
    });
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull();
    });
  });

  it('shows the active tenant label on the trigger button', () => {
    renderWithProviders(<TenantPicker />, {
      identity: {
        user: { access_scope_type: 'platform', access_scope_id: null },
        capabilities: ['all'],
        scope: {
          tenant: { id: 'org_swift', label: 'Swift Express KSA', rank: 2 },
        },
      },
    });
    const trigger = screen.getByRole('button', { name: /active tenant/i });
    expect(trigger).toHaveTextContent('Swift Express KSA');
  });
});
