import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import { runWithRuntimeErrors } from "./utils/runtime-errors";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();

function resolveConsoleUser() {
  return (
    demoContext.users.find((user) => user.user_type === "ops_admin") ??
    demoContext.users.find((user) => user.user_type === "super_admin") ??
    demoContext.users.find((user) => user.scope_type === "tenant") ??
    null
  );
}

test.describe("console workflow template studio empty state", () => {
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  test.beforeAll(() => {
    if (!demoContext.available && strict) {
      throw new Error(demoContext.reason ?? "Demo accounts missing.");
    }
  });

  test("creates a template with zero steps without runtime errors", async ({ page }) => {
    test.setTimeout(120_000);
    if (!demoContext.available) {
      test.skip(true, demoContext.reason ?? "Demo accounts missing.");
    }

    const user = resolveConsoleUser();
    if (!user) {
      if (strict) throw new Error("No console demo user available for empty workflow template smoke.");
      test.skip(true, "No console demo user available for empty workflow template smoke.");
    }

    const basePath = getConsoleBasePath();
    await runWithRuntimeErrors(page, { label: "console-workflow-template-empty-studio" }, async () => {
      await page.goto(basePath || "/", { waitUntil: "domcontentloaded" });

      const authGate = page.locator('[data-testid="console-auth-required"]');
      if (await authGate.isVisible()) {
        await signInWithPassword(page, user.email, demoContext.password || "");
      }
      await expectSignedIn(page, user.email, user.scope_type);

      await page.goto(`${basePath}/workflows/templates/new`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      const nameInput = page.locator('[data-testid="console-workflow-template-create-name"]');
      await expect(nameInput).toBeVisible({ timeout: 30_000 });

      const workflowName = `e2e_empty_${Date.now()}`;
      await nameInput.fill(workflowName);

      const submit = page.locator('[data-testid="console-workflow-template-create-submit"]');
      await expect(submit).toBeEnabled({ timeout: 20_000 });
      await submit.click({ timeout: 20_000 });

      await expect(
        page.locator(
          '[data-testid="console-workflow-template-studio-ready"], [data-testid="console-workflow-template-studio-error"]'
        )
      ).toBeVisible({ timeout: 120_000 });

      await expect(
        page.locator('[data-testid="console-workflow-template-studio-ready"]')
      ).toBeVisible({ timeout: 120_000 });

      await expect(page.getByRole("heading", { name: workflowName })).toBeVisible({
        timeout: 60_000,
      });

      await expect(
        page.locator('[data-testid="console-workflow-template-studio-steps-ready"]')
      ).toBeVisible({ timeout: 30_000 });

      const flowTab = page.locator(
        '[data-testid="console-workflow-template-studio-steps-tab-flow"]'
      );
      if (await flowTab.isVisible()) {
        await flowTab.click({ timeout: 20_000 });
      }

      const emptyState = page.locator(
        '[data-testid="console-workflow-template-studio-steps-flow-flow-empty-state"]'
      );
      await expect(emptyState).toBeVisible({ timeout: 30_000 });

      const addStepCta = page.locator(
        '[data-testid="console-workflow-template-studio-steps-flow-flow-empty-add-step"]'
      );
      await expect(addStepCta).toBeVisible({ timeout: 30_000 });

      if (await addStepCta.isEnabled()) {
        await addStepCta.click({ timeout: 20_000 });
        const addStepModal = page.locator(
          '[data-testid="console-workflow-template-studio-steps-flow-add-modal"]'
        );
        await expect(addStepModal).toBeVisible({ timeout: 20_000 });
        await page.keyboard.press("Escape");
        await expect(addStepModal).toBeHidden({ timeout: 20_000 });
      }

      const builderTab = page.locator(
        '[data-testid="console-workflow-template-studio-steps-tab-builder"]'
      );
      if (await builderTab.isVisible()) {
        await builderTab.click({ timeout: 20_000 });
        await expect(
          page.locator(
            '[data-testid="console-workflow-template-studio-steps-builder-add"]'
          )
        ).toBeVisible({ timeout: 20_000 });
        await flowTab.click({ timeout: 20_000 });
        await expect(emptyState).toBeVisible({ timeout: 20_000 });
      }

      const triggersTab = page.getByRole("tab", { name: /Triggers/i });
      if (await triggersTab.isVisible()) {
        await triggersTab.click({ timeout: 20_000 });
        await expect(
          page.locator('[data-testid="console-workflow-template-studio-triggers-ready"]')
        ).toBeVisible({ timeout: 30_000 });
      }

      await page.goto(`${basePath}/workflows/templates`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await expect(
        page.locator('[data-testid="console-workflow-templates-ready"]')
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        page.getByRole("heading", { name: /Workflow templates/i })
      ).toBeVisible({ timeout: 60_000 });
    });
  });
});
