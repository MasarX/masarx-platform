const fs = jest.requireActual("fs");
const path = jest.requireActual("path");
const { spawnSync } = jest.requireActual("child_process");
const vm = jest.requireActual("vm");
const ts = jest.requireActual("typescript");

describe("landing E2E config", () => {
  const configFile = path.join(
    __dirname,
    "..",
    "..",
    "playwright.landing.config.ts"
  );

  function evaluateConfig(env, resolvedPort = 3333) {
    const resolvePort = jest.fn(() => resolvedPort);
    const resolveCache = jest.fn(() => "/unused-test-cache");
    const code = ts.transpileModule(fs.readFileSync(configFile, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const exports = {};
    vm.runInNewContext(code, {
      exports, process: { env: { ...env } }, URL,
      require: (name) => {
        if (name === "@playwright/test") return { defineConfig: value => value };
        if (name === "./apps/shared/security-headers.js") {
          return require("../../apps/shared/security-headers.js");
        }
        if (name === "./scripts/utils/resolve-local-web-server-port.js") {
          return { resolveLocalWebServerPort: resolvePort, resolveLocalWebServerPortCachePath: resolveCache };
        }
        throw new Error(`Unexpected config dependency: ${name}`);
      },
    });
    return { config: exports.default, resolvePort, resolveCache };
  }

  test.each([
    [{ LANDING_BASE_URL: "https://landing.example.test" }, false],
    [{ LANDING_BASE_URL: "http://127.0.0.2:3333" }, false],
    [{ LANDING_BASE_URL: "http://127.0.0.1:3333", STRICT_E2E_GATE_ENV: "1" }, true],
    [{ LANDING_BASE_URL: "http://127.0.0.2:3333", CI: "true" }, true],
  ])("external/governed origin avoids port/cache resolution %#", (env, governed) => {
    if (governed) {
      expect(() => evaluateConfig(env)).toThrow("Strict E2E loopback requires the dedicated public CI configuration.");
      return;
    }
    const result = evaluateConfig(env);
    expect(result.resolvePort).not.toHaveBeenCalled();
    expect(result.resolveCache).not.toHaveBeenCalled();
    expect(result.config.webServer).toBeUndefined();
  });

  test.each([
    [{}, 3334, true],
    [{ LANDING_BASE_URL: "http://127.0.0.1:3333" }, 3333, true],
    [{ LANDING_HOST: "custom.test", LANDING_BASE_URL: "http://custom.test:3334" }, 3334, true],
    [{ LANDING_HOST: "custom.test", LANDING_BASE_URL: "http://custom.test:3333" }, 3334, false],
  ])("local allocation and custom-host exact binding remain unchanged %#", (env, port, starts) => {
    const result = evaluateConfig(env, port);
    expect(result.resolvePort).toHaveBeenCalledTimes(1);
    expect(result.resolveCache).toHaveBeenCalledTimes(1);
    expect(Boolean(result.config.webServer)).toBe(starts);
  });

  test("guards against accidental server reuse on a conflicting port", () => {
    const body = fs.readFileSync(configFile, "utf8");

    expect(body).toMatch("LANDING_E2E_REUSE_SERVER");
    expect(body).toMatch("reuseExistingServer");
    expect(body).toMatch("resolveLocalWebServerPort");
    expect(body).toMatch("resolveLocalWebServerPortCachePath");
    expect(body).toMatch("LANDING_E2E_RUN_ID");
    expect(body).toMatch("localLoopbackHost");
    expect(body).toMatch("process.env.LANDING_HOST?.trim()");
    expect(body).toMatch("runId: process.env.GITHUB_RUN_ID || localRunId");
    expect(body).toMatch("allowOccupiedCachedPort: isCi || Boolean(process.env.LANDING_E2E_RUN_ID) || reuseExistingServer");
    expect(body).toMatch("LANDING_HOST=${localLoopbackHost}");
    expect(body).not.toMatch("reuseExistingServer: !isCi");
  });

  test("keeps Landing E2E bounded to an explicit one-to-four worker contract", () => {
    const body = fs.readFileSync(configFile, "utf8");

    expect(body).toContain("LANDING_E2E_WORKERS");
    expect(body).toContain("const landingWorkersRaw");
    expect(body).toContain('/^[1-4]$/');
    expect(body).toContain("Expected an integer from 1 through 4");
    expect(body).toContain("const landingWorkers = landingWorkersRaw ? Number(landingWorkersRaw) : 1");
    expect(body).toContain("workers: landingWorkers");
  });

  test("uses separate implemented local intake mocks for its own server only", () => {
    const body = fs.readFileSync(configFile, "utf8");
    expect(body).toContain('process.env.LANDING_TENANT_SIGNUP_ENDPOINT?.trim() || "/__tenant-signup"');
    expect(body).toContain('LANDING_TENANT_SIGNUP_ENDPOINT=${landingTenantSignupEndpoint}');
    expect(body).toContain('LANDING_ENABLE_INTAKE_MOCKS=1');
  });

  test("rejects strict loopback and leaves ordinary local startup unchanged", () => {
    const body = fs.readFileSync(configFile, "utf8");
    const normalized = body.replace(/\s+/g, "");

    expect(normalized).toContain("conststrictE2e=isCi||/^(1|true|yes)$/i.test(");
    expect(normalized).toContain("process.env.STRICT_E2E_GATE_ENV");
    expect(normalized).toContain("constgovernedLocalRuntime=strictE2e&&isGovernedLoopbackOrigin(resolvedOrigin)");
    expect(body).toContain('throw new Error("Strict E2E loopback requires the dedicated public CI configuration.")');
    expect(normalized).toContain("constshouldStartServer=!governedLocalRuntime&&(isOrdinaryLocalServerOrigin(resolvedOrigin)||explicitServerBindMatches)");
    expect(normalized).toContain('isLoopbackHostname(newURL(origin).hostname)');
    expect(normalized).toContain('forbidOnly:strictE2e');
    expect(normalized).toContain('projects:[{name:"landing"}]');
  });

  test("loads ordinary extended loopback without a server and rejects it in strict mode", () => {
    const cli = require.resolve("@playwright/test/cli");
    const run = (strict) => {
      const env = {
        ...process.env,
        CI: "",
        GITHUB_ACTIONS: "",
        STRICT_E2E_GATE_ENV: strict ? "1" : "",
        LANDING_BASE_URL: "http://127.0.0.2:3333",
      };
      delete env.JEST_WORKER_ID;
      return spawnSync(process.execPath, [
        cli, "test", "--config=playwright.landing.config.ts", "--list", "--project=landing",
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env,
      });
    };
    const ordinary = run(false);
    expect(ordinary.status).toBe(0);
    expect(ordinary.stdout).toContain("[landing]");
    const governed = run(true);
    expect(governed.status).not.toBe(0);
    expect(`${governed.stdout}\n${governed.stderr}`).toContain("Strict E2E loopback requires the dedicated public CI configuration.");
  });
});
