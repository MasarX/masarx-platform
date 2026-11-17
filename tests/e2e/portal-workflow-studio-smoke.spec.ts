import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getPortalBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import { runWithRuntimeErrors } from "./utils/runtime-errors";
import {
  fetchUserContext,
  flattenNavigationSections,
  normalizeNavHref,
} from "./utils/role-matrix";
import {
  createWorkflowTemplateDraftViaUi,
  ensureWorkflowTemplateFlowHasStep,
  keyboardZoomWorkflowTemplateFlowCanvas,
  wheelZoomWorkflowTemplateFlowCanvas,
} from "./utils/workflow-studio";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();

async function resolvePortalWorkflowStudioTarget(basePath: string) {
  const prioritized = [
    ...demoContext.users.filter((user) => user.user_type === "client_admin"),
    ...demoContext.users.filter((user) => user.scope_type === "client"),
    ...demoContext.users.filter((user) => user.scope_type === "tenant"),
    ...demoContext.users.filter((user) => user.scope_type === "platform"),
  ].filter(
    (user, index, list) =>
      list.findIndex((entry) => entry.email === user.email) === index
  );

  for (const user of prioritized) {
    const context = await fetchUserContext({
      app: "portal",
      email: user.email,
      password: demoContext.password ?? "",
    });
    const templatesItem = flattenNavigationSections(
      Array.isArray(context.navigation.sections) ? context.navigation.sections : []
    ).find(({ item }) => {
      const href = String(item.href ?? "").trim().toLowerCase();
      if (!href || item.disabled_reason) return false;
      return href.includes("/workflows/templates");
    });
    if (!templatesItem?.item?.href) continue;
    return {
      user,
      templatesRoute: normalizeNavHref(templatesItem.item.href, basePath),
    };
  }

  return null;
}

