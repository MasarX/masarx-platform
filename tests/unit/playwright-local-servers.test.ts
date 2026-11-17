jest.mock("@playwright/test", () => ({ defineConfig: (config: unknown) => config }));
jest.mock("../../apps/shared/security-headers.js", () => ({
  __esModule: true,
  default: jest.requireActual("../../apps/shared/security-headers.js"),
}));

describe("Playwright local app startup", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      CI: "",
      STRICT_E2E_GATE_ENV: "",
      E2E_REQUIRE_BASE_URLS: "",
      E2E_PROJECTS: "console,portal",
      CONSOLE_BASE_URL: "http://localhost:3001",
      PORTAL_BASE_URL: "http://localhost:3002",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function localServerUrls() {
    const config = require("../../playwright.config").default;
    return (config.webServer ?? []).map((server: { url: string }) => server.url);
  }

  test("starts both selected local apps", () => {
    expect(localServerUrls()).toEqual([
      "http://localhost:3001/",
      "http://localhost:3002/",
    ]);
  });

  test("starts the local console when the portal uses a hosted origin", () => {
    process.env.PORTAL_BASE_URL = "https://portal.example.test";
    expect(localServerUrls()).toEqual(["http://localhost:3001/"]);
  });

  test("starts the local portal when the console uses a hosted origin", () => {
    process.env.CONSOLE_BASE_URL = "https://console.example.test";
    expect(localServerUrls()).toEqual(["http://localhost:3002/"]);
  });

  test("does not start an unselected local app", () => {
    process.env.E2E_PROJECTS = "console";
    process.env.CONSOLE_BASE_URL = "https://console.example.test";
    expect(localServerUrls()).toEqual([]);
  });

  test("does not start servers for strict hosted runs", () => {
    process.env.STRICT_E2E_GATE_ENV = "1";
    process.env.CONSOLE_BASE_URL = "https://console.example.test";
    process.env.PORTAL_BASE_URL = "https://portal.example.test";
    expect(localServerUrls()).toEqual([]);
  });
});
