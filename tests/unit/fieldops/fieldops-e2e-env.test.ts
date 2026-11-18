import {
  assertFieldOpsEnvForStrictMode,
  isFieldOpsStrictMode,
  missingRequiredFieldOpsEnv,
} from "../../../tests/fieldops-e2e/helpers/fieldops-env";
import {
  buildFieldOpsWebServerEnv,
} from "../../../tests/fieldops-e2e/helpers/playwright-runtime";

describe("FieldOps E2E environment contract", () => {
  const completeEnv = {
    SUPABASE_URL: "https://example.example.invalid",
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.example.invalid",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    DATABASE_URL_DIRECT: "postgres://localhost/fieldops",
    DEMO_ACCOUNTS_PROVISION_GUARD: "enabled",
  };

  test("accepts the complete strict FieldOps runtime contract", () => {
    expect(missingRequiredFieldOpsEnv(completeEnv)).toEqual([]);
    expect(isFieldOpsStrictMode({ STRICT_CORE_ENV: "true" })).toBe(true);
    expect(isFieldOpsStrictMode({ STRICT_CORE_ENV: "false" })).toBe(false);
  });

  test("requires a DB runtime and guarded demo-account provisioning", () => {
    expect(
      missingRequiredFieldOpsEnv({
        ...completeEnv,
        DATABASE_URL_DIRECT: "",
        DEMO_ACCOUNTS_PROVISION_GUARD: "disabled",
      }),
    ).toEqual([
      "DATABASE_URL|DATABASE_URL_DIRECT|DATABASE_URL_POOLER|PG_CONN_STRING",
      "DEMO_ACCOUNTS_PROVISION_GUARD=enabled",
    ]);
  });

  test("fails closed only in strict mode", () => {
    expect(() =>
      assertFieldOpsEnvForStrictMode(
        "FieldOps owner pack",
        ["SUPABASE_URL"],
        { STRICT_CORE_ENV: "false" },
      ),
    ).not.toThrow();

    expect(() =>
      assertFieldOpsEnvForStrictMode(
        "FieldOps owner pack",
        ["SUPABASE_URL"],
        { STRICT_CORE_ENV: "true" },
      ),
    ).toThrow(/Strict FieldOps gates must fail closed/);
  });

  test("passes only public/runtime-safe variables into the FieldOps web server", () => {
    const webEnv = buildFieldOpsWebServerEnv({
      env: {
        PATH: "/usr/bin",
        SUPABASE_SERVICE_ROLE_KEY: "SyntheticOnly-2f5b7839!",
        SUPABASE_SECRET_KEY: "SyntheticOnly-db216060!",
        DATABASE_URL: "postgres://secret@example/postgres",
        SUPABASE_URL: "https://example.example.invalid",
        SUPABASE_ANON_KEY: "anon",
        NEXT_PUBLIC_FEATURE_FLAG: "enabled",
      },
      fieldopsTempDir: "/tmp/fieldops",
      supabaseUrl: "https://example.example.invalid",
      supabaseAnonKey: "anon",
    });

    expect(webEnv).toMatchObject({
      PATH: "/usr/bin",
      CI: "1",
      EXPO_NO_DOTENV: "1",
      TEMP: "/tmp/fieldops",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.example.invalid",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
      NEXT_PUBLIC_FEATURE_FLAG: "enabled",
    });
    expect(webEnv).not.toHaveProperty("SUPABASE_SERVICE_ROLE_KEY");
    expect(webEnv).not.toHaveProperty("SUPABASE_SECRET_KEY");
    expect(webEnv).not.toHaveProperty("DATABASE_URL");
  });
});
