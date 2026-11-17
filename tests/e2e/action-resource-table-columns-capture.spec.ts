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

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();
const captureEnabled = isCaptureEnabled();
const evidenceGroup = "ui-resource-table-columns";
const evidencePath = (...segments: string[]) =>
  resolveEvidencePath(evidenceGroup, ...segments);

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

test.describe("resource table column screenshots", () => {
  test.skip(!captureEnabled, "Set E2E_CAPTURE_UI=1 to enable screenshot capture.");
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  for (const config of appConfigs) {
    test(`${config.label} captures resource table columns properties`, async ({ page }) => {
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

      const preferredKey =
        resolveResourceKeyByLabel({
          readRegistry: context.readRegistry,
          resourceKeys,
          keyword: "shipments",
        }) ?? null;
      const resourceKey = preferredKey ?? resourceKeys[0] ?? null;

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

      await page.goto(`${baseUrl}/resources/${resourceKey}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      await expect(
        page.locator(
          `[data-testid="${config.resourceTestIdPrefix}-ready"], [data-testid="${config.resourceTestIdPrefix}-error"], [data-testid="${config.authTestId}"]`
        )
      ).toBeVisible();

      await captureFullPage(
        page,
        evidencePath(`${config.label}-${resourceKey}-table.png`)
      );

      const propertiesButton = page.getByRole("button", { name: /Properties/i });
      if (await propertiesButton.isVisible()) {
        await propertiesButton.click({ timeout: 20_000 });
        await expect(page.getByTestId("table-columns-search")).toBeVisible();
        await captureFullPage(
          page,
          evidencePath(`${config.label}-${resourceKey}-properties.png`)
        );
      }
    });
  }
});
