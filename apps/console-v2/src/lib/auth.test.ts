import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  client: null as null | {
    auth: {
      signInWithPassword: ReturnType<typeof vi.fn>;
      signInWithOtp: ReturnType<typeof vi.fn>;
      exchangeCodeForSession: ReturnType<typeof vi.fn>;
      setSession: ReturnType<typeof vi.fn>;
      getSession: ReturnType<typeof vi.fn>;
      signOut: ReturnType<typeof vi.fn>;
    };
  },
  rpc: vi.fn(),
}));

vi.mock('./supabase', () => ({
  getSupabaseClient: () => authMocks.client,
  rpc: authMocks.rpc,
}));

import {
  CONSOLE_AUTH_REDIRECT_STORAGE_KEY,
  completeConsoleAuthCallback,
  consumeConsoleAuthRedirect,
  hydrateConsoleIdentity,
  normalizeUiMePayload,
  rememberConsoleAuthRedirect,
  sendConsoleMagicLink,
  signInConsoleWithPassword,
  signOutConsole,
} from './auth';

function makeClient() {
  return {
    auth: {
      signInWithPassword: vi.fn(async () => ({ data: { session: { access_token: 'tok' } }, error: null })),
      signInWithOtp: vi.fn(async () => ({ data: {}, error: null })),
      exchangeCodeForSession: vi.fn(async () => ({ data: { session: { access_token: 'tok' } }, error: null })),
      setSession: vi.fn(async () => ({ data: { session: { access_token: 'hash-tok' } }, error: null })),
      getSession: vi.fn(async () => ({ data: { session: { access_token: 'tok' } }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
    },
  };
}

const uiMePayload = {
  user: {
    id: 'usr_live_1',
    email: 'ops@example.com',
    name: 'Ops User',
    user_type: 'ops_admin',
    status: 'active',
  },
  org: { id: 'org_live_1', name: 'Live Tenant' },
  access_scope: {
    scope_type: 'tenant',
    scope_id: null,
    scope_label: 'Live Tenant',
  },
  capabilities: ['shipments.read', 'routes.write'],
};

describe('lib/auth', () => {
  beforeEach(() => {
    authMocks.client = makeClient();
    authMocks.rpc.mockReset();
    localStorage.clear();
    window.history.replaceState({}, '', '/');
    vi.unstubAllEnvs();
  });

  it('normalizes api.ui_me_v1 into the Console identity snapshot', () => {
    const snapshot = normalizeUiMePayload(uiMePayload);

    expect(snapshot.user).toMatchObject({
      id: 'usr_live_1',
      email: 'ops@example.com',
      name: 'Ops User',
      role: 'ops_admin',
      access_scope_type: 'tenant',
      access_scope_id: null,
      organization_id: 'org_live_1',
      status: 'active',
    });
    expect(snapshot.scope.tenant).toMatchObject({
      id: 'org_live_1',
      label: 'Live Tenant',
    });
    expect(snapshot.capabilities).toEqual(['shipments.read', 'routes.write']);
  });

  it('rejects an invalid access scope from ui_me', () => {
    expect(() =>
      normalizeUiMePayload({
        ...uiMePayload,
        access_scope: { scope_type: 'client', scope_id: null },
      }),
    ).toThrow(/access_scope_id must be set/);
  });

  it('signs in with Supabase password auth', async () => {
    await expect(
      signInConsoleWithPassword({ email: ' ops@example.com ', password: 'secret' }),
    ).resolves.toMatchObject({ access_token: 'tok' });

    expect(authMocks.client?.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'ops@example.com',
      password: 'secret',
    });
  });

  it('sends a Supabase email link with the configured callback URL', async () => {
    vi.stubEnv('VITE_AUTH_REDIRECT_URL', 'https://console.example.com/auth/callback');

    await sendConsoleMagicLink(' ops@example.com ');

    expect(authMocks.client?.auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'ops@example.com',
      options: { emailRedirectTo: 'https://console.example.com/auth/callback' },
    });
  });

  it('exchanges auth callback code for a session', async () => {
    window.history.replaceState({}, '', '/auth/callback?code=abc123');

    await expect(completeConsoleAuthCallback()).resolves.toMatchObject({
      access_token: 'tok',
    });
    expect(authMocks.client?.auth.exchangeCodeForSession).toHaveBeenCalledWith('abc123');
  });

  it('persists Supabase invite tokens returned in the callback hash', async () => {
    window.history.replaceState(
      {},
      '',
      '/auth/callback#access_token=access123&refresh_token=refresh456&type=invite',
    );

    await expect(completeConsoleAuthCallback()).resolves.toMatchObject({
      access_token: 'hash-tok',
    });
    expect(authMocks.client?.auth.setSession).toHaveBeenCalledWith({
      access_token: 'access123',
      refresh_token: 'refresh456',
    });
    expect(authMocks.client?.auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('does not treat an empty callback session as a successful sign-in', async () => {
    window.history.replaceState({}, '', '/auth/callback');
    authMocks.client?.auth.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });

    await expect(completeConsoleAuthCallback()).rejects.toThrow(
      /sign-in link did not return a console session/i,
    );
  });

  it('surfaces callback hash errors before redirecting away', async () => {
    window.history.replaceState(
      {},
      '',
      '/auth/callback#error_description=Invite%20link%20expired',
    );

    await expect(completeConsoleAuthCallback()).rejects.toThrow(/invite link expired/i);
    expect(authMocks.client?.auth.getSession).not.toHaveBeenCalled();
  });

  it('hydrates identity from api.ui_me_v1', async () => {
    authMocks.rpc.mockResolvedValue(uiMePayload);

    await expect(hydrateConsoleIdentity()).resolves.toMatchObject({
      user: { id: 'usr_live_1', organization_id: 'org_live_1' },
    });
    expect(authMocks.rpc).toHaveBeenCalledWith('ui_me_v1');
  });

  it('signs out and clears the stored redirect', async () => {
    localStorage.setItem(CONSOLE_AUTH_REDIRECT_STORAGE_KEY, '/operate/shipments');

    await signOutConsole();

    expect(authMocks.client?.auth.signOut).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(CONSOLE_AUTH_REDIRECT_STORAGE_KEY)).toBeNull();
  });

  it('stores and consumes only same-origin Console redirects', () => {
    rememberConsoleAuthRedirect('/operate/shipments?status=open');
    expect(consumeConsoleAuthRedirect()).toBe('/operate/shipments?status=open');

    rememberConsoleAuthRedirect('https://evil.example/path');
    expect(consumeConsoleAuthRedirect()).toBe('/');

    rememberConsoleAuthRedirect('/.//evil.example');
    expect(consumeConsoleAuthRedirect()).toBe('/');

    rememberConsoleAuthRedirect('/login');
    expect(consumeConsoleAuthRedirect()).toBe('/');
  });
});
