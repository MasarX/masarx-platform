import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getPortalBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import { ensureSignedIn } from "./utils/session";
import { fetchUserContext } from "./utils/role-matrix";
import { assertNavigationPerformance } from "./utils/performance";
import {
  fetchResourceSampleField,
  fetchResourceSampleId,
} from "./utils/core-resource";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();
const portalBasePath = getPortalBasePath();

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

test.describe("portal observability flows", () => {
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  const portalUsers = demoContext.users.filter((user) =>
    ["client", "sender"].includes(user.scope_type ?? "")
  );

  test.beforeAll(() => enforceDemoContext("portal", portalUsers));

  test("portal workflow run and trace detail flow", async ({ page }) => {
    const user = portalUsers[0];
    test.skip(!user, "No portal demo user available.");

    await ensureSignedIn({
      page,
      basePath: portalBasePath,
      authTestId: "portal-auth-required",
      email: user.email,
      password: demoContext.password ?? "",
      scopeType: user.scope_type ?? null,
    });

    const context = await fetchUserContext({
      app: "portal",
      email: user.email,
      password: demoContext.password ?? "",
    });
    const resources = Array.isArray(context.readRegistry?.resources)
      ? context.readRegistry?.resources
      : [];
    const workflowRunResource = resources.find((entry) => entry?.key === "workflow_runs") ?? null;

    if (workflowRunResource) {
      const sampleRun = await fetchResourceSampleId({
        resourceKey: "workflow_runs",
        idColumn: workflowRunResource.id_column ?? null,
        email: user.email,
        password: demoContext.password ?? "",
      });
      if (sampleRun.id) {
        await page.goto(
          `${portalBasePath}/workflows/runs/${encodeURIComponent(sampleRun.id)}`,
          { waitUntil: "domcontentloaded", timeout: 60_000 }
        );
        await expect(
          page.locator(
            '[data-testid="portal-workflow-run-ready"], [data-testid="portal-workflow-run-error"], [data-testid="portal-auth-required"]'
          )
        ).toBeVisible();
        await assertNavigationPerformance(page);
      }

      const correlation = await fetchResourceSampleField({
        resourceKey: "workflow_runs",
        fieldCandidates: ["correlation_id", "triggered_by_request_id", "request_id"],
        email: user.email,
        password: demoContext.password ?? "",
      });
      if (correlation.value) {
        await page.goto(
          `${portalBasePath}/observability/trace/${encodeURIComponent(correlation.value)}`,
          { waitUntil: "domcontentloaded", timeout: 60_000 }
        );
        await expect(
          page.locator(
            '[data-testid="portal-trace-ready"], [data-testid="portal-trace-error"], [data-testid="portal-auth-required"]'
          )
        ).toBeVisible();
        await assertNavigationPerformance(page);
      }
    }
  });
});
