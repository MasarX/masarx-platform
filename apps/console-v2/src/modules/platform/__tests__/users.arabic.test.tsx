// users.arabic.test.tsx: the users page renders its own copy in Arabic (issue #302).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { UsersModule } from '@/modules/platform/users';
import { englishT } from '@/lib/i18n';
import * as api from '@/lib/api';
import ar from '@/lib/seed-raw/i18n/areas/ar/platform-users';
import en from '@/lib/seed-raw/i18n/areas/en/platform-users';

// Copy moved into the catalog: each Arabic sentence is Latin-free and keeps the English placeholders.
const MOVED_KEYS = {
  inviteUserForm: ['unnamedClient', 'unnamedSender', 'statusTag', 'clientTag'],
  userSecurityActions: ['pendingTimestamp'],
  usersModule: [
    'userListCouldNotLoad', 'roleGrantedToast', 'roleRevokedToast', 'savedDataConfirmsSuspended',
    'savedDataConfirmsActive', 'inviteResendSaved', 'inviteDecisionSaved', 'usersSuspendedCount',
    'usersReactivatedCount', 'selectedUser',
  ],
} as const;

const TENANT_IDENTITY = {
  user: { access_scope_type: 'tenant', access_scope_id: null, organization_id: 'org_rashed' },
  scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
} as const;

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

describe('UsersModule in Arabic', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState(null, '', '/platform/users');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<UsersModule />, { locale: 'ar', identity: { capabilities: ['users.read'], ...TENANT_IDENTITY } });

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
    expect(lookup(ar, 'platformUsers.usersModule.titleAccent')).toMatch(/[؀-ۿ]/);
  });

  it('reads back a suspension in Arabic with the email isolated', async () => {
    let suspended = false;
    const realComplete = api.ui_list_resource_complete;
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
      const result = await realComplete(resource, opts);
      if (!suspended || (resource !== 'users' && resource !== 'user_directory')) return result;
      return {
        ...result,
        rows: result.rows.map((row) =>
          String((row as Record<string, unknown>).id) === 'usr_ops_admin_layla' ? { ...row, status: 'suspended' } : row,
        ),
      };
    });
    vi.spyOn(api, 'suspend_user_v1').mockImplementation(async () => {
      suspended = true;
      return { ok: true, target_user_id: 'usr_ops_admin_layla', status: 'suspended' };
    });
    const user = userEvent.setup();
    renderWithProviders(<UsersModule />, {
      locale: 'ar',
      identity: { capabilities: ['users.read', 'users.manage'], ...TENANT_IDENTITY },
    });
    await user.click((await screen.findByText(/Layla Bin Saeed/i)).closest('tr')!);
    const drawer = await screen.findByTestId('users-drawer');
    await user.click(within(drawer).getByRole('button', { name: ar.platformUsers.usersDrawerBody.suspend }));
    const confirm = await screen.findByTestId('users-suspend-confirm');
    await user.type(within(confirm).getByLabelText(ar.platformUsers.suspendUserConfirm.reason), 'synthetic');
    await user.click(within(confirm).getByRole('button', { name: ar.platformUsers.suspendUserConfirm.confirmSuspend }));

    const [before, after] = ar.platformUsers.usersModule.savedDataConfirmsSuspended.split('{email}');
    await waitFor(async () => {
      const readback = await screen.findByTestId('users-drawer-lifecycle-readback');
      expect(readback).toHaveTextContent(before!.trim());
      expect(readback).toHaveTextContent(after!.trim());
      expect(readback.querySelector('bdi')).not.toBeNull();
      expect(findUntranslated(readback)).toEqual([]);
    });
  });

  it('keeps every moved sentence Arabic, Latin-free and placeholder-aligned with English', () => {
    for (const [group, keys] of Object.entries(MOVED_KEYS)) {
      for (const key of keys) {
        const path = `platformUsers.${group}.${key}`;
        const arabic = String(lookup(ar, path));
        expect(arabic, path).toMatch(/[؀-ۿ]/);
        expect(arabic.replace(/\{\w+\}/g, ''), path).not.toMatch(/[A-Za-z]{2,}/);
        expect(placeholders(arabic), path).toEqual(placeholders(String(lookup(en, path))));
      }
    }
    expect(englishT('platformUsers.usersModule.savedDataConfirmsSuspended')).toBe('Saved data confirms {email} is suspended in this drawer.');
    expect(englishT('platformUsers.usersModule.roleGrantedToast')).toBe('grant_user_role_v1 - {email} - {role}');
  });
});
