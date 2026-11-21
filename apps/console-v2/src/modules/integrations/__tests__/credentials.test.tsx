// credentials.test.tsx — module-level integration tests for the
// CredentialsModule (CLAIM-INTEGRATIONS-WORKFLOWS-WIRING / Phase C5).
//
// Backed by:
//   - public.provider_auth_configs / public.providers from
//     supabase/migrations/202510110004_webhook_integration.sql
//   - useResourceList<ProviderAuthConfigRaw>('provider_auth_configs')
//   - useUpsertProviderAuthConfig (Console CRUD -> ui_upsert_provider_auth_config_v1)
//   - useRotateProviderCredentials (Phase C5 hook → integration_plugin_rotate_credentials_v1)
//   - useRevokeProviderAuthConfig (Phase C5 hook → ui_revoke_provider_auth_config_v1)
//
// Targets:
//   1. Module mounts and the table renders rows from the seeded creds.
//   2. Rotate row action fires integration_plugin_rotate_credentials_v1.
//   3. Revoke row action fires ui_revoke_provider_auth_config_v1.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { CredentialsModule } from '@/modules/integrations/credentials';
import * as apiMod from '@/lib/api';
import * as toastStore from '@/components/toastStore';
import { typedSpy, type TypedSpy } from '@/test/helpers/typed-spy';
import type { ListResult } from '@/types/domain';
import vendorAccount from '../../../../../../tests/fixtures/carrier/vendor-account.synthetic.json';

