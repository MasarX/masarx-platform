// users.arabic.test.tsx: the users page renders its own copy in Arabic (issue #302).
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { UsersModule } from '@/modules/platform/users';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/platform-users';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('UsersModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/platform/users');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<UsersModule />, { locale: 'ar', identity: { capabilities: ['users.read'], user: { access_scope_type: 'tenant', access_scope_id: null, organization_id: 'org_rashed' }, scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } } } });

    const [title] = await screen.findAllByText(ar.platformUsers.usersModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.platformUsers.usersModule.totalUsers);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<UsersModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.platformUsers.usersModule.userManagementRequiresUser)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('platformUsers.usersModule.titlePlain')).toBe('management');
    expect(englishT('platformUsers.usersModule.inviteUser')).toBe('Invite user');
    expect(lookup(ar, 'platformUsers.usersModule.titleAccent')).toMatch(/[\u0600-\u06FF]/);
  });
});
