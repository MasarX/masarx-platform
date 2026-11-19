import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
    delete process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL;
  });

  test("maps and trims Expo extra values before resolving public config", () => {
    const extra = {
      NEXT_PUBLIC_APP_NAME: "  Field Ops  ",
      NEXT_PUBLIC_SUPABASE_URL: " https://example.supabase.co ",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: " anon-key ",
      NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL: " https://functions.example/functions/v1 ",
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
    expect(forwarded.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL).toBeUndefined();
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

  test("keeps Expo public aliases statically inlineable by Metro", () => {
    const source = readFileSync(
      resolve(__dirname, "../../../apps/fieldops/src/mobile-public-config.ts"),
      "utf8",
    );

    for (const key of [
      "EXPO_PUBLIC_APP_NAME",
      "EXPO_PUBLIC_SUPABASE_URL",
      "EXPO_PUBLIC_SUPABASE_ANON_KEY",
      "EXPO_PUBLIC_SENTRY_DSN",
      "EXPO_PUBLIC_SENTRY_ENVIRONMENT",
      "EXPO_PUBLIC_AUTH_METHODS",
      "EXPO_PUBLIC_LOCALE",
    ]) {
      expect(source).toContain(`process.env.${key}`);
    }
    expect(source).not.toContain("source[EXPO_PUBLIC_ENV_ALIASES[key]]");
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

 test("signup URL follows explicit Expo precedence and fails closed", () => {
  const previous = process.env.EXPO_PUBLIC_DRIVER_SIGNUP_URL;
  process.env.EXPO_PUBLIC_DRIVER_SIGNUP_URL = "https://env.example.test/apply";
  try {
    expect(getPublicConfigFromExpo({NEXT_PUBLIC_DRIVER_SIGNUP_URL:"https://configured.example.test/apply"}).driverSignupUrl).toBe("https://configured.example.test/apply");
    expect(getPublicConfigFromExpo({NEXT_PUBLIC_DRIVER_SIGNUP_URL:"javascript:bad"}).driverSignupUrl).toBeNull();
  } finally { if (previous === undefined) delete process.env.EXPO_PUBLIC_DRIVER_SIGNUP_URL; else process.env.EXPO_PUBLIC_DRIVER_SIGNUP_URL = previous; }
});
