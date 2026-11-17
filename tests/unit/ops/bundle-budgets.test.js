const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const sourceScript = path.resolve(__dirname, "../../../scripts/frontend/check-bundle-budgets.js");
let fixtureRoot;

function write(relativePath, value) {
  const file = path.join(fixtureRoot, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

function asset(name, bytes) {
  write(`apps/console/.next/${name}`, "x".repeat(bytes));
}

function clientManifest(route, extraFiles = []) {
  const payload = {
    entryJSFiles: { layout: ["static/shared.js"], page: ["static/page.js", ...extraFiles] },
    entryCSSFiles: { layout: [{ path: "static/styles.css", inlined: false }] },
    clientModules: { module: { chunks: ["123", "/_next/static/shared.js", "/_next/static/deferred.js"] } },
  };
  write(`apps/console/.next/server/app/${route.slice(1)}_client-reference-manifest.js`,
    `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\nglobalThis.__RSC_MANIFEST[${JSON.stringify(route)}] = ${JSON.stringify(payload)};`);
}

function modernBuild() {
  write("apps/console/.next/BUILD_ID", "fixture-production-build");
  write("apps/console/.next/build-manifest.json", {
    pages: {}, rootMainFiles: ["static/runtime.js"],
    // Nomodule polyfills are excluded from the modern browser client graph.
    polyfillFiles: ["static/legacy-polyfill.js"],
  });
  write("apps/console/.next/app-path-routes-manifest.json", {
    "/page": "/", "/api/status/route": "/api/status", "/_not-found/page": "/_not-found",
  });
  asset("static/runtime.js", 10);
  asset("static/shared.js", 20);
  asset("static/page.js", 30);
  asset("static/styles.css", 5);
  asset("static/deferred.js", 7);
  clientManifest("/page");
}

function run(...args) {
  const result = spawnSync(process.execPath,
    [path.join(fixtureRoot, "scripts/frontend/check-bundle-budgets.js"), ...args],
    { cwd: fixtureRoot, encoding: "utf8" });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

function budgets() {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, "config/tooling/bundle-budgets.json"), "utf8"));
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "masarx-bundle-budget-"));
  write("scripts/frontend/check-bundle-budgets.js", fs.readFileSync(sourceScript, "utf8"));
  write("config/tooling/bundle-budgets.json", {
    apps: {
      console: { root: "apps/console", defaultMaxBytes: 100, routes: [] },
      portal: { root: "apps/portal", defaultMaxBytes: 123, routes: [{ route: "/", maxBytes: 100 }] },
    },
  });
});

