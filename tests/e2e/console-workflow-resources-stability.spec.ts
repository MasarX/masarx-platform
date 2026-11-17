import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBasePath } from "./utils/base-paths";
import { captureFullPage, isCaptureEnabled, resolveEvidencePath } from "./utils/evidence";
import { isStrictE2EEnv } from "./utils/env";
import { runWithRuntimeErrors } from "./utils/runtime-errors";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();

function resolveConsoleUser() {
  return (
    demoContext.users.find((user) => user.user_type === "super_admin") ??
    demoContext.users.find((user) => user.user_type === "ops_admin") ??
    demoContext.users.find((user) => user.scope_type === "platform") ??
    demoContext.users.find((user) => user.scope_type === "tenant") ??
    null
  );
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test.describe("console workflow resources stability", () => {
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  test.beforeAll(() => {
    if (!demoContext.available && strict) {
      throw new Error(demoContext.reason ?? "Demo accounts missing.");
    }
  });

  test("workflow surfaces do not crash with hook ordering errors", async ({ page }) => {
    test.setTimeout(180_000);
    if (!demoContext.available) {
      test.skip(true, demoContext.reason ?? "Demo accounts missing.");
    }

    const user = resolveConsoleUser();
    if (!user) {
      if (strict) throw new Error("No console demo user available for workflow resource coverage.");
      test.skip(true, "No console demo user available for workflow resource coverage.");
    }

    const basePath = getConsoleBasePath();
    const targets = [
      `${basePath}/workflows/templates`,
      `${basePath}/resources/workflow_templates`,
      `${basePath}/resources/workflow_template_steps`,
      `${basePath}/resources/workflow_run_steps`,
      `${basePath}/observability/workflow-runs`,
    ];

    const toSlug = (value: string) =>
      value
        .replace(/^https?:\/\//i, "")
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 120)
        .toLowerCase();

    await runWithRuntimeErrors(page, { label: "console-workflow-resources" }, async () => {
      await page.goto(basePath || "/", { waitUntil: "domcontentloaded" });

      const authGate = page.locator('[data-testid="console-auth-required"]');
      if (await authGate.isVisible()) {
        await signInWithPassword(page, user.email, demoContext.password || "");
      }
      await expectSignedIn(page, user.email, user.scope_type);

      for (const target of targets) {
        const navLink = page.locator(`nav a[href="${target}"]`).first();
        if (await navLink.isVisible().catch(() => false)) {
          await navLink.scrollIntoViewIfNeeded();
          await Promise.all([
            page.waitForURL(new RegExp(`${escapeRegex(target)}$`), {
              timeout: 60_000,
            }),
            navLink.click(),
          ]);
        } else {
          await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
        }

        const errorBoundary = page.getByText(/We hit an unexpected issue while loading this view\./i);
        if (await errorBoundary.isVisible()) {
          const hookError = page.getByText(/rendered more hooks than during the previous render/i);
          const suffixParts = [toSlug(target)];
          if (await hookError.isVisible()) suffixParts.push("hooks");
          if (isCaptureEnabled()) {
            await captureFullPage(
              page,
              resolveEvidencePath(
                "ui-workflow-stability",
                `console-${suffixParts.join("-")}.png`
              )
            );
          }
          throw new Error(`UI crash detected (error boundary visible): ${target}`);
        }

        await expect(
          page.locator(
            '[data-testid="console-resource-ready"], [data-testid="console-resource-error"], [data-testid="console-workflow-templates-ready"], [data-testid="console-workflow-templates-error"], [data-testid="console-workflow-runs-ready"], [data-testid="console-workflow-runs-error"]'
          )
        ).toBeVisible({ timeout: 60_000 });
      }
    });
  });
});
