import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

import { loadEnv } from "./scripts/utils/load-env.js";

loadEnv();

const isCi = Boolean(process.env.CI);

const portRaw = Number.parseInt(String(process.env.FIELDOPS_E2E_PORT ?? ""), 10);
const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 8081;

const reuseExistingServer =
  !isCi && /^(1|true|yes)$/i.test(String(process.env.FIELDOPS_E2E_REUSE_SERVER ?? "").trim());

const baseUrl =
  process.env.FIELDOPS_BASE_URL?.trim()
  || `http://127.0.0.1:${port}`; // objectives:allow LOCALHOST Justification: FieldOps E2E runs against a local Expo web preview by default.

function trimTrailingSlash(value: string) {
  return value.length > 1 ? value.replace(/\/+$/g, "") : value;
}

function resolveBaseUrl(value: string) {
  try {
    const parsed = new URL(value);
    return trimTrailingSlash(parsed.origin + parsed.pathname);
  } catch (error) {
    throw new Error(
      `Invalid FIELDOPS_BASE_URL "${value}". Expected an absolute URL like "https://www.example.com".`,
      { cause: error }
    );
  }
}

const resolvedBaseUrl = resolveBaseUrl(baseUrl);
// Expo serves the HTML before its web entry bundle has finished compiling.
// Gate test startup on the same bundle requested by that HTML.
const bundleReadyUrl = new URL(
  "/index.ts.bundle?platform=web&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.routerRoot=app&unstable_transformProfile=hermes-stable",
  resolvedBaseUrl
).toString();
const fieldopsWebDir = path.resolve(__dirname, "apps/fieldops");
const runPwaSmoke = /^(1|true)$/i.test(process.env.FIELDOPS_PWA_SMOKE ?? "");
const exportedWebDir = process.env.FIELDOPS_WEB_EXPORT_DIR?.trim();
const proxyServer = process.env.FIELDOPS_E2E_PROXY_SERVER?.trim();

function isLocalhostOrigin(origin: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

const shouldStartServer = isLocalhostOrigin(new URL(resolvedBaseUrl).origin);
if (runPwaSmoke && shouldStartServer && !exportedWebDir) {
  throw new Error("FieldOps PWA smoke requires FIELDOPS_WEB_EXPORT_DIR: test the exported artifact, not Metro.");
}

const supabaseUrl =
  (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "").trim();
const supabaseAnonKey =
  (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "").trim();
const authMethods = (process.env.NEXT_PUBLIC_AUTH_METHODS || "password").trim();

if (!process.env.NEXT_PUBLIC_SUPABASE_URL && supabaseUrl) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = supabaseUrl;
}
if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && supabaseAnonKey) {
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = supabaseAnonKey;
}
if (!process.env.NEXT_PUBLIC_AUTH_METHODS) {
  process.env.NEXT_PUBLIC_AUTH_METHODS = authMethods;
}

export default defineConfig({
  testDir: "./tests/fieldops-e2e",
  projects: runPwaSmoke ? [
    { name: "fieldops-android-web", testMatch: /pwa\.spec\.ts/, use: { ...devices["Pixel 7"] } },
    { name: "fieldops-iphone-web", testMatch: /pwa\.spec\.ts/, use: { ...devices["iPhone 13"] } },
  ] : [{ name: "fieldops", testIgnore: /pwa\.spec\.ts/, use: { browserName: "chromium" } }],
  timeout: 90_000,
  // Same-renderer visual baselines (mobile-v2-visual-baseline.spec.ts) live
  // under __screenshots__/ with a flat, platform-agnostic name so each is a
  // single committed reference PNG.
  snapshotPathTemplate:
    "{testDir}/__screenshots__/mobile-v2-visual-baseline/{arg}{ext}",
  expect: {
    timeout: 15_000,
    // Per-screen visual-parity gate: a screen must stay >95% pixel-
    // identical to its committed same-renderer baseline (≤5% of pixels
    // may drift). `threshold` is the per-pixel YIQ tolerance that absorbs
    // sub-pixel anti-aliasing without hiding real change.
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.05,
      threshold: 0.2,
      animations: "disabled",
    },
  },
  retries: 0,
  reporter: isCi
    ? [["html", { outputFolder: "playwright-report/fieldops", open: "never" }]]
    : [["html", { outputFolder: "playwright-report/fieldops", open: "on-failure" }]],
  outputDir: "test-results/fieldops",
  use: {
    baseURL: `${resolvedBaseUrl}/`,
    ...(proxyServer ? { proxy: { server: proxyServer, bypass: "localhost,127.0.0.1" } } : {}),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: shouldStartServer && runPwaSmoke
    ? {
        command: `node scripts/frontend/serve-landing.js --skip-build --out ${JSON.stringify(path.resolve(exportedWebDir!))} --port ${port} --base-path ${JSON.stringify(new URL(`${resolvedBaseUrl}/`).pathname)}`,
        cwd: __dirname,
        env: { ...process.env, LANDING_HOST: "127.0.0.1", LANDING_PORT: String(port) },
        url: `${resolvedBaseUrl}/`,
        reuseExistingServer,
        timeout: 30_000,
      }
    : shouldStartServer
    ? {
        command: `npm run web -- --port ${port} --clear`,
        cwd: fieldopsWebDir,
        env: {
          ...process.env,
          CI: "1",
          EXPO_NO_TELEMETRY: "1",
          EXPO_NO_DEPENDENCY_VALIDATION: "1",
          EXPO_NO_METRO_WORKSPACE_ROOT: "1",
          // Do not let apps/fieldops/.env placeholders override test-provided values.
          EXPO_NO_DOTENV: "1",
          NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || supabaseUrl,
          NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || supabaseAnonKey,
          NEXT_PUBLIC_AUTH_METHODS: process.env.NEXT_PUBLIC_AUTH_METHODS || authMethods,
          EXPO_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || supabaseUrl,
          EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || supabaseAnonKey,
          EXPO_PUBLIC_AUTH_METHODS: process.env.NEXT_PUBLIC_AUTH_METHODS || authMethods,
        },
        url: bundleReadyUrl,
        reuseExistingServer,
        timeout: 240_000,
      }
    : undefined,
});
