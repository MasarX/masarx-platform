import { test, expect, type Page } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getConsoleBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import { ensureSignedIn, signInIfAuthRequired } from "./utils/session";
import { fetchUserContext } from "./utils/role-matrix";
import { assertNavigationPerformance } from "./utils/performance";
import {
  fetchResourceSampleField,
  fetchResourceSampleId,
} from "./utils/core-resource";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();

function enforceDemoContext(scopeLabel: string, users: Array<{ email: string }>) {
  if (!demoContext.available) {
    if (strict) {
      throw new Error(`Demo accounts missing for ${scopeLabel}: ${demoContext.reason}`);
    }
    return;
  }
  if (users.length === 0 && strict) {
    throw new Error(`No demo users available for ${scopeLabel}.`);
  }
}

async function openConsoleObservabilityRoute(params: {
  page: Page;
  url: string;
  email: string;
  password: string;
}) {
  const { page, url, email, password } = params;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await signInIfAuthRequired({
    page,
    authTestId: "console-auth-required",
    email,
    password,
    timeoutMs: 1_000,
  });
}

test.describe("console observability flows", () => {
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  const consoleUsers = demoContext.users.filter((user) =>
    ["platform", "tenant"].includes(user.scope_type ?? "")
  );

  test.beforeAll(() => enforceDemoContext("console", consoleUsers));

  test("console observability detail flows", async ({ page }) => {
    const user = consoleUsers[0];
    test.skip(!user, "No console demo user available.");
    const consoleBasePath = getConsoleBasePath();

    await ensureSignedIn({
      page,
      basePath: consoleBasePath,
      authTestId: "console-auth-required",
      email: user.email,
      password: demoContext.password ?? "",
      scopeType: user.scope_type ?? null,
    });

    const context = await fetchUserContext({
      app: "console",
      email: user.email,
      password: demoContext.password ?? "",
    });
    const resources = Array.isArray(context.readRegistry?.resources)
      ? context.readRegistry?.resources
      : [];
    const workflowResource = resources.find((entry) => entry?.key === "workflow_runs") ?? null;
    const domainResource = resources.find((entry) => entry?.key === "domain_events") ?? null;

    if (workflowResource) {
      const sample = await fetchResourceSampleId({
        resourceKey: "workflow_runs",
        idColumn: workflowResource.id_column ?? null,
        email: user.email,
        password: demoContext.password ?? "",
      });
      if (sample.id) {
        await openConsoleObservabilityRoute({
          page,
          url: `${consoleBasePath}/observability/workflow-runs/${encodeURIComponent(sample.id)}`,
          email: user.email,
          password: demoContext.password ?? "",
        });
        await expect(
          page.locator(
            '[data-testid="console-workflow-run-ready"], [data-testid="console-workflow-run-error"], [data-testid="console-auth-required"]'
          )
        ).toBeVisible();
        await assertNavigationPerformance(page);
        await expect(
          page.locator(
            '[data-testid="console-workflow-run-steps-ready"], [data-testid="console-workflow-run-steps-error"]'
          )
        ).toBeVisible();
      }
    }

    if (domainResource) {
      const eventSample = await fetchResourceSampleId({
        resourceKey: "domain_events",
        idColumn: domainResource.id_column ?? null,
        email: user.email,
        password: demoContext.password ?? "",
      });
      if (eventSample.id) {
        await openConsoleObservabilityRoute({
          page,
          url: `${consoleBasePath}/observability/domain-events/${encodeURIComponent(eventSample.id)}`,
          email: user.email,
          password: demoContext.password ?? "",
        });
        await expect(
          page.locator(
            '[data-testid="console-domain-event-ready"], [data-testid="console-domain-event-error"], [data-testid="console-auth-required"]'
          )
        ).toBeVisible();
        await assertNavigationPerformance(page);
      }

      const correlation = await fetchResourceSampleField({
        resourceKey: "domain_events",
        fieldCandidates: ["correlation_id", "triggered_by_request_id", "request_id"],
        email: user.email,
        password: demoContext.password ?? "",
      });
      if (correlation.value) {
        await openConsoleObservabilityRoute({
          page,
          url: `${consoleBasePath}/observability/trace/${encodeURIComponent(correlation.value)}`,
          email: user.email,
          password: demoContext.password ?? "",
        });
        await expect(
          page.locator(
            '[data-testid="console-trace-ready"], [data-testid="console-trace-error"], [data-testid="console-auth-required"]'
          )
        ).toBeVisible();
        await assertNavigationPerformance(page);
      }
    }
  });
});
