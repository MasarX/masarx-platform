import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  callback: null as null | ((event: string, session: unknown) => void),
  getSession: vi.fn(),
  unsubscribe: vi.fn(),
  hydrateConsoleIdentity: vi.fn(),
  client: null as null | {
    auth: {
      getSession: ReturnType<typeof vi.fn>;
      onAuthStateChange: ReturnType<typeof vi.fn>;
    };
  },
}));

vi.mock('./auth', () => ({
  getConsoleAuthClient: () => authMocks.client,
  hydrateConsoleIdentity: authMocks.hydrateConsoleIdentity,
}));

import { IdentityProvider, useIdentity } from './identity';

const snapshot = {
  user: {
    id: 'usr_live_1',
    name: 'Live Operator',
    email: 'live@example.com',
    role: 'ops_admin',
    capabilities: ['shipments.read'],
    access_scope_type: 'tenant',
    access_scope_id: null,
    organization_id: 'org_live_1',
  },
  scope: { tenant: { id: 'org_live_1', label: 'Live Tenant', rank: 2 } },
  capabilities: ['shipments.read'],
};

function wrapper({ children }: { children: React.ReactNode }) {
  return <IdentityProvider>{children}</IdentityProvider>;
}

function installClient(session: unknown) {
  authMocks.getSession.mockResolvedValue({ data: { session }, error: null });
  authMocks.client = {
    auth: {
      getSession: authMocks.getSession,
      onAuthStateChange: vi.fn((cb) => {
        authMocks.callback = cb;
        return { data: { subscription: { unsubscribe: authMocks.unsubscribe } } };
      }),
    },
  };
}

describe('lib/identity - Supabase live auth hydration', () => {
  beforeEach(() => {
    authMocks.callback = null;
    authMocks.getSession.mockReset();
    authMocks.unsubscribe.mockReset();
    authMocks.hydrateConsoleIdentity.mockReset();
    authMocks.client = null;
    window.localStorage.clear();
  });

  it('fails closed to unauthenticated when Supabase has no session', async () => {
    installClient(null);

    const { result, unmount } = renderHook(() => useIdentity(), { wrapper });

    expect(result.current.authStatus).toBe('loading');
    await waitFor(() => expect(result.current.authStatus).toBe('unauthenticated'));
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.hasCapability('shipments.read')).toBe(false);

    unmount();
    expect(authMocks.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('hydrates user, scope, and capabilities from ui_me_v1 when a session exists', async () => {
    installClient({ access_token: 'tok' });
    authMocks.hydrateConsoleIdentity.mockResolvedValue(snapshot);

    const { result } = renderHook(() => useIdentity(), { wrapper });

    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'));
    expect(result.current.user).toMatchObject({
      id: 'usr_live_1',
      organization_id: 'org_live_1',
      access_scope_type: 'tenant',
    });
    expect(result.current.currentTenantId()).toBe('org_live_1');
    expect(result.current.hasCapability('shipments.read')).toBe(true);
  });

  it('deduplicates overlapping live session refreshes from mount and auth events', async () => {
    let resolveSession: (value: { data: { session: unknown }; error: null }) => void = () => {};
    authMocks.getSession.mockImplementation(() => new Promise((resolve) => {
      resolveSession = resolve;
    }));
    authMocks.client = {
      auth: {
        getSession: authMocks.getSession,
        onAuthStateChange: vi.fn((cb) => {
          authMocks.callback = cb;
          return { data: { subscription: { unsubscribe: authMocks.unsubscribe } } };
        }),
      },
    };
    authMocks.hydrateConsoleIdentity.mockResolvedValue(snapshot);

    const { result } = renderHook(() => useIdentity(), { wrapper });
    await waitFor(() => expect(authMocks.callback).not.toBeNull());

    act(() => {
      authMocks.callback?.('INITIAL_SESSION', { access_token: 'tok' });
    });
    expect(authMocks.getSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSession({ data: { session: { access_token: 'tok' } }, error: null });
    });
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'));
    expect(authMocks.hydrateConsoleIdentity).toHaveBeenCalledTimes(1);
  });

  it('honors backend "*" wildcard from ui_me_v1 in live auth mode', async () => {
    installClient({ access_token: 'tok' });
    authMocks.hydrateConsoleIdentity.mockResolvedValue({
      ...snapshot,
      capabilities: ['*'],
      user: {
        ...snapshot.user,
        role: 'super_admin',
        capabilities: ['*'],
        access_scope_type: 'platform',
      },
    });

    const { result } = renderHook(() => useIdentity(), { wrapper });

    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'));
    expect(result.current.hasCapability('finance.write')).toBe(true);
    expect(result.current.hasCapability('any.future.capability')).toBe(true);
  });

  it('lets platform users switch the active tenant lens in live auth mode', async () => {
    installClient({ access_token: 'tok' });
    authMocks.hydrateConsoleIdentity.mockResolvedValue({
      ...snapshot,
      user: {
        ...snapshot.user,
        role: 'super_admin',
        access_scope_type: 'platform',
      },
      scope: {
        global: { id: 'platform', label: 'Platform', rank: 1 },
        tenant: { id: 'org_live_1', label: 'Live Tenant', rank: 2 },
      },
      capabilities: ['*'],
    });

    const { result } = renderHook(() => useIdentity(), { wrapper });

    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'));
    act(() => {
      result.current.switchScope({
        tenant: { id: 'org_live_2', label: 'Second Live Tenant', rank: 2 },
      });
    });

    expect(result.current.scope.tenant).toMatchObject({
      id: 'org_live_2',
      label: 'Second Live Tenant',
    });
    expect(result.current.currentScopeType()).toBe('platform');
    expect(result.current.currentTenantId()).toBe('org_live_2');
  });

  it('persists the platform active tenant lens across live auth hydration', async () => {
    installClient({ access_token: 'tok' });
    authMocks.hydrateConsoleIdentity.mockResolvedValue({
      ...snapshot,
      user: {
        ...snapshot.user,
        role: 'super_admin',
        access_scope_type: 'platform',
      },
      scope: {
        global: { id: 'platform', label: 'Platform', rank: 1 },
        tenant: { id: 'org_live_1', label: 'Live Tenant', rank: 2 },
      },
      capabilities: ['*'],
    });

    const first = renderHook(() => useIdentity(), { wrapper });
    await waitFor(() => expect(first.result.current.authStatus).toBe('authenticated'));

    act(() => {
      first.result.current.switchScope({
        tenant: { id: 'org_live_2', label: 'Second Live Tenant', rank: 2 },
      });
    });
    first.unmount();

    const second = renderHook(() => useIdentity(), { wrapper });
    await waitFor(() => expect(second.result.current.authStatus).toBe('authenticated'));

    expect(second.result.current.scope.tenant).toMatchObject({
      id: 'org_live_2',
      label: 'Second Live Tenant',
    });
    expect(second.result.current.currentTenantId()).toBe('org_live_2');
  });

  it('clears live identity on Supabase SIGNED_OUT events', async () => {
    installClient({ access_token: 'tok' });
    authMocks.hydrateConsoleIdentity.mockResolvedValue(snapshot);

    const { result } = renderHook(() => useIdentity(), { wrapper });
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'));

    act(() => {
      authMocks.callback?.('SIGNED_OUT', null);
    });

    expect(result.current.authStatus).toBe('unauthenticated');
    expect(result.current.user.id).toBe('');
    expect(result.current.hasCapability('shipments.read')).toBe(false);
  });
});
