import { test, expect, type Route, type Locator } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext } from "./utils/role-matrix";
import { assertNavigationPerformance } from "./utils/performance";
import {
  applyResourceLimit,
  resolveResourceKeysForUser,
} from "./utils/core-resource";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();

type AppConfig = {
  label: "console" | "portal";
  app: "console" | "portal";
  baseUrl: () => string;
  authTestId: string;
  resourceTestIdPrefix: string;
  scopeTypes: string[];
};

const appConfigs: AppConfig[] = [
  {
    label: "console",
    app: "console",
    baseUrl: getConsoleBaseUrl,
    authTestId: "console-auth-required",
    resourceTestIdPrefix: "console-resource",
    scopeTypes: ["platform", "tenant"],
  },
  {
    label: "portal",
    app: "portal",
    baseUrl: getPortalBaseUrl,
    authTestId: "portal-auth-required",
    resourceTestIdPrefix: "portal-resource",
    scopeTypes: ["client", "sender"],
  },
];

function enforceDemoContext(scopeLabel: string, users: Array<{ email: string }>) {
  if (!demoContext.available) {
    if (strict) {
      throw new Error(
        `Demo accounts missing for ${scopeLabel}: ${demoContext.reason}`
      );
    }
    return;
  }
  if (users.length === 0 && strict) {
    throw new Error(`No demo users available for ${scopeLabel}.`);
  }
}

async function expectAnyLocatorVisible(locator: Locator) {
  await expect
    .poll(async () => {
      const count = await locator.count();
      for (let index = 0; index < count; index += 1) {
        if (await locator.nth(index).isVisible()) return true;
      }
      return false;
    })
    .toBe(true);
}

