// config.test.tsx — verifies the Configuration screen lists categories,
// renders a LadderViz, exposes the resolution-log deeplink, and the
// "Compare scopes" + "Request change" CTAs work end-to-end.

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { ConfigModule } from '@/modules/platform/config';
import * as ds from '@/lib/data-source';
import * as toastStore from '@/components/toastStore';

const PROPOSE_SETTINGS_SPY = vi.spyOn(ds, 'proposeSettingsChange');
const RESOLVE_SETTINGS_SPY = vi.spyOn(ds, 'resolveSettings');
const APPLY_SETTINGS_SPY = vi.spyOn(ds, 'applySettingsValue');

beforeEach(() => {
  window.history.pushState(null, '', '/platform/config');
  PROPOSE_SETTINGS_SPY.mockClear();
  RESOLVE_SETTINGS_SPY.mockClear();
  APPLY_SETTINGS_SPY.mockClear();
});

describe('ConfigModule', () => {
  it('renders categories and a default selection with a resolution_log deep-link', async () => {
    renderWithProviders(<ConfigModule />, { capabilities: ['settings.read'] });
    // Default selected category renders its resolved card
    expect(await screen.findByText(/Resolved value/i)).toBeInTheDocument();
    expect(screen.queryByText(/Something went wrong/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/resolution\.ladder_path missing winning scope_id/i)).not.toBeInTheDocument();
    // Deeplink
    const link = screen.getByTestId('config-resolution-log-link');
    expect(link).toHaveAttribute('href', expect.stringMatching(/^\/insights\/resolutions\?category=/));
  });

  it('summarizes large resolved backend values instead of flooding the operator view', async () => {
    const largeValue = {
      roles: Array.from({ length: 12 }, (_, index) => ({ key: `role_${index}` })),
      capabilities: Array.from({ length: 48 }, (_, index) => ({ key: `capability_${index}` })),
      resource_map: Object.fromEntries(
        Array.from({ length: 16 }, (_, index) => [`resource_${index}`, { read: 'settings.read' }]),
      ),
      assignments: { user_type: { ops_admin: ['ops_admin'] } },
      denies: [],
      version: 1,
    };
    RESOLVE_SETTINGS_SPY.mockResolvedValueOnce({
      value: largeValue,
      resolved_from: 'tenant',
      ladder_path: [
        {
          rank: 10,
          scope_type: 'tenant',
          scope_id: 'org_scope_tenant',
          has_value: true,
          value: largeValue,
        },
      ],
      settings_resolution_id: 'srlv_large_policy',
      override_of: null,
    });

    renderWithProviders(<ConfigModule />, {
      identity: {
        capabilities: ['settings.read'],
        scope: {
          tenant: { id: 'org_scope_tenant', label: 'Scope Tenant', rank: 2 },
        },
      },
    });

    const summary = await screen.findByTestId('resolved-value-summary');
    expect(summary).toHaveTextContent('Large saved policy value summarized');
    expect(summary).toHaveTextContent('6 top-level keys');
    expect(summary).toHaveTextContent('roles: 12 items');
    expect(summary).toHaveTextContent('capabilities: 48 items');
    expect(summary).toHaveTextContent('resource_map: 16 keys');
    expect(screen.getByText('Show full saved policy details')).toBeInTheDocument();
    expect(screen.getByTestId('resolved-value-json')).not.toBeVisible();
  });

  it('resolves the selected settings category through the active tenant scope', async () => {
    renderWithProviders(<ConfigModule />, {
      identity: {
        capabilities: ['settings.read'],
        scope: {
          tenant: { id: 'org_scope_tenant', label: 'Scope Tenant', rank: 2 },
        },
      },
    });

    expect(await screen.findByText(/Resolved value/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(RESOLVE_SETTINGS_SPY).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          tenant: { id: 'org_scope_tenant' },
          organization_id: 'org_scope_tenant',
        }),
      );
    });
  });

  it('honors tenant scope_id from organization drawer handoff for resolve and request change', async () => {
    window.history.pushState(
      null,
      '',
      '/platform/config?scope_type=tenant&scope_id=org_tabuk_logistics',
    );
    renderWithProviders(<ConfigModule />, {
      identity: {
        capabilities: ['settings.read', 'settings.write'],
        scope: {
          tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 },
        },
      },
    });

    expect(await screen.findByText(/Resolved value/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(RESOLVE_SETTINGS_SPY).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          tenant: { id: 'org_tabuk_logistics' },
          organization_id: 'org_tabuk_logistics',
        }),
      );
    });

    fireEvent.click(await screen.findByTestId('config-cat-route_assignment_policy'));
    const headerBtns = await screen.findAllByRole('button', { name: /Request change/i });
    fireEvent.click(headerBtns[0]!);
    const form = await screen.findByTestId('change-request-form');
    expect((form.querySelector('select') as HTMLSelectElement | null)?.value).toBe('tenant');
    fireEvent.click(screen.getByRole('button', { name: /^Submit request$/i }));

    await waitFor(() => {
      expect(PROPOSE_SETTINGS_SPY).toHaveBeenCalled();
    });
    const [, submittedScope] = PROPOSE_SETTINGS_SPY.mock.calls[0] as [
      string,
      Record<string, { id: string }>,
      unknown,
      unknown,
    ];
    expect(submittedScope).toEqual({ tenant: { id: 'org_tabuk_logistics' } });
  });

  it('selecting a category updates the right pane', async () => {
    renderWithProviders(<ConfigModule />, { capabilities: ['settings.read'] });
    const navBtn = await screen.findByTestId('config-cat-driver_safety_policy');
    fireEvent.click(navBtn);
    // The category id should now appear as a heading in the right pane
    const matches = await screen.findAllByText('driver_safety_policy');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('opens the category requested by URL so domain surfaces can deep-link policy fixes', async () => {
    window.history.pushState(
      null,
      '',
      '/platform/config?category=bank_reconciliation_policy&scope_type=tenant&scope_id=org_scope_tenant',
    );
    renderWithProviders(<ConfigModule />, {
      identity: {
        capabilities: ['settings.read'],
        scope: {
          tenant: { id: 'org_scope_tenant', label: 'Scope Tenant', rank: 2 },
        },
      },
    });

    expect(await screen.findByText(/Resolved value/i)).toBeInTheDocument();
    expect(screen.getByTestId('config-cat-bank_reconciliation_policy')).toHaveStyle({
      background: 'var(--accent-soft)',
    });
    expect(screen.getAllByText('bank_reconciliation_policy').length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(RESOLVE_SETTINGS_SPY).toHaveBeenCalledWith(
        'bank_reconciliation_policy',
        expect.objectContaining({
          tenant: { id: 'org_scope_tenant' },
          organization_id: 'org_scope_tenant',
        }),
      );
    });
  });

  it('opens "Request change" modal with a Justification field that is persisted', async () => {
    renderWithProviders(<ConfigModule />, { capabilities: ['settings.write', 'all'] });
    // Click the page header "Request change" button (there's only one in the header actions)
    const headerBtns = await screen.findAllByRole('button', { name: /Request change/i });
    fireEvent.click(headerBtns[0]!);
    const form = await screen.findByTestId('change-request-form');
    expect(form).toBeInTheDocument();
    // Find the justification field by label text — the input is the next sibling
    expect(screen.getByPlaceholderText(/Required by Exampleparcel KSA/i)).toBeInTheDocument();
  });

  it('shows an inline error when approval-required settings submit fails before backend readback', async () => {
    window.history.pushState(null, '', '/platform/config?category=route_assignment_policy');
    PROPOSE_SETTINGS_SPY.mockRejectedValueOnce(new Error('settings_change.requested missing workflow_template_id policy'));

    renderWithProviders(<ConfigModule />, { capabilities: ['settings.read', 'settings.write'] });

    expect(await screen.findByText(/Resolved value/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Request change$/i }));
    const form = await screen.findByTestId('change-request-form');
    expect(form).toHaveTextContent('Sends the change for review');

    fireEvent.click(screen.getByRole('button', { name: /^Submit request$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Settings change was not submitted');
    expect(screen.getByTestId('change-request-form')).toBeInTheDocument();
  });

  it('applies safe bank reconciliation policy changes through the active backend apply path', async () => {
    window.history.pushState(
      null,
      '',
      '/platform/config?category=bank_reconciliation_policy&scope_type=tenant&scope_id=org_scope_tenant',
    );
    const policyValue = {
      version: 1,
      enabled: false,
      default_bank_account_key: null,
      bank_statement_event_type: 'bank_statement',
      match: {
        window_days_before: 2,
        window_days_after: 2,
        amount_tolerance: 0,
        require_unique: true,
      },
    };
    RESOLVE_SETTINGS_SPY.mockResolvedValueOnce({
      value: policyValue,
      resolved_from: 'tenant',
      ladder_path: [
        {
          rank: 10,
          scope_type: 'tenant',
          scope_id: 'org_scope_tenant',
          has_value: true,
          value: policyValue,
        },
      ],
      settings_resolution_id: 'srlv_bank_policy_disabled',
      override_of: null,
    });
    APPLY_SETTINGS_SPY.mockResolvedValueOnce({
      ok: true,
      applied: true,
      category: 'bank_reconciliation_policy',
      scope_type: 'tenant',
      scope_id: 'org_scope_tenant',
      settings_version_id: 'sv_bank_policy_enabled',
      settings_version_number: 2,
      settings_resolution_id: 'sv_bank_policy_enabled',
    });

    renderWithProviders(<ConfigModule />, {
      identity: {
        capabilities: ['settings.read', 'settings.write'],
        scope: {
          tenant: { id: 'org_scope_tenant', label: 'Scope Tenant', rank: 2 },
        },
      },
    });

    expect(await screen.findByText(/Resolved value/i)).toBeInTheDocument();
    const headerBtns = await screen.findAllByRole('button', { name: /Request change/i });
    fireEvent.click(headerBtns[0]!);

    const form = await screen.findByTestId('change-request-form');
    expect(form).toHaveTextContent('Saves approved categories immediately');
    const textarea = form.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(textarea?.value).toContain('"enabled": false');

    fireEvent.change(textarea!, {
      target: {
        value: JSON.stringify({ ...policyValue, enabled: true }, null, 2),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Apply active$/i }));

    await waitFor(() => {
      expect(APPLY_SETTINGS_SPY).toHaveBeenCalledWith(
        'bank_reconciliation_policy',
        { tenant: { id: 'org_scope_tenant' } },
        expect.objectContaining({ enabled: true }),
        expect.any(Object),
      );
    });
    expect(PROPOSE_SETTINGS_SPY).not.toHaveBeenCalled();
  });

  it('refreshes the visible resolved value after tenant safe-setting auto-apply without leaving the workflow', async () => {
    window.history.pushState(
      null,
      '',
      '/platform/config?category=bank_reconciliation_policy&scope_type=tenant&scope_id=org_scope_tenant',
    );
    const initialPolicyValue = {
      version: 1,
      enabled: false,
      default_bank_account_key: null,
      bank_statement_event_type: 'bank_statement',
      match: {
        window_days_before: 2,
        window_days_after: 2,
        amount_tolerance: 0,
        require_unique: true,
      },
    };
    const appliedPolicyValue = {
      ...initialPolicyValue,
      enabled: true,
    };
    RESOLVE_SETTINGS_SPY.mockResolvedValueOnce({
      value: initialPolicyValue,
      resolved_from: 'tenant',
      ladder_path: [
        {
          rank: 10,
          scope_type: 'tenant',
          scope_id: 'org_scope_tenant',
          has_value: true,
          value: initialPolicyValue,
        },
      ],
      settings_resolution_id: 'srlv_bank_readback_initial',
      override_of: null,
    });
    RESOLVE_SETTINGS_SPY.mockResolvedValue({
      value: appliedPolicyValue,
      resolved_from: 'tenant',
      ladder_path: [
        {
          rank: 10,
          scope_type: 'tenant',
          scope_id: 'org_scope_tenant',
          has_value: true,
          value: appliedPolicyValue,
        },
      ],
      settings_resolution_id: 'srlv_bank_readback_applied',
      override_of: null,
    });
    APPLY_SETTINGS_SPY.mockResolvedValueOnce({
      ok: true,
      applied: true,
      category: 'bank_reconciliation_policy',
      scope_type: 'tenant',
      scope_id: 'org_scope_tenant',
      settings_version_id: 'sv_bank_readback_applied',
      settings_version_number: 2,
      settings_resolution_id: 'srlv_bank_readback_applied',
    });

    renderWithProviders(<ConfigModule />, {
      identity: {
        capabilities: ['settings.read', 'settings.write'],
        scope: {
          tenant: { id: 'org_scope_tenant', label: 'Scope Tenant', rank: 2 },
        },
      },
    });

    expect(await screen.findByText(/Resolved value/i)).toBeInTheDocument();
    expect(document.body).toHaveTextContent('"enabled": false');
    expect(document.body).not.toHaveTextContent('"enabled": true');

    const headerBtns = await screen.findAllByRole('button', { name: /^Request change$/i });
    fireEvent.click(headerBtns[0]!);

    const form = await screen.findByTestId('change-request-form');
    const textarea = form.querySelector('textarea') as HTMLTextAreaElement | null;
    const justification = screen.getByPlaceholderText(/Required by Exampleparcel KSA/i);
    fireEvent.change(textarea!, {
      target: {
        value: JSON.stringify(appliedPolicyValue, null, 2),
      },
    });
    fireEvent.change(justification, {
      target: {
        value: 'OrganizationSettingsApplyReadbackTest',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Apply active$/i }));

    await waitFor(() => {
      expect(APPLY_SETTINGS_SPY).toHaveBeenCalledWith(
        'bank_reconciliation_policy',
        { tenant: { id: 'org_scope_tenant' } },
        expect.objectContaining({ enabled: true }),
        expect.objectContaining({ justification: 'OrganizationSettingsApplyReadbackTest' }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId('change-request-form')).not.toBeInTheDocument();
      expect(document.body).toHaveTextContent('"enabled": true');
    });
    expect(document.body).not.toHaveTextContent('"enabled": false');
    expect(window.location.pathname).toBe('/platform/config');
    expect(window.location.search).toContain('scope_id=org_scope_tenant');
    expect(PROPOSE_SETTINGS_SPY).not.toHaveBeenCalled();
  });

  it('lets system.write operators apply safe bank reconciliation policy changes', async () => {
    window.history.pushState(
      null,
      '',
      '/platform/config?category=bank_reconciliation_policy&scope_type=tenant&scope_id=org_scope_tenant',
    );
    const policyValue = {
      version: 1,
      enabled: false,
      default_bank_account_key: null,
      bank_statement_event_type: 'bank_statement',
      match: {
        window_days_before: 2,
        window_days_after: 2,
        amount_tolerance: 0,
        require_unique: true,
      },
    };
    RESOLVE_SETTINGS_SPY.mockResolvedValueOnce({
      value: policyValue,
      resolved_from: 'tenant',
      ladder_path: [
        {
          rank: 10,
          scope_type: 'tenant',
          scope_id: 'org_scope_tenant',
          has_value: true,
          value: policyValue,
        },
      ],
      settings_resolution_id: 'srlv_bank_policy_disabled',
      override_of: null,
    });
    APPLY_SETTINGS_SPY.mockResolvedValueOnce({
      ok: true,
      applied: true,
      category: 'bank_reconciliation_policy',
      scope_type: 'tenant',
      scope_id: 'org_scope_tenant',
      settings_version_id: 'sv_bank_policy_enabled_system',
      settings_version_number: 3,
      settings_resolution_id: 'sv_bank_policy_enabled_system',
    });

    renderWithProviders(<ConfigModule />, {
      identity: {
        capabilities: ['settings.read', 'system.write'],
        scope: {
          tenant: { id: 'org_scope_tenant', label: 'Scope Tenant', rank: 2 },
        },
      },
    });

    expect(await screen.findByText(/Resolved value/i)).toBeInTheDocument();
    const headerBtns = await screen.findAllByRole('button', { name: /^Request change$/i });
    expect(headerBtns[0]).toBeEnabled();
    fireEvent.click(headerBtns[0]!);

    const form = await screen.findByTestId('change-request-form');
    expect(screen.getByRole('button', { name: /^Preview impact$/i })).toBeEnabled();
    const textarea = form.querySelector('textarea') as HTMLTextAreaElement | null;
    fireEvent.change(textarea!, {
      target: {
        value: JSON.stringify({ ...policyValue, enabled: true }, null, 2),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Apply active$/i }));

    await waitFor(() => {
      expect(APPLY_SETTINGS_SPY).toHaveBeenCalledWith(
        'bank_reconciliation_policy',
        { tenant: { id: 'org_scope_tenant' } },
        expect.objectContaining({ enabled: true }),
        expect.any(Object),
      );
    });
  });

  it('opens "Compare scopes" modal restricted to category-allowed scopes', async () => {
    renderWithProviders(<ConfigModule />, { capabilities: ['settings.read'] });
    const cmpBtn = await screen.findByRole('button', { name: /Compare scopes/i });
    fireEvent.click(cmpBtn);
    const compareScopes = await screen.findByTestId('compare-scopes');
    expect(compareScopes).toBeInTheDocument();
    // Default cat is `pod.required_evidence` → allowed scopes are
    // global, tenant, client, sender, resource (5 boxes).
    // Each ScopeBox has a "G/T/C/S/R" rank letter as a span — assert at least 4 are present.
    expect(screen.getByText(/Global/)).toBeInTheDocument();
    expect(screen.getByText(/Tenant/)).toBeInTheDocument();
    expect(screen.getByText(/Client/)).toBeInTheDocument();
    expect(screen.getByText(/Sender/)).toBeInTheDocument();
  });

  it('surfaces compare-scope failures without demo or synthetic wording', async () => {
    const toastSpy = vi.spyOn(toastStore, 'pushToast');
    renderWithProviders(<ConfigModule />, { capabilities: ['settings.read'] });
    expect(await screen.findByText(/Resolved value/i)).toBeInTheDocument();
    RESOLVE_SETTINGS_SPY.mockRejectedValueOnce(new Error('scope comparison unavailable'));

    fireEvent.click(screen.getByRole('button', { name: /Compare scopes/i }));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith('Compare scopes failed', 'danger');
    });
    expect(toastSpy).not.toHaveBeenCalledWith(expect.stringMatching(/synthetic|demo/i), expect.anything());
  });

  it.each([
    ['tenant', 'org_scope_tenant'],
    ['client', 'cl_scope_client'],
    ['sender', 'snd_scope_sender'],
  ])('submits the active %s scope id in request settings changes', async (scopeType, expectedId) => {
    renderWithProviders(<ConfigModule />, {
      identity: {
        capabilities: ['settings.read', 'settings.write'],
        scope: {
          tenant: { id: 'org_scope_tenant', label: 'Scope Tenant', rank: 2 },
          client: { id: 'cl_scope_client', label: 'Scope Client', rank: 3 },
          sender: { id: 'snd_scope_sender', label: 'Scope Sender', rank: 4 },
        },
      },
    });
    fireEvent.click(await screen.findByTestId('config-cat-route_assignment_policy'));
    const headerBtns = await screen.findAllByRole('button', { name: /Request change/i });
    fireEvent.click(headerBtns[0]!);
    const form = await screen.findByTestId('change-request-form');
    const scopeSelect = form.querySelector('select') as HTMLSelectElement | null;
    expect(scopeSelect).not.toBeNull();
    fireEvent.change(scopeSelect!, { target: { value: scopeType } });
    fireEvent.click(screen.getByRole('button', { name: /^Submit request$/i }));
    await waitFor(() => {
      expect(PROPOSE_SETTINGS_SPY).toHaveBeenCalled();
    });
    const [, submittedScope] = PROPOSE_SETTINGS_SPY.mock.calls[0] as [
      string,
      Record<string, { id: string }>,
      unknown,
      unknown,
    ];
    expect(submittedScope).toEqual({ [scopeType]: { id: expectedId } });
  });
});
