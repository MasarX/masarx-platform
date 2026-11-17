import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import {
  createAuthedSupabaseBrowserCookies,
  createAuthedSupabaseClient,
  type BrowserAuthCookie,
} from "../../e2e/utils/supabase";
import { resolveUsableDemoPassword } from "../../e2e/utils/demo-accounts";

const mockSignIn = jest.fn();
const mockCreateClient = jest.fn();
const mockCreateBrowserClient = jest.fn();
const client = { auth: { signInWithPassword: mockSignIn } };
const cookie: BrowserAuthCookie = {
  name: "sb-unit-auth-token",
  value: "synthetic-session",
  options: { maxAge: 3600 },
};
const credentials = { email: "synthetic@example.com", password: "requested-password" };

jest.mock("@supabase/supabase-js", () => ({
  ...jest.requireActual("@supabase/supabase-js"),
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
jest.mock("@supabase/ssr", () => ({
  createBrowserClient: (...args: unknown[]) => mockCreateBrowserClient(...args),
}));
jest.mock("../../e2e/utils/demo-accounts", () => ({
  resolveUsableDemoPassword: jest.fn(),
}));
jest.mock("../../e2e/utils/env", () => ({
  getSupabaseUrl: () => "http://127.0.0.1:54321",
  getSupabaseAnonKey: () => "synthetic-anon-key",
  getSupabaseDbSchema: () => "api",
}));

const originalEnv = process.env;
let timeout: jest.SpyInstance;

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers();
  timeout = jest.spyOn(global, "setTimeout");
  jest.spyOn(Math, "random").mockReturnValue(0);
  process.env = {
    ...originalEnv,
    E2E_SUPABASE_SIGNIN_ATTEMPTS: "3",
    E2E_SUPABASE_SIGNIN_DELAY_MS: "100",
    E2E_SUPABASE_SIGNIN_MAX_DELAY_MS: "150",
  };
  jest.mocked(resolveUsableDemoPassword).mockResolvedValue("resolved-password");
  mockSignIn.mockResolvedValue({ data: { session: {} }, error: null });
  mockCreateClient.mockReturnValue(client);
  mockCreateBrowserClient.mockImplementation((_url, _key, options) => ({
    auth: {
      signInWithPassword: async (params: unknown) => {
        const result = await mockSignIn(params);
        if (result.data?.session && !result.error) options.cookies.setAll([cookie]);
        return result;
      },
    },
  }));
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  process.env = originalEnv;
});

describe.each([
  { name: "client", signIn: createAuthedSupabaseClient, expected: client },
  { name: "browser cookies", signIn: createAuthedSupabaseBrowserCookies, expected: [cookie] },
])("$name sign-in retries", ({ signIn, expected }) => {
  test("recovers from a wrapped opaque SDK error within the configured budget", async () => {
    mockSignIn.mockResolvedValueOnce({
      data: { session: null },
      error: new AuthRetryableFetchError("{}", 504),
    });

    await Promise.all([
      expect(signIn(credentials)).resolves.toEqual(expected),
      jest.runAllTimersAsync(),
    ]);

    expect(resolveUsableDemoPassword).toHaveBeenCalledWith(credentials);
    expect(mockSignIn).toHaveBeenCalledTimes(2);
    expect(mockSignIn).toHaveBeenLastCalledWith({ ...credentials, password: "resolved-password" });
    expect(timeout.mock.calls.map((call) => call[1])).toEqual([100]);
  });

  test("preserves the configured attempt limit and capped delays on exhaustion", async () => {
    const error = new AuthRetryableFetchError("{}", 504);
    mockSignIn.mockResolvedValue({ data: { session: null }, error });

    await Promise.all([
      expect(signIn(credentials)).rejects.toMatchObject({ cause: error }),
      jest.runAllTimersAsync(),
    ]);

    expect(mockSignIn).toHaveBeenCalledTimes(3);
    expect(timeout.mock.calls.map((call) => call[1])).toEqual([100, 150]);
  });

  test.each([
    ["invalid credentials", new AuthApiError("Invalid login credentials", 400, "invalid_credentials")],
    ["unknown opaque error", new Error("{}")],
    ["missing session", null],
  ])("does not retry %s", async (_label, error) => {
    mockSignIn.mockResolvedValue({ data: { session: null }, error });

    await expect(signIn(credentials)).rejects.toMatchObject({ cause: error });

    expect(mockSignIn).toHaveBeenCalledTimes(1);
    expect(timeout).not.toHaveBeenCalled();
  });
});
