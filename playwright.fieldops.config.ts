import { defineConfig } from "@playwright/test";
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
const fieldopsWebDir = path.resolve(__dirname, "apps/fieldops");

function isLocalhostOrigin(origin: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

const shouldStartServer = isLocalhostOrigin(new URL(resolvedBaseUrl).origin);

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
  timeout: 90_000,
  expect: {
    timeout: 15_000
  },
  retries: isCi ? 2 : 0,
  reporter: isCi
    ? [["html", { outputFolder: "playwright-report/fieldops", open: "never" }]]
    : [["html", { outputFolder: "playwright-report/fieldops", open: "on-failure" }]],
  outputDir: "test-results/fieldops",
  use: {
    baseURL: resolvedBaseUrl,
    trace: isCi ? "on-first-retry" : "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: shouldStartServer
    ? {
        command: `npm run web -- --port ${port} --clear`,
        cwd: fieldopsWebDir,
        env: {
          ...process.env,
          CI: "1",
          EXPO_NO_TELEMETRY: "1",
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
        url: resolvedBaseUrl,
        reuseExistingServer,
        timeout: 240_000,
      }
    : undefined,
});
