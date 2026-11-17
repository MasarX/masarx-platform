const mockCookieStore = {
  getAll: jest.fn(() => []),
  set: jest.fn(),
};
const mockCreateSupabaseServerClient = jest.fn();

jest.mock('next/headers', () => ({
  cookies: jest.fn(() => mockCookieStore),
}));

jest.mock('@supabase/ssr', () => ({
  createServerClient: (...args: unknown[]) => mockCreateSupabaseServerClient(...args),
}));

jest.mock('@masarx/config', () => ({
  getPublicConfig: jest.fn(),
}));

import { getPublicConfig } from '@masarx/config';
import {
  createServerClient,
  getVerifiedAccessToken,
  getVerifiedUser,
} from '../../packages/auth/src/server';

function buildJwt(payload: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

describe('auth server fallback client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCookieStore.getAll.mockReturnValue([]);
    mockCookieStore.set.mockReset();
  });

  test('exposes noop auth operations when public config is unavailable', async () => {
    (getPublicConfig as jest.Mock).mockImplementation(() => {
      throw new Error('Missing required env');
    });

    const client = createServerClient();

    await expect(client.auth.getSession()).resolves.toEqual({
      data: { session: null },
      error: null,
    });
    await expect(client.auth.getUser()).resolves.toEqual({
      data: { user: null },
      error: null,
    });
    await expect(client.auth.exchangeCodeForSession('code')).resolves.toEqual({
      data: { session: null, user: null },
      error: null,
    });
    await expect(client.auth.signOut()).resolves.toEqual({
      error: null,
    });
    await expect(getVerifiedUser()).resolves.toMatchObject({
      user: null,
      error: expect.any(Error),
    });
    await expect(getVerifiedAccessToken()).resolves.toMatchObject({
      user: null,
      accessToken: null,
      error: expect.any(Error),
    });
  });

  test('getVerifiedAccessToken reuses the verified auth cookie without clearing it', async () => {
    (getPublicConfig as jest.Mock).mockReturnValue({
      supabaseUrl: 'https://project.supabase.co',
      supabaseAnonKey: 'anon-key',
    });
    const accessToken = buildJwt({
      sub: 'user-1',
      email: 'super_admin@example.com',
      role: 'authenticated',
    });
    mockCookieStore.getAll.mockReturnValue([
      {
        name: 'sb-project-auth-token',
        value: `base64-${Buffer.from(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: 'refresh-token',
            expires_at: 1_900_000_000,
            user: {
              id: 'user-1',
              email: 'super_admin@example.com',
            },
          }),
        ).toString('base64url')}`,
      },
    ]);
    mockCreateSupabaseServerClient.mockReturnValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: {
            user: {
              id: 'user-1',
              email: 'super_admin@example.com',
            },
          },
          error: null,
        }),
        getSession: jest.fn().mockResolvedValue({
          data: { session: null },
          error: new Error('server cookie session should not be needed'),
        }),
      },
    });

    await expect(getVerifiedAccessToken()).resolves.toMatchObject({
      user: expect.objectContaining({
        id: 'user-1',
        email: 'super_admin@example.com',
      }),
      accessToken,
      error: null,
    });
    expect(mockCreateSupabaseServerClient).toHaveBeenCalledTimes(1);
    expect(mockCookieStore.set).not.toHaveBeenCalled();
  });
});
