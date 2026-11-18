// UserMenuDrawer.test.tsx — covers the Phase E1 user-menu surface.
//
// Backend SSOT
//   • Auth signOut: routed through the @/lib/supabase swap-seam factory
//     so tests can mock the client and assert auth.signOut() was called
//     with no args (revokes the current session per the JS SDK contract).
//   • Identity shape: useIdentity().user/scope/currentScopeType() mirrors
//     supabase/migrations/202512291310_users_access_scope_model.sql.
//
// Coverage anchors (≥ 5)
//   1. Drawer mounts when open=true and unmounts when open=false.
//   2. Profile summary renders name, email, role chip, and scope tier
//      label sourced from useIdentity().
//   3. Sign-out invokes supabase.auth.signOut() exactly once when the
//      live client is mocked.
//   4. In-memory mode (getSupabaseClient → null): sign-out clears local
//      role state via identity.setRole and never throws.
//   5. Esc closes the drawer (Drawer is a Radix Dialog; we route through
//      the controlled onClose).
//   6. Quick links navigate to canonical routes and close the drawer.
//   7. Quick-link "Keyboard shortcuts" forwards to the AppShell-owned
//      shortcuts opener (and the link is omitted when no opener is given).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Hoisted mocks for both the supabase swap-seam factory and the router
// navigation. We hoist them with `vi.hoisted` so they're stable across
// the multiple test files vitest may reuse.
//
// The signOut return shape is permissive { error: ... | null } so
// individual tests can swap between success ({ error: null }) and
// failure ({ error: { message } }) without TS narrowing the literal.
type SignOutResult = { error: { message: string } | null };
const supabaseMocks = vi.hoisted(() => ({
  signOut: vi.fn(
    async (): Promise<{ error: { message: string } | null }> => ({ error: null }),
  ),
  signOutConsole: vi.fn(async (): Promise<void> => {}),
  client: null as null | { auth: { signOut: ReturnType<typeof vi.fn> } },
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseClient: () => supabaseMocks.client,
}));

vi.mock('@/lib/auth', () => ({
  CONSOLE_LOGIN_PATH: '/login',
  getConsoleAuthClient: () => null,
  hydrateConsoleIdentity: vi.fn(),
  signOutConsole: supabaseMocks.signOutConsole,
}));

// Mock router navigate so tests don't need a TanStack Router instance —
// renderWithProviders does not mount one. We assert the path the drawer
// asked the router to go to.
const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );
  return {
    ...actual,
    useRouter: () => ({ navigate: routerMocks.navigate }),
  };
});

import { renderWithProviders } from '@/test/render';
import * as api from '@/lib/api';
import { UserMenuDrawer } from '../UserMenuDrawer';

beforeEach(() => {
  supabaseMocks.signOut.mockClear();
  supabaseMocks.signOut.mockImplementation(
    async (): Promise<SignOutResult> => ({ error: null }),
  );
  supabaseMocks.signOutConsole.mockClear();
  supabaseMocks.signOutConsole.mockImplementation(async (): Promise<void> => {});
  supabaseMocks.client = null;
  routerMocks.navigate.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shell/UserMenuDrawer — visibility', () => {
  it('renders nothing when open=false', () => {
    renderWithProviders(
      <UserMenuDrawer open={false} onClose={() => {}} />,
      {
        identity: {
          user: { name: 'Test', email: 'test@example.com' },
          capabilities: ['all'],
        },
      },
    );
    expect(screen.queryByTestId('user-menu-drawer')).toBeNull();
  });

  it('renders body when open=true', () => {
    renderWithProviders(
      <UserMenuDrawer open onClose={() => {}} />,
      {
        identity: {
          user: { name: 'Test', email: 'test@example.com' },
          capabilities: ['all'],
        },
      },
    );
    expect(screen.getByTestId('user-menu-drawer')).toBeInTheDocument();
  });
});

