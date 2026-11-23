import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const anonymousSpecs: Record<string, string> = {
  console: "console-public-auth.spec.ts",
  portal: "portal-public-auth.spec.ts",
};

for (const key of ["CONSOLE_BASE_URL", "PORTAL_BASE_URL"]) {
  const url = new URL(process.env[key] || "about:blank");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${key} must be a credential-free HTTPS app origin.`);
  }
}

if (!process.env.RUNNER_TEMP || !process.env.GITHUB_STEP_SUMMARY) {
  throw new Error("DEV browser report requires the runner output paths.");
}

// shortcut: admit anonymous specs until the synthetic fixture and role contracts cover signed-in specs.
const projects = Object.entries(anonymousSpecs).map(([name, spec]) => {
  const project = base.projects?.find(project => project.name === name);
  if (!project?.use?.baseURL) throw new Error(`${name} has no browser project target.`);
  return { ...project, testMatch: new RegExp(`[/\\\\]e2e[/\\\\]${spec.replaceAll(".", "\\.")}$`) };
});

export default defineConfig({
  ...base,
  webServer: undefined,
  outputDir: join(process.env.RUNNER_TEMP, "dev-e2e-test-results"),
  reporter: [["./scripts/ci-hosted/dev-e2e-reporter.cjs", {
    specs: Object.values(anonymousSpecs),
    reportPath: join(process.env.RUNNER_TEMP, "dev-e2e-report.json"),
    summaryPath: process.env.GITHUB_STEP_SUMMARY,
  }]],
  use: { trace: "off", screenshot: "off", video: "off" },
  projects,
});
