let createSupabaseServerClientMock: jest.Mock;
let activeAuthClient: {
  getSession: jest.Mock;
  getUser: jest.Mock;
} | null = null;
let activeCookies: { name: string; value: string }[] = [];

jest.mock("@supabase/ssr", () => {
  createSupabaseServerClientMock = jest.fn(() => ({
    auth: activeAuthClient,
  }));
  return {
    createServerClient: (...args: unknown[]) =>
      createSupabaseServerClientMock(...args),
  };
});

jest.mock("next/headers", () => ({
  cookies: jest.fn(() => ({
    getAll: jest.fn(() => activeCookies),
    set: jest.fn(),
  })),
}));

jest.mock("@masarx/config", () => ({
  getPublicConfig: jest.fn(() => ({
    supabaseUrl: "https://example.supabase.co",
    supabaseAnonKey: "anon",
  })),
}));

import { getVerifiedAccessToken } from "../../packages/auth/src/server";

const createAccessToken = (subject: string) => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url"
  );
  const payload = Buffer.from(JSON.stringify({ sub: subject })).toString("base64url");
  return `${header}.${payload}.signature`;
};

describe("getVerifiedAccessToken", () => {
  beforeEach(() => {
    createSupabaseServerClientMock.mockClear();
    activeAuthClient = null;
    activeCookies = [];
  });

  test("uses the verified session cookie token before user verification mutates auth state", async () => {
    const accessToken = createAccessToken("user-1");
    activeCookies = [
      {
        name: "sb-masarx-auth-token",
        value: JSON.stringify({
          access_token: accessToken,
          user: { id: "user-1" },
        }),
      },
    ];

    const getSession = jest.fn().mockResolvedValue({
      data: { session: null },
      error: null,
    });
    const getUser = jest.fn().mockImplementation(async (jwt?: string) => {
      expect(jwt).toBe(accessToken);
      return {
        data: { user: { id: "user-1" } },
        error: null,
      };
    });

    activeAuthClient = { getSession, getUser };

    await expect(getVerifiedAccessToken({ allowCookieSet: false })).resolves.toMatchObject({
      user: { id: "user-1" },
      accessToken,
      error: null,
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(getUser).toHaveBeenCalledWith(accessToken);
  });

  test("fails closed when the verified user does not match the session subject", async () => {
    const accessToken = createAccessToken("session-user");
    activeCookies = [
      {
        name: "sb-masarx-auth-token",
        value: JSON.stringify({
          access_token: accessToken,
          user: { id: "session-user" },
        }),
      },
    ];

    activeAuthClient = {
      getSession: jest.fn().mockResolvedValue({
        data: { session: null },
        error: null,
      }),
      getUser: jest.fn().mockResolvedValue({
        data: { user: { id: "verified-user" } },
        error: null,
      }),
    };

    const result = await getVerifiedAccessToken({ allowCookieSet: false });
    expect(result).toMatchObject({
      user: null,
      accessToken: null,
      error: expect.any(Error),
    });
    expect(result.error?.message).toBe("verified_access_token_user_mismatch");
  });
});