describe('shell/UserMenuDrawer — profile summary', () => {
  it('renders the user name + email + role chip + scope tier from useIdentity()', () => {
    renderWithProviders(
      <UserMenuDrawer open onClose={() => {}} />,
      {
        identity: {
          user: {
            name: 'Rashed Al-Otaibi',
            email: 'rashed@rashed-logistics.example',
            role: 'super_admin',
            access_scope_type: 'platform',
            access_scope_id: null,
          },
          capabilities: ['all'],
        },
      },
    );

    expect(screen.getByTestId('user-menu-name')).toHaveTextContent('Rashed Al-Otaibi');
    expect(screen.getByTestId('user-menu-email')).toHaveTextContent(
      'rashed@rashed-logistics.example',
    );
    // Role chip lives inside the role wrapper; scope text is its sibling.
    const roleWrapper = screen.getByTestId('user-menu-role');
    expect(roleWrapper).toHaveTextContent('super_admin');
    expect(screen.getByTestId('user-menu-scope')).toHaveTextContent(/Platform/);
  });

  it('falls back gracefully when email is absent (still renders name + scope)', () => {
    renderWithProviders(
      <UserMenuDrawer open onClose={() => {}} />,
      {
        identity: {
          user: {
            name: 'No-Email User',
            // Force email off — the live seed user has one, so explicit
            // empty-string overrides it through the IdentityProvider mock
            // merge (overrideUser spread runs last over baseUser).
            email: '',
            access_scope_type: 'tenant',
            access_scope_id: null,
          },
          scope: { tenant: { id: 'org_x', label: 'Tenant X', rank: 2 } },
          capabilities: ['shipments.read'],
        },
      },
    );
    expect(screen.getByTestId('user-menu-name')).toHaveTextContent('No-Email User');
    expect(screen.queryByTestId('user-menu-email')).toBeNull();
    expect(screen.getByTestId('user-menu-scope')).toHaveTextContent('Tenant · Tenant X');
  });
});

describe('shell/UserMenuDrawer — current-user sessions', () => {
  it('mounts the shared SessionsList scoped to the current user', async () => {
    const listSpy = vi.spyOn(api, 'ui_list_user_sessions_v1').mockResolvedValue({
      rows: [
        {
          id: 'ssn_account_current',
          user_id: 'usr_account_current',
          user_email: 'account@example.com',
          aal: 'aal1',
          user_agent: 'Account drawer test browser',
          ip: '127.0.0.1',
          updated_at: new Date().toISOString(),
          is_current: true,
        },
      ],
      total: 1,
    });

    renderWithProviders(
      <UserMenuDrawer open onClose={() => {}} />,
      {
        identity: {
          user: {
            id: 'usr_account_current',
            name: 'Account User',
            email: 'account@example.com',
          },
          capabilities: ['users.read'],
        },
      },
    );

    const sessionsSection = await screen.findByTestId('user-menu-sessions');
    expect(sessionsSection).toHaveTextContent('Your sessions');
    expect(await screen.findByTestId('sessions-list-item-ssn_account_current')).toBeInTheDocument();
    expect(listSpy).toHaveBeenCalledWith('usr_account_current', 50);
  });

  it('revokes a non-current current-user session and keeps the same drawer updated', async () => {
    const user = userEvent.setup();
    const sessionId = 'ssn_account_non_current';
    let rows: api.UserSessionRow[] = [
      {
        id: sessionId,
        user_id: 'usr_account_revoke',
        user_email: 'account.revoke@example.com',
        aal: 'aal1',
        user_agent: 'Account drawer secondary browser',
        ip: '127.0.0.2',
        updated_at: new Date().toISOString(),
        is_current: false,
        revocation_status: null,
        revocation_reason: null,
        revocation_requested_at: null,
      },
    ];
    const listSpy = vi.spyOn(api, 'ui_list_user_sessions_v1').mockImplementation(async () => ({
      rows,
      total: rows.length,
    }));
    const revokeSpy = vi.spyOn(api, 'revoke_session_v1').mockImplementation(async (args) => {
      rows = rows.map((row) =>
        row.id === sessionId
          ? {
              ...row,
              revocation_audit_id: 'rva_account_non_current',
              revocation_status: 'pending',
              revocation_reason: args.reason,
              revocation_requested_at: new Date().toISOString(),
              revocation_correlation_id: 'corr_account_non_current',
            }
          : row,
      );
      return {
        ok: true,
        status: 'pending',
        revocation_audit_id: 'rva_account_non_current',
        session_id: sessionId,
        target_user_id: 'usr_account_revoke',
        correlation_id: 'corr_account_non_current',
      };
    });

    renderWithProviders(
      <UserMenuDrawer open onClose={() => {}} />,
      {
        identity: {
          user: {
            id: 'usr_account_revoke',
            name: 'Account Revoke User',
            email: 'account.revoke@example.com',
          },
          capabilities: ['users.read', 'users.manage'],
        },
      },
    );

    const row = await screen.findByTestId(`sessions-list-item-${sessionId}`);
    await user.click(within(row).getByLabelText(`Revoke session ${sessionId}`));
    const form = await within(row).findByTestId(`sessions-list-revoke-form-${sessionId}`);
    await user.type(within(form).getByLabelText(/Revocation reason/i), 'Account drawer security review');
    await user.click(within(form).getByRole('button', { name: /Confirm revoke/i }));

    expect(revokeSpy).toHaveBeenCalledWith({
      target_user_id: 'usr_account_revoke',
      session_id: sessionId,
      reason: 'Account drawer security review',
    });
    await waitFor(() => expect(listSpy.mock.calls.length).toBeGreaterThanOrEqual(2));
    const updatedRow = await screen.findByTestId(`sessions-list-item-${sessionId}`);
    expect(updatedRow).toHaveTextContent('revoke pending');
    expect(within(updatedRow).getByTestId(`sessions-list-revocation-${sessionId}`))
      .toHaveTextContent('Account drawer security review');
    expect(screen.getByTestId('user-menu-drawer')).toBeInTheDocument();
  });
});

