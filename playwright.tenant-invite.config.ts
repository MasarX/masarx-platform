import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  workers: 1,
  timeout: 120_000,
  // Native attack qualification consumes an already admitted stack; it never starts one implicitly.
  webServer: undefined,
  // Acceptance secrets and passwords must never enter browser/network artifacts.
  use: { trace: "off", screenshot: "off", video: "off" },
  projects: [{
    name: "console",
    testMatch: /security\/tenant-user-invite-takeover\.spec\.ts/,
    use: base.projects?.find((project) => project.name === "console")?.use,
  }],
});
