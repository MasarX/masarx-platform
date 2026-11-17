const fs = require("fs");
const path = require("path");

describe("landing E2E config", () => {
  test("guards against accidental server reuse on a conflicting port", () => {
    const file = path.join(
      __dirname,
      "..",
      "..",
      "playwright.landing.config.ts"
    );
    const body = fs.readFileSync(file, "utf8");

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
});

