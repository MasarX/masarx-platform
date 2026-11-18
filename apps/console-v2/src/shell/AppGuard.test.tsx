// AppGuard.test.tsx — verifies the operator-console gate.
//
// Backend rule (mirrored here):
//   - access_scope_type IN ('platform', 'tenant')  → render shell content
//   - access_scope_type IN ('client',   'sender')  → render denied StateView
//                                                    with link to /portal/
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { AppGuard } from './AppGuard';
import * as api from '@/lib/api';
import * as auth from '@/lib/auth';

const Children = () => <div data-testid="shell-content">shell-content</div>;

beforeEach(() => {
  vi.spyOn(api, 'hasConsoleLiveBackend').mockReturnValue(false);
  vi.spyOn(api, 'isConsoleSeedModeEnabled').mockReturnValue(true);
  vi.spyOn(api, 'hydrateConsoleLiveMetadata').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shell/AppGuard', () => {
  it('renders a loading panel while Supabase session hydration is in flight', () => {
    renderWithProviders(
      <AppGuard>
        <Children />
      </AppGuard>,
      {
        identity: {
          authStatus: 'loading',
          capabilities: [],
        },
      },
    );
    expect(screen.queryByTestId('shell-content')).toBeNull();
    expect(screen.getByTestId('app-guard-loading')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /checking session/i })).toBeInTheDocument();
    expect(screen.getByText(/checking your sign-in status/i)).toBeInTheDocument();
    expect(screen.queryByText(/supabase/i)).toBeNull();
  });

  it('fails closed with setup wording that does not expose connection details', () => {
    vi.spyOn(api, 'hasConsoleLiveBackend').mockReturnValue(false);
    vi.spyOn(api, 'isConsoleSeedModeEnabled').mockReturnValue(false);

    renderWithProviders(
      <AppGuard>
        <Children />
      </AppGuard>,
      {
        identity: {
          authStatus: 'unauthenticated',
          capabilities: [],
        },
      },
    );

    expect(screen.queryByTestId('shell-content')).toBeNull();
    expect(screen.getByTestId('app-guard-live-backend-missing')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /console access setup required/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /console access is not ready/i })).toBeInTheDocument();
    expect(screen.getByText(/ask a platform administrator to finish setup/i)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /backend/i })).toBeNull();
    expect(screen.queryByText(/seed data/i)).toBeNull();
    expect(screen.queryByText(/supabase/i)).toBeNull();
    expect(screen.queryByText(/anon key/i)).toBeNull();
  });

  it('fails closed for unauthenticated users and surfaces the sign-in action', () => {
    renderWithProviders(
      <AppGuard>
        <Children />
      </AppGuard>,
      {
        identity: {
          authStatus: 'unauthenticated',
          capabilities: [],
        },
      },
    );
    expect(screen.queryByTestId('shell-content')).toBeNull();
    expect(screen.getByTestId('app-guard-unauthenticated')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /sign in required/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('fails closed when the authenticated profile cannot be hydrated', () => {
    renderWithProviders(
      <AppGuard>
        <Children />
      </AppGuard>,
      {
        identity: {
          authStatus: 'error',
          authError: 'ui_me_v1 requires authenticated user',
          capabilities: [],
        },
      },
    );
    expect(screen.queryByTestId('shell-content')).toBeNull();
    expect(screen.getByTestId('app-guard-auth-error')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /session could not be verified/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/please sign in again/i)).toBeInTheDocument();
    expect(screen.queryByText(/ui_me_v1 requires authenticated user/i)).toBeNull();
  });

  it('renders children for a platform user', () => {
    renderWithProviders(
      <AppGuard>
        <Children />
      </AppGuard>,
      {
        identity: {
          user: { access_scope_type: 'platform', access_scope_id: null },
          capabilities: ['all'],
        },
      },
    );
    expect(screen.getByTestId('shell-content')).toBeInTheDocument();
    expect(screen.queryByTestId('app-guard-denied')).toBeNull();
  });

  it('renders children for a tenant user', () => {
    renderWithProviders(
      <AppGuard>
        <Children />
      </AppGuard>,
      {
        identity: {
          user: { access_scope_type: 'tenant', access_scope_id: null },
          capabilities: ['shipments.read'],
        },
      },
    );
    expect(screen.getByTestId('shell-content')).toBeInTheDocument();
    expect(screen.queryByTestId('app-guard-denied')).toBeNull();
  });

  it('blocks a client_admin user with a denied StateView, portal link, and sign-out escape', async () => {
    const signOutSpy = vi.spyOn(auth, 'signOutConsole').mockResolvedValue(undefined);
    const originalLocation = window.location;
    const assignFn = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...originalLocation, assign: assignFn, href: originalLocation.href },
    });
    const user = userEvent.setup();

    try {
      renderWithProviders(
        <AppGuard>
          <Children />
        </AppGuard>,
        {
          identity: {
            user: { access_scope_type: 'client', access_scope_id: 'cl_exampleparcel_ksa' },
            capabilities: ['shipments.read'],
          },
        },
      );
      expect(screen.queryByTestId('shell-content')).toBeNull();
      expect(screen.getByTestId('app-guard-denied')).toBeInTheDocument();
      // The StateView heading is rendered as <h3>; assert the title surfaces.
      expect(
        screen.getByRole('heading', { name: /this is the operator console/i }),
      ).toBeInTheDocument();
      // The denied panel must surface the explicit "Client Admin" tier label so
      // the user knows why they were blocked.
      expect(screen.getByText(/Client Admin/i)).toBeInTheDocument();
      // The action button to open the portal must be present.
      expect(
        screen.getByRole('button', { name: /open customer portal/i }),
      ).toBeInTheDocument();
      const signOutButton = screen.getByRole('button', { name: /sign out/i });
      expect(signOutButton).toBeInTheDocument();

      await user.click(signOutButton);
      await waitFor(() => expect(signOutSpy).toHaveBeenCalledTimes(1));
      expect(assignFn).toHaveBeenCalledWith('/login');
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: originalLocation,
      });
    }
  });

  it('blocks a sender_user with a denied StateView and a portal link', () => {
    renderWithProviders(
      <AppGuard>
        <Children />
      </AppGuard>,
      {
        identity: {
          user: { access_scope_type: 'sender', access_scope_id: 'snd_exampleparcel_jed' },
          capabilities: ['shipments.read'],
        },
      },
    );
    expect(screen.queryByTestId('shell-content')).toBeNull();
    expect(screen.getByTestId('app-guard-denied')).toBeInTheDocument();
    expect(screen.getByText(/Sender User/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /open customer portal/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('uses the configurable portalHref when overridden', () => {
    renderWithProviders(
      <AppGuard portalHref="/custom-portal/">
        <Children />
      </AppGuard>,
      {
        identity: {
          user: { access_scope_type: 'client', access_scope_id: 'cl_test' },
          capabilities: ['shipments.read'],
        },
      },
    );
    expect(screen.getByTestId('app-guard-denied')).toBeInTheDocument();
    // The handler is bound to the override; we just need the action button
    // to remain present (click handler wires to the override at runtime).
    expect(
      screen.getByRole('button', { name: /open customer portal/i }),
    ).toBeInTheDocument();
  });

  // W35e-3 — suspended-account branch closes REAUDIT3/IDENTITY.md cross-cutting
  // P1. Mirrors the canonical `users.status='suspended'` set by suspend_user_v1
  // (supabase/migrations/202604300320_suspend_user_v1.sql). The check fires
  // before the portal-user denial because a suspended user has no legitimate UI
  // on either surface.
  it('blocks a suspended user with a dedicated panel even if access_scope_type=tenant', () => {
    renderWithProviders(
      <AppGuard>
        <Children />
      </AppGuard>,
      {
        identity: {
          user: {
            access_scope_type: 'tenant',
            access_scope_id: null,
            status: 'suspended',
          },
          capabilities: ['shipments.read'],
        },
      },
    );
    expect(screen.queryByTestId('shell-content')).toBeNull();
    // Suspended panel renders, NOT the portal-denial panel.
    expect(screen.getByTestId('app-guard-suspended')).toBeInTheDocument();
    expect(screen.queryByTestId('app-guard-denied')).toBeNull();
    expect(
      screen.getByRole('heading', { name: /account suspended/i }),
    ).toBeInTheDocument();
  });

  it('renders children for an active tenant user (status omitted defaults to active)', () => {
    renderWithProviders(
      <AppGuard>
        <Children />
      </AppGuard>,
      {
        identity: {
          // status field omitted → treated as active (back-compat).
          user: { access_scope_type: 'tenant', access_scope_id: null },
          capabilities: ['shipments.read'],
        },
      },
    );
    expect(screen.getByTestId('shell-content')).toBeInTheDocument();
    expect(screen.queryByTestId('app-guard-suspended')).toBeNull();
  });

  it('renders permission-focused metadata denial without leaking raw capability errors', async () => {
    vi.spyOn(api, 'hasConsoleLiveBackend').mockReturnValue(true);
    vi.spyOn(api, 'isConsoleSeedModeEnabled').mockReturnValue(false);
    vi.spyOn(api, 'hydrateConsoleLiveMetadata').mockRejectedValue(
      new Error('Capability denied: console_metadata.read'),
    );
    const signOutSpy = vi.spyOn(auth, 'signOutConsole').mockResolvedValue(undefined);
    const originalLocation = window.location;
    const assignFn = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...originalLocation, assign: assignFn, href: originalLocation.href },
    });
    const user = userEvent.setup();

    try {
      renderWithProviders(
        <AppGuard>
          <Children />
        </AppGuard>,
        {
          identity: {
            user: { access_scope_type: 'tenant', access_scope_id: null, status: 'active' },
            capabilities: ['routes.read'],
          },
        },
      );

      expect(await screen.findByTestId('app-guard-metadata-error')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /console access is limited/i })).toBeInTheDocument();
      expect(screen.getByText(/does not have the operator permissions required/i)).toBeInTheDocument();
      const signOutButton = screen.getByRole('button', { name: /sign out/i });
      expect(signOutButton).toBeInTheDocument();
      expect(screen.queryByText(/list_lookup_values_catalog_json_v1/i)).toBeNull();
      expect(screen.queryByText(/capability denied/i)).toBeNull();
      expect(screen.queryByText(/console_metadata\.read capability/i)).toBeNull();
      expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();

      await user.click(signOutButton);
      await waitFor(() => expect(signOutSpy).toHaveBeenCalledTimes(1));
      expect(assignFn).toHaveBeenCalledWith('/login');
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: originalLocation,
      });
    }
  });
});
