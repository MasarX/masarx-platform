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
    loadPublicEnv({ appDir, initialEnv: options.initialEnv });
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

  test("treats app-local-equal process values as preloaded without letting later workspace files win", () => {
    const { dir, consoleDir } = makeTempRepo(
      "NEXT_PUBLIC_SUPABASE_URL=https://cloud.example.com\nSUPABASE_ANON_KEY=cloud-anon\n"
    );
    fs.writeFileSync(path.join(dir, "config", "env", ".env.local"),
      "NEXT_PUBLIC_SUPABASE_URL=http/example/workspace=workspace-local-anon\n");
    fs.writeFileSync(path.join(consoleDir, ".env.local"),
      "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\nSUPABASE_ANON_KEY=stale-app-anon\n");
    fs.writeFileSync(path.join(consoleDir, ".env"),
      "NEXT_PUBLIC_SUPABASE_URL=https://app-default.example.com\nSUPABASE_ANON_KEY=app-default-anon\n");
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_ANON_KEY = "stale-app-anon";

    load(consoleDir, { initialEnv: {} });

    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://cloud.example.com");
    expect(process.env.SUPABASE_ANON_KEY).toBe("cloud-anon");
    expect(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("cloud-anon");
  });

  test("keeps distinct process overrides and gives ENV_FILE priority over other files", () => {
    const { dir, portalDir } = makeTempRepo(
      "NEXT_PUBLIC_SUPABASE_URL=https://cloud.example.com\nSUPABASE_ANON_KEY=cloud-anon\n"
    );
    fs.writeFileSync(path.join(dir, "explicit.env"),
      "NEXT_PUBLIC_SUPABASE_URL=https://explicit.example.com\nSUPABASE_ANON_KEY=explicit-anon\n");
    fs.writeFileSync(path.join(portalDir, ".env.local"),
      "NEXT_PUBLIC_SUPABASE_URL=https://app.example.com\nSUPABASE_ANON_KEY=app-anon\n");
    process.env.ENV_FILE = "explicit.env";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://process.example.com";

    load(portalDir);

    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://process.example.com");
    expect(process.env.SUPABASE_ANON_KEY).toBe("explicit-anon");
    expect(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("explicit-anon");
  });

  test("preserves distinct private and public process overrides", () => {
    const { fieldopsDir } = makeTempRepo(
      "NEXT_PUBLIC_SUPABASE_URL=https://cloud.example.com\nSUPABASE_ANON_KEY=cloud-anon\n"
    );
    fs.writeFileSync(path.join(fieldopsDir, ".env.local"),
      "NEXT_PUBLIC_SUPABASE_URL=https://app.example.com\nSUPABASE_ANON_KEY=app-anon\n");
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://process.example.com";
    process.env.SUPABASE_ANON_KEY = "process-anon";

    load(fieldopsDir);

    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://process.example.com");
    expect(process.env.SUPABASE_ANON_KEY).toBe("process-anon");
    expect(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("process-anon");
  });
  test.each([false, true])("workspace coordinates replace only Next-preloaded app values, fallback=%s", (fallback) => {
    const { consoleDir } = makeTempRepo((fallback ? "SUPABASE_URL" : "NEXT_PUBLIC_SUPABASE_URL") + "=http/example/workspace");
    fs.writeFileSync(path.join(consoleDir, ".env.local"), "NEXT_PUBLIC_SUPABASE_URL=https://stale.supabase.co\n");
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stale.supabase.co";
    load(consoleDir, { initialEnv: {} });
    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBe("http/example/workspace");
  });
  test.each(["https://stale.supabase.co", "https://explicit.supabase.co"])("preserves true startup override %s even when it matches the app file", (url) => {
    const { consoleDir } = makeTempRepo("NEXT_PUBLIC_SUPABASE_URL=http/example/workspace");
    fs.writeFileSync(path.join(consoleDir, ".env.local"), "NEXT_PUBLIC_SUPABASE_URL=https://stale.supabase.co\n");
    process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    load(consoleDir, { initialEnv: { NEXT_PUBLIC_SUPABASE_URL: url } });
    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBe(url);
  });
  test("generic non-Next callers retain explicit process values", () => {
    const { fieldopsDir } = makeTempRepo("NEXT_PUBLIC_SUPABASE_URL=http/example/workspace");
    fs.writeFileSync(path.join(fieldopsDir, ".env.local"), "NEXT_PUBLIC_SUPABASE_URL=https://explicit.supabase.co\n");
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://explicit.supabase.co";
    load(fieldopsDir);
    expect(process.env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://explicit.supabase.co");
  });

  test.each(["console", "portal"])("empty higher-priority placeholders do not mask %s public values", (app) => {
    const { dir, consoleDir, portalDir } = makeTempRepo(
      "NEXT_PUBLIC_UI_FILTER_OP_LABELS=\nNEXT_PUBLIC_SUPABASE_ANON_KEY=\n");
    fs.writeFileSync(path.join(dir, "config", "env", ".env.local"),
      'NEXT_PUBLIC_UI_FILTER_OP_LABELS={"eq":"Equal"}\nNEXT_PUBLIC_SUPABASE_ANON_KEY=workspace-anon\n');
    delete process.env.NEXT_PUBLIC_UI_FILTER_OP_LABELS;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "";
    load(app === "console" ? consoleDir : portalDir, { initialEnv: { NEXT_PUBLIC_SUPABASE_ANON_KEY: "" } });
    expect(process.env.NEXT_PUBLIC_UI_FILTER_OP_LABELS).toBe('{"eq":"Equal"}');
    expect(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("workspace-anon");
  });
  test.each(["console", "portal"])("Next-preloaded %s anon keys yield to workspace credentials", (app) => {
    const { consoleDir, portalDir } = makeTempRepo("NEXT_PUBLIC_SUPABASE_ANON_KEY=workspace-anon\n");
    const appDir = app === "console" ? consoleDir : portalDir;
    fs.writeFileSync(path.join(appDir, ".env.local"), "NEXT_PUBLIC_SUPABASE_ANON_KEY=stale-anon\n");
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stale-anon";
    load(appDir, { initialEnv: {} });
    expect(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("workspace-anon");
  });

});