describe('CredentialsModule (Phase C5 wiring)', () => {
  // W56-E — typed spy helper preserves the precise MockInstance shape returned
  // by vitest without the `<any, any>` widening introduced as a W54-F stopgap.
  let rotateSpy: TypedSpy<typeof apiMod, 'integration_plugin_rotate_credentials_v1'>;
  let revokeSpy: TypedSpy<typeof apiMod, 'ui_revoke_provider_auth_config_v1'>;
  let upsertSpy: TypedSpy<typeof apiMod, 'ui_upsert_provider_auth_config_v1'>;
  let bindProviderAccountSpy: TypedSpy<typeof apiMod, 'ui_bind_provider_account_credential_v1'>;
  let unbindProviderAccountSpy: TypedSpy<typeof apiMod, 'ui_unbind_provider_account_credential_v1'>;
  let resourceListSpy: { mockRestore: () => void } | undefined;
  beforeEach(() => {
    rotateSpy = typedSpy(apiMod, 'integration_plugin_rotate_credentials_v1');
    revokeSpy = typedSpy(apiMod, 'ui_revoke_provider_auth_config_v1');
    upsertSpy = typedSpy(apiMod, 'ui_upsert_provider_auth_config_v1');
    bindProviderAccountSpy = typedSpy(apiMod, 'ui_bind_provider_account_credential_v1');
    unbindProviderAccountSpy = typedSpy(apiMod, 'ui_unbind_provider_account_credential_v1');
  });
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    rotateSpy.mockRestore();
    revokeSpy.mockRestore();
    upsertSpy.mockRestore();
    bindProviderAccountSpy.mockRestore();
    unbindProviderAccountSpy.mockRestore();
    resourceListSpy?.mockRestore();
    resourceListSpy = undefined;
    toastStore.clearToasts();
  });

  function mockCredentialDirectoryReadback() {
    const realList = apiMod.ui_list_resource_v1;
    let credentials: Array<Record<string, unknown>> = [
      {
        id: 'auth_cfg_readback',
        organization_id: 'org_launch',
        provider_id: 'prv_readback',
        provider_label: 'Readback Provider',
        provider_kind: 'api',
        provider_vendor: 'logestechs',
        auth_type: 'api_key',
        status: 'active',
        is_active: true,
        is_expiring: false,
        is_expired: false,
        days_until_expiry: 90,
        created_at: '2026-05-13T06:00:00.000Z',
        last_rotated_at: '2026-05-13T06:00:00.000Z',
      },
    ];
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'providers') {
        return {
          rows: [
            {
              id: 'prv_readback',
              organization_id: 'org_launch',
              name: 'Readback Provider',
              provider_type: 'api',
              enabled: true,
              priority_rank: 10,
              health_status: 'healthy',
              metadata: { vendor: 'logestechs' },
            },
          ],
          total: 1,
        } as ListResult<unknown>;
      }
      if (resource === 'lookup_values') {
        return {
          rows: [
            { value: 'api_key', label: 'API key', rank: 10, is_default: true },
            { value: 'basic_auth', label: 'Basic Auth', rank: 20 },
          ],
          total: 2,
        } as ListResult<unknown>;
      }
      if (resource === 'api_routes') {
        return { rows: [], total: 0 } as ListResult<unknown>;
      }
      if (resource === 'integration_credential_directory') {
        return { rows: credentials.map((row) => ({ ...row })), total: credentials.length } as ListResult<unknown>;
      }
      return realList(resource, opts);
    });
    resourceListSpy = listSpy;
    upsertSpy.mockImplementation(async (args) => {
      const configId = String(args.config_id ?? 'auth_cfg_created_readback');
      const expiresAt = typeof args.expires_at === 'string' ? args.expires_at : null;
      const isExpired = expiresAt ? Date.parse(expiresAt) <= Date.now() : false;
      const nextRow = {
        id: configId,
        organization_id: 'org_launch',
        provider_id: String(args.provider_id ?? 'prv_readback'),
        provider_label: 'Readback Provider',
        provider_kind: 'api',
        provider_vendor: 'logestechs',
        auth_type: String(args.auth_type ?? 'api_key'),
        status: isExpired ? 'expired' : 'active',
        is_active: !isExpired,
        is_expiring: false,
        is_expired: isExpired,
        days_until_expiry: isExpired ? 0 : 120,
        ...(expiresAt ? { expires_at: expiresAt } : {}),
        created_at: '2026-05-13T06:05:00.000Z',
        last_rotated_at: '2026-05-13T06:05:00.000Z',
      };
      credentials = credentials.some((row) => row.id === configId)
        ? credentials.map((row) => (row.id === configId ? { ...row, ...nextRow } : row))
        : [...credentials, nextRow];
      return { ok: true, provider_auth_config_id: configId };
    });
    revokeSpy.mockImplementation(async (args) => {
      credentials = credentials.map((row) =>
        row.id === args.config_id
          ? { ...row, status: 'revoked', is_active: false, days_until_expiry: 0 }
          : row,
      );
      return { ok: true, provider_auth_config_id: String(args.config_id ?? '') };
    });
    rotateSpy.mockImplementation(async (args) => {
      const configId = String(args.config_id ?? '');
      credentials = credentials.map((row) =>
        row.id === configId
          ? {
              ...row,
              status: 'active',
              is_active: true,
              is_expiring: false,
              is_expired: false,
              days_until_expiry: 140,
              last_rotated_at: '2026-05-13T07:10:00.000Z',
              expires_at: typeof args.expires_at === 'string' ? args.expires_at : row.expires_at,
            }
          : row,
      );
      return { ok: true, provider_auth_config_id: configId };
    });
    return { listSpy };
  }

  function credentialTableRows() {
    return Array.from(document.querySelectorAll('.dt__table tbody tr'));
  }

  it('mounts the page header + table rows', async () => {
    renderWithProviders(<CredentialsModule />, { capabilities: ['all'] });
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole('toolbar', { name: /External Intake workspace/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open Sources & tokens/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Open API request intake/i })).toBeEnabled();
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
  });

  it('renders denied state without protected provider credential reads when provider_auth.read is missing', async () => {
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    const settingsSpy = vi.spyOn(apiMod, 'resolveSettings');
    renderWithProviders(<CredentialsModule />, { capabilities: [] });

    expect(await screen.findByText(/You do not have permission to view provider credentials/i)).toBeInTheDocument();
    await waitFor(() => {
      const resources = listSpy.mock.calls.map(([resource]) => resource);
      expect(resources).not.toContain('providers');
      expect(resources).not.toContain('lookup_values');
      expect(resources).not.toContain('api_routes');
      expect(resources).not.toContain('integration_credential_directory');

      const categories = settingsSpy.mock.calls.map(([category]) => category);
      expect(categories).not.toContain('provider_credential_policy');
      expect(categories).not.toContain('logestechs_v2_account');
    });
    listSpy.mockRestore();
    settingsSpy.mockRestore();
  });

  it('permission-gates provider credential write actions without firing backend mutations', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CredentialsModule />, { capabilities: ['provider_auth.read'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    expect(await screen.findByRole('button', { name: /New credential/i })).toBeDisabled();
    expect(
      await screen.findByRole('button', { name: /Set delivery API account|Update delivery API account/i }),
    ).toBeDisabled();

    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);

    const editOption = await screen.findByRole('option', { name: /^Edit credential/ });
    const rotateOption = await screen.findByRole('option', { name: /^Rotate/ });
    const historyOption = await screen.findByRole('option', { name: /^View rotation history/ });
    const revokeOption = await screen.findByRole('option', { name: /^Revoke/ });
    expect(editOption).toHaveClass('is-disabled');
    expect(rotateOption).toHaveClass('is-disabled');
    expect(historyOption).not.toHaveClass('is-disabled');
    expect(revokeOption).toHaveClass('is-disabled');

    await user.click(editOption);
    await user.click(rotateOption);
    await user.click(revokeOption);
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(rotateSpy).not.toHaveBeenCalled();
    expect(revokeSpy).not.toHaveBeenCalled();
    expect(bindProviderAccountSpy).not.toHaveBeenCalled();
  });

  it('scopes credential directory/provider reads to the active tenant lens without raw credential listing', async () => {
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1');
    renderWithProviders(<CredentialsModule />, {
      identity: {
        capabilities: ['all'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: { tenant: { id: 'org_swift', label: 'Swift Express KSA', rank: 2 } },
      },
    });

    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith(
        'providers',
        expect.objectContaining({ filter: { organization_id: 'org_swift' } }),
      );
      expect(listSpy).toHaveBeenCalledWith(
        'integration_credential_directory',
        expect.objectContaining({ filter: { organization_id: 'org_swift' } }),
      );
      expect(listSpy.mock.calls.some(([resource]) => resource === 'provider_auth_configs')).toBe(false);
    });
    listSpy.mockRestore();
  });

  it('keeps generic credential resource reads browser-safe and redacted', async () => {
    const list = await apiMod.ui_list_resource_v1<Record<string, unknown>>('provider_auth_configs', {
      page_size: 5,
    });
    expect(list.rows.length).toBeGreaterThan(0);
    for (const row of list.rows) {
      expect(row).not.toHaveProperty('credentials');
      expect(row).not.toHaveProperty('credentials_vault_id');
      expect(row).toHaveProperty('provider_label');
    }

    const detail = await apiMod.ui_get_resource_v1<Record<string, unknown>>(
      'provider_auth_configs',
      String(list.rows[0]!.id),
    );
    expect(detail).toBeTruthy();
    expect(detail).not.toHaveProperty('credentials');
    expect(detail).not.toHaveProperty('credentials_vault_id');
    expect(detail).toHaveProperty('provider_label');
  });

  it('uses credential directory provider labels in rotation history when the provider catalog row is absent', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      ((resource: string, opts?: unknown) => {
        if (resource === 'providers') {
          return Promise.resolve({ rows: [], total: 0, page: 0, page_size: 100 });
        }
        if (resource === 'integration_credential_directory') {
          return Promise.resolve({
            rows: [
              {
                id: 'auth_cfg_directory_label_only',
                organization_id: 'org_launch',
                provider_id: 'prv_missing_from_catalog',
                provider_label: 'Friendly Backend Provider',
                provider_kind: 'api',
                provider_vendor: 'logestechs',
                auth_type: 'api_key',
                status: 'active',
                is_active: true,
                is_expiring: false,
                is_expired: false,
                days_until_expiry: 90,
                created_at: '2026-05-10T08:00:00.000Z',
                last_rotated_at: '2026-05-10T08:00:00.000Z',
              },
            ],
            total: 1,
            page: 0,
            page_size: 100,
          });
        }
        return realList(resource, opts as never);
      }) as typeof apiMod.ui_list_resource_v1,
    );

    try {
      renderWithProviders(<CredentialsModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
      });

      const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
      await user.click(kebabs[0]!);
      await user.click(await screen.findByRole('option', { name: /^View rotation history/ }));

      expect(await screen.findByRole('heading', { name: /Friendly Backend Provider .* rotation history/i }))
        .toBeInTheDocument();
      expect(screen.getAllByText('Friendly Backend Provider').length).toBeGreaterThan(0);
      expect(screen.queryByText('prv_missing_from_catalog')).not.toBeInTheDocument();
    } finally {
      listSpy.mockRestore();
    }
  });

  it('renders revoked credential directory status distinctly and locks terminal row actions', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      ((resource: string, opts?: unknown) => {
        if (resource === 'providers') {
          return Promise.resolve({
            rows: [
              {
                id: 'prv_revoked_status',
                organization_id: 'org_launch',
                name: 'Revoked Status Provider',
                provider_type: 'webhook',
                enabled: true,
                priority_rank: 10,
                health_status: 'healthy',
                metadata: {},
              },
            ],
            total: 1,
            page: 0,
            page_size: 100,
          });
        }
        if (resource === 'integration_credential_directory') {
          return Promise.resolve({
            rows: [
              {
                id: 'auth_cfg_revoked_status',
                organization_id: 'org_launch',
                provider_id: 'prv_revoked_status',
                provider_label: 'Revoked Status Provider',
                provider_kind: 'webhook',
                auth_type: 'api_key',
                status: 'revoked',
                is_active: false,
                is_expiring: false,
                is_expired: false,
                days_until_expiry: 0,
                created_at: '2026-05-10T08:00:00.000Z',
                last_rotated_at: '2026-05-10T08:00:00.000Z',
                expires_at: '2026-05-11T08:37:00.000Z',
              },
            ],
            total: 1,
            page: 0,
            page_size: 100,
          });
        }
        return realList(resource, opts as never);
      }) as typeof apiMod.ui_list_resource_v1,
    );

    try {
      renderWithProviders(<CredentialsModule />, { capabilities: ['all'] });
      await waitFor(() => {
        expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
      });

      expect(await screen.findByText('Revoked')).toBeInTheDocument();
      expect(screen.queryByText('Expired')).not.toBeInTheDocument();

      const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
      await user.click(kebabs[0]!);
      expect(screen.queryByRole('option', { name: /^Edit credential/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('option', { name: /^Rotate/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('option', { name: /^Revoke/ })).not.toBeInTheDocument();
      await user.click(await screen.findByRole('option', { name: /^View rotation history/ }));

      expect(await screen.findByText('Revoked credential - provider operations disabled')).toBeInTheDocument();
      expect(screen.queryByText(/Active credential/i)).not.toBeInTheDocument();
    } finally {
      listSpy.mockRestore();
    }
  });

  it('surfaces readiness bootstrap when a tenant has no provider catalog', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/integrations/credentials');
    renderWithProviders(<CredentialsModule />, {
      identity: {
        capabilities: ['all'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: { tenant: { id: 'org_swift', label: 'Swift Express KSA', rank: 2 } },
      },
    });

    expect(await screen.findByText('Provider catalog needs onboarding')).toBeInTheDocument();
    const create = await screen.findByRole('button', { name: /New credential/i });
    expect(create).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Open setup/i }));
    expect(window.location.pathname).toBe('/platform/onboarding-readiness');
    expect(window.location.search).toContain('scope_type=tenant');
    expect(window.location.search).toContain('scope_id=org_swift');
  });

  it('Rotate row action collects replacement material before integration_plugin_rotate_credentials_v1 (Phase C5)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CredentialsModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const rotate = await screen.findByRole('option', { name: /^Rotate/ });
    await user.click(rotate);
    const form = await screen.findByTestId('provider-auth-config-rotate-form');
    expect(form).toBeInTheDocument();
    expect(rotateSpy).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Replacement credential details/i), {
      target: { value: '{"api_key":"rotated-unit-test"}' },
    });
    fireEvent.change(screen.getByLabelText(/Rotation reason/i), {
      target: { value: 'scheduled rotation' },
    });
    await user.click(screen.getByRole('button', { name: /^Rotate credential$/ }));

    await waitFor(() => {
      expect(rotateSpy).toHaveBeenCalled();
    });
    const args = rotateSpy.mock.calls[0]?.[0] as {
      config_id?: string;
      auth_type?: string;
      credentials?: unknown;
      reason?: string;
    } | undefined;
    expect(args?.config_id).toBeTruthy();
    expect(args?.auth_type).toBeTruthy();
    expect(args?.credentials).toEqual({ api_key: 'rotated-unit-test' });
    expect(args?.reason).toBe('scheduled rotation');
  });

  it('Revoke row action requires reason before ui_revoke_provider_auth_config_v1 (Phase C5)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CredentialsModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const revoke = await screen.findByRole('option', { name: /^Revoke/ });
    await user.click(revoke);
    expect(await screen.findByTestId('provider-auth-config-revoke-form')).toBeInTheDocument();
    expect(revokeSpy).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Revoke reason/i), {
      target: { value: 'credential replaced during readiness test' },
    });
    await user.click(screen.getByRole('button', { name: /^Revoke credential$/ }));

    await waitFor(() => {
      expect(revokeSpy).toHaveBeenCalled();
    });
    const args = revokeSpy.mock.calls[0]?.[0] as { config_id?: string; reason?: string } | undefined;
    expect(args?.config_id).toBeTruthy();
    expect(args?.reason).toBe('credential replaced during readiness test');
  });

  it('revokes a credential and shows the backend-readback revoked row without reload', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/integrations/credentials');
    const { listSpy } = mockCredentialDirectoryReadback();
    renderWithProviders(<CredentialsModule />, {
      identity: {
        capabilities: ['all'],
        user: {
          access_scope_type: 'tenant',
          access_scope_id: null,
          organization_id: 'org_launch',
        },
        scope: { tenant: { id: 'org_launch', label: 'Launch Tenant', rank: 2 } },
      },
    });

    await waitFor(() => expect(screen.getByText('auth_cfg_readback')).toBeInTheDocument());
    const readsBeforeMutation = listSpy.mock.calls.filter(
      ([resource]) => resource === 'integration_credential_directory',
    ).length;
    const row = screen.getByText('auth_cfg_readback').closest('tr');
    expect(row).not.toBeNull();
    await user.click(within(row as HTMLTableRowElement).getByRole('button', { name: /Row actions/ }));
    await user.click(await screen.findByRole('option', { name: /^Revoke/ }));
    fireEvent.change(screen.getByLabelText(/Revoke reason/i), {
      target: { value: 'credential replaced during readiness test' },
    });
    await user.click(screen.getByRole('button', { name: /^Revoke credential$/ }));

    await waitFor(() => {
      const updatedRow = screen.getByText('auth_cfg_readback').closest('tr');
      expect(updatedRow).not.toBeNull();
      expect(within(updatedRow as HTMLTableRowElement).getByText('Revoked')).toBeInTheDocument();
    });
    expect(revokeSpy).toHaveBeenCalledWith({
      config_id: 'auth_cfg_readback',
      reason: 'credential replaced during readiness test',
    });
    expect(listSpy.mock.calls.filter(([resource]) => resource === 'integration_credential_directory').length)
      .toBeGreaterThan(readsBeforeMutation);
    expect(screen.queryByTestId('provider-auth-config-revoke-form')).toBeNull();
    expect(window.location.pathname).toBe('/integrations/credentials');
  });

  it('rotates a credential and shows backend-readback rotation metadata without reload', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/integrations/credentials');
    const { listSpy } = mockCredentialDirectoryReadback();
    renderWithProviders(<CredentialsModule />, {
      identity: {
        capabilities: ['all'],
        user: {
          access_scope_type: 'tenant',
          access_scope_id: null,
          organization_id: 'org_launch',
        },
        scope: { tenant: { id: 'org_launch', label: 'Launch Tenant', rank: 2 } },
      },
    });

    await waitFor(() => expect(screen.getByText('auth_cfg_readback')).toBeInTheDocument());
    const readsBeforeMutation = listSpy.mock.calls.filter(
      ([resource]) => resource === 'integration_credential_directory',
    ).length;
    const row = screen.getByText('auth_cfg_readback').closest('tr') as HTMLTableRowElement;
    expect(within(row).getByText('90')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: /Row actions/ }));
    await user.click(await screen.findByRole('option', { name: /^Rotate/ }));
    fireEvent.change(screen.getByLabelText(/Replacement credential details/i), {
      target: { value: '{"api_key":"rotated-readback-secret"}' },
    });
    fireEvent.change(screen.getByLabelText(/Rotation reason/i), {
      target: { value: 'scheduled first tenant rotation' },
    });
    await user.click(screen.getByRole('button', { name: /^Rotate credential$/ }));

    await waitFor(() => {
      const updatedRow = screen.getByText('auth_cfg_readback').closest('tr') as HTMLTableRowElement;
      expect(within(updatedRow).getByText('140')).toBeInTheDocument();
    });
    expect(rotateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        config_id: 'auth_cfg_readback',
        auth_type: 'api_key',
        credentials: { api_key: 'rotated-readback-secret' },
        reason: 'scheduled first tenant rotation',
      }),
    );
    expect(listSpy.mock.calls.filter(([resource]) => resource === 'integration_credential_directory').length)
      .toBeGreaterThan(readsBeforeMutation);
    expect(screen.queryByTestId('provider-auth-config-rotate-form')).toBeNull();
    expect(window.location.pathname).toBe('/integrations/credentials');
  });

  it('New credential action fires ui_upsert_provider_auth_config_v1 create', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CredentialsModule />, { capabilities: ['all'] });
    const create = await screen.findByRole('button', { name: /New credential/i });
    await user.click(create);

    const form = await screen.findByTestId('provider-auth-config-form');
    expect(form).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Credential details/i), { target: { value: '{"api_key":"unit-test"}' } });
    await user.click(screen.getByRole('button', { name: /Save credential/i }));

    await waitFor(() => {
      expect(upsertSpy).toHaveBeenCalled();
    });
    const args = upsertSpy.mock.calls[0]?.[0] as { provider_id?: string; auth_type?: string; credentials?: unknown } | undefined;
    expect(args?.provider_id).toBeTruthy();
    expect(args?.auth_type).toBeTruthy();
    expect(args?.credentials).toEqual({ api_key: 'unit-test' });
  });

  it('creates a credential and shows the backend-readback row without reload', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/integrations/credentials');
    const { listSpy } = mockCredentialDirectoryReadback();
    renderWithProviders(<CredentialsModule />, {
      identity: {
        capabilities: ['all'],
        user: {
          access_scope_type: 'tenant',
          access_scope_id: null,
          organization_id: 'org_launch',
        },
        scope: { tenant: { id: 'org_launch', label: 'Launch Tenant', rank: 2 } },
      },
    });

    await waitFor(() => expect(credentialTableRows().length).toBeGreaterThan(0));
    const readsBeforeMutation = listSpy.mock.calls.filter(
      ([resource]) => resource === 'integration_credential_directory',
    ).length;
    await user.click(await screen.findByRole('button', { name: /New credential/i }));
    await screen.findByTestId('provider-auth-config-form');
    fireEvent.change(screen.getByLabelText(/Credential details/i), {
      target: { value: '{"api_key":"created-readback-secret"}' },
    });
    await user.click(screen.getByRole('button', { name: /Save credential/i }));

    expect(await screen.findByText('auth_cfg_created_readback')).toBeInTheDocument();
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider_id: 'prv_readback',
        auth_type: 'api_key',
        credentials: { api_key: 'created-readback-secret' },
      }),
    );
    expect(listSpy.mock.calls.filter(([resource]) => resource === 'integration_credential_directory').length)
      .toBeGreaterThan(readsBeforeMutation);
    expect(screen.queryByTestId('provider-auth-config-form')).toBeNull();
    expect(window.location.pathname).toBe('/integrations/credentials');
  });

  it('creates an expired credential and shows the backend-readback expired row without reload', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/integrations/credentials');
    const { listSpy } = mockCredentialDirectoryReadback();
    renderWithProviders(<CredentialsModule />, {
      identity: {
        capabilities: ['all'],
        user: {
          access_scope_type: 'tenant',
          access_scope_id: null,
          organization_id: 'org_launch',
        },
        scope: { tenant: { id: 'org_launch', label: 'Launch Tenant', rank: 2 } },
      },
    });

    await waitFor(() => expect(credentialTableRows().length).toBeGreaterThan(0));
    const readsBeforeMutation = listSpy.mock.calls.filter(
      ([resource]) => resource === 'integration_credential_directory',
    ).length;
    await user.click(await screen.findByRole('button', { name: /New credential/i }));
    await screen.findByTestId('provider-auth-config-form');
    fireEvent.change(screen.getByLabelText(/Credential details/i), {
      target: { value: '{"api_key":"expired-readback-secret"}' },
    });
    fireEvent.change(screen.getByLabelText(/Expires at/i), {
      target: { value: '2026-05-14T01:00' },
    });
    await user.click(screen.getByRole('button', { name: /Save credential/i }));

    const createdRow = await screen.findByText('auth_cfg_created_readback');
    const tableRow = createdRow.closest('tr');
    expect(tableRow).toBeTruthy();
    expect(within(tableRow as HTMLTableRowElement).getByText('Expired')).toBeInTheDocument();
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider_id: 'prv_readback',
        auth_type: 'api_key',
        credentials: { api_key: 'expired-readback-secret' },
        expires_at: expect.any(String),
      }),
    );
    expect(listSpy.mock.calls.filter(([resource]) => resource === 'integration_credential_directory').length)
      .toBeGreaterThan(readsBeforeMutation);
    expect(screen.queryByTestId('provider-auth-config-form')).toBeNull();
    expect(window.location.pathname).toBe('/integrations/credentials');
  });

  it('binds the delivery API provider account through the backend RPC', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CredentialsModule />, {
      identity: {
        capabilities: ['all'],
        user: {
          access_scope_type: 'tenant',
          access_scope_id: null,
          organization_id: 'org_launch',
        },
        scope: { tenant: { id: 'org_launch', label: 'Launch Tenant', rank: 2 } },
      },
    });

    expect(await screen.findByTestId('delivery-api-account-status')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /Set delivery API account|Update delivery API account/i }));

    const form = await screen.findByTestId('provider-account-binding-form');
    expect(form).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Company ID/i), { target: { value: vendorAccount.companyId } });
    fireEvent.change(screen.getByLabelText(/Basic Auth credentials/i), {
      target: { value: '{"username":"unit-api-user","password":"unit-api-pass"}' },
    });
    fireEvent.change(screen.getByLabelText(/Change reason/i), {
      target: { value: 'first tenant API shipment intake setup' },
    });
    await user.click(screen.getByRole('button', { name: /Bind delivery API account/i }));

    await waitFor(() => {
      expect(bindProviderAccountSpy).toHaveBeenCalled();
    });
    const args = bindProviderAccountSpy.mock.calls[0]?.[0] as {
      route_id?: string;
      route_method?: string;
      route_path?: string;
      organization_id?: string;
      scope_type?: string;
      company_id?: string;
      auth_type?: string;
      provider_account_category?: string;
      credentials?: unknown;
      reason?: string;
    } | undefined;
    expect(args).toEqual(expect.objectContaining({
      route_id: 'rt_logestechs_ship_request_by_email',
      route_method: 'POST',
      route_path: '/api/ship/request/by-email',
      organization_id: 'org_launch',
      scope_type: 'tenant',
      company_id: vendorAccount.companyId,
      auth_type: 'basic_auth',
      provider_account_category: 'logestechs_v2_account',
      reason: 'first tenant API shipment intake setup',
    }));
    expect(args?.credentials).toEqual({ username: 'unit-api-user', password: 'unit-api-pass' });
  });

  it('binds the delivery API account and shows backend-readback account status without reload', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/integrations/credentials');
    let boundAuthConfigId = '';
    let boundCompanyId = '';
    let credentials: Array<Record<string, unknown>> = [];
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource, opts) => {
        if (resource === 'providers') {
          return {
            rows: [
              {
                id: 'prv_delivery_account',
                organization_id: 'org_launch',
                name: 'Delivery Account Provider',
                provider_type: 'api',
                enabled: true,
                priority_rank: 10,
                health_status: 'healthy',
                metadata: { vendor: 'logestechs' },
              },
            ],
            total: 1,
          } as ListResult<unknown>;
        }
        if (resource === 'lookup_values') {
          return {
            rows: [
              { value: 'api_key', label: 'API key', rank: 10, is_default: true },
              { value: 'basic_auth', label: 'Basic Auth', rank: 20 },
            ],
            total: 2,
          } as ListResult<unknown>;
        }
        if (resource === 'api_routes') {
          return {
            rows: [
              {
                id: 'rt_delivery_ship_create',
                route_name: 'Delivery shipment create',
                method: 'POST',
                path_template: '/api/ship/request/by-email',
                enabled: true,
                provider_id: 'prv_delivery_account',
                policy: {
                  provider_account: {
                    category: 'logestechs_v2_account',
                    required: true,
                    require_company_id: true,
                  },
                  auth: { auth_type: 'basic_auth' },
                },
              },
            ],
            total: 1,
          } as ListResult<unknown>;
        }
        if (resource === 'integration_credential_directory') {
          return { rows: credentials.map((row) => ({ ...row })), total: credentials.length } as ListResult<unknown>;
        }
        return realList(resource, opts);
      },
    );
    const resolveSpy = vi.spyOn(apiMod, 'resolveSettings').mockImplementation(async (category) => {
      if (category === 'provider_credential_policy') {
        return {
          value: { expiring_days_threshold: 30, danger_days_threshold: 7 },
          settings_id: 'settings_provider_credential_policy',
          settings_version_id: 'settings_version_provider_credential_policy',
          scope_type: 'global',
          scope_id: null,
          settings_resolution_id: 'srlv_provider_credential_policy',
        } as never;
      }
      if (category === 'logestechs_v2_account') {
        return {
          value: {
            company_id: boundCompanyId || null,
            auth_config_id: boundAuthConfigId || null,
          },
          settings_id: 'settings_logestechs_v2_account',
          settings_version_id: 'settings_version_logestechs_v2_account',
          scope_type: 'tenant',
          scope_id: 'org_launch',
          settings_resolution_id: 'srlv_logestechs_v2_account',
        } as never;
      }
      return {
        value: {},
        settings_id: `settings_${category}`,
        settings_version_id: `settings_version_${category}`,
        scope_type: 'global',
        scope_id: null,
        settings_resolution_id: `srlv_${category}`,
      } as never;
    });
    bindProviderAccountSpy.mockImplementation(async (args) => {
      boundAuthConfigId = 'auth_cfg_delivery_bound';
      boundCompanyId = String(args.company_id ?? '');
      credentials = [
        {
          id: boundAuthConfigId,
          organization_id: 'org_launch',
          provider_id: 'prv_delivery_account',
          provider_label: 'Delivery Account Provider',
          provider_kind: 'api',
          provider_vendor: 'logestechs',
          auth_type: String(args.auth_type ?? 'basic_auth'),
          status: 'active',
          is_active: true,
          is_expiring: false,
          is_expired: false,
          days_until_expiry: 180,
          created_at: '2026-05-13T07:20:00.000Z',
          last_rotated_at: '2026-05-13T07:20:00.000Z',
        },
      ];
      return { ok: true, provider_auth_config_id: boundAuthConfigId };
    });

    try {
      renderWithProviders(<CredentialsModule />, {
        identity: {
          capabilities: ['all'],
          user: {
            access_scope_type: 'tenant',
            access_scope_id: null,
            organization_id: 'org_launch',
          },
          scope: { tenant: { id: 'org_launch', label: 'Launch Tenant', rank: 2 } },
        },
      });

      const status = await screen.findByTestId('delivery-api-account-status');
      expect(within(status).getByText('Credential missing')).toBeInTheDocument();
      await user.click(within(status).getByRole('button', { name: /Set account/i }));
      await screen.findByTestId('provider-account-binding-form');
      fireEvent.change(screen.getByLabelText(/Company ID/i), { target: { value: vendorAccount.companyId } });
      fireEvent.change(screen.getByLabelText(/Basic Auth credentials/i), {
        target: { value: '{"username":"unit-api-user","password":"unit-api-pass"}' },
      });
      fireEvent.change(screen.getByLabelText(/Change reason/i), {
        target: { value: 'first tenant API shipment intake setup' },
      });
      await user.click(screen.getByRole('button', { name: /Bind delivery API account/i }));

      await waitFor(() => {
        const updatedStatus = screen.getByTestId('delivery-api-account-status');
        expect(within(updatedStatus).getByText('Credential bound')).toBeInTheDocument();
        expect(within(updatedStatus).getByText('Company account linked')).toBeInTheDocument();
        expect(within(updatedStatus).getByText('Delivery Account Provider')).toBeInTheDocument();
        expect(within(updatedStatus).getByText('Active')).toBeInTheDocument();
        expect(within(updatedStatus).getByText('Credential selected')).toBeInTheDocument();
      });
      expect(bindProviderAccountSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          route_id: 'rt_delivery_ship_create',
          route_method: 'POST',
          route_path: '/api/ship/request/by-email',
          provider_account_category: 'logestechs_v2_account',
          organization_id: 'org_launch',
          scope_type: 'tenant',
          company_id: vendorAccount.companyId,
          auth_type: 'basic_auth',
          credentials: { username: 'unit-api-user', password: 'unit-api-pass' },
          reason: 'first tenant API shipment intake setup',
        }),
      );
      expect(screen.queryByTestId('provider-account-binding-form')).toBeNull();
      expect(window.location.pathname).toBe('/integrations/credentials');
    } finally {
      resolveSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('unbinds the delivery API account and shows backend-readback missing status without reload', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/integrations/credentials');
    let boundAuthConfigId = 'auth_cfg_delivery_bound';
    let boundCompanyId = vendorAccount.companyId;
    const credentials: Array<Record<string, unknown>> = [
      {
        id: 'auth_cfg_delivery_bound',
        organization_id: 'org_launch',
        provider_id: 'prv_delivery_account',
        provider_label: 'Delivery Account Provider',
        provider_kind: 'api',
        provider_vendor: 'logestechs',
        auth_type: 'basic_auth',
        status: 'active',
        is_active: true,
        is_expiring: false,
        is_expired: false,
        days_until_expiry: 180,
        created_at: '2026-05-13T07:20:00.000Z',
        last_rotated_at: '2026-05-13T07:20:00.000Z',
      },
    ];
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource, opts) => {
        if (resource === 'providers') {
          return {
            rows: [
              {
                id: 'prv_delivery_account',
                organization_id: 'org_launch',
                name: 'Delivery Account Provider',
                provider_type: 'api',
                enabled: true,
                priority_rank: 10,
                health_status: 'healthy',
                metadata: { vendor: 'logestechs' },
              },
            ],
            total: 1,
          } as ListResult<unknown>;
        }
        if (resource === 'lookup_values') {
          return {
            rows: [
              { value: 'api_key', label: 'API key', rank: 10, is_default: true },
              { value: 'basic_auth', label: 'Basic Auth', rank: 20 },
            ],
            total: 2,
          } as ListResult<unknown>;
        }
        if (resource === 'api_routes') {
          return {
            rows: [
              {
                id: 'rt_delivery_ship_create',
                route_name: 'Delivery shipment create',
                method: 'POST',
                path_template: '/api/ship/request/by-email',
                enabled: true,
                provider_id: 'prv_delivery_account',
                policy: {
                  provider_account: {
                    category: 'logestechs_v2_account',
                    required: true,
                    require_company_id: true,
                  },
                  auth: { auth_type: 'basic_auth' },
                },
              },
            ],
            total: 1,
          } as ListResult<unknown>;
        }
        if (resource === 'integration_credential_directory') {
          return { rows: credentials.map((row) => ({ ...row })), total: credentials.length } as ListResult<unknown>;
        }
        return realList(resource, opts);
      },
    );
    const resolveSpy = vi.spyOn(apiMod, 'resolveSettings').mockImplementation(async (category) => {
      if (category === 'provider_credential_policy') {
        return {
          value: { expiring_days_threshold: 30, danger_days_threshold: 7 },
          settings_id: 'settings_provider_credential_policy',
          settings_version_id: 'settings_version_provider_credential_policy',
          scope_type: 'global',
          scope_id: null,
          settings_resolution_id: 'srlv_provider_credential_policy',
        } as never;
      }
      if (category === 'logestechs_v2_account') {
        return {
          value: {
            enabled: Boolean(boundAuthConfigId),
            company_id: boundCompanyId || null,
            auth_config_id: boundAuthConfigId || null,
          },
          settings_id: 'settings_logestechs_v2_account',
          settings_version_id: 'settings_version_logestechs_v2_account',
          scope_type: 'tenant',
          scope_id: 'org_launch',
          settings_resolution_id: 'srlv_logestechs_v2_account',
        } as never;
      }
      return {
        value: {},
        settings_id: `settings_${category}`,
        settings_version_id: `settings_version_${category}`,
        scope_type: 'global',
        scope_id: null,
        settings_resolution_id: `srlv_${category}`,
      } as never;
    });
    unbindProviderAccountSpy.mockImplementation(async (args) => {
      boundCompanyId = String(args.company_id ?? boundCompanyId);
      boundAuthConfigId = '';
      return { ok: true, bound: false, auth_config_id: null };
    });

    try {
      renderWithProviders(<CredentialsModule />, {
        identity: {
          capabilities: ['all'],
          user: {
            access_scope_type: 'tenant',
            access_scope_id: null,
            organization_id: 'org_launch',
          },
          scope: { tenant: { id: 'org_launch', label: 'Launch Tenant', rank: 2 } },
        },
      });

      const status = await screen.findByTestId('delivery-api-account-status');
      expect(within(status).getByText('Credential bound')).toBeInTheDocument();
      expect(within(status).getByText('Credential selected')).toBeInTheDocument();
      await user.click(within(status).getByRole('button', { name: /Unbind account/i }));
      await screen.findByTestId('provider-account-unbind-form');
      fireEvent.change(screen.getByLabelText(/Unbind reason/i), {
        target: { value: 'readiness lifecycle unbind proof' },
      });
      await user.click(screen.getByRole('button', { name: /Unbind delivery API account/i }));

      await waitFor(() => {
        const updatedStatus = screen.getByTestId('delivery-api-account-status');
        expect(within(updatedStatus).getByText('Credential missing')).toBeInTheDocument();
        expect(within(updatedStatus).getByText('Company account linked')).toBeInTheDocument();
        expect(within(updatedStatus).queryByText('Credential selected')).toBeNull();
      });
      expect(unbindProviderAccountSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          route_id: 'rt_delivery_ship_create',
          route_method: 'POST',
          route_path: '/api/ship/request/by-email',
          provider_account_category: 'logestechs_v2_account',
          organization_id: 'org_launch',
          scope_type: 'tenant',
          company_id: vendorAccount.companyId,
          reason: 'readiness lifecycle unbind proof',
        }),
      );
      expect(screen.queryByTestId('provider-account-unbind-form')).toBeNull();
      expect(window.location.pathname).toBe('/integrations/credentials');
    } finally {
      resolveSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it('defaults the delivery API account to the shipment create route when update routes sort first', async () => {
    const user = userEvent.setup();
    const originalList = apiMod.ui_list_resource_v1;
    bindProviderAccountSpy.mockResolvedValue({ ok: true } as never);
    const providerAccountPolicy = {
      provider_account: {
        category: 'logestechs_v2_account',
        required: true,
        require_company_id: true,
      },
      auth: { auth_type: 'basic_auth' },
    };
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource, opts) => {
        if (resource === 'api_routes') {
          return {
            rows: [
              {
                id: 'rt_logestechs_package_update',
                route_name: 'Logestechs package update',
                method: 'PUT',
                path_template: '/api/guests/{companyId}/packages/{shipmentId}',
                enabled: true,
                provider_id: 'prv_exampledepot',
                policy: providerAccountPolicy,
              },
              {
                id: 'rt_logestechs_ship_request_by_email',
                route_name: 'Logestechs shipment create by email',
                method: 'POST',
                path_template: '/api/ship/request/by-email',
                enabled: true,
                provider_id: 'prv_exampledepot',
                policy: providerAccountPolicy,
              },
            ],
            total: 2,
            page: 0,
            page_size: 100,
          } as never;
        }
        return originalList(resource, opts) as never;
      },
    );

    try {
      renderWithProviders(<CredentialsModule />, {
        identity: {
          capabilities: ['all'],
          user: {
            access_scope_type: 'tenant',
            access_scope_id: null,
            organization_id: 'org_launch',
          },
          scope: { tenant: { id: 'org_launch', label: 'Launch Tenant', rank: 2 } },
        },
      });

      expect(await screen.findByTestId('delivery-api-account-status')).toBeInTheDocument();
      expect(await screen.findByText('POST /api/ship/request/by-email')).toBeInTheDocument();
      await user.click(await screen.findByRole('button', { name: /Set delivery API account|Update delivery API account/i }));

      await screen.findByTestId('provider-account-binding-form');
      fireEvent.change(screen.getByLabelText(/Company ID/i), { target: { value: vendorAccount.companyId } });
      fireEvent.change(screen.getByLabelText(/Basic Auth credentials/i), {
        target: { value: '{"username":"unit-api-user","password":"unit-api-pass"}' },
      });
      fireEvent.change(screen.getByLabelText(/Change reason/i), {
        target: { value: 'first tenant API shipment intake setup' },
      });
      await user.click(screen.getByRole('button', { name: /Bind delivery API account/i }));

      await waitFor(() => {
        expect(bindProviderAccountSpy).toHaveBeenCalled();
      });
      const args = bindProviderAccountSpy.mock.calls[0]?.[0] as {
        route_id?: string;
        route_method?: string;
        route_path?: string;
        provider_account_category?: string;
      } | undefined;
      expect(args).toEqual(expect.objectContaining({
        route_id: 'rt_logestechs_ship_request_by_email',
        route_method: 'POST',
        route_path: '/api/ship/request/by-email',
        provider_account_category: 'logestechs_v2_account',
      }));
    } finally {
      listSpy.mockRestore();
    }
  });

  it('passes the selected API route provider-account category into the binding RPC', async () => {
    const user = userEvent.setup();
    const originalList = apiMod.ui_list_resource_v1;
    bindProviderAccountSpy.mockResolvedValue({ ok: true } as never);
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource, opts) => {
        if (resource === 'api_routes') {
          return {
            rows: [
              {
                id: 'rt_custom_ship_create',
                route_name: 'Custom shipment create',
                method: 'POST',
                path_template: '/api/custom/shipments',
                enabled: true,
                provider_id: 'prv_exampledepot',
                policy: {
                  provider_account: {
                    category: 'custom_delivery_account',
                    required: true,
                    require_company_id: true,
                  },
                  auth: { auth_type: 'basic_auth' },
                },
              },
            ],
            total: 1,
            page: 0,
            page_size: 100,
          } as never;
        }
        return originalList(resource, opts) as never;
      },
    );

    try {
      renderWithProviders(<CredentialsModule />, {
        identity: {
          capabilities: ['all'],
          user: {
            access_scope_type: 'tenant',
            access_scope_id: null,
            organization_id: 'org_launch',
          },
          scope: { tenant: { id: 'org_launch', label: 'Launch Tenant', rank: 2 } },
        },
      });

      expect(await screen.findByText('POST /api/custom/shipments')).toBeInTheDocument();
      await user.click(await screen.findByRole('button', { name: /Set delivery API account|Update delivery API account/i }));

      await screen.findByTestId('provider-account-binding-form');
      fireEvent.change(screen.getByLabelText(/Company ID/i), { target: { value: `CUSTOM-${vendorAccount.companyId}` } });
      fireEvent.change(screen.getByLabelText(/Basic Auth credentials/i), {
        target: { value: '{"username":"custom-api-user","password":"custom-api-pass"}' },
      });
      await user.click(screen.getByRole('button', { name: /Bind delivery API account/i }));

      await waitFor(() => {
        expect(bindProviderAccountSpy).toHaveBeenCalled();
      });
      const args = bindProviderAccountSpy.mock.calls[0]?.[0] as {
        route_id?: string;
        route_path?: string;
        provider_account_category?: string;
        company_id?: string;
      } | undefined;
      expect(args).toEqual(expect.objectContaining({
        route_id: 'rt_custom_ship_create',
        route_path: '/api/custom/shipments',
        provider_account_category: 'custom_delivery_account',
        company_id: `CUSTOM-${vendorAccount.companyId}`,
      }));
    } finally {
      listSpy.mockRestore();
    }
  });

  it('keeps the account missing and surfaces backend registry failures for custom route categories', async () => {
    const user = userEvent.setup();
    const originalList = apiMod.ui_list_resource_v1;
    const toastSpy = vi.spyOn(toastStore, 'pushToast');
    bindProviderAccountSpy.mockRejectedValue(
      new Error('insert or update on table "settings" violates foreign key constraint "settings_category_fk"'),
    );
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      async (resource, opts) => {
        if (resource === 'api_routes') {
          return {
            rows: [
              {
                id: 'd3322c48-e7bb-47e0-ba2e-5fc82f992489',
                route_name: 'Provider credential binding proof 20260529050359',
                method: 'POST',
                path_template: '/api/first-tenant/provider-credential-binding-proof/20260529050359',
                enabled: true,
                provider_id: 'prv_delivery_proof',
                policy: {
                  provider_account: {
                    category: 'provider_credential_binding_proof_20260529050359',
                    required: true,
                    require_company_id: true,
                  },
                  auth: { auth_type: 'basic_auth' },
                },
              },
            ],
            total: 1,
            page: 0,
            page_size: 100,
          } as never;
        }
        return originalList(resource, opts) as never;
      },
    );

    try {
      renderWithProviders(<CredentialsModule />, {
        identity: {
          capabilities: ['all'],
          user: {
            access_scope_type: 'tenant',
            access_scope_id: null,
            organization_id: 'org_launch',
          },
          scope: { tenant: { id: 'org_launch', label: 'Launch Tenant', rank: 2 } },
        },
      });

      const status = await screen.findByTestId('delivery-api-account-status');
      expect(within(status).getByText('Credential missing')).toBeInTheDocument();
      expect(within(status).getByText('provider_credential_binding_proof_20260529050359')).toBeInTheDocument();
      await user.click(within(status).getByRole('button', { name: /Set account/i }));

      await screen.findByTestId('provider-account-binding-form');
      fireEvent.change(screen.getByLabelText(/Company ID/i), { target: { value: '736259291800' } });
      fireEvent.change(screen.getByLabelText(/Basic Auth credentials/i), {
        target: { value: '{"username":"proof-api-user","password":"proof-api-pass"}' },
      });
      fireEvent.change(screen.getByLabelText(/Change reason/i), {
        target: { value: 'ProviderAccountUnbindBindProof20260529' },
      });
      await user.click(screen.getByRole('button', { name: /Bind delivery API account/i }));

      await waitFor(() => {
        expect(bindProviderAccountSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            route_id: 'd3322c48-e7bb-47e0-ba2e-5fc82f992489',
            route_path: '/api/first-tenant/provider-credential-binding-proof/20260529050359',
            provider_account_category: 'provider_credential_binding_proof_20260529050359',
            company_id: '736259291800',
          }),
        );
        expect(toastSpy).toHaveBeenCalledWith(
          expect.stringContaining('settings_category_fk'),
          'danger',
        );
      });
      expect(within(screen.getByTestId('delivery-api-account-status')).getByText('Credential missing')).toBeInTheDocument();
    } finally {
      listSpy.mockRestore();
      toastSpy.mockRestore();
    }
  });

  it('does not call the delivery API binding RPC when Basic Auth is incomplete', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CredentialsModule />, { capabilities: ['all'] });

    await user.click(await screen.findByRole('button', { name: /Set delivery API account|Update delivery API account/i }));
    await screen.findByTestId('provider-account-binding-form');
    fireEvent.change(screen.getByLabelText(/Company ID/i), { target: { value: vendorAccount.companyId } });
    fireEvent.change(screen.getByLabelText(/Basic Auth credentials/i), {
      target: { value: '{"username":"unit-api-user"}' },
    });
    await user.click(screen.getByRole('button', { name: /Bind delivery API account/i }));

    await waitFor(() => {
      expect(bindProviderAccountSpy).not.toHaveBeenCalled();
    });
  });

  it('enables credential creation for a bootstrapped tenant provider catalog with no existing credentials', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    const listSpy = vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(
      ((resource: string, opts?: unknown) => {
        if (resource === 'providers') {
          return Promise.resolve({
            rows: [
              {
                id: 'prv_launch_webhook',
                organization_id: 'org_launch',
                name: 'Webhook intake provider',
                provider_type: 'webhook',
                enabled: true,
                priority_rank: 10,
                health_status: 'degraded',
                metadata: {
                  credential_state: 'pending',
                  onboarding: {
                    default_key: 'webhook-intake',
                    managed_by: 'bootstrap_tenant_provider_catalog_defaults_v1',
                  },
                },
              },
            ],
            total: 1,
            page: 0,
            page_size: 100,
          });
        }
        if (resource === 'integration_credential_directory') {
          return Promise.resolve({ rows: [], total: 0, page: 0, page_size: 100 });
        }
        return realList(resource, opts as never);
      }) as typeof apiMod.ui_list_resource_v1,
    );

    try {
      renderWithProviders(<CredentialsModule />, {
        identity: {
          capabilities: ['all'],
          user: {
            access_scope_type: 'tenant',
            access_scope_id: null,
            organization_id: 'org_launch',
          },
          scope: { tenant: { id: 'org_launch', label: 'Launch Tenant', rank: 2 } },
        },
      });

      const create = await screen.findByRole('button', { name: /New credential/i });
      await waitFor(() => expect(create).toBeEnabled());
      await user.click(create);

      expect(await screen.findByTestId('provider-auth-config-form')).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText(/Credential details/i), {
        target: { value: '{"api_key":"first-tenant-secret"}' },
      });
      await user.click(screen.getByRole('button', { name: /Save credential/i }));

      await waitFor(() => {
        expect(upsertSpy).toHaveBeenCalled();
      });
      const args = upsertSpy.mock.calls[0]?.[0] as {
        provider_id?: string;
        auth_type?: string;
        credentials?: unknown;
      } | undefined;
      expect(args?.provider_id).toBe('prv_launch_webhook');
      expect(args?.auth_type).toBeTruthy();
      expect(args?.credentials).toEqual({ api_key: 'first-tenant-secret' });
      expect(listSpy).toHaveBeenCalledWith(
        'providers',
        expect.objectContaining({ filter: { organization_id: 'org_launch' } }),
      );
    } finally {
      listSpy.mockRestore();
    }
  });

  it('Edit credential row action fires ui_upsert_provider_auth_config_v1 update', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CredentialsModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const edit = await screen.findByRole('option', { name: /^Edit credential/ });
    await user.click(edit);
    await screen.findByTestId('provider-auth-config-form');
    await user.click(screen.getByRole('button', { name: /Save credential/i }));

    await waitFor(() => {
      expect(upsertSpy).toHaveBeenCalled();
    });
    const args = upsertSpy.mock.calls[0]?.[0] as { config_id?: string } | undefined;
    expect(args?.config_id).toBeTruthy();
  });

  // W27 — paired projection consumption assertions. Module reads
  // `integration_credential_directory` so projection-derived Days-left column
  // and the operator-facing directory pill surface in the DOM.
  it('renders the credential health directory projection pill (W27)', async () => {
    renderWithProviders(<CredentialsModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(
        screen.getByText('Credential health directory'),
      ).toBeInTheDocument();
    });
  });

  it('renders the projection-derived Days-left column (W27)', async () => {
    renderWithProviders(<CredentialsModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table thead th').length).toBeGreaterThan(0);
    });
    const headerCells = Array.from(document.querySelectorAll('.dt__table thead th')).map((th) =>
      th.textContent?.trim() ?? '',
    );
    // W27 directory join surfaces a Days-left column powered by
    // v_integration_credential_directory.days_until_expiry.
    expect(headerCells.some((h) => /Days left/.test(h))).toBe(true);
  });
});
