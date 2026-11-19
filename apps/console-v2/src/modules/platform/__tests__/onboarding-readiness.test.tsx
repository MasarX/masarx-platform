import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { OnboardingReadinessModule } from '@/modules/platform/onboarding-readiness';
import { CAP } from '@/lib/capabilities';
import * as api from '@/lib/api';
import * as toastStore from '@/components/toastStore';
import type { UiOnboardingReadiness } from '@/types/domain';

const readyPayload: UiOnboardingReadiness = {
  scope_type: 'tenant',
  scope_id: 'org_ready',
  organization_id: 'org_ready',
  generated_at: '2026-05-03T00:00:00.000Z',
  overall_status: 'ready',
  healthy: true,
  settings_defaults: {
    status: 'ready',
    healthy: true,
    required_count: 4,
    present_count: 4,
    healthy_count: 4,
    blocking_count: 0,
    warning_count: 0,
  },
  workflow_bindings: {
    status: 'ready',
    healthy: true,
    required_count: 3,
    present_count: 3,
    healthy_count: 3,
    blocking_count: 0,
    warning_count: 0,
  },
  integration_plugins: {
    status: 'ready',
    healthy: true,
    required_count: 2,
    present_count: 2,
    healthy_count: 2,
    blocking_count: 0,
    warning_count: 0,
    items: [
      { plugin_key: 'plg_exampleparcel_ksa', status: 'active', credentials_status: 'ready', enabled: true, blocking: false },
    ],
  },
  label_design: {
    status: 'ready',
    healthy: true,
    required_count: 3,
    present_count: 3,
    healthy_count: 3,
    blocking_count: 0,
    warning_count: 0,
  },
  blocking_findings: [],
};

