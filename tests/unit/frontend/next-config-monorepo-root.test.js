const fs = require("fs");
const path = require("path");

test.each(["console", "portal"])("%s stages map assets only in dev/build phases", async (app) => {
  const helper = require("../../../scripts/frontend/prepare-map-worker");
  const prepare = jest.spyOn(helper, "prepareMapWorker").mockImplementation(() => {});
  try {
    const config = require(`../../../apps/${app}/next.config.js`);
    // Next typegen also uses the real production-build phase; it has no separate phase.
    for (const phase of ["phase-development-server", "phase-production-build"]) {
      await config(phase, {});
      expect(prepare).toHaveBeenLastCalledWith(path.resolve(__dirname, "../../../apps", app));
    }
    expect(prepare).toHaveBeenCalledTimes(2);
    await config("phase-production-server", {});
    expect(prepare).toHaveBeenCalledTimes(2);
  } finally { prepare.mockRestore(); }
});

describe("Next.js monorepo root config", () => {
  const repoRoot = path.resolve(__dirname, "../../..");

  test("console aligns output tracing and turbopack root", async () => {
    const config = await require("../../../apps/console/next.config.js")("phase-production-server", {});
    expect(config.outputFileTracingRoot).toBe(repoRoot);
    expect(config.turbopack?.root).toBe(repoRoot);
    expect(fs.readFileSync(path.join(repoRoot, "apps/console/next.config.js"), "utf8"))
      .not.toMatch(/next-react-singleton|next\/dist\/compiled\/react/u);
  });

  test("portal aligns output tracing and turbopack root", async () => {
    const config = await require("../../../apps/portal/next.config.js")("phase-production-server", {});
    expect(config.outputFileTracingRoot).toBe(repoRoot);
    expect(config.turbopack?.root).toBe(repoRoot);
    expect(fs.readFileSync(path.join(repoRoot, "apps/portal/next.config.js"), "utf8"))
      .not.toMatch(/next-react-singleton|next\/dist\/compiled\/react/u);
  });

  test.each(["console", "portal"])("%s resolves selected workspace imports and the real locale plugin", async (app) => {
    const appDir = path.join(repoRoot, "apps", app);
    const resolve = require("module").createRequire(path.join(appDir, "package.json")).resolve;
    const selectedImports = [
      ["@masarx/api", "packages/api/src/index.ts"],
      ["@masarx/api/server", "packages/api/src/server.ts"],
      ["@masarx/auth", "packages/auth/src/index.ts"],
      ["@masarx/auth/browser", "packages/auth/src/browser.ts"],
      ["@masarx/auth/server", "packages/auth/src/server.ts"],
      ["@masarx/config", "packages/config/src/index.ts"],
      ["@masarx/config/messages/en.json", "packages/config/messages/en.json"],
      ["@masarx/ui", "packages/ui/src/index.ts"],
      ["@masarx/ui/client", "packages/ui/src/client.ts"],
      ["@masarx/ui/tailwind-preset", "packages/ui/tailwind-preset.js"],
    ];
    for (const [specifier, expected] of selectedImports) {
      expect(fs.realpathSync(resolve(specifier))).toBe(fs.realpathSync(path.join(repoRoot, expected)));
    }
    const config = await require(path.join(appDir, "next.config.js"))("phase-production-server", {});
    expect(config.transpilePackages).toEqual(expect.arrayContaining([
      "@masarx/api", "@masarx/auth", "@masarx/config", "@masarx/ui",
    ]));
    // Inspect the actual plugin-produced configuration, not a mocked plugin or copied alias map.
    const localeModule = config.turbopack?.resolveAlias?.["next-intl/config"];
    expect(typeof localeModule).toBe("string");
    expect(fs.realpathSync(path.resolve(appDir, localeModule)))
      .toBe(fs.realpathSync(path.join(appDir, "i18n/request.ts")));
  });

  test("Next owns React aliases without a shared private-module override", () => {
    expect(fs.existsSync(path.join(repoRoot, "apps/shared/next-react-singleton.js")))
      .toBe(false);
  });

  test.each(["console", "portal"].flatMap(app => [1, 4].map(cpus => [app, cpus])))(
    "%s bounds build workers to %i available CPUs", async (app, cpus) => {
      const parallelism = jest.spyOn(require("node:os"), "availableParallelism").mockReturnValue(cpus);
      try {
        await jest.isolateModulesAsync(async () => {
          const config = await require(`../../../apps/${app}/next.config.js`)("phase-production-server", {});
          expect(config.experimental.cpus).toBe(cpus);
        });
      } finally { parallelism.mockRestore(); }
    }
  );
});
