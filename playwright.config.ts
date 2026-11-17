import { defineConfig } from "@playwright/test";
import { isTruthy, loadE2EEnv } from "./tests/e2e/utils/env";
import { resolveVercelBypassHeaders } from "./tests/e2e/utils/vercel-bypass";
import { mergeAllowedDevOrigins } from "./apps/shared/next-dev-origins";
import securityHeaders from "./apps/shared/security-headers.js";

const { isLoopbackHostname } = securityHeaders;

loadE2EEnv();

const isCi = Boolean(process.env.CI);
const strictE2e = isCi || isTruthy(process.env.STRICT_E2E_GATE_ENV);
const requireBaseUrls =
  isTruthy(process.env.E2E_REQUIRE_BASE_URLS) || strictE2e;
const shouldForceClean = /^(1|true|yes)$/i.test(
  String(process.env.E2E_FORCE_CLEAN ?? "").trim()
);
const localWorkersRaw = Number.parseInt(process.env.E2E_WORKERS ?? "", 10);
const localWorkers =
  Number.isFinite(localWorkersRaw) && localWorkersRaw > 0 ? localWorkersRaw : isCi ? 1 : 4;
const webServerTimeoutRaw = Number.parseInt(
  process.env.E2E_WEB_SERVER_TIMEOUT_MS ?? "",
  10
);
const webServerTimeoutMs =
  Number.isFinite(webServerTimeoutRaw) && webServerTimeoutRaw > 0
    ? webServerTimeoutRaw
    : 180_000;
const testTimeoutRaw = Number.parseInt(process.env.E2E_TEST_TIMEOUT_MS ?? "", 10);
const testTimeoutMs =
  Number.isFinite(testTimeoutRaw) && testTimeoutRaw > 0
    ? testTimeoutRaw
    : 60_000;
const expectTimeoutRaw = Number.parseInt(process.env.E2E_EXPECT_TIMEOUT_MS ?? "", 10);
const expectTimeoutMs =
  Number.isFinite(expectTimeoutRaw) && expectTimeoutRaw > 0
    ? expectTimeoutRaw
    : 10_000;
const recordHarPath = String(process.env.E2E_RECORD_HAR_PATH ?? "").trim();
const vercelBypassHeaders = resolveVercelBypassHeaders(process.env);
const KNOWN_E2E_PROJECTS = ["console", "a11y", "shared", "portal"] as const;

const DEFAULT_ORIGINS = {
  console: "http://localhost:3001", // objectives:allow LOCALHOST Justification: Local E2E defaults; strict base URL required in CI/STRICT_E2E_GATE_ENV.
  portal: "http://localhost:3002", // objectives:allow LOCALHOST Justification: Local E2E defaults; strict base URL required in CI/STRICT_E2E_GATE_ENV.
};

const DEFAULT_BASE_PATHS = {
  console: "/",
  portal: "/",
};