describe('OnboardingReadinessModule', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.pushState(null, '', '/');
  });

  it('calls ui_get_onboarding_readiness_v1 with the tenant scope from identity', async () => {
    const spy = vi.spyOn(api, 'ui_get_onboarding_readiness_v1').mockResolvedValue(readyPayload);
    renderWithProviders(<OnboardingReadinessModule />, {
      identity: {
        capabilities: [CAP.SETTINGS_READ],
        user: {
          organization_id: 'org_ready',
          access_scope_type: 'tenant',
          access_scope_id: null,
        },
        scope: {
          tenant: { id: 'org_ready', label: 'Rashed Logistics', rank: 2 },
        },
      },
    });

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ scope_type: 'tenant', scope_id: 'org_ready' });
    });
    expect(await screen.findByTestId('onboarding-readiness-status')).toHaveTextContent('Ready');
    expect(screen.getAllByText('Settings defaults').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Workflow bindings').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Integration plugins').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Label design').length).toBeGreaterThan(0);
    expect(screen.getByText('Exampleparcel Ksa')).toBeInTheDocument();
    expect(screen.getByLabelText('Scope reference')).toHaveTextContent('Rashed Logistics');
    expect(screen.queryByText('org_ready')).not.toBeInTheDocument();
  });

  it('renders Mobile V2 tenant defaults breadth from the backend readiness snapshot', async () => {
    vi.spyOn(api, 'ui_get_onboarding_readiness_v1').mockResolvedValue({
      ...readyPayload,
      settings_defaults: {
        ...readyPayload.settings_defaults,
        status: 'healthy',
        healthy: true,
        required_count: 140,
        present_count: 140,
        missing_categories: [],
      },
    });

    renderWithProviders(<OnboardingReadinessModule />, {
      identity: {
        capabilities: [CAP.SETTINGS_READ],
        user: {
          organization_id: 'org_ready',
          access_scope_type: 'tenant',
          access_scope_id: null,
        },
      },
    });

    expect(await screen.findByTestId('onboarding-readiness-status')).toHaveTextContent('Ready');
    expect(screen.getByText('140/140')).toBeInTheDocument();
    expect(screen.queryByText(/mobile_cash_policy/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/mobile_pod_policy/i)).not.toBeInTheDocument();
  });

  it('uses the tenant scope query from the approved signup readiness handoff', async () => {
    window.history.pushState(
      null,
      '',
      '/platform/onboarding-readiness?scope_type=tenant&scope_id=org_tabuk_logistics',
    );
    const spy = vi.spyOn(api, 'ui_get_onboarding_readiness_v1').mockResolvedValue({
      ...readyPayload,
      scope_id: 'org_tabuk_logistics',
      organization_id: 'org_tabuk_logistics',
    });

    renderWithProviders(<OnboardingReadinessModule />, {
      identity: {
        capabilities: [CAP.SETTINGS_READ],
        user: {
          organization_id: 'org_demo',
          access_scope_type: 'platform',
          access_scope_id: null,
        },
        scope: {
          tenant: { id: 'org_demo', label: 'Demo Organization', rank: 2 },
        },
      },
    });

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({
        scope_type: 'tenant',
        scope_id: 'org_tabuk_logistics',
      });
    });
    expect(await screen.findByTestId('onboarding-readiness-status')).toHaveTextContent('Ready');
    expect(screen.getByLabelText('Scope reference')).toHaveTextContent('Tenant scope');
  });

  it('fails closed when the row-driven scope registry cannot be loaded', async () => {
    const readinessSpy = vi.spyOn(api, 'ui_get_onboarding_readiness_v1').mockResolvedValue(readyPayload);
    const original = api.ui_list_resource_v1;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource: string, opts?: unknown) => {
      if (resource === 'scope_type_registry') throw new Error('scope_registry_rpc_failed');
      return original(resource, opts as never);
    });

    renderWithProviders(<OnboardingReadinessModule />, {
      identity: {
        capabilities: [CAP.SETTINGS_READ],
        user: {
          organization_id: 'org_ready',
          access_scope_type: 'tenant',
          access_scope_id: null,
        },
      },
    });

    expect(await screen.findByText('Readiness scope registry failed')).toBeInTheDocument();
    expect(screen.getByText(/This section could not load/i)).toBeInTheDocument();
    expect(screen.queryByText('scope_registry_rpc_failed')).not.toBeInTheDocument();
    expect(readinessSpy).not.toHaveBeenCalled();
  });

  it('does not fall back to hardcoded scope types when the registry is empty', async () => {
    const readinessSpy = vi.spyOn(api, 'ui_get_onboarding_readiness_v1').mockResolvedValue(readyPayload);
    const original = api.ui_list_resource_v1;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource: string, opts?: unknown) => {
      if (resource === 'scope_type_registry') {
        return { rows: [], total: 0, page: 0, page_size: 0 };
      }
      return original(resource, opts as never);
    });

    renderWithProviders(<OnboardingReadinessModule />, {
      identity: {
        capabilities: [CAP.SETTINGS_READ],
        user: {
          organization_id: 'org_ready',
          access_scope_type: 'tenant',
          access_scope_id: null,
        },
      },
    });

    expect(await screen.findByText('Readiness scope registry empty')).toBeInTheDocument();
    expect(screen.getByText(/Configure enabled scope_type_registry rows/i)).toBeInTheDocument();
    expect(readinessSpy).not.toHaveBeenCalled();
  });

  it('fails closed when tenant scope labels cannot be loaded', async () => {
    const readinessSpy = vi.spyOn(api, 'ui_get_onboarding_readiness_v1').mockResolvedValue(readyPayload);
    const original = api.ui_list_resource_v1;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource: string, opts?: unknown) => {
      if (resource === 'organizations') throw new Error('tenant_scope_reference_failed');
      return original(resource, opts as never);
    });

    renderWithProviders(<OnboardingReadinessModule />, {
      identity: {
        capabilities: [CAP.SETTINGS_READ],
        user: {
          organization_id: 'org_ready',
          access_scope_type: 'tenant',
          access_scope_id: null,
        },
      },
    });

    expect(await screen.findByText('Tenant scope reference failed')).toBeInTheDocument();
    expect(screen.getByText(/This section could not load/i)).toBeInTheDocument();
    expect(screen.queryByText('tenant_scope_reference_failed')).not.toBeInTheDocument();
    expect(readinessSpy).not.toHaveBeenCalled();
  });

  it('renders blocking findings returned by the canonical readiness RPC', async () => {
    vi.spyOn(api, 'ui_get_onboarding_readiness_v1').mockResolvedValue({
      ...readyPayload,
      overall_status: 'blocked',
      healthy: false,
      settings_defaults: {
        ...readyPayload.settings_defaults,
        status: 'blocked',
        healthy: false,
        present_count: 2,
        blocking_count: 2,
      },
      blocking_findings: [
        {
          code: 'settings_defaults_missing',
          severity: 'blocking',
          component: 'settings_defaults',
          message: 'Required onboarding default cod.float.max_per_driver is missing for tenant/7b34a9fc-9ef1-4602-a4cf-9b10f64c25df.',
          action: 'Configure live_tail_policy for tenant/7b34a9fc-9ef1-4602-a4cf-9b10f64c25df.',
        },
      ],
    });
    renderWithProviders(<OnboardingReadinessModule />, {
      identity: {
        capabilities: [CAP.SETTINGS_READ],
        user: {
          organization_id: 'org_ready',
          access_scope_type: 'tenant',
          access_scope_id: null,
        },
      },
    });

    expect(await screen.findByText('Settings Defaults Missing')).toBeInTheDocument();
    expect(screen.getAllByText('Blocking').length).toBeGreaterThan(0);
    expect(screen.getByText('Required onboarding default Cod Float Max Per Driver is missing for tenant scope.')).toBeInTheDocument();
    expect(screen.getByText('Configure Live Tail Policy for tenant scope.')).toBeInTheDocument();
    expect(screen.queryByText(/finding_severity\/blocking/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/7b34a9fc/i)).not.toBeInTheDocument();
  });

  it('runs canonical onboarding bootstrap repair from the readiness page', async () => {
    const user = userEvent.setup();
    const readinessSpy = vi.spyOn(api, 'ui_get_onboarding_readiness_v1')
      .mockResolvedValue(readyPayload);
    const bootstrapSpy = vi.spyOn(api, 'ui_execute_onboarding_bootstrap_v1')
      .mockResolvedValue({ ok: true, readiness: readyPayload });

    renderWithProviders(<OnboardingReadinessModule />, {
      identity: {
        capabilities: [CAP.SETTINGS_READ, CAP.SETTINGS_WRITE],
        user: {
          organization_id: 'org_ready',
          access_scope_type: 'tenant',
          access_scope_id: null,
        },
      },
    });

    await screen.findByTestId('onboarding-readiness-status');
    await user.click(screen.getByRole('button', { name: /run bootstrap/i }));

    await waitFor(() => {
      expect(bootstrapSpy).toHaveBeenCalledWith({
        scope_type: 'tenant',
        scope_id: 'org_ready',
      });
    });
    await waitFor(() => expect(readinessSpy).toHaveBeenCalledTimes(2));
  });

  it('updates readiness cards from backend readback after bootstrap without a page reload', async () => {
    const user = userEvent.setup();
    const blockedPayload: UiOnboardingReadiness = {
      ...readyPayload,
      overall_status: 'blocked',
      healthy: false,
      settings_defaults: {
        ...readyPayload.settings_defaults,
        status: 'blocked',
        healthy: false,
        required_count: 142,
        present_count: 0,
        healthy_count: 0,
        blocking_count: 142,
      },
      blocking_findings: [
        {
          code: 'missing_scope_default',
          severity: 'blocking',
          component: 'settings_defaults',
          message: 'Required onboarding default access_control_policy is missing for tenant/org_ready.',
          action: 'Run tenant onboarding bootstrap for tenant/org_ready.',
        },
      ],
    };
    const readinessSpy = vi.spyOn(api, 'ui_get_onboarding_readiness_v1')
      .mockResolvedValueOnce(blockedPayload)
      .mockResolvedValueOnce({
        ...readyPayload,
        settings_defaults: {
          ...readyPayload.settings_defaults,
          required_count: 142,
          present_count: 142,
          healthy_count: 142,
          blocking_count: 0,
        },
      });
    const bootstrapSpy = vi.spyOn(api, 'ui_execute_onboarding_bootstrap_v1')
      .mockResolvedValue({
        ok: true,
        scope_type: 'tenant',
        scope_id: 'org_ready',
        result: {
          ok: true,
          enabled: true,
          scope_defaults: { seeded_categories: ['access_control_policy'] },
          rbac_templates_provisioned: ['ops_admin'],
        },
        readiness: readyPayload,
      } as unknown as Record<string, unknown>);

    renderWithProviders(<OnboardingReadinessModule />, {
      identity: {
        capabilities: [CAP.SETTINGS_READ, CAP.SETTINGS_WRITE],
        user: {
          organization_id: 'org_ready',
          access_scope_type: 'tenant',
          access_scope_id: null,
        },
      },
    });

    expect(await screen.findByTestId('onboarding-readiness-status')).toHaveTextContent('Blocked');
    expect(screen.getByText('0/142')).toBeInTheDocument();
    expect(screen.getByText('Missing Scope Default')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /run bootstrap/i }));

    await waitFor(() => {
      expect(bootstrapSpy).toHaveBeenCalledWith({
        scope_type: 'tenant',
        scope_id: 'org_ready',
      });
    });
    await waitFor(() => expect(readinessSpy).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('onboarding-readiness-status')).toHaveTextContent('Ready');
    expect(screen.getByText('142/142')).toBeInTheDocument();
    expect(screen.queryByText('Missing Scope Default')).not.toBeInTheDocument();
    expect(screen.getByTestId('onboarding-bootstrap-result')).toHaveTextContent('Bootstrap completed');
  });

  it('surfaces onboarding bootstrap failures through the canonical toast', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'ui_get_onboarding_readiness_v1').mockResolvedValue(readyPayload);
    vi.spyOn(api, 'ui_execute_onboarding_bootstrap_v1')
      .mockRejectedValue(new Error('bootstrap_policy_denied'));
    const toastSpy = vi.spyOn(toastStore, 'pushToast');

    renderWithProviders(<OnboardingReadinessModule />, {
      identity: {
        capabilities: [CAP.SETTINGS_READ, CAP.SETTINGS_WRITE],
        user: {
          organization_id: 'org_ready',
          access_scope_type: 'tenant',
          access_scope_id: null,
        },
      },
    });

    await screen.findByTestId('onboarding-readiness-status');
    await user.click(screen.getByRole('button', { name: /run bootstrap/i }));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        'Onboarding bootstrap failed - bootstrap_policy_denied',
        'danger',
      );
    });
  });

  it('shows a settings.write or system.write permission lock on the bootstrap button when write access is missing', async () => {
    vi.spyOn(api, 'ui_get_onboarding_readiness_v1').mockResolvedValue(readyPayload);
    renderWithProviders(<OnboardingReadinessModule />, {
      identity: {
        capabilities: [CAP.SETTINGS_READ],
        user: {
          organization_id: 'org_ready',
          access_scope_type: 'tenant',
          access_scope_id: null,
        },
      },
    });

    await screen.findByTestId('onboarding-readiness-status');
    const button = screen.getByRole('button', { name: /run bootstrap/i });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(/Settings Write permission required/i);
    expect(button).toHaveTextContent(/System Write permission required/i);
  });

  it('allows onboarding bootstrap when the operator has system.write instead of settings.write', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'ui_get_onboarding_readiness_v1').mockResolvedValue(readyPayload);
    const bootstrapSpy = vi.spyOn(api, 'ui_execute_onboarding_bootstrap_v1')
      .mockResolvedValue({ ok: true, enabled: true, readiness: readyPayload });

    renderWithProviders(<OnboardingReadinessModule />, {
      identity: {
        capabilities: [CAP.SETTINGS_READ, CAP.SYSTEM_WRITE],
        user: {
          organization_id: 'org_ready',
          access_scope_type: 'tenant',
          access_scope_id: null,
        },
      },
    });

    await screen.findByTestId('onboarding-readiness-status');
    const button = screen.getByRole('button', { name: /run bootstrap/i });
    expect(button).toBeEnabled();

    await user.click(button);

    await waitFor(() => {
      expect(bootstrapSpy).toHaveBeenCalledWith({
        scope_type: 'tenant',
        scope_id: 'org_ready',
      });
    });
  });

  it('keeps onboarding bootstrap disabled for global scope and does not call the canonical RPC', async () => {
    const user = userEvent.setup();
    const readinessSpy = vi.spyOn(api, 'ui_get_onboarding_readiness_v1')
      .mockResolvedValue(readyPayload);
    const bootstrapSpy = vi.spyOn(api, 'ui_execute_onboarding_bootstrap_v1')
      .mockResolvedValue({ ok: true, readiness: readyPayload });

    renderWithProviders(<OnboardingReadinessModule />, {
      identity: {
        capabilities: [CAP.SETTINGS_READ, CAP.SETTINGS_WRITE],
        user: {
          organization_id: 'org_ready',
          access_scope_type: 'tenant',
          access_scope_id: null,
        },
      },
    });

    await screen.findByTestId('onboarding-readiness-status');
    await user.selectOptions(screen.getByLabelText('Scope type'), 'global');

    await waitFor(() => {
      expect(readinessSpy).toHaveBeenCalledWith({
        scope_type: 'global',
        scope_id: null,
      });
    });
    const bootstrapButton = screen.getByRole('button', { name: /run bootstrap/i });
    expect(bootstrapButton).toBeDisabled();
    await user.click(bootstrapButton);
    expect(bootstrapSpy).not.toHaveBeenCalled();
  });

  it('blocks the module when settings.read is missing', async () => {
    const spy = vi.spyOn(api, 'ui_get_onboarding_readiness_v1').mockResolvedValue(readyPayload);
    renderWithProviders(<OnboardingReadinessModule />, { capabilities: [] });

    expect(await screen.findByText(/Settings Access permission required/i)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  describe('bootstrap evidence modal (no toast-only completion)', () => {
    function mockScopeRegistry() {
      const original = api.ui_list_resource_v1;
      vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource: string, opts?: unknown) => {
        if (resource === 'scope_type_registry') {
          return {
            rows: [
              { id: 'scope_global', scope_type: 'global', ladder_rank: 0, is_enabled: true },
              { id: 'scope_tenant', scope_type: 'tenant', ladder_rank: 10, is_enabled: true },
              { id: 'scope_client', scope_type: 'client', ladder_rank: 20, is_enabled: true },
              { id: 'scope_sender', scope_type: 'sender', ladder_rank: 30, is_enabled: true },
            ] as never,
            total: 4,
            page: 0,
            page_size: 100,
          };
        }
        if (resource === 'organizations') {
          return {
            rows: [
              { id: 'org_ready', name: 'First Tenant Readiness', display_name: 'First Tenant Readiness' },
            ] as never,
            total: 1,
            page: 0,
            page_size: 100,
          };
        }
        return original(resource, opts as never);
      });
    }

    const successfulBootstrapPayload = {
      ok: true,
      scope_type: 'tenant',
      scope_id: 'org_ready',
      result: {
        ok: true,
        enabled: true,
        organization_id: 'org_ready',
        scope_defaults: {
          scope_type: 'tenant',
          scope_id: 'org_ready',
          seeded_categories: [
            'pod.required_evidence',
            'route_assignment_policy',
            'cod.float.max_per_driver',
          ],
        },
        global_defaults: {
          seeded_categories: ['live_tail_policy'],
          skipped_categories: [
            { category: 'address_policy', reason: 'already exists' },
          ],
        },
        rbac_templates_provisioned: ['ops_admin', 'driver', 'cashier'],
      },
      readiness: { ...readyPayload },
    } as const;

    it('opens a backend-readback evidence modal with scope/result/readiness fields after a successful bootstrap', async () => {
      const user = userEvent.setup();
      mockScopeRegistry();
      vi.spyOn(api, 'ui_get_onboarding_readiness_v1').mockResolvedValue(readyPayload);
      const bootstrapSpy = vi
        .spyOn(api, 'ui_execute_onboarding_bootstrap_v1')
        .mockResolvedValue(successfulBootstrapPayload as unknown as Record<string, unknown>);

      renderWithProviders(<OnboardingReadinessModule />, {
        identity: {
          capabilities: [CAP.SETTINGS_READ, CAP.SETTINGS_WRITE],
          user: {
            organization_id: 'org_ready',
            access_scope_type: 'tenant',
            access_scope_id: null,
          },
        },
      });

      await screen.findByTestId('onboarding-readiness-status');
      await user.click(screen.getByRole('button', { name: /run bootstrap/i }));

      await waitFor(() => {
        expect(bootstrapSpy).toHaveBeenCalledWith({
          scope_type: 'tenant',
          scope_id: 'org_ready',
        });
      });

      const modal = await screen.findByTestId('onboarding-bootstrap-result');
      expect(modal).toBeInTheDocument();
      expect(modal).toHaveTextContent('Bootstrap completed');
      expect(screen.getByTestId('bootstrap-scope-defaults-count')).toHaveTextContent('3');
      expect(screen.getByTestId('bootstrap-global-defaults-count')).toHaveTextContent('1');
      expect(screen.getByTestId('bootstrap-global-defaults-skipped')).toHaveTextContent('1');
      expect(screen.getByTestId('bootstrap-rbac-templates-count')).toHaveTextContent('3');
      expect(modal).toHaveTextContent('pod.required_evidence');
      expect(modal).toHaveTextContent('route_assignment_policy');
      expect(modal).toHaveTextContent('ops_admin');
      expect(modal).toHaveTextContent('address_policy');
      expect(modal).toHaveTextContent('already exists');
    });

    it('keeps backend-readback evidence in the modal when bootstrap is skipped by policy', async () => {
      const user = userEvent.setup();
      mockScopeRegistry();
      vi.spyOn(api, 'ui_get_onboarding_readiness_v1').mockResolvedValue(readyPayload);
      vi.spyOn(api, 'ui_execute_onboarding_bootstrap_v1').mockResolvedValue({
        ok: true,
        scope_type: 'tenant',
        scope_id: 'org_ready',
        result: {
          ok: true,
          enabled: false,
          organization_id: 'org_ready',
          reason: 'disabled_by_policy',
        },
        readiness: readyPayload,
      } as unknown as Record<string, unknown>);

      renderWithProviders(<OnboardingReadinessModule />, {
        identity: {
          capabilities: [CAP.SETTINGS_READ, CAP.SETTINGS_WRITE],
          user: {
            organization_id: 'org_ready',
            access_scope_type: 'tenant',
            access_scope_id: null,
          },
        },
      });

      await screen.findByTestId('onboarding-readiness-status');
      await user.click(screen.getByRole('button', { name: /run bootstrap/i }));

      const modal = await screen.findByTestId('onboarding-bootstrap-result');
      expect(modal).toHaveTextContent('Bootstrap skipped by policy');
      expect(modal).toHaveTextContent('Disabled By Policy');
      expect(screen.getByTestId('bootstrap-scope-defaults-count')).toHaveTextContent('0');
    });

    it('does not open the evidence modal when bootstrap fails (toast-only error path)', async () => {
      const user = userEvent.setup();
      mockScopeRegistry();
      vi.spyOn(api, 'ui_get_onboarding_readiness_v1').mockResolvedValue(readyPayload);
      vi.spyOn(api, 'ui_execute_onboarding_bootstrap_v1').mockRejectedValue(
        new Error('bootstrap_policy_denied'),
      );
      const toastSpy = vi.spyOn(toastStore, 'pushToast');

      renderWithProviders(<OnboardingReadinessModule />, {
        identity: {
          capabilities: [CAP.SETTINGS_READ, CAP.SETTINGS_WRITE],
          user: {
            organization_id: 'org_ready',
            access_scope_type: 'tenant',
            access_scope_id: null,
          },
        },
      });

      await screen.findByTestId('onboarding-readiness-status');
      await user.click(screen.getByRole('button', { name: /run bootstrap/i }));

      await waitFor(() => {
        expect(toastSpy).toHaveBeenCalledWith(
          'Onboarding bootstrap failed - bootstrap_policy_denied',
          'danger',
        );
      });
      expect(screen.queryByTestId('onboarding-bootstrap-result')).not.toBeInTheDocument();
    });
  });
});
