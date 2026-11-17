import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getPortalBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext } from "./utils/role-matrix";
import {
  applyResourceLimit,
  resolveResourceActionTarget,
  resolveResourceKeysForUser,
} from "./utils/core-resource";
import { ensureBulkActionVisible, selectFirstTableRow } from "./utils/table-actions";
import {
  captureUiEvents,
  captureUiEventRequests,
  waitForUiEvent,
} from "./utils/ui-events";

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

test.describe("portal wildcard surfaces", () => {
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  const portalUsers = demoContext.users;

  test.beforeAll(() => enforceDemoContext("portal wildcard", portalUsers));

  const wildcardUser =
    portalUsers.find((user) => user.user_type === "super_admin") ??
    portalUsers.find((user) => user.scope_type === "platform") ??
    null;

  test("wildcard users can save views and download record assets", async ({ page }) => {
    test.setTimeout(600_000);
    if (!wildcardUser) {
      test.skip(true, "No wildcard demo user available.");
    }

    const events = captureUiEvents(page);
    const requestEvents = captureUiEventRequests(page);
    const portalBasePath = getPortalBasePath();
    const context = await fetchUserContext({
      app: "portal",
      email: wildcardUser.email,
      password: demoContext.password ?? "",
    });

    expect(context.me?.capabilities ?? []).toContain("*");

    const sections = Array.isArray(context.navigation.sections)
      ? context.navigation.sections
      : [];
    const allResourceKeys = resolveResourceKeysForUser({
      sections,
      readRegistry: context.readRegistry,
      commandRegistry: context.commandRegistry,
      capabilities: context.me?.capabilities ?? null,
    });
    const resourceKeys = applyResourceLimit(
      allResourceKeys,
      "E2E_WILDCARD_RESOURCE_LIMIT",
      8
    );
    if (resourceKeys.length === 0) {
      throw new Error(`No resources available for ${wildcardUser.email}.`);
    }

    await page.goto(portalBasePath || "/");
    const authGate = page.locator('[data-testid="portal-auth-required"]');
    if (await authGate.isVisible()) {
      await signInWithPassword(page, wildcardUser.email, demoContext.password || "");
    }
    await expectSignedIn(page, wildcardUser.email, wildcardUser.scope_type);

    let viewResourceKey: string | null = null;
    for (const resourceKey of resourceKeys) {
      await page.goto(`${portalBasePath}/resources/${resourceKey}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      const ready = page.locator('[data-testid="portal-resource-ready"]');
      await expect(
        page.locator(
          '[data-testid="portal-resource-ready"], [data-testid="portal-resource-error"], [data-testid="portal-auth-required"], [data-testid="portal-not-found"], [data-testid="portal-resource-blocked"]'
        )
      ).toBeVisible();
      if (!(await ready.isVisible())) continue;

      const viewsControl = page.locator(
        '[data-testid="portal-resource-table-view-control-views"]'
      );
      if ((await viewsControl.count()) === 0) continue;
      if (await viewsControl.first().isDisabled()) continue;

      viewResourceKey = resourceKey;
      break;
    }

    expect(viewResourceKey).not.toBeNull();
    if (!viewResourceKey) return;

    await page.goto(`${portalBasePath}/resources/${viewResourceKey}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await expect(page.locator('[data-testid="portal-resource-ready"]')).toBeVisible();

    const viewsControl = page.locator(
      '[data-testid="portal-resource-table-view-control-views"]'
    );
    await viewsControl.first().click();
    await expect(
      page.locator('[data-testid="portal-resource-table-views-panel"]')
    ).toBeVisible();

    const viewSaveToggle = page.locator(
      '[data-testid="portal-resource-table-view-save-toggle"]'
    );
    await expect(viewSaveToggle).toBeVisible();
    await viewSaveToggle.click();
    await expect(
      page.locator('[data-testid="portal-resource-table-view-save-name"]')
    ).toBeVisible();
    await page
      .locator('[data-testid="portal-resource-table-view-save-name"]')
      .fill(`E2E Wildcard View ${Date.now()}`);
    const saveCreate = page.locator(
      '[data-testid="portal-resource-table-view-save-create"]'
    );
    if (await saveCreate.count()) {
      await saveCreate.click();
      const saveEvent = await waitForUiEvent(
        [events, requestEvents],
        (entry) => entry.type === "ui.table.view.save",
        { timeout: 15_000, required: false }
      );
      if (saveEvent) {
        expect(saveEvent.timestamp).toBeTruthy();
      }
    }

    let downloadResourceKey: string | null = null;
    const downloadBasePath = `${portalBasePath}/api/resource-download`;
    const downloadScanKeys = applyResourceLimit(
      allResourceKeys,
      "E2E_WILDCARD_DOWNLOAD_SCAN_LIMIT",
      30
    );
    let remainingKeys = [...downloadScanKeys];
    const isActionDisabled = async (action: ReturnType<typeof page.locator>) => {
      const disabledAttr = await action.getAttribute("disabled");
      if (disabledAttr !== null) return true;
      const ariaDisabled = await action.getAttribute("aria-disabled");
      if (ariaDisabled === "true") return true;
      const dataDisabled = await action.getAttribute("data-disabled");
      if (dataDisabled === "true") return true;
      return false;
    };

    while (remainingKeys.length > 0) {
      const target = resolveResourceActionTarget({
        resourceKeys: remainingKeys,
        readRegistry: context.readRegistry,
        commandRegistry: context.commandRegistry,
        capabilities: context.me?.capabilities ?? null,
        appBasePath: portalBasePath,
        downloadBasePath,
        actionType: "download",
      });
      if (!target) break;
      remainingKeys = remainingKeys.filter((key) => key !== target.resourceKey);

      await page.goto(`${portalBasePath}/resources/${target.resourceKey}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      const ready = page.locator('[data-testid="portal-resource-ready"]');
      await expect(
        page.locator(
          '[data-testid="portal-resource-ready"], [data-testid="portal-resource-error"], [data-testid="portal-auth-required"], [data-testid="portal-not-found"], [data-testid="portal-resource-blocked"]'
        )
      ).toBeVisible();
      if (!(await ready.isVisible())) {
        continue;
      }

      const action = await ensureBulkActionVisible({
        page,
        actionKey: target.actionKey,
        testIdPrefix: "portal-resource-table",
      });
      if (!action) {
        continue;
      }

      const selectionBar = page.locator(
        '[data-testid="portal-resource-table-selection-bar"]'
      );
      await expect(selectionBar).toBeVisible();

      const hasSelection = await selectFirstTableRow(page);
      if (hasSelection) {
        await expect(selectionBar).toContainText("Selected 1");
        if (await isActionDisabled(action)) {
          throw new Error(
            `Download action ${target.actionKey} is disabled after selecting a row for ${target.resourceKey}.`
          );
        }
      } else {
        if (!(await isActionDisabled(action))) {
          throw new Error(
            `Download action ${target.actionKey} should be disabled with empty selection for ${target.resourceKey}.`
          );
        }
        await expect(action).toHaveAttribute("title", /.+/);
      }

      downloadResourceKey = target.resourceKey;
      break;
    }

    if (!downloadResourceKey) {
      const message = `No downloadable resources found for ${wildcardUser.email}.`;
      if (strict) {
        throw new Error(
          `Resource not available for download in portal. ${message} Ensure at least one resource exposes a download action and has seeded rows, or raise E2E_WILDCARD_DOWNLOAD_SCAN_LIMIT.`
        );
      }
      test.skip(true, message);
    }
  });
});
