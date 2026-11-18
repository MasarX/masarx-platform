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
import { captureFullPage, isCaptureEnabled, resolveEvidencePath } from "./utils/evidence";
import enMessages from "../../packages/config/messages/en.json";
import arMessages from "../../packages/config/messages/ar.json";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();
const captureEnabled = isCaptureEnabled();
const evidenceGroup = "ui-resource-detail-title";
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

test.describe("resource detail title screenshots", () => {
  test.skip(!captureEnabled, "Set E2E_CAPTURE_UI=1 to enable screenshot capture.");
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  for (const config of appConfigs) {
    test(`${config.label} captures narrow detail drawer titles`, async ({ page }) => {
      test.setTimeout(300_000);
      await page.setViewportSize(drawerViewport);

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

      const firstRowLink = page.locator("table tbody a").first();
      await expect(firstRowLink).toBeVisible();
      const href = await firstRowLink.getAttribute("href");
      if (!href) {
        if (strict) {
          throw new Error(`No row link href found for ${config.label}:${resourceKey}`);
        }
        test.skip(true, `No row link href found for ${config.label}:${resourceKey}`);
      }

      const parsed = new URL(href, baseUrl);
      const recordId = parsed.searchParams.get("id");
      if (!recordId) {
        if (strict) {
          throw new Error(`No id query param found for ${config.label}:${resourceKey}`);
        }
        test.skip(true, `No id query param found for ${config.label}:${resourceKey}`);
      }

      await page.goto(
        `${baseUrl}/resources/${encodeURIComponent(resourceKey)}?id=${encodeURIComponent(
          recordId
        )}&detail_open=1`,
        {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        }
      );

      const locale = process.env.STUDIO_BROWSER_EXPECTED_LOCALE;
      if (locale !== "en" && locale !== "ar") {
        throw new Error("Explicit owned app locale proof selection required");
      }
      const messages = locale === "ar" ? arMessages : enMessages;
      await expect(page.getByRole("button", { name: messages.ui.resourcePage.detail.backToList, exact: true })).toBeVisible();

      await captureFullPage(
        page,
        evidencePath(`${config.label}-${resourceKey}-drawer-title.png`)
      );
    });
  }
});
