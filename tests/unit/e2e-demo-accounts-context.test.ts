import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadDemoContext } from "../e2e/utils/demo-accounts";

const ENV_KEYS = ["DEMO_ACCOUNTS_PATH", "DEMO_PASSWORD", "E2E_IDENTITY_STRATEGY"] as const;

function writeManifest(dir: string, payload: Record<string, unknown>) {
  const manifestPath = path.join(dir, "demo-accounts.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return manifestPath;
}

describe("loadDemoContext password precedence", () => {
  const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("prefers manifest password when identity strategy is ephemeral", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "demo-ctx-"));
    const manifestPath = writeManifest(tmpRoot, {
      mode: "ephemeral",
      password: "manifest-pass",
      users: [{ email: "user@example.com" }],
    });

    process.env.DEMO_ACCOUNTS_PATH = manifestPath;
    process.env.DEMO_PASSWORD = "env-pass";
    process.env.E2E_IDENTITY_STRATEGY = "ephemeral";

    const context = loadDemoContext();
    expect(context.available).toBe(true);
    expect(context.password).toBe("manifest-pass");

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("prefers env password for non-ephemeral mode", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "demo-ctx-"));
    const manifestPath = writeManifest(tmpRoot, {
      mode: "persistent",
      password: "manifest-pass",
      users: [{ email: "user@example.com" }],
    });

    process.env.DEMO_ACCOUNTS_PATH = manifestPath;
    process.env.DEMO_PASSWORD = "env-pass";

    const context = loadDemoContext();
    expect(context.available).toBe(true);
    expect(context.password).toBe("env-pass");

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("falls back to manifest password when env password is absent", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "demo-ctx-"));
    const manifestPath = writeManifest(tmpRoot, {
      mode: "persistent",
      password: "manifest-pass",
      users: [{ email: "user@example.com" }],
    });

    process.env.DEMO_ACCOUNTS_PATH = manifestPath;

    const context = loadDemoContext();
    expect(context.available).toBe(true);
    expect(context.password).toBe("manifest-pass");

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
});
