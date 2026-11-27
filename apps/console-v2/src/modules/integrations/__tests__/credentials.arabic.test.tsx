// credentials.arabic.test.tsx: the credentials page renders its own copy in Arabic (issue #302).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { CredentialsModule } from '@/modules/integrations/credentials';
import * as apiMod from '@/lib/api';
import * as toastStore from '@/components/toastStore';
import { englishT, fill } from '@/lib/i18n';
import type { ListResult } from '@/types/domain';
import ar from '@/lib/seed-raw/i18n/areas/ar/integrations-credentials';
import arShell from '@/lib/seed-raw/i18n/areas/ar/shell';

const AR = ar.integrationsCredentials.credentialsModule;

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Toast messages are not in the rendered tree, so they are placed in an element for the shared check.
function toastBox(): HTMLElement {
  const box = document.createElement('div');
  for (const toast of toastStore.getToasts()) {
    const line = document.createElement('p');
    line.textContent = toast.message;
    box.append(line);
  }
  return box;
}

describe('CredentialsModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/integrations/credentials');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    toastStore.clearToasts();
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<CredentialsModule />, { locale: 'ar', capabilities: ['all'] });

    const [title] = await screen.findAllByText(ar.integrationsCredentials.credentialsModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.integrationsCredentials.credentialsModule.providerCredentialVault);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<CredentialsModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.integrationsCredentials.credentialsModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('integrationsCredentials.credentialsModule.titlePlain')).toBe('credentials');
    expect(englishT('integrationsCredentials.credentialsModule.rotateCredential')).toBe('Rotate credential');
    expect(lookup(ar, 'integrationsCredentials.credentialsModule.titleAccent')).toMatch(/[؀-ۿ]/);
  });

  it('explains the disabled New credential action in Arabic', async () => {
    renderWithProviders(<CredentialsModule />, {
      locale: 'ar',
      identity: {
        capabilities: ['all'],
        user: { access_scope_type: 'platform', access_scope_id: null, organization_id: 'org_rashed' },
        scope: { tenant: { id: 'org_swift', label: 'Swift Express KSA', rank: 2 } },
      },
    });

    const create = await screen.findByRole('button', { name: AR.newCredential });
    await waitFor(() => expect(create).toHaveAttribute('title', AR.completeProviderSetupFirst));
    expect(create).toBeDisabled();
    expect(findUntranslated(create)).toEqual([]);
  });

  it('explains the blocked provider account actions and shows editor toasts in Arabic', async () => {
    const user = userEvent.setup();
    const realList = apiMod.ui_list_resource_v1;
    vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource, opts) => {
      if (resource === 'api_routes') return { rows: [], total: 0 } as ListResult<unknown>;
      return realList(resource, opts);
    });
    const upsertSpy = vi.spyOn(apiMod, 'ui_upsert_provider_auth_config_v1').mockResolvedValue({
      ok: true,
      provider_auth_config_id: 'auth_cfg_arabic',
    } as never);
    renderWithProviders(<CredentialsModule />, { locale: 'ar', capabilities: ['all'] });

    const accountName = new RegExp(`^(${escapeRegExp(AR.setDeliveryApiAccount)}|${escapeRegExp(AR.updateDeliveryApiAccount)})$`);
    const [bind] = await screen.findAllByRole('button', { name: accountName });
    await waitFor(() => expect(bind).toHaveAttribute('title', AR.noProviderAccountRoute));
    expect(findUntranslated(bind!, ['API'])).toEqual([]);

    await user.click(await screen.findByRole('button', { name: AR.newCredential }));
    await screen.findByTestId('provider-auth-config-form');
    const details = screen.getByLabelText(new RegExp(escapeRegExp(AR.credentialDetails)));
    const save = screen.getByRole('button', { name: AR.saveCredential });

    fireEvent.change(details, { target: { value: '{' } });
    await user.click(save);
    await waitFor(() => {
      expect(toastStore.getToasts().map((toast) => toast.message)).toContain(
        fill(AR.credentialsJson, { value: AR.credentialDetailsAreInvalid }),
      );
    });

    fireEvent.change(details, { target: { value: '[1]' } });
    await user.click(save);
    await waitFor(() => {
      expect(toastStore.getToasts().map((toast) => toast.message)).toContain(
        fill(AR.credentialsJson, { value: AR.credentialDetailsMustBeObject }),
      );
    });
    expect(upsertSpy).not.toHaveBeenCalled();

    fireEvent.change(details, { target: { value: '{"api_key":"unit-test"}' } });
    await user.click(save);
    await waitFor(() => {
      expect(toastStore.getToasts().map((toast) => toast.message)).toContain(AR.credentialCreated);
    });
    expect(findUntranslated(toastBox())).toEqual([]);
    expect(toastStore.getToasts().some((toast) => toast.message.includes('unit-test'))).toBe(false);
  });

  it('titles the revoke dialog in Arabic', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CredentialsModule />, { locale: 'ar', capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBeGreaterThan(0);
    });

    const kebabs = await screen.findAllByRole('button', { name: arShell.shell.table.rowActions });
    await user.click(kebabs[0]!);
    const [revoke] = await screen.findAllByRole('option', { name: new RegExp(`^${escapeRegExp(AR.revoke)}`) });
    await user.click(revoke!);
    await screen.findByTestId('provider-auth-config-revoke-form');

    const title = document.querySelector('.modal__title') as HTMLElement;
    expect(title).toHaveTextContent(AR.revokeCredential);
    expect(findUntranslated(title)).toEqual([]);
  });

  it('keeps one whole sentence per credential state in both languages', () => {
    const box = document.createElement('div');
    box.textContent = [
      fill(AR.revokeCredentialsCount, { count: '2' }),
      AR.credentialUpdated,
      AR.authTypeLookupsMissing,
      AR.loadingRoutePolicy,
      AR.binding,
    ].join(' ');
    expect(findUntranslated(box)).toEqual([]);
    expect(AR.binding).toBe('جارٍ الربط');

    expect(englishT('integrationsCredentials.credentialsModule.revokeCredential')).toBe('Revoke credential');
    expect(fill(englishT('integrationsCredentials.credentialsModule.revokeCredentialsCount'), { count: '2' })).toBe('Revoke 2 credentials');
    expect(englishT('integrationsCredentials.credentialsModule.credentialUpdated')).toBe('Credential updated');
    expect(englishT('integrationsCredentials.credentialsModule.credentialCreated')).toBe('Credential created');
    expect(englishT('integrationsCredentials.credentialsModule.completeProviderSetupFirst')).toBe(
      'Complete tenant provider setup before creating credentials.',
    );
  });
});