afterEach(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

test("Next 16 client references enforce real routes and deduplicate normalized JS/CSS assets", () => {
  modernBuild();
  expect(run("--app", "console").status).toBe(0);
  const beforePortal = budgets().apps.portal;
  const writeResult = run("--write", "--app=console");
  expect(writeResult.status).toBe(0);
  expect(budgets().apps.console.routes).toEqual([{ route: "/", currentBytes: 72, maxBytes: 80 }]);
  expect(budgets().apps.console.defaultMaxBytes).toBe(88);
  expect(budgets().apps.portal).toEqual(beforePortal);
  expect(budgets().measurement).toBe("uncompressed-route-referenced-js-css");
  expect(run("--app", "console").status).toBe(0);
});

test("a modern route exceeding its configured limit fails", () => {
  modernBuild();
  const config = budgets();
  config.apps.console.routes = [{ route: "/", maxBytes: 71 }];
  write("config/tooling/bundle-budgets.json", config);
  const result = run("--app", "console");
  expect(result.status).toBe(1);
  expect(result.output).toContain("/ is 72 B (limit 71 B, route budget)");
});

test.each([[[]], [["--write"]]])("empty route evidence fails closed with args %j", (args) => {
  modernBuild();
  write("apps/console/.next/app-path-routes-manifest.json", {});
  const original = budgets();
  const result = run("--app", "console", ...args);
  expect(result.status).toBe(1);
  expect(result.output).toContain("No public page route evidence");
  expect(budgets()).toEqual(original);
});

test.each([[[]], [["--write"]]])("missing modern client manifest fails with args %j", (args) => {
  modernBuild();
  fs.unlinkSync(path.join(fixtureRoot, "apps/console/.next/server/app/page_client-reference-manifest.js"));
  const original = budgets();
  const result = run("--app", "console", ...args);
  expect(result.status).toBe(1);
  expect(result.output).toContain("Missing client reference manifest");
  expect(budgets()).toEqual(original);
});

test.each([[[]], [["--write"]]])("a missing referenced asset fails before baseline writes with args %j", (args) => {
  modernBuild();
  fs.unlinkSync(path.join(fixtureRoot, "apps/console/.next/static/deferred.js"));
  const original = budgets();
  const result = run("--app", "console", ...args);
  expect(result.status).toBe(1);
  expect(result.output).toContain("missing asset");
  expect(budgets()).toEqual(original);
});

test("legacy App Router manifests retain shared layout assets and public route mapping", () => {
  modernBuild();
  write("apps/console/.next/app-build-manifest.json", {
    pages: { "/layout": ["static/shared.js"], "/shipments/page": ["static/page.js"] },
  });
  write("apps/console/.next/app-path-routes-manifest.json", { "/shipments/page": "/shipments" });
  expect(run("--write", "--app", "console").status).toBe(0);
  expect(budgets().apps.console.routes).toEqual([{ route: "/shipments", currentBytes: 50, maxBytes: 56 }]);
  expect(run("--app", "console").status).toBe(0);
});

test("legacy Pages Router manifests retain shared app/error assets without an app route map", () => {
  modernBuild();
  fs.unlinkSync(path.join(fixtureRoot, "apps/console/.next/app-path-routes-manifest.json"));
  write("apps/console/.next/build-manifest.json", {
    pages: { "/_app": ["static/shared.js"], "/_error": ["static/runtime.js"], "/tracking": ["static/page.js"] },
  });
  expect(run("--write", "--app", "console").status).toBe(0);
  expect(budgets().apps.console.routes).toEqual([{ route: "/tracking", currentBytes: 60, maxBytes: 66 }]);
});

test("grouped app paths mapping to one public route union assets instead of overwriting", () => {
  modernBuild();
  write("apps/console/.next/app-path-routes-manifest.json", { "/(first)/page": "/", "/(second)/page": "/" });
  clientManifest("/(first)/page");
  clientManifest("/(second)/page", ["static/variant.js"]);
  asset("static/variant.js", 11);
  expect(run("--write", "--app", "console").status).toBe(0);
  expect(budgets().apps.console.routes[0].currentBytes).toBe(83);
});

test("route-specific shared runtime trees take precedence over the generic runtime list", () => {
  modernBuild();
  write("apps/console/.next/build-manifest.json", {
    pages: {}, rootMainFiles: ["static/unused-runtime.js"], rootMainFilesTree: { "/page": ["static/runtime.js"] },
  });
  expect(run("--write", "--app", "console").status).toBe(0);
  expect(budgets().apps.console.routes[0].currentBytes).toBe(72);
});

test("manifest code is parsed as JSON rather than executed", () => {
  modernBuild();
  const file = path.join(fixtureRoot, "apps/console/.next/server/app/page_client-reference-manifest.js");
  fs.writeFileSync(file, `throw new Error("must never execute");\n${fs.readFileSync(file, "utf8")}`);
  expect(run("--app", "console").status).toBe(0);
});

test("baseline generation requires a completed production build", () => {
  modernBuild();
  fs.unlinkSync(path.join(fixtureRoot, "apps/console/.next/BUILD_ID"));
  const result = run("--write", "--app", "console");
  expect(result.status).toBe(1);
  expect(result.output).toContain("Missing production BUILD_ID");
});

test("unknown app selections fail instead of succeeding without checks", () => {
  const result = run("--app", "missing-app");
  expect(result.status).toBe(1);
  expect(result.output).toContain("Unknown or missing app");
});
