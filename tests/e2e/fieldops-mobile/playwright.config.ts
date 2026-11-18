import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Dedicated Playwright configuration for the FieldOps mobile web suite.
//
// SSOT: runs the Expo web bundle on port 8081 (see apps/fieldops/package.json
// "web" script) inside an iPhone 15 Pro viewport. Keeps all artifacts under
// this subdirectory so the main E2E pipeline (tests/e2e/{console,portal,a11y,
// shared}) remains unaffected.

const isCi = Boolean(process.env.CI);
const repoRoot = path.resolve(__dirname, "..", "..", "..");

const BASE_URL = process.env.FIELDOPS_MOBILE_BASE_URL?.trim() || "http://localhost:8081";
const WEB_SERVER_TIMEOUT_MS = Number.parseInt(
  process.env.FIELDOPS_MOBILE_WEB_SERVER_TIMEOUT_MS ?? "",
  10,
);
const webServerTimeout = Number.isFinite(WEB_SERVER_TIMEOUT_MS) && WEB_SERVER_TIMEOUT_MS > 0
  ? WEB_SERVER_TIMEOUT_MS
  : 180_000;

// iPhone 15 Pro physical viewport: width 430, height 932 (logical CSS px)
const MOBILE_VIEWPORT = { width: 430, height: 932 };

export default defineConfig({
  testDir: __dirname,
  // The Expo web bundle compiles + caches on first load; 180s per-test gives
  // the initial Metro build enough headroom while keeping later tests fast.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  // Workers: 1 because Expo bundles are heavy and a shared module cache helps.
  workers: 1,
  // Retries on CI only so local failures surface immediately.
  retries: isCi ? 2 : 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  outputDir: "test-results",
  use: {
    baseURL: BASE_URL,
    viewport: MOBILE_VIEWPORT,
    deviceScaleFactor: 3,
    // isMobile emulation requires a browser that supports it (WebKit). The
    // per-project overrides below opt into mobile emulation for WebKit only.
    hasTouch: true,
    // Mobile user agent closer to an iPhone so react-native-web picks mobile
    // code paths where possible (not strictly required but good hygiene).
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    // Permissions for camera-enabled scan flows. --use-fake-device keeps the
    // CI headless runner from prompting for hardware.
    permissions: ["camera"],
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
  },
  webServer: {
    // Expo start --web binds to 8081 and serves the RN bundle. Start from the
    // repo root so workspace resolution works (cwd is relative to this file).
    command: "npm --prefix apps/fieldops run web -- --port 8081",
    cwd: repoRoot,
    url: BASE_URL,
    timeout: webServerTimeout,
    reuseExistingServer: !isCi,
  },
  projects: [
    {
      // Chromium running under mobile emulation. The built-in "iPhone 15 Pro"
      // device descriptor defaults to WebKit, which is not installed on every
      // Windows workstation — so we override defaultBrowserType to chromium
      // while keeping the viewport / user agent from the device preset.
      name: "mobile-chromium",
      use: {
        ...devices["iPhone 15 Pro"],
        defaultBrowserType: "chromium",
        viewport: MOBILE_VIEWPORT,
        isMobile: false, // Chromium cannot emulate touch+mobile flag simultaneously on Windows.
      },
    },
    // WebKit is optional: the Playwright WebKit build is unavailable on some
    // Windows setups. Enable with FIELDOPS_MOBILE_ENABLE_WEBKIT=1 to run it.
    ...(String(process.env.FIELDOPS_MOBILE_ENABLE_WEBKIT ?? "").trim() === "1"
      ? [
          {
            name: "mobile-webkit",
            use: {
              ...devices["iPhone 15 Pro"],
              viewport: MOBILE_VIEWPORT,
            },
          },
        ]
      : []),
  ],
});
