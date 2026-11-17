const path = require("path");

describe("Next.js monorepo root config", () => {
  const repoRoot = path.resolve(__dirname, "../../..");

  test("console aligns output tracing and turbopack root", () => {
    const config = require("../../../apps/console/next.config.js");
    expect(config.outputFileTracingRoot).toBe(repoRoot);
    expect(config.turbopack?.root).toBe(repoRoot);
  });

  test("portal aligns output tracing and turbopack root", () => {
    const config = require("../../../apps/portal/next.config.js");
    expect(config.outputFileTracingRoot).toBe(repoRoot);
    expect(config.turbopack?.root).toBe(repoRoot);
  });
});

