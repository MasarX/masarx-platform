import { getPublicConfigFromEnv } from "@masarx/config";

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {},
}), { virtual: true });

import { getPublicConfigFromExpo, resolveExpoExtra } from "../../../apps/fieldops/src/mobile-public-config";

jest.mock("@masarx/config", () => ({
  getPublicConfigFromEnv: jest.fn((input) => input),
}));

describe("mobile public config", () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  });

  test("maps and trims Expo extra values before resolving public config", () => {
    const extra = {
      NEXT_PUBLIC_APP_NAME: "  Field Ops  ",
      NEXT_PUBLIC_SUPABASE_URL: " https://example.supabase.co ",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: " anon-key ",
      NEXT_PUBLIC_SENTRY_DSN: " https://dsn.example/1 ",
      NEXT_PUBLIC_SENTRY_ENVIRONMENT: " production ",
      NEXT_PUBLIC_AUTH_METHODS: " password,otp ",
      NEXT_PUBLIC_LOCALE: " en-US ",
      NEXT_PUBLIC_APP_BASE_PATH: "/should-not-be-forwarded",
      IGNORE_NON_STRING: 123,
    } as const;

    const resolved = getPublicConfigFromExpo(extra);

    expect(getPublicConfigFromEnv).toHaveBeenCalledTimes(1);
    expect(getPublicConfigFromEnv).toHaveBeenCalledWith(
      expect.objectContaining({
        NEXT_PUBLIC_APP_NAME: "Field Ops",
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
        NEXT_PUBLIC_SENTRY_DSN: "https://dsn.example/1",
        NEXT_PUBLIC_SENTRY_ENVIRONMENT: "production",
        NEXT_PUBLIC_AUTH_METHODS: "password,otp",
        NEXT_PUBLIC_LOCALE: "en-US",
      })
    );

    const forwarded = (getPublicConfigFromEnv as jest.Mock).mock.calls[0]?.[0] || {};
    expect(forwarded.NEXT_PUBLIC_APP_BASE_PATH).toBeUndefined();
    expect(resolved.NEXT_PUBLIC_APP_NAME).toBe("Field Ops");
  });

  test("treats missing, empty, and non-string extra values as undefined", () => {
    getPublicConfigFromExpo({
      NEXT_PUBLIC_APP_NAME: "",
      NEXT_PUBLIC_SUPABASE_URL: null,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 42,
      NEXT_PUBLIC_AUTH_METHODS: "   ",
    });

    expect(getPublicConfigFromEnv).toHaveBeenLastCalledWith(
      expect.objectContaining({
        NEXT_PUBLIC_APP_NAME: undefined,
        NEXT_PUBLIC_SUPABASE_URL: undefined,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined,
        NEXT_PUBLIC_AUTH_METHODS: undefined,
      })
    );
  });

  test("falls back to process env when expo extra does not include required runtime keys", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://env.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "env-anon";

    getPublicConfigFromExpo({});

    expect(getPublicConfigFromEnv).toHaveBeenLastCalledWith(
      expect.objectContaining({
        NEXT_PUBLIC_SUPABASE_URL: "https://env.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "env-anon",
      })
    );
  });

  test("maps Expo public env aliases to the canonical Next public config keys", () => {
    process.env.EXPO_PUBLIC_SUPABASE_URL = "https://expo-env.supabase.co";
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "expo-env-anon";

    getPublicConfigFromExpo({});

    expect(getPublicConfigFromEnv).toHaveBeenLastCalledWith(
      expect.objectContaining({
        NEXT_PUBLIC_SUPABASE_URL: "https://expo-env.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "expo-env-anon",
      })
    );
  });

  test("resolveExpoExtra keeps explicit extra precedence over env fallback", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://env.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "env-anon";

    const resolved = resolveExpoExtra({
      NEXT_PUBLIC_SUPABASE_URL: "https://explicit.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "explicit-anon",
    });

    expect(resolved.NEXT_PUBLIC_SUPABASE_URL).toBe("https://explicit.supabase.co");
    expect(resolved.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("explicit-anon");
  });
});
