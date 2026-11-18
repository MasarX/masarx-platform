import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';

const authMocks = vi.hoisted(() => ({
  client: {} as unknown,
  signInConsoleWithPassword: vi.fn(async () => ({ access_token: 'tok' })),
  sendConsoleMagicLink: vi.fn(async () => {}),
}));

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    getConsoleAuthClient: () => authMocks.client,
    signInConsoleWithPassword: authMocks.signInConsoleWithPassword,
    sendConsoleMagicLink: authMocks.sendConsoleMagicLink,
  };
});

import { CONSOLE_AUTH_REDIRECT_STORAGE_KEY } from '@/lib/auth';
import { LoginModule } from './LoginModule';

describe('modules/auth/LoginModule', () => {
  let origLocation: Location;
  let assignFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    authMocks.client = {};
    authMocks.signInConsoleWithPassword.mockClear();
    authMocks.sendConsoleMagicLink.mockClear();
    localStorage.clear();
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

  it('signs in with email/password and redirects to the stored Console target', async () => {
    localStorage.setItem(CONSOLE_AUTH_REDIRECT_STORAGE_KEY, '/operate/shipments');
    const user = userEvent.setup();
    const refreshSession = vi.fn(async () => {});
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

    renderWithProviders(<LoginModule />, {
      identity: {
        authStatus: 'unauthenticated',
        capabilities: [],
        refreshSession,
      },
    });

    await user.type(screen.getByLabelText(/email/i), 'ops@example.com');
    await user.type(screen.getByLabelText(/password/i), 'secret');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() =>
      expect(authMocks.signInConsoleWithPassword).toHaveBeenCalledWith({
        email: 'ops@example.com',
        password: 'secret',
      }),
    );
    await waitFor(() => expect(refreshSession).toHaveBeenCalled());
    expect(authMocks.signInConsoleWithPassword.mock.invocationCallOrder[0]).toBeLessThan(
      refreshSession.mock.invocationCallOrder[0],
    );
    expect(assignFn).not.toHaveBeenCalled();
    expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/operate/shipments');
  });

  it('keeps the email field browser-automation friendly while preserving email entry hints', () => {
    renderWithProviders(<LoginModule />, {
      identity: {
        authStatus: 'unauthenticated',
        capabilities: [],
      },
    });

    const emailInput = screen.getByLabelText(/email/i);
    expect(emailInput).toHaveAttribute('type', 'text');
    expect(emailInput).toHaveAttribute('inputmode', 'email');
    expect(emailInput).toHaveAttribute('autocomplete', 'email');
    expect(emailInput).toHaveAttribute('pattern');
  });

  it('sends an email sign-in link through Supabase auth', async () => {
    const user = userEvent.setup();

    renderWithProviders(<LoginModule />, {
      identity: {
        authStatus: 'unauthenticated',
        capabilities: [],
      },
    });

    await user.type(screen.getByLabelText(/email/i), 'ops@example.com');
    await user.click(screen.getByRole('button', { name: /send email link/i }));

    await waitFor(() =>
      expect(authMocks.sendConsoleMagicLink).toHaveBeenCalledWith('ops@example.com'),
    );
    expect(screen.getByRole('status')).toHaveTextContent(/email sign-in link sent/i);
  });

  it('fails closed when console sign-in is not configured', () => {
    authMocks.client = null;

    renderWithProviders(<LoginModule />, {
      identity: {
        authStatus: 'unauthenticated',
        capabilities: [],
      },
    });

    expect(
      screen.getByRole('heading', { name: /console sign-in is not ready/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open demo console/i })).toBeNull();
    expect(assignFn).not.toHaveBeenCalled();
  });
});
