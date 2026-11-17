import { getPublicConfig } from "@masarx/config";

describe("public config", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("reads current env values on each call", () => {
    process.env.NEXT_PUBLIC_APP_NAME = "Console A";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://a.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-a";
    process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL = "https://functions-a.example.com/functions/v1";
    process.env.NEXT_PUBLIC_AUTH_METHODS = "magic_link";

    const first = getPublicConfig();
    expect(first.appName).toBe("Console A");
    expect(first.supabaseUrl).toBe("https://a.supabase.co");
    expect(first.supabaseAnonKey).toBe("anon-a");
    expect(first.supabaseFunctionsUrl).toBe("https://functions-a.example.com/functions/v1");
    expect(first.authMethods).toEqual(["magic_link"]);

    process.env.NEXT_PUBLIC_APP_NAME = "Console B";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://b.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-b";
    process.env.NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL = "https://functions-b.example.com/functions/v1";
    process.env.NEXT_PUBLIC_AUTH_METHODS = "password";

    const second = getPublicConfig();
    expect(second.appName).toBe("Console B");
    expect(second.supabaseUrl).toBe("https://b.supabase.co");
    expect(second.supabaseAnonKey).toBe("anon-b");
    expect(second.supabaseFunctionsUrl).toBe("https://functions-b.example.com/functions/v1");
    expect(second.authMethods).toEqual(["password"]);
  });

  test("falls back to app-specific name when only one app label is set", () => {
    delete process.env.NEXT_PUBLIC_APP_NAME;
    process.env.NEXT_PUBLIC_APP_NAME_CONSOLE = "Console Ops";
    delete process.env.NEXT_PUBLIC_APP_NAME_PORTAL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://console.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-console";

    const config = getPublicConfig();
    expect(config.appName).toBe("Console Ops");
  });

  test("falls back to generic label when app label context is ambiguous", () => {
    delete process.env.NEXT_PUBLIC_APP_NAME;
    process.env.NEXT_PUBLIC_APP_NAME_CONSOLE = "Console Ops";
    process.env.NEXT_PUBLIC_APP_NAME_PORTAL = "Portal Ops";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://portal.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-portal";

    const config = getPublicConfig();
    expect(config.appName).toBe("App");
  });

  test("falls back to generic label when no app context is available", () => {
    delete process.env.NEXT_PUBLIC_APP_NAME;
    delete process.env.NEXT_PUBLIC_APP_NAME_CONSOLE;
    delete process.env.NEXT_PUBLIC_APP_NAME_PORTAL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fallback.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-fallback";

    const config = getPublicConfig();
    expect(config.appName).toBe("App");
  });
});