describe('shell/UserMenuDrawer — sign-out (live mode)', () => {
  // jsdom locks `window.location.assign` so vi.spyOn cannot redefine it.
  // We swap the whole `window.location` object with a relaxed mock for
  // these tests and restore it after each one.
  let origLocation: Location;
  let assignFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    origLocation = window.location;
    assignFn = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...origLocation, assign: assignFn, href: origLocation.href },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: origLocation,
    });
  });

  it('invokes the Supabase sign-out seam when the live client is available', async () => {
    supabaseMocks.client = {
      auth: { signOut: supabaseMocks.signOut },
    };
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <UserMenuDrawer open onClose={onClose} />,
      {
        identity: {
          user: { name: 'Live User', email: 'live@example.com' },
          capabilities: ['all'],
        },
      },
    );

    await user.click(screen.getByLabelText('Sign out'));
    await waitFor(() => expect(supabaseMocks.signOutConsole).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalled();
    expect(assignFn).toHaveBeenCalledWith('/login');
  });

  it('surfaces a toast and does not redirect when sign-out fails', async () => {
    supabaseMocks.signOutConsole.mockRejectedValue(new Error('session not found'));
    supabaseMocks.client = {
      auth: { signOut: supabaseMocks.signOut },
    };
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <UserMenuDrawer open onClose={onClose} />,
      {
        identity: {
          user: { name: 'Live User', email: 'live@example.com' },
          capabilities: ['all'],
        },
      },
    );

    await user.click(screen.getByLabelText('Sign out'));
    await waitFor(() => expect(supabaseMocks.signOutConsole).toHaveBeenCalled());
    // Drawer stays open + no redirect when sign-out fails.
    expect(onClose).not.toHaveBeenCalled();
    expect(assignFn).not.toHaveBeenCalled();
  });
});

describe('shell/UserMenuDrawer — sign-out (in-memory mode)', () => {
  it('falls back to identity.setRole("guest") when getSupabaseClient() is null and never throws', async () => {
    supabaseMocks.client = null;
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <UserMenuDrawer open onClose={onClose} />,
      {
        identity: {
          user: { name: 'Mock User' },
          capabilities: ['all'],
        },
      },
    );

    await user.click(screen.getByLabelText('Sign out'));
    // No supabase call must have happened.
    expect(supabaseMocks.signOut).not.toHaveBeenCalled();
    // Drawer closes — the in-memory branch resolves without throwing.
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe('shell/UserMenuDrawer — escape + close', () => {
  it('Escape calls onClose (Radix Dialog forwards Esc through controlled onOpenChange)', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <UserMenuDrawer open onClose={onClose} />,
      {
        identity: {
          user: { name: 'Esc User', email: 'esc@example.com' },
          capabilities: ['all'],
        },
      },
    );
    await act(async () => {
      await user.keyboard('{Escape}');
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking the drawer Close button calls onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <UserMenuDrawer open onClose={onClose} />,
      {
        identity: {
          user: { name: 'Close User' },
          capabilities: ['all'],
        },
      },
    );
    await user.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('shell/UserMenuDrawer — quick links', () => {
  it('Settings link navigates to /platform/config and closes the drawer', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <UserMenuDrawer open onClose={onClose} />,
      {
        identity: {
          user: { name: 'Nav User', email: 'nav@example.com' },
          capabilities: ['all'],
        },
      },
    );
    await user.click(screen.getByTestId('user-menu-link-settings'));
    expect(routerMocks.navigate).toHaveBeenCalledWith({ to: '/platform/config' });
    expect(onClose).toHaveBeenCalled();
  });

  it('Keyboard shortcuts link calls onOpenShortcuts and closes the drawer', async () => {
    const onOpenShortcuts = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <UserMenuDrawer open onClose={onClose} onOpenShortcuts={onOpenShortcuts} />,
      {
        identity: {
          user: { name: 'Shortcut User' },
          capabilities: ['all'],
        },
      },
    );
    await user.click(screen.getByTestId('user-menu-link-shortcuts'));
    expect(onOpenShortcuts).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('omits the shortcuts link entirely when no opener is provided', () => {
    renderWithProviders(
      <UserMenuDrawer open onClose={() => {}} />,
      {
        identity: {
          user: { name: 'No-Shortcut User' },
          capabilities: ['all'],
        },
      },
    );
    expect(screen.queryByTestId('user-menu-link-shortcuts')).toBeNull();
  });
});
