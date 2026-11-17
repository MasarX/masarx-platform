const fs = require("fs");
const os = require("os");
const path = require("path");

describe("load-public-env fallback mappings", () => {
  const originalEnv = { ...process.env };

  const load = (appDir, options = {}) => {
    jest.resetModules();
    if (options.mockMissingDotenv) {
      jest.doMock("dotenv", () => {
        const error = new Error("Cannot find module 'dotenv'");
        error.code = "MODULE_NOT_FOUND";
        throw error;
      });
    } else {
      jest.dontMock("dotenv");
    }
    let loadPublicEnv;
    jest.isolateModules(() => {
      ({ loadPublicEnv } = require("../../scripts/utils/load-public-env"));
    });
    loadPublicEnv({ appDir });
    jest.dontMock("dotenv");
  };

  function makeTempRepo(envContents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "load-public-env-"));
    const envDir = path.join(dir, "config", "env");
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(path.join(envDir, ".env.cloud"), envContents, "utf8");
    const consoleDir = path.join(dir, "apps", "console");
    const portalDir = path.join(dir, "apps", "portal");
    const fieldopsDir = path.join(dir, "apps", "fieldops");
    fs.mkdirSync(consoleDir, { recursive: true });
    fs.mkdirSync(portalDir, { recursive: true });
    fs.mkdirSync(fieldopsDir, { recursive: true });
    return { dir, consoleDir, portalDir, fieldopsDir };
  }

  beforeEach(() => {
    delete process.env.ENV_FILE;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.NEXT_PUBLIC_APP_NAME;
    delete process.env.NEXT_PUBLIC_APP_NAME_CONSOLE;
    delete process.env.NEXT_PUBLIC_APP_NAME_PORTAL;
    delete process.env.NEXT_PUBLIC_APP_NAME_FIELDOPS;
    delete process.env.NEXT_PUBLIC_APP_BASE_PATH;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.dontMock("dotenv");
  });

  test("maps SUPABASE_URL and SUPABASE_ANON_KEY to NEXT_PUBLIC_* when missing", () => {
    const { consoleDir } = makeTempRepo(
      [
        "SUPABASE_URL=https://temp.supabase.co",
        "SUPABASE_ANON_KEY=anon-key",
        "NEXT_PUBLIC_APP_NAME_CONSOLE=Console App"
      ].join("\n")
    );

    load(consoleDir);

    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://temp.supabase.co");
    expect(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("anon-key");
  });

  test("maps app-specific name to NEXT_PUBLIC_APP_NAME", () => {
    const { portalDir } = makeTempRepo("NEXT_PUBLIC_APP_NAME_PORTAL=Portal UI\n");
    delete process.env.NEXT_PUBLIC_APP_NAME;

    load(portalDir);

    expect(process.env.NEXT_PUBLIC_APP_NAME).toBe("Portal UI");
  });

  test("loads fallback public env values without dotenv installed", () => {
    const { consoleDir } = makeTempRepo(
      [
        "SUPABASE_URL=https://temp.supabase.co",
        "SUPABASE_ANON_KEY=anon-key",
        "NEXT_PUBLIC_APP_NAME_CONSOLE=Console App"
      ].join("\n")
    );

    load(consoleDir, { mockMissingDotenv: true });

    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://temp.supabase.co");
    expect(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("anon-key");
    expect(process.env.NEXT_PUBLIC_APP_NAME).toBe("Console App");
  });

  test("maps fieldops app-specific name to NEXT_PUBLIC_APP_NAME", () => {
    const { fieldopsDir } = makeTempRepo(
      "NEXT_PUBLIC_APP_NAME_FIELDOPS=Field Ops\n"
    );
    delete process.env.NEXT_PUBLIC_APP_NAME;

    load(fieldopsDir);

    expect(process.env.NEXT_PUBLIC_APP_NAME).toBe("Field Ops");
  });

  test("does not override existing NEXT_PUBLIC_APP_NAME", () => {
    const { consoleDir } = makeTempRepo(
      "NEXT_PUBLIC_APP_NAME_CONSOLE=Console Name\n"
    );
    process.env.NEXT_PUBLIC_APP_NAME = "Existing Name";

    load(consoleDir);

    expect(process.env.NEXT_PUBLIC_APP_NAME).toBe("Existing Name");
  });

  test("falls back to app directory name when app name is missing", () => {
    const { consoleDir } = makeTempRepo("SUPABASE_URL=https://temp.supabase.co\n");
    delete process.env.NEXT_PUBLIC_APP_NAME;

    load(consoleDir);

    expect(process.env.NEXT_PUBLIC_APP_NAME).toBe("Console");
  });

  test("resolves repo root from nested build directory", () => {
    const { consoleDir } = makeTempRepo(
      [
        "SUPABASE_URL=https://temp.supabase.co",
        "SUPABASE_ANON_KEY=anon-key",
        "NEXT_PUBLIC_APP_NAME_CONSOLE=Console App"
      ].join("\n")
    );
    const nestedDir = path.join(consoleDir, ".next", "server", "app");
    fs.mkdirSync(nestedDir, { recursive: true });
    delete process.env.NEXT_PUBLIC_APP_NAME;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    load(nestedDir);

    expect(process.env.NEXT_PUBLIC_APP_NAME).toBe("Console App");
    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://temp.supabase.co");
    expect(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("anon-key");
  });
});