function parseRequestedProjects(raw: string | undefined) {
  const requested = Array.from(
    new Set(
      String(raw ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    )
  );
  const invalid = requested.filter(
    (project) => !KNOWN_E2E_PROJECTS.includes(project as (typeof KNOWN_E2E_PROJECTS)[number])
  );
  if (invalid.length > 0) {
    throw new Error(
      `Invalid E2E_PROJECTS=${JSON.stringify(requested)}. Expected a subset of ${JSON.stringify(KNOWN_E2E_PROJECTS)}.`
    );
  }
  return new Set(requested);
}

function trimTrailingSlash(value: string) {
  return value.length > 1 ? value.replace(/\/+$/g, "") : value;
}

function parseOriginAndPath(urlValue: string, fallbackPath: string, envKey: string) {
  try {
    const parsed = new URL(urlValue);
    const path = trimTrailingSlash(parsed.pathname || "");
    if (path && path !== "/") {
      throw new Error(
        `${envKey} must be host-root (remove path "${path}").`
      );
    }
    return { origin: parsed.origin, path: fallbackPath };
  } catch (error) {
    throw new Error(
      `Invalid base URL "${urlValue}". Expected a host-root absolute URL like "http://example.com:3001".`,
      { cause: error }
    );
  }
}

const requestedProjects = parseRequestedProjects(
  process.env.E2E_PROJECTS ?? process.env.E2E_PROJECT
);

function isProjectSelected(
  ...projects: Array<(typeof KNOWN_E2E_PROJECTS)[number]>
) {
  return requestedProjects.size === 0 || projects.some((project) => requestedProjects.has(project));
}

const consoleResolved = process.env.CONSOLE_BASE_URL
  ? parseOriginAndPath(
      process.env.CONSOLE_BASE_URL,
      DEFAULT_BASE_PATHS.console,
      "CONSOLE_BASE_URL"
    )
  : requireBaseUrls && isProjectSelected("console", "a11y", "shared")
    ? undefined
    : { origin: DEFAULT_ORIGINS.console, path: DEFAULT_BASE_PATHS.console }; // objectives:allow LOCALHOST Justification: Playwright uses localhost baseURL for local E2E runs.

const portalResolved = process.env.PORTAL_BASE_URL
  ? parseOriginAndPath(
      process.env.PORTAL_BASE_URL,
      DEFAULT_BASE_PATHS.portal,
      "PORTAL_BASE_URL"
    )
  : requireBaseUrls && isProjectSelected("portal")
    ? undefined
    : { origin: DEFAULT_ORIGINS.portal, path: DEFAULT_BASE_PATHS.portal }; // objectives:allow LOCALHOST Justification: Playwright uses localhost baseURL for local E2E runs.

if (
  (isProjectSelected("console", "a11y", "shared") && !consoleResolved) ||
  (isProjectSelected("portal") && !portalResolved)
) {
  throw new Error(
    "Missing required hosted base URL for the selected E2E projects. Set the necessary CONSOLE_BASE_URL and/or PORTAL_BASE_URL before running E2E, or unset CI/E2E_REQUIRE_BASE_URLS for local runs."
  );
}

const consoleBase = (consoleResolved ?? { origin: DEFAULT_ORIGINS.console }).origin; // objectives:allow LOCALHOST Justification: Playwright uses localhost baseURL for local E2E runs.
const portalBase = (portalResolved ?? { origin: DEFAULT_ORIGINS.portal }).origin; // objectives:allow LOCALHOST Justification: Playwright uses localhost baseURL for local E2E runs.

function isGovernedLoopbackOrigin(origin: string) {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function isOrdinaryLocalServerOrigin(origin: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

const selectedLocalSurfaces = [
  ...(isProjectSelected("console", "a11y", "shared") && isGovernedLoopbackOrigin(consoleBase) ? ["console"] : []),
  ...(isProjectSelected("portal") && isGovernedLoopbackOrigin(portalBase) ? ["portal"] : []),
];
if (requireBaseUrls && selectedLocalSurfaces.length > 0) {
  throw new Error("Strict E2E loopback requires the dedicated public CI configuration.");
}
const shouldStartLocalServers =
  !requireBaseUrls;
const localAllowedDevOrigins = mergeAllowedDevOrigins(
  process.env.NEXT_ALLOWED_DEV_ORIGINS,
  [consoleBase, portalBase],
).join(",");
const localWebServerEnv = {
  ...process.env,
  NEXT_ALLOWED_DEV_ORIGINS: localAllowedDevOrigins,
};

const localWebServers = shouldStartLocalServers
  ? [
      ...(isProjectSelected("console", "a11y", "shared") && isOrdinaryLocalServerOrigin(consoleBase)
        ? [
            {
              command: shouldForceClean
                ? "node scripts/tests/stop-port-listeners.js 3001 && node scripts/tests/clear-next-cache.js apps/console && npm run dev:console"
                : "npm run dev:console",
              url: `${consoleResolved.origin}${consoleResolved.path}`,
              reuseExistingServer: !shouldForceClean,
              timeout: webServerTimeoutMs,
              env: localWebServerEnv,
            },
          ]
        : []),
      ...(isProjectSelected("portal") && isOrdinaryLocalServerOrigin(portalBase)
        ? [
            {
              command: shouldForceClean
                ? "node scripts/tests/stop-port-listeners.js 3002 && node scripts/tests/clear-next-cache.js apps/portal && npm run dev:portal"
                : "npm run dev:portal",
              url: `${portalResolved.origin}${portalResolved.path}`,
              reuseExistingServer: !shouldForceClean,
              timeout: webServerTimeoutMs,
              env: localWebServerEnv,
            },
          ]
        : []),
    ]
  : [];

export default defineConfig({
  testDir: "./tests/e2e",
  forbidOnly: strictE2e,
  timeout: testTimeoutMs,
  expect: {
    timeout: expectTimeoutMs
  },
  workers: localWorkers,
  retries: 0,
  reporter: isCi
    ? [
        ["list"],
        ["html", { outputFolder: process.env.PLAYWRIGHT_HTML_OUTPUT_DIR || "playwright-report", open: "never" }],
      ]
    : [["list"]],
  outputDir: process.env.PLAYWRIGHT_TEST_OUTPUT_DIR?.trim() || "test-results",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    ...(vercelBypassHeaders
      ? {
          // Required for protected Vercel preview deployments in live E2E lanes.
          extraHTTPHeaders: vercelBypassHeaders,
        }
      : {}),
    ...(recordHarPath
      ? {
          // Captures the backend interactions used by QA evidence matrix generation.
          recordHar: {
            path: recordHarPath,
            mode: "minimal",
            content: "omit",
          },
        }
      : {}),
  },
  webServer: localWebServers.length > 0 ? localWebServers : undefined,
  projects: [
    {
      name: "console",
      testMatch: /console.*\.spec\.ts/,
      use: {
        baseURL: consoleBase
      }
    },
    {
      name: "a11y",
      testMatch: /a11y.*\.spec\.ts/,
      use: {
        baseURL: consoleBase
      }
    },
    {
      name: "shared",
      testMatch: /(^|\/)(action|logging|navigation|labels).*\.spec\.ts/,
      use: {
        baseURL: consoleBase
      }
    },
    {
      name: "portal",
      testMatch: /portal.*\.spec\.ts/,
      use: {
        baseURL: portalBase
      }
    }
  ]
});
