// organizations.arabic.test.tsx: the organizations page renders its own copy in Arabic (issue #302).
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { OrganizationsModule } from '@/modules/platform/organizations';
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/platform-organizations';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('OrganizationsModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/platform/organizations');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<OrganizationsModule />, { locale: 'ar', capabilities: ['organizations.read', 'tenant_signup_requests.read'] });

    const [title] = await screen.findAllByText(ar.platformOrganizations.organizationsModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.platformOrganizations.organizationsModule.tenantRegistrySignupQueue);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<OrganizationsModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.platformOrganizations.organizationsModule.tenantListRequiresOrganization)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('platformOrganizations.organizationsModule.titleAccent')).toBe('Organizations');
    expect(englishT('platformOrganizations.organizationsModule.tenants')).toBe('Tenants');
    expect(lookup(ar, 'platformOrganizations.organizationsModule.titleAccent')).toMatch(/[\u0600-\u06FF]/);
  });
});
