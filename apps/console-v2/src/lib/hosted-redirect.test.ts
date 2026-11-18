import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostedInviteRedirect, normalizeHostedHttpUrl } from './hosted-redirect';

describe('hosted invite redirect helper', () => {
  const originalLocation = window.location;

  function mockWindowLocation(url: string) {
    const parsed = new URL(url);
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: {
        ...originalLocation,
        href: parsed.href,
        origin: parsed.origin,
        protocol: parsed.protocol,
        hostname: parsed.hostname,
      },
    });
  }

  beforeEach(() => {
    vi.stubEnv('VITE_AUTH_REDIRECT_URL', '');
    vi.stubEnv('VITE_CONSOLE_AUTH_REDIRECT_URL', '');
    vi.stubEnv('VITE_APP_HOST', '');
    mockWindowLocation('http://localhost:5175/platform/organizations');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it('preserves an explicit hosted auth callback URL', () => {
    vi.stubEnv('VITE_AUTH_REDIRECT_URL', 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback');

    expect(hostedInviteRedirect()).toBe('https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback');
  });

  it('converts a hosted Console base host to the auth callback route', () => {
    vi.stubEnv('VITE_APP_HOST', 'vtgspxqkvhurpwtxnnyvhjzw.example.invalid');

    expect(hostedInviteRedirect()).toBe('https://vtgspxqkvhurpwtxnnyvhjzw.example.invalid/auth/callback');
  });

  it('uses a hosted Browser origin as the auth callback route when env is empty', () => {
    mockWindowLocation('https://vtgspxqkvhurpwtxnnyvhjzw.example.invalid/platform/organizations');

    expect(hostedInviteRedirect()).toBe('https://vtgspxqkvhurpwtxnnyvhjzw.example.invalid/auth/callback');
  });

  it('fails closed for local-only rehearsal redirect configuration', () => {
    vi.stubEnv('VITE_AUTH_REDIRECT_URL', 'http://localhost:5175/auth/callback');
    vi.stubEnv('VITE_APP_HOST', 'local-backend.console-v2');

    expect(hostedInviteRedirect()).toBeNull();
  });

  it('does not classify local pseudo-hosts as hosted URLs', () => {
    expect(normalizeHostedHttpUrl('local-backend.console-v2')).toBeNull();
  });
});
