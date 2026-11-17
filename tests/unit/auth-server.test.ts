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
  createServerReachableFetch,
  getVerifiedAccessToken,
  getVerifiedUser,
} from '../../packages/auth/src/server';

const originalInternalSupabaseUrl = process.env.SUPABASE_INTERNAL_URL;
function buildJwt(payload: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

describe('auth server fallback client', () => {

  test.each(['single', 'chunked', 'already-rotated-snapshot'] as const)(
    'keeps verified %s cookie token on the returned real SSR client RPC',
    async (shape) => {
      (getPublicConfig as jest.Mock).mockReturnValue({
        supabaseUrl: 'https://project.supabase.co',
        supabaseAnonKey: 'anon-key',
      });
      delete process.env.SUPABASE_INTERNAL_URL;
      const accessToken = buildJwt({
        sub: 'user-1', role: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 3600,
        generation: shape === 'already-rotated-snapshot' ? 2 : 1,
      });
      const encoded = 'base64-' + Buffer.from(JSON.stringify({
        access_token: accessToken, refresh_token: 'refresh-token',
        token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: 'user-1' },
      })).toString('base64url');
      const middle = Math.ceil(encoded.length / 2);
      mockCookieStore.getAll.mockReturnValue(shape === 'single' ? [
        { name: 'sb-project-auth-token', value: encoded },
      ] : [
        { name: 'sb-project-auth-token.0', value: encoded.slice(0, middle) },
        { name: 'sb-project-auth-token.1', value: encoded.slice(middle) },
      ]);
      const requests: Array<{ url: string; authorization: string | null }> = [];
      const transport = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        requests.push({ url, authorization: headers.get('authorization') });
        if (url.endsWith('/auth/v1/user')) {
          return new Response(JSON.stringify({ id: 'user-1' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.endsWith('/rest/v1/rpc/ui_me_v1')) {
          return new Response(JSON.stringify({ user_id: 'user-1' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error('Unexpected auth continuity transport: ' + url);
      });
      const actualSsr = jest.requireActual<typeof import('@supabase/ssr')>('@supabase/ssr');
      mockCreateSupabaseServerClient.mockImplementation((url, key, options) =>
        actualSsr.createServerClient(url, key, {
          ...options, global: { ...options.global, fetch: transport },
        }));
      try {
        const verified = await getVerifiedAccessToken({ allowCookieSet: false });
        expect(verified.error).toBeNull();
        expect(verified.accessToken).toBe(accessToken);
        expect(verified.user?.id).toBe('user-1');
        const rpc = await verified.client.rpc('ui_me_v1');
        expect(rpc.error).toBeNull();
        expect(requests).toEqual([
          { url: 'https://project.supabase.co/auth/v1/user', authorization: 'Bearer ' + accessToken },
          { url: 'https://project.supabase.co/rest/v1/rpc/ui_me_v1', authorization: 'Bearer ' + accessToken },
        ]);
        expect(mockCreateSupabaseServerClient).toHaveBeenCalledTimes(1);
        expect(mockCookieStore.set).not.toHaveBeenCalled();
      } finally {
        mockCreateSupabaseServerClient.mockReset();
      }
    },
  );
  beforeEach(() => {
    jest.clearAllMocks();
    mockCookieStore.getAll.mockReturnValue([]);
    mockCookieStore.set.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalInternalSupabaseUrl === undefined) delete process.env.SUPABASE_INTERNAL_URL;
    else process.env.SUPABASE_INTERNAL_URL = originalInternalSupabaseUrl;
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
    const verifiedClient = {
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
    };
    mockCreateSupabaseServerClient.mockReturnValue(verifiedClient);

    const result = await getVerifiedAccessToken();

    expect(result).toMatchObject({
      user: expect.objectContaining({
        id: 'user-1',
        email: 'super_admin@example.com',
      }),
      accessToken,
      error: null,
    });
    expect(result.client).toBe(verifiedClient);
    expect(mockCreateSupabaseServerClient).toHaveBeenCalledTimes(1);
    expect(mockCreateSupabaseServerClient).toHaveBeenCalledWith(
      'https://project.supabase.co',
      'anon-key',
      expect.objectContaining({ db: { schema: 'api' } }),
    );
    expect(mockCookieStore.set).not.toHaveBeenCalled();
  });

  test('verifies cookie tokens through the server-reachable Supabase URL', async () => {
    (getPublicConfig as jest.Mock).mockReturnValue({
      supabaseUrl: 'http://127.0.0.1:21198',
      supabaseAnonKey: 'anon-key',
    });
    process.env.SUPABASE_INTERNAL_URL = 'http://rvzwwjlztwwisjthghnipgjr.example.invalid:21198';
    const accessToken = buildJwt({ sub: 'user-1' });
    mockCookieStore.getAll.mockReturnValue([{
      name: 'sb-127-auth-token',
      value: JSON.stringify({
        access_token: accessToken,
        user: { id: 'user-1' },
      }),
    }]);
    mockCreateSupabaseServerClient.mockReturnValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: { user: null },
          error: new Error('network verification failed'),
        }),
        getSession: jest.fn(),
      },
    });
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'user-1' }),
    } as Response);

    await expect(getVerifiedAccessToken({ allowCookieSet: false })).resolves.toMatchObject({
      user: { id: 'user-1' },
      accessToken,
      error: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://rvzwwjlztwwisjthghnipgjr.example.invalid:21198/auth/v1/user',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: `Bearer ${accessToken}`,
        }),
      }),
    );
    expect(mockCreateSupabaseServerClient).toHaveBeenCalledWith(
      'http://127.0.0.1:21198',
      'anon-key',
      expect.objectContaining({ db: { schema: 'api' } }),
    );
    const serverFetch = mockCreateSupabaseServerClient.mock.calls[0][2].global.fetch;
    fetchMock.mockClear();
    await serverFetch('http://127.0.0.1:21198/rest/v1/rpc/ui_me_v1', {
      method: 'POST',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0].toString()).toBe(
      'http://rvzwwjlztwwisjthghnipgjr.example.invalid:21198/rest/v1/rpc/ui_me_v1',
    );

    fetchMock.mockClear();
    const edgeFetch = createServerReachableFetch('http://127.0.0.1:21198');
    await edgeFetch?.('http://127.0.0.1:21198/functions/v1/marketplace-participant-review', {
      method: 'POST',
    });
    expect(fetchMock.mock.calls[0][0].toString()).toBe(
      'http://rvzwwjlztwwisjthghnipgjr.example.invalid:21198/functions/v1/marketplace-participant-review',
    );
  });

  test('retries transient direct verification and preserves a valid cookie session', async () => {
    (getPublicConfig as jest.Mock).mockReturnValue({
      supabaseUrl: 'http://127.0.0.1:21198',
      supabaseAnonKey: 'anon-key',
    });
    const accessToken = buildJwt({ sub: 'user-1' });
    mockCookieStore.getAll.mockReturnValue([{
      name: 'sb-127-auth-token',
      value: JSON.stringify({ access_token: accessToken, user: { id: 'user-1' } }),
    }]);
    mockCreateSupabaseServerClient.mockReturnValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: { user: null },
          error: new Error('fetch failed'),
        }),
        getSession: jest.fn(),
      },
    });
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({}),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'user-1' }),
      } as Response);

    await expect(getVerifiedAccessToken({ allowCookieSet: false })).resolves.toMatchObject({
      user: { id: 'user-1' },
      accessToken,
      error: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('does not retry rejected credentials', async () => {
    (getPublicConfig as jest.Mock).mockReturnValue({
      supabaseUrl: 'http://127.0.0.1:21198',
      supabaseAnonKey: 'anon-key',
    });
    const accessToken = buildJwt({ sub: 'user-1' });
    mockCookieStore.getAll.mockReturnValue([{
      name: 'sb-127-auth-token',
      value: JSON.stringify({ access_token: accessToken, user: { id: 'user-1' } }),
    }]);
    mockCreateSupabaseServerClient.mockReturnValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: { user: null },
          error: new Error('invalid token'),
        }),
        getSession: jest.fn(),
      },
    });
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'invalid jwt' }),
    } as Response);

    const result = await getVerifiedAccessToken({ allowCookieSet: false });
    expect(result).toMatchObject({
      user: null,
      accessToken: null,
      error: expect.any(Error),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    'Auth session missing!',
    'Session from session_id claim in JWT does not exist',
    'Session not found',
  ])('rejects unverified session identity when auth reports %s', async (message) => {
    (getPublicConfig as jest.Mock).mockReturnValue({
      supabaseUrl: 'https://project.supabase.co',
      supabaseAnonKey: 'anon-key',
    });
    const accessToken = buildJwt({
      sub: 'forged-user',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    mockCreateSupabaseServerClient.mockReturnValue({
      auth: {
        getSession: jest.fn().mockResolvedValue({
          data: { session: { access_token: accessToken, user: { id: 'forged-user' } } },
          error: null,
        }),
        getUser: jest.fn().mockResolvedValue({
          data: { user: null },
          error: new Error(message),
        }),
      },
    });
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message }),
    } as Response);

    await expect(getVerifiedUser()).resolves.toMatchObject({
      user: null,
      error: expect.any(Error),
    });
    await expect(getVerifiedAccessToken()).resolves.toMatchObject({
      user: null,
      accessToken: null,
      error: expect.any(Error),
    });
    expect(mockCookieStore.set).not.toHaveBeenCalled();
  });
});
