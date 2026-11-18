import { defineConfig } from "@playwright/test";
import resolveLocalWebServerPortModule from "./scripts/utils/resolve-local-web-server-port.js";

const isCi = Boolean(process.env.CI);
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
const port = resolveLocalWebServerPort({
  preferredPort,
  cachePath: resolveLocalWebServerPortCachePath({
    preferredPort,
    runId: process.env.GITHUB_RUN_ID || localRunId,
  }),
  allowOccupiedCachedPort: isCi || Boolean(process.env.LANDING_E2E_RUN_ID) || reuseExistingServer,
});
const localLoopbackHost =
  process.env.LANDING_HOST?.trim()
  || "127.0.0.1"; // objectives:allow LOCALHOST Justification: Landing E2E defaults to the loopback host for the local static server.

const baseUrl =
  process.env.LANDING_BASE_URL?.trim()
  || `http://${localLoopbackHost}:${port}`;
const landingContactEndpoint =
  process.env.LANDING_CONTACT_ENDPOINT?.trim() || "/__landing-contact";
const landingTenantSignupEndpoint =
  process.env.LANDING_TENANT_SIGNUP_ENDPOINT?.trim() || "/__tenant-signup";

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

function isLocalhostOrigin(origin: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

const shouldStartServer = isLocalhostOrigin(new URL(resolvedBaseUrl).origin);

export default defineConfig({
  testDir: "./tests/landing-e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000
  },
  retries: isCi ? 2 : 0,
  use: {
    baseURL: resolvedBaseUrl,
    trace: isCi ? "on-first-retry" : "retain-on-failure",
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
          `LANDING_TURNSTILE_SITE_KEY= ` +
          `npm run dev:landing`,
        url: resolvedBaseUrl,
        reuseExistingServer,
        timeout: 120_000,
      }
    : undefined,
});
