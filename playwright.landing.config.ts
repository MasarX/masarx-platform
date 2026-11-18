import { defineConfig } from "@playwright/test";
import securityHeaders from "./apps/shared/security-headers.js";
import resolveLocalWebServerPortModule from "./scripts/utils/resolve-local-web-server-port.js";

const { isLoopbackHostname } = securityHeaders;

const isCi = Boolean(process.env.CI);
const strictE2e = isCi || /^(1|true|yes)$/i.test(
  String(process.env.STRICT_E2E_GATE_ENV ?? "").trim()
);
const { resolveLocalWebServerPort } = resolveLocalWebServerPortModule;
const { resolveLocalWebServerPortCachePath } = resolveLocalWebServerPortModule;
const localRunId =
  process.env.LANDING_E2E_RUN_ID?.trim()
  || `local-${Math.random().toString(36).slice(2, 10)}`;

process.env.LANDING_E2E_RUN_ID = localRunId;

const reuseExistingServer =
  /^(1|true|yes)$/i.test(String(process.env.LANDING_E2E_REUSE_SERVER ?? "").trim());

const portRaw = Number.parseInt(String(process.env.LANDING_E2E_PORT ?? ""), 10);
const preferredPort = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 3333;
const explicitBaseUrl = process.env.LANDING_BASE_URL?.trim();
const explicitOrigin = explicitBaseUrl
  ? new URL(resolveBaseUrl(explicitBaseUrl)).origin
  : null;
// A governed or external origin does not own a local server allocation.
// Custom-host candidates still resolve ports before the exact bind check below,
// preserving occupied/cached-port behavior and explicit origin mismatches.
const explicitCustomHostCandidate = Boolean(process.env.LANDING_HOST?.trim())
  && explicitOrigin !== null
  && new URL(explicitOrigin).hostname === new URL(localServerOrigin(
    process.env.LANDING_HOST!.trim(), preferredPort,
  )).hostname;
const needsLocalPort = explicitOrigin === null || (
  !(strictE2e && isGovernedLoopbackOrigin(explicitOrigin))
  && (isOrdinaryLocalServerOrigin(explicitOrigin) || explicitCustomHostCandidate)
);
const port = needsLocalPort ? resolveLocalWebServerPort({
  preferredPort,
  cachePath: resolveLocalWebServerPortCachePath({
    preferredPort,
    runId: process.env.GITHUB_RUN_ID || localRunId,
  }),
  allowOccupiedCachedPort: isCi || Boolean(process.env.LANDING_E2E_RUN_ID) || reuseExistingServer,
}) : preferredPort;
const localLoopbackHost =
  process.env.LANDING_HOST?.trim()
  || "127.0.0.1"; // objectives:allow LOCALHOST Justification: Landing E2E defaults to the loopback host for the local static server.

const baseUrl =
  process.env.LANDING_BASE_URL?.trim()
  || localServerOrigin(localLoopbackHost, port);
const landingContactEndpoint =
  process.env.LANDING_CONTACT_ENDPOINT?.trim() || "/__landing-contact";
const landingTenantSignupEndpoint =
  process.env.LANDING_TENANT_SIGNUP_ENDPOINT?.trim() || "/__tenant-signup";
const landingWorkersRaw = String(process.env.LANDING_E2E_WORKERS ?? "").trim();
if (landingWorkersRaw && !/^[1-4]$/.test(landingWorkersRaw)) {
  throw new Error(
    `Invalid LANDING_E2E_WORKERS "${landingWorkersRaw}". Expected an integer from 1 through 4.`
  );
}
const landingWorkers = landingWorkersRaw ? Number(landingWorkersRaw) : 1;

function trimTrailingSlash(value: string) {
  return value.length > 1 ? value.replace(/\/+$/g, "") : value;
}

function resolveBaseUrl(value: string) {
  try {
    const parsed = new URL(value);
    return trimTrailingSlash(parsed.origin + parsed.pathname);
  } catch (error) {
    throw new Error(
      `Invalid LANDING_BASE_URL "${value}". Expected an absolute URL like "https://www.example.com".`,
      { cause: error }
    );
  }
}

const resolvedBaseUrl = resolveBaseUrl(baseUrl);

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

function localServerOrigin(host: string, serverPort: number) {
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return new URL(`http://${urlHost}:${serverPort}`).origin;
}

const resolvedOrigin = new URL(resolvedBaseUrl).origin;
const governedLocalRuntime = strictE2e && isGovernedLoopbackOrigin(resolvedOrigin);
if (governedLocalRuntime) {
  throw new Error("Strict E2E loopback requires the dedicated public CI configuration.");
}
const explicitServerBindMatches = Boolean(process.env.LANDING_HOST?.trim())
  && resolvedOrigin === localServerOrigin(localLoopbackHost, port);
const shouldStartServer = !governedLocalRuntime
  && (isOrdinaryLocalServerOrigin(resolvedOrigin) || explicitServerBindMatches);

export default defineConfig({
  testDir: "./tests/landing-e2e",
  forbidOnly: strictE2e,
  timeout: 60_000,
  expect: {
    timeout: 10_000
  },
  retries: 0,
  workers: landingWorkers,
  projects: [{ name: "landing" }],
  reporter: isCi
    ? [
        ["list"],
        ["json", { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_FILE || "playwright-report.json" }],
        ["html", { outputFolder: process.env.PLAYWRIGHT_HTML_OUTPUT_DIR || "playwright-report", open: "never" }],
      ]
    : [["list"]],
  outputDir: process.env.PLAYWRIGHT_TEST_OUTPUT_DIR?.trim() || "test-results",
  use: {
    baseURL: resolvedBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: shouldStartServer
      ? {
        command:
          `cross-env LANDING_HOST=${localLoopbackHost} LANDING_PORT=${port} ` +
          `LANDING_SITE_URL=${resolvedBaseUrl} ` +
          `LANDING_APP_URL=https://app.example.com/login ` +
          `LANDING_CONTACT_ENDPOINT=${landingContactEndpoint} ` +
          `LANDING_TENANT_SIGNUP_ENDPOINT=${landingTenantSignupEndpoint} ` +
          `LANDING_ENABLE_INTAKE_MOCKS=1 ` +
          `LANDING_TURNSTILE_SITE_KEY= ` +
          `npm run dev:landing`,
        url: resolvedBaseUrl,
        reuseExistingServer,
        timeout: 120_000,
      }
    : undefined,
});