test.describe("portal workflow studio smoke", () => {
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  test.beforeAll(() => {
    if (!demoContext.available && strict) {
      throw new Error(demoContext.reason ?? "Demo accounts missing.");
    }
  });

  test("loads workflow studio and operation library", async ({ page }) => {
    if (!demoContext.available) {
      test.skip(true, demoContext.reason ?? "Demo accounts missing.");
    }

    const basePath = getPortalBasePath();
    const target = await resolvePortalWorkflowStudioTarget(basePath);
    if (!target) {
      if (strict) throw new Error("No portal demo user available for workflow studio smoke.");
      test.skip(true, "No portal demo user available for workflow studio smoke.");
    }
    const { user, templatesRoute } = target;

    await runWithRuntimeErrors(page, { label: "portal-workflow-studio" }, async () => {
      await page.goto(basePath || "/", { waitUntil: "domcontentloaded" });

      const authGate = page.locator('[data-testid="portal-auth-required"]');
      if (await authGate.isVisible()) {
        await signInWithPassword(page, user.email, demoContext.password || "");
      }
      await expectSignedIn(page, user.email, user.scope_type);

      await page.goto(templatesRoute, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      await expect(
        page.locator(
          '[data-testid="portal-workflow-templates-ready"], [data-testid="portal-workflow-templates-error"], [data-testid="portal-auth-required"], [data-testid="portal-not-found"], [data-testid="portal-resource-blocked"]'
        )
      ).toBeVisible();

      const templatesReady = page.locator(
        '[data-testid="portal-workflow-templates-ready"]'
      );
      if (!(await templatesReady.isVisible())) {
        await expect(
          page.locator(
            '[data-testid="portal-workflow-templates-error"], [data-testid="portal-not-found"], [data-testid="portal-resource-blocked"]'
          ).first()
        ).toBeVisible();
        return;
      }

      const templatesPropertiesButton = page.getByRole("button", {
        name: /Properties/i,
      });
      if (await templatesPropertiesButton.isVisible()) {
        await templatesPropertiesButton.click({ timeout: 20_000 });
        const columnsSearch = page.getByTestId("table-columns-search");
        await expect(columnsSearch).toBeVisible({ timeout: 20_000 });

        await templatesPropertiesButton.click({ timeout: 20_000 });
        if (await columnsSearch.isVisible()) {
          await page.keyboard.press("Escape");
        }
      }

      const { templateId } = await createWorkflowTemplateDraftViaUi({
        page,
        basePath,
        testIdPrefix: "portal",
      });
      expect(templateId, "workflow template id should exist").toBeTruthy();

      await expect(
        page.locator(
          '[data-testid="portal-workflow-template-studio-ready"], [data-testid="portal-workflow-template-studio-error"]'
        )
      ).toBeVisible();

      await expect(
        page.locator('[data-testid="portal-workflow-template-studio-ready"]')
      ).toBeVisible();

      await expect(
        page.locator('[data-testid="portal-workflow-template-studio-steps-ready"]')
      ).toBeVisible({ timeout: 20_000 });

      const flowTab = page.locator(
        '[data-testid="portal-workflow-template-studio-steps-tab-flow"]'
      );
      if (await flowTab.isVisible()) {
        await flowTab.click({ timeout: 20_000 });
      }

      const paletteSearch = page.locator(
        '[data-testid="portal-workflow-template-studio-steps-flow-palette-search"]'
      );
      await expect(paletteSearch).toBeVisible({ timeout: 20_000 });

      const paletteList = page.locator(
        '[data-testid="portal-workflow-template-studio-steps-flow-palette-list"]'
      );
      await expect(paletteList).toBeVisible({ timeout: 20_000 });

      const firstPaletteItem = paletteList
        .locator(
          '[data-testid^="portal-workflow-template-studio-steps-flow-palette-item-"]'
        )
        .first();

      await expect(firstPaletteItem).toBeVisible({ timeout: 20_000 });

      await ensureWorkflowTemplateFlowHasStep({ page, testIdPrefix: "portal" });

      const connectFrom = page
        .locator(
          '[data-testid^="portal-workflow-template-studio-steps-flow-connect-from-"]'
        )
        .first();
      await expect(connectFrom).toBeVisible({ timeout: 20_000 });

      const zoomValue = page.locator(
        '[data-testid="portal-workflow-template-studio-steps-flow-zoom-value"]'
      );
      await expect(zoomValue).toBeVisible({ timeout: 20_000 });
      await expect(zoomValue).toHaveText("100%");

      const wheelZoomed = await wheelZoomWorkflowTemplateFlowCanvas({
        page,
        testIdPrefix: "portal",
        deltaY: -120,
      });
      if (wheelZoomed) {
        await expect(zoomValue).toHaveText("110%");
        await wheelZoomWorkflowTemplateFlowCanvas({
          page,
          testIdPrefix: "portal",
          deltaY: 120,
        });
        await expect(zoomValue).toHaveText("100%");
      }

      await keyboardZoomWorkflowTemplateFlowCanvas({ page, key: "=", ctrlKey: true });
      await expect(zoomValue).toHaveText("110%");
      await keyboardZoomWorkflowTemplateFlowCanvas({ page, key: "0", ctrlKey: true });
      await expect(zoomValue).toHaveText("100%");

      const zoomOut = page.locator(
        '[data-testid="portal-workflow-template-studio-steps-flow-zoom-out"]'
      );
      if (await zoomOut.isVisible()) {
        await zoomOut.click({ timeout: 20_000 });
        await expect(zoomValue).toHaveText("90%");

        if (await zoomValue.isEnabled()) {
          await zoomValue.click({ timeout: 20_000 });
          await expect(zoomValue).toHaveText("100%");
        }
      }

      const disconnectButton = page
        .locator(
          '[data-testid^="portal-workflow-template-studio-steps-flow-step-clear-next-"]'
        )
        .first();
      if (await disconnectButton.isVisible()) {
        const disconnectTestId = await disconnectButton.getAttribute("data-testid");
        if (disconnectTestId) {
          await disconnectButton.click({ timeout: 20_000 });
          const confirmDialog = page.locator(
            `[data-testid="${disconnectTestId}-confirm-dialog"]`
          );
          await expect(confirmDialog).toBeVisible({ timeout: 20_000 });
          await page.keyboard.press("Escape");
          await expect(confirmDialog).toBeHidden({ timeout: 20_000 });
        }
      }

      const triggersOpen = page.locator(
        '[data-testid="portal-workflow-template-studio-steps-flow-triggers-card-open"]'
      );
      if (await triggersOpen.isVisible()) {
        await triggersOpen.click({ timeout: 20_000 });
        const triggersDrawer = page.locator(
          '[data-testid="portal-workflow-template-studio-steps-flow-triggers-card-drawer"]'
        );
        await expect(triggersDrawer).toBeVisible({ timeout: 20_000 });

        const workflowRunTriggersPanel = triggersDrawer.locator(
          '[data-testid="portal-workflow-template-studio-steps-flow-triggers-card-workflow-runs"]'
        );
        if (await workflowRunTriggersPanel.isVisible()) {
          await expect(
            workflowRunTriggersPanel.locator(
              '[data-testid="portal-workflow-template-studio-steps-flow-triggers-card-workflow-runs-incoming"]'
            )
          ).toBeVisible({ timeout: 20_000 });
          await expect(
            workflowRunTriggersPanel.locator(
              '[data-testid="portal-workflow-template-studio-steps-flow-triggers-card-workflow-runs-outgoing"]'
            )
          ).toBeVisible({ timeout: 20_000 });
        }
        await page.keyboard.press("Escape");
      }

      const runPreviewSelect = page.locator(
        '[data-testid="portal-workflow-template-studio-steps-flow-run-preview-select"]'
      );
      if (await runPreviewSelect.isVisible()) {
        if (await runPreviewSelect.isEnabled()) {
          const values = await runPreviewSelect
            .locator("option")
            .evaluateAll((options) =>
              options.map((option) => option.getAttribute("value") || "")
            );
          const selected = values.find((value) => value.trim().length > 0);
          if (selected) {
            await runPreviewSelect.selectOption(selected);
          }
        }

        const runInspectorOpen = page.locator(
          '[data-testid="portal-workflow-template-studio-steps-flow-run-preview-inspect"]'
        );
        if (await runInspectorOpen.isVisible()) {
          await runInspectorOpen.click({ timeout: 20_000 });
          const runInspectorDrawer = page.locator(
            '[data-testid="portal-workflow-template-studio-steps-flow-run-inspector-drawer"]'
          );
          await expect(runInspectorDrawer).toBeVisible({ timeout: 20_000 });

          await expect(
            runInspectorDrawer.locator(
              '[data-testid="portal-workflow-template-studio-steps-flow-run-inspector-provenance"]'
            )
          ).toBeVisible({ timeout: 30_000 });

          const logsPanel = runInspectorDrawer.locator(
            '[data-testid="portal-workflow-template-studio-steps-flow-run-inspector-logs"]'
          );
          await logsPanel.scrollIntoViewIfNeeded();
          await expect(logsPanel).toBeVisible({ timeout: 30_000 });

          const logsTabSimple = runInspectorDrawer.locator(
            '[data-testid="portal-workflow-template-studio-steps-flow-run-inspector-logs-tab-simple"]'
          );
          const logsTabAdvanced = runInspectorDrawer.locator(
            '[data-testid="portal-workflow-template-studio-steps-flow-run-inspector-logs-tab-advanced"]'
          );
          await expect(logsTabSimple).toBeVisible({ timeout: 30_000 });
          await expect(logsTabAdvanced).toBeVisible({ timeout: 30_000 });

          await logsTabSimple.click({ timeout: 20_000 });
          const logsSimpleEmpty = runInspectorDrawer.locator(
            '[data-testid="portal-workflow-template-studio-steps-flow-run-inspector-logs-simple-empty"]'
          );
          const logsSimpleStep = runInspectorDrawer
            .locator(
              '[data-testid^="portal-workflow-template-studio-steps-flow-run-inspector-logs-simple-step-"]'
            )
            .first();
          await expect(logsSimpleEmpty.or(logsSimpleStep)).toBeVisible({ timeout: 30_000 });

          await logsTabAdvanced.click({ timeout: 20_000 });
          await expect(
            runInspectorDrawer.locator(
              '[data-testid="portal-workflow-template-studio-steps-flow-run-inspector-logs-advanced"]'
            )
          ).toBeVisible({ timeout: 30_000 });
          await expect(
            runInspectorDrawer.locator(
              '[data-testid="portal-workflow-template-studio-steps-flow-run-inspector-logs-filter-search"]'
            )
          ).toBeVisible({ timeout: 30_000 });
          await expect(
            runInspectorDrawer.locator(
              '[data-testid="portal-workflow-template-studio-steps-flow-run-inspector-logs-action-copy-json"]'
            )
          ).toBeVisible({ timeout: 30_000 });

          await page.keyboard.press("Escape");
        }
      }

      await page.goto(
        `${basePath}/workflows/templates/${encodeURIComponent(templateId)}#workflow-triggers`,
        { waitUntil: "domcontentloaded", timeout: 60_000 }
      );
      await expect(
        page.locator(
          '[data-testid="portal-workflow-template-studio-ready"], [data-testid="portal-workflow-template-studio-error"]'
        )
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        page.locator('[data-testid="portal-workflow-template-studio-triggers-ready"]')
      ).toBeVisible({ timeout: 20_000 });

      const workflowRunTriggersPanel = page.locator(
        '[data-testid="portal-workflow-template-studio-triggers-workflow-runs"]'
      );
      await expect(workflowRunTriggersPanel).toBeVisible({ timeout: 20_000 });
      const incomingRuns = workflowRunTriggersPanel.locator(
        '[data-testid="portal-workflow-template-studio-triggers-workflow-runs-incoming"]'
      );
      const outgoingRuns = workflowRunTriggersPanel.locator(
        '[data-testid="portal-workflow-template-studio-triggers-workflow-runs-outgoing"]'
      );
      await expect.poll(async () => await incomingRuns.count()).toBeGreaterThan(0);
      await expect.poll(async () => await outgoingRuns.count()).toBeGreaterThan(0);
      await expect(incomingRuns.first()).toBeVisible({ timeout: 20_000 });
      await expect(outgoingRuns.first()).toBeVisible({ timeout: 20_000 });
    });
  });
});
