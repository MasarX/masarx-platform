let createSupabaseServerClient: jest.Mock;
let cookieGetAll: jest.Mock;
let cookieSet: jest.Mock;

jest.mock("@supabase/ssr", () => {
  createSupabaseServerClient = jest.fn((_url, _key, options) => ({ options }));
  return {
    createServerClient: (...args: unknown[]) =>
      createSupabaseServerClient(...args),
  };
});

jest.mock("next/headers", () => {
  cookieGetAll = jest.fn(() => []);
  cookieSet = jest.fn();
  return {
    cookies: () => ({
      getAll: cookieGetAll,
      set: cookieSet,
    }),
  };
});

jest.mock("@masarx/config", () => ({
  getPublicConfig: () => ({
    supabaseUrl: "https://example.supabase.co",
    supabaseAnonKey: "anon",
  }),
}));

import { createServerClient } from "../../packages/auth/src/server";

describe("createServerClient", () => {
  beforeEach(() => {
    createSupabaseServerClient.mockClear();
    cookieGetAll.mockClear();
    cookieSet.mockClear();
  });

  test("disables cookie writes when allowCookieSet is false", async () => {
    const client = createServerClient({ allowCookieSet: false }) as {
      options: { cookies: { setAll: (cookies: Array<unknown>) => void } };
    };

    await client.options.cookies.setAll([{ name: "a", value: "b", options: {} }]);

    expect(cookieSet).not.toHaveBeenCalled();
  });

  test("writes cookies when allowCookieSet is true", async () => {
    const client = createServerClient({ allowCookieSet: true }) as {
      options: { cookies: { setAll: (cookies: Array<unknown>) => void } };
    };

    await client.options.cookies.setAll([{ name: "a", value: "b", options: {} }]);

    expect(cookieSet).toHaveBeenCalledTimes(1);
  });
});
