import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext } from "./utils/role-matrix";
import {
  resolveResourceKeyByLabel,
  resolveResourceKeysForUser,
} from "./utils/core-resource";
import { assertSingleAppShellSidebar } from "./utils/layout-guards";
import { assertNoAppErrorReload } from "./utils/error-guards";
import { assertNavigationPerformance } from "./utils/performance";
import { captureFullPage, isCaptureEnabled, resolveEvidencePath } from "./utils/evidence";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();
const captureEnabled = isCaptureEnabled();
const evidenceGroup = "ui-resource-detail-open-mode";
const evidencePath = (...segments: string[]) =>
  resolveEvidencePath(evidenceGroup, ...segments);
const drawerViewport = { width: 960, height: 720 };

type AppConfig = {
  label: "console" | "portal";
  app: "console" | "portal";
  baseUrl: () => string;
  authTestId: string;
  resourceTestIdPrefix: string;
  preferredScopeType: string;
};

const appConfigs: AppConfig[] = [
  {
    label: "console",
    app: "console",
    baseUrl: getConsoleBaseUrl,
    authTestId: "console-auth-required",
    resourceTestIdPrefix: "console-resource",
    preferredScopeType: "platform",
  },
  {
    label: "portal",
    app: "portal",
    baseUrl: getPortalBaseUrl,
    authTestId: "portal-auth-required",
    resourceTestIdPrefix: "portal-resource",
    preferredScopeType: "client",
  },
];

test.describe("resource detail open mode", () => {
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  for (const config of appConfigs) {
    test(`${config.label} toggles between side-peek and full-page detail layouts`, async ({ page }) => {
      test.setTimeout(300_000);

      const user = demoContext.users.find(
        (entry) => entry.scope_type === config.preferredScopeType
      );
      if (!user || !demoContext.password) {
        if (strict) {
          throw new Error(`Demo user missing for ${config.label}:${config.preferredScopeType}`);
        }
        test.skip(true, `Demo user missing for ${config.label}:${config.preferredScopeType}`);
      }

      const baseUrl = config.baseUrl();
      const context = await fetchUserContext({
        app: config.app,
        email: user.email,
        password: demoContext.password,
      });

      const sections = Array.isArray(context.navigation.sections)
        ? context.navigation.sections
        : [];
      const resourceKeys = resolveResourceKeysForUser({
        sections,
        readRegistry: context.readRegistry,
        commandRegistry: context.commandRegistry,
        capabilities: context.me?.capabilities ?? null,
      });

      const resourceKey =
        resolveResourceKeyByLabel({
          readRegistry: context.readRegistry,
          resourceKeys,
          keyword: "shipments",
        }) ??
        resourceKeys[0] ??
        null;

      if (!resourceKey) {
        if (strict) {
          throw new Error(`No resources available for ${config.label}:${user.email}`);
        }
        test.skip(true, `No resources available for ${config.label}:${user.email}`);
      }

      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      const authGate = page.locator(`[data-testid="${config.authTestId}"]`);
      if (await authGate.isVisible()) {
        await signInWithPassword(page, user.email, demoContext.password);
      }
      await expectSignedIn(page, user.email, user.scope_type);

      await page.goto(`${baseUrl}/resources/${encodeURIComponent(resourceKey)}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      await expect(
        page.locator(
          `[data-testid="${config.resourceTestIdPrefix}-ready"], [data-testid="${config.resourceTestIdPrefix}-error"], [data-testid="${config.authTestId}"]`
        )
      ).toBeVisible();
      await assertSingleAppShellSidebar(page, config.label);
      await assertNoAppErrorReload(page);
      await assertNavigationPerformance(page);

      if (captureEnabled) {
        await captureFullPage(page, evidencePath(`${config.label}-table-peek.png`));
      }

      const rowLinks = page.locator("table tbody a");
      const rowLinkCount = await rowLinks.count();
      if (rowLinkCount < 2) {
        if (strict) {
          throw new Error(
            `Need at least 2 rows to validate detail reopen regression for ${config.label}:${user.email}`
          );
        }
        test.skip(
          true,
          `Need at least 2 rows to validate detail reopen regression for ${config.label}:${user.email}`
        );
      }

      const propertiesButton = page.getByTestId(
        `${config.resourceTestIdPrefix}-table-view-control-properties`
      );

      await propertiesButton.click({ timeout: 20_000 });
      await expect(page.getByTestId("table-columns-search")).toBeVisible();

      await page.getByLabel("Open records in").selectOption("full");

      await propertiesButton.click({ timeout: 20_000 });

      await rowLinks.first().click({ timeout: 30_000 });
      await page.waitForURL((url) => url.searchParams.get("detail_layout") === "full", {
        timeout: 60_000,
      });

      await expect(page.getByRole("button", { name: "Back to list" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Open side peek" })).toBeVisible();

      if (captureEnabled) {
        await captureFullPage(page, evidencePath(`${config.label}-detail-full.png`));
      }

      await page.getByRole("button", { name: "Open side peek" }).click({ timeout: 20_000 });
      await page.waitForURL((url) => !url.searchParams.has("detail_layout"), {
        timeout: 60_000,
      });

      await expect(propertiesButton).toBeVisible();
      const detailToggle = page.locator(
        `[data-testid="${config.resourceTestIdPrefix}-detail-toggle"]`
      );
      const detailHidden = page.locator(
        `[data-testid="${config.resourceTestIdPrefix}-detail-hidden"]`
      );
      if ((await detailToggle.count()) > 0) {
        await detailToggle.first().click({ timeout: 20_000 });
        await expect(detailHidden).toBeVisible();
        const hiddenUrl = page.url();
        await rowLinks.nth(1).click({ timeout: 30_000 });
        await page.waitForURL(
          (url) =>
            url.toString() !== hiddenUrl &&
            (url.searchParams.get("detail_open") !== "0"),
          { timeout: 60_000 }
        );
      }

      const resizer = page.getByTestId(
        `${config.resourceTestIdPrefix}-detail-resizer`
      );
      const detailPanel = page.getByTestId(
        `${config.resourceTestIdPrefix}-detail-panel-container`
      );

      await expect(resizer).toBeVisible();
      await expect(detailPanel).toBeVisible();

      await resizer.scrollIntoViewIfNeeded();

      const panelBefore = await detailPanel.boundingBox();
      const resizerBox = await resizer.boundingBox();
      if (!panelBefore || !resizerBox) {
        throw new Error("Detail panel resizer bounds unavailable.");
      }

      const dragY = Math.round(resizerBox.y + resizerBox.height / 2);
      const dragStartX = Math.round(resizerBox.x + resizerBox.width / 2);
      await page.mouse.move(dragStartX, dragY);
      await page.mouse.down();
      await page.mouse.move(dragStartX - 160, dragY);
      await page.mouse.up();

      await expect
        .poll(async () => (await detailPanel.boundingBox())?.width ?? 0)
        .toBeGreaterThanOrEqual(panelBefore.width + 80);

      if (captureEnabled) {
        await captureFullPage(page, evidencePath(`${config.label}-detail-peek.png`));
      }

      if (captureEnabled) {
        await page.setViewportSize(drawerViewport);
        await page.waitForTimeout(250);
        await captureFullPage(page, evidencePath(`${config.label}-detail-drawer.png`));
      }
    });
  }
});