for (const config of appConfigs) {
  test.describe(`${config.label} resource error handling`, () => {
    test.skip(
      !demoContext.available && !strict,
      demoContext.reason ?? "Demo accounts missing."
    );

    const scopedUsers = demoContext.users.filter((user) =>
      config.scopeTypes.includes(user.scope_type ?? "")
    );

    test.beforeAll(() => enforceDemoContext(config.label, scopedUsers));

    const user = scopedUsers[0];
    if (!user) return;

    test(`${config.label} resource not registered surfaces error notice`, async ({
      page,
    }) => {
      test.setTimeout(600_000);
      const baseUrl = config.baseUrl();
      const context = await fetchUserContext({
        app: config.app,
        email: user.email,
        password: demoContext.password ?? "",
      });
      const sections = Array.isArray(context.navigation.sections)
        ? context.navigation.sections
        : [];
      const resourceKeys = applyResourceLimit(
        resolveResourceKeysForUser({
          sections,
          readRegistry: context.readRegistry,
          commandRegistry: context.commandRegistry,
          capabilities: context.me?.capabilities ?? null,
        })
      );
      if (resourceKeys.length === 0) {
        throw new Error(`No resources available for ${user.email}.`);
      }
      const resourceKey = resourceKeys[0];
      const missingKeyBase = `${resourceKey}_missing_e2e`;
      const invalidResourceKey = resourceKeys.includes(missingKeyBase)
        ? `${missingKeyBase}_${Date.now()}`
        : missingKeyBase;

      await page.goto(baseUrl);
      const authGate = page.locator(`[data-testid="${config.authTestId}"]`);
      if (await authGate.isVisible()) {
        await signInWithPassword(page, user.email, demoContext.password || "");
      }
      await expectSignedIn(page, user.email, user.scope_type);

      await page.goto(`${baseUrl}/resources/${invalidResourceKey}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      const errorState = page.locator(
        `[data-testid="${config.resourceTestIdPrefix}-error"]`
      );
      await expectAnyLocatorVisible(errorState);
      await expect
        .poll(async () => {
          const count = await errorState.count();
          for (let index = 0; index < count; index += 1) {
            const candidate = errorState.nth(index);
            if (!(await candidate.isVisible())) continue;
            const text = (await candidate.innerText().catch(() => "")).trim();
            if (text.includes(invalidResourceKey)) return true;
          }
          return false;
        })
        .toBe(true);
    });

    test(`${config.label} inline edit failure shows redacted error`, async ({
      page,
    }) => {
      test.setTimeout(600_000);
      const baseUrl = config.baseUrl();
      const context = await fetchUserContext({
        app: config.app,
        email: user.email,
        password: demoContext.password ?? "",
      });
      const sections = Array.isArray(context.navigation.sections)
        ? context.navigation.sections
        : [];
      const resourceKeys = applyResourceLimit(
        resolveResourceKeysForUser({
          sections,
          readRegistry: context.readRegistry,
          commandRegistry: context.commandRegistry,
          capabilities: context.me?.capabilities ?? null,
        })
      );
      if (resourceKeys.length === 0) {
        throw new Error(`No resources available for ${user.email}.`);
      }
      const resourceKey = resourceKeys[0];
      const redactedToken =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
      let injected = false;
      const editRoute = async (route: Route) => {
        if (injected) {
          await route.continue();
          return;
        }
        const request = route.request();
        const body = request.postData() ?? "";
        if (!body.includes(`"p_resource":"${resourceKey}"`)) {
          await route.continue();
          return;
        }
        injected = true;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            message: `token=${redactedToken}`,
            details: `token=${redactedToken}`,
          }),
        });
      };
      await page.route("**/rest/v1/rpc/ui_update_resource_v1**", editRoute);

      await page.goto(baseUrl);
      const authGate = page.locator(`[data-testid="${config.authTestId}"]`);
      if (await authGate.isVisible()) {
        await signInWithPassword(page, user.email, demoContext.password || "");
      }
      await expectSignedIn(page, user.email, user.scope_type);

      await page.goto(`${baseUrl}/resources/${resourceKey}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      const ready = page.locator(
        `[data-testid="${config.resourceTestIdPrefix}-ready"]`
      );
      const resourceState = page.locator(
        `[data-testid="${config.resourceTestIdPrefix}-ready"], [data-testid="${config.resourceTestIdPrefix}-error"], [data-testid="${config.authTestId}"]`
      );
      await expectAnyLocatorVisible(resourceState);
      if (!(await ready.isVisible())) return;
      await assertNavigationPerformance(page);

      const editAction = page.locator('[data-testid="table-inline-edit-action"]');
      if ((await editAction.count()) === 0) {
        if (strict) {
          throw new Error(`Inline edit not available for ${config.label}.`);
        }
        return;
      }
      await editAction.first().click();
      const editRow = page
        .locator('[data-testid="table-inline-edit-save"]')
        .first()
        .locator("xpath=ancestor::tr[1]");
      const editInput = editRow.locator(
        'input:not([type="checkbox"]):not([type="hidden"]):not([readonly]), textarea:not([readonly]), select'
      );
      if ((await editInput.count()) === 0) {
        if (strict) {
          throw new Error(`Inline edit input missing for ${config.label}.`);
        }
        return;
      }
      const inputHandle = editInput.first();
      const tag = await inputHandle.evaluate((node) => node.tagName.toLowerCase());
      if (tag === "select") {
        const options = inputHandle.locator("option");
        if ((await options.count()) > 1) {
          const optionValue = await options.nth(1).getAttribute("value");
          if (optionValue) {
            await inputHandle.selectOption(optionValue);
          }
        }
      } else {
        await inputHandle.fill(`e2e-${Date.now()}`);
      }
      const saveButton = page.locator('[data-testid="table-inline-edit-save"]');
      await saveButton.first().click();
      if (strict && !injected) {
        throw new Error("Inline edit update route was not intercepted.");
      }
      const redactedInline = editRow.getByText("[redacted]").first();
      const redactedToast = page.locator(".ui-toast").filter({ hasText: "[redacted]" }).first();
      await expect
        .poll(async () => {
          const inlineVisible =
            (await redactedInline.count()) > 0 && (await redactedInline.isVisible());
          const toastVisible =
            (await redactedToast.count()) > 0 && (await redactedToast.isVisible());
          return inlineVisible || toastVisible;
        })
        .toBe(true);
      await page.unroute("**/rest/v1/rpc/ui_update_resource_v1**", editRoute);
    });
  });
}
