import { NextRequest } from "next/server";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { proxy } from "../../../apps/console/proxy";

const environmentKeys = ["NEXT_PUBLIC_FIELDOPS_DEV_HOSTING", "MASARX_VERCEL_STAGE", "NEXT_PUBLIC_SUPABASE_URL", "NODE_ENV"];
let previousEnvironment: Record<string, string | undefined>;
beforeEach(() => {
  previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = "production";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://backend.example";
});
afterEach(() => {
  for (const key of environmentKeys) {
    if (previousEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnvironment[key];
  }
});

async function consoleConfig(enabled: boolean) {
  process.env.NEXT_PUBLIC_FIELDOPS_DEV_HOSTING = enabled ? "1" : "0";
  process.env.MASARX_VERCEL_STAGE = "dev";
  let config: any;
  jest.isolateModules(() => { config = require("../../../apps/console/next.config.js"); });
  return await config(PHASE_PRODUCTION_BUILD, {});
}

test("default Console config retains its existing headers and canonical route behavior", async () => {
  const config = await consoleConfig(false);
  expect(config.skipTrailingSlashRedirect).toBeUndefined();
  expect(config.redirects).toBeUndefined();
  expect(config.rewrites).toBeUndefined();
  const headers = await config.headers();
  expect(headers).toHaveLength(1);
  expect(headers[0].headers).toContainEqual({ key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" });
});

test("DEV FieldOps receives static CSP and permissions only inside its own path", async () => {
  const config = await consoleConfig(true);
  const headers = await config.headers();
  const original = headers.find((rule: any) => rule.source === "/:path*");
  const fieldops = headers.find((rule: any) => rule.source === "/fieldops/:path*");
  expect(original.headers).toContainEqual({ key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" });
  expect(fieldops.headers).toContainEqual({ key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(self)" });
  expect(fieldops.headers).toContainEqual({ key: "Cache-Control", value: "public, max-age=0, must-revalidate" });
  const csp = fieldops.headers.find((header: any) => header.key === "Content-Security-Policy").value;
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("connect-src 'self' https://backend.example wss://backend.example");
  expect(csp).not.toMatch(/nonce-|strict-dynamic|unsafe-eval|script-src[^;]*unsafe-inline/);
  expect(fieldops.headers.some((header: any) => header.key === "Service-Worker-Allowed")).toBe(false);
});

test("Next validates the scoped directory rewrite and preserves ordinary Console slash redirects", async () => {
  const config = await consoleConfig(true);
  const loadCustomRoutes = require("next/dist/lib/load-custom-routes").default;
  const { buildCustomRoute } = require("next/dist/lib/build-custom-route");
  const routes = await loadCustomRoutes({ ...config, basePath: "", assetPrefix: "", trailingSlash: false, experimental: {} });
  expect(routes.rewrites.beforeFiles).toEqual([{ source: "/fieldops/", destination: "/fieldops/index.html" }]);
  const { getPathMatch } = require("next/dist/shared/lib/router/utils/path-match");
  const { prepareDestination } = require("next/dist/shared/lib/router/utils/prepare-destination");
  const canonical = routes.redirects.find((route: any) => route.destination === "/:path");
  const canonicalRegex = new RegExp(buildCustomRoute("redirect", canonical, ["/_next/"]).regex);
  const match = getPathMatch(canonical.source, { strict: true });
  expect(canonicalRegex.test("/fieldops/")).toBe(false);
  for (const pathname of ["/signin/", "/shipments/123/", "/fieldops-other/", "/fieldops/assets/file/"]) {
    expect(canonicalRegex.test(pathname)).toBe(true);
    const params = match(pathname);
    expect(params).toBeTruthy();
    const destination = prepareDestination({ destination: canonical.destination, params, query: { q: "fixture" }, appendParamsToQuery: false });
    expect(destination.parsedDestination.pathname).toBe(pathname.slice(0, -1));
    expect(destination.parsedDestination.query.q).toBe("fixture");
  }
  expect(match("/")).toBe(false);
  const entry = routes.redirects.find((route: any) => route.destination === "/fieldops/");
  const entryRegex = new RegExp(buildCustomRoute("redirect", entry, ["/_next/"]).regex);
  expect(entryRegex.test("/fieldops")).toBe(true);
  // The production compiler permits an optional slash; strict getPathMatch alone hides a self-redirect.
  for (const pathname of ["/fieldops/", "/fieldops/index.html", "/fieldops/sw.js", "/fieldops-other"]) {
    expect(entryRegex.test(pathname)).toBe(false);
  }
  const entryParams = getPathMatch(entry.source)("/fieldops");
  const destination = prepareDestination({ destination: entry.destination, params: entryParams,
    query: { q: "fixture" }, appendParamsToQuery: false });
  expect(destination.parsedDestination.pathname).toBe("/fieldops/");
  expect(destination.parsedDestination.query.q).toBe("fixture");
  const rewriteRegex = new RegExp(buildCustomRoute("rewrite", routes.rewrites.beforeFiles[0]).regex);
  expect(rewriteRegex.test("/fieldops/")).toBe(true);
});

test.each(["/fieldops", "/fieldops/", "/fieldops/index.html", "/fieldops/manifest.json"])("DEV proxy leaves scoped static CSP intact for %s", async (pathname) => {
  await consoleConfig(true);
  const response = proxy(new NextRequest(`https://console-dev.example${pathname}`));
  expect(response.headers.has("x-nonce")).toBe(false);
  expect(response.headers.has("Content-Security-Policy")).toBe(false);
});

test.each(["/signin", "/shipments", "/fieldops-other"])("Console security stays active for %s", async (pathname) => {
  await consoleConfig(true);
  const response = proxy(new NextRequest(`https://console-dev.example${pathname}`));
  expect(response.headers.get("Content-Security-Policy")).toContain("strict-dynamic");
  expect(response.headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
});

test("non-DEV/default proxy preserves Console security even on the unused FieldOps path", async () => {
  await consoleConfig(false);
  const response = proxy(new NextRequest("https://console.example/fieldops/"));
  expect(response.headers.get("Content-Security-Policy")).toContain("strict-dynamic");
});
