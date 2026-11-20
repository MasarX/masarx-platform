import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("e2e env loading", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.ENV_FILE;
    delete process.env.ENV_FILE_OVERRIDE;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.PREVIEW_SUPABASE_URL;
    delete process.env.PREVIEW_SUPABASE_ANON_KEY;
    delete process.env.PREVIEW_SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
    process.chdir(originalCwd);
  });

  test("prefers .env.local over .env.cloud when ENV_FILE is unset", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "masarx-e2e-env-"));
    const envRoot = path.join(repoRoot, "config", "env");
    fs.mkdirSync(envRoot, { recursive: true });
    fs.writeFileSync(
      path.join(envRoot, ".env.cloud"),
      "SUPABASE_URL=https://cloud.example.invalid\nSUPABASE_ANON_KEY=cloud-anon\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(envRoot, ".env.local"),
      "SUPABASE_URL=http://127.0.0.1:56321\nSUPABASE_ANON_KEY=local-anon\n",
      "utf8",
    );

    process.chdir(repoRoot);

    jest.isolateModules(() => {
      const envModule = require("../e2e/utils/env");
      envModule.loadE2EEnv();

      expect(process.env.SUPABASE_URL).toBe("http://127.0.0.1:56321");
      expect(process.env.SUPABASE_ANON_KEY).toBe("local-anon");
      expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:56321");
      expect(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("local-anon");
    });
  });

  test("explicit ENV_FILE override replaces stale shared Supabase keys for E2E helpers", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "masarx-e2e-env-"));
    const envRoot = path.join(repoRoot, "config", "env");
    const explicitEnvPath = path.join(repoRoot, "tmp", "preview.env");
    fs.mkdirSync(envRoot, { recursive: true });
    fs.mkdirSync(path.dirname(explicitEnvPath), { recursive: true });
    fs.writeFileSync(
      path.join(envRoot, ".env.local"),
      "SUPABASE_URL=https://shared.example.invalid\nSUPABASE_ANON_KEY=shared-anon\nNEXT_PUBLIC_SUPABASE_URL=https://shared.example.invalid\nNEXT_PUBLIC_SUPABASE_ANON_KEY=shared-anon\n",
      "utf8",
    );
    fs.writeFileSync(
      explicitEnvPath,
      "SUPABASE_URL=https://preview.example.invalid\nSUPABASE_ANON_KEY=preview-anon\nPREVIEW_SUPABASE_URL=https://preview.example.invalid\nPREVIEW_SUPABASE_ANON_KEY=preview-anon\n",
      "utf8",
    );

    process.env.SUPABASE_URL = "https://stale.example.invalid";
    process.env.SUPABASE_ANON_KEY = "stale-anon";
    process.env.PREVIEW_SUPABASE_URL = "https://stale-preview.example.invalid";
    process.env.PREVIEW_SUPABASE_ANON_KEY = "obsolete-preview-fixture";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stale.example.invalid";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stale-anon";
    process.env.ENV_FILE = explicitEnvPath;
    process.env.ENV_FILE_OVERRIDE = "1";
    process.chdir(repoRoot);

    jest.isolateModules(() => {
      const envModule = require("../e2e/utils/env");
      envModule.loadE2EEnv();

      expect(process.env.SUPABASE_URL).toBe("https://preview.example.invalid");
      expect(process.env.SUPABASE_ANON_KEY).toBe("preview-anon");
      expect(process.env.PREVIEW_SUPABASE_URL).toBe("https://preview.example.invalid");
      expect(process.env.PREVIEW_SUPABASE_ANON_KEY).toBe("preview-anon");
      expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://preview.example.invalid");
      expect(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("preview-anon");
      expect(envModule.getSupabaseUrl()).toBe("https://preview.example.invalid");
      expect(envModule.getSupabaseAnonKey()).toBe("preview-anon");
    });
  });
});
