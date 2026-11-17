import { test, expect, type Route } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext } from "./utils/role-matrix";
import {
  applyResourceLimit,
  resolveResourceKeysForUser,
} from "./utils/core-resource";
import { hasCapability, resolveCapabilitySet } from "./utils/capabilities";
import {
  captureUiEvents,
  captureUiEventRequests,
} from "./utils/ui-events";

type DemoUser = {
  email: string;
  user_type?: string;
  scope_type?: string;
};

type AppConfig = {
  label: "console" | "portal";
  app: "console" | "portal";
  baseUrl: () => string;
  authTestId: string;
  scopeTypes: string[];
  tableTestIdPrefix: string;
};

const appConfigs: AppConfig[] = [
  {
    label: "console",
    app: "console",
    baseUrl: getConsoleBaseUrl,
    authTestId: "console-auth-required",
    scopeTypes: ["platform", "tenant"],
    tableTestIdPrefix: "console-resource-table",
  },
  {
    label: "portal",
    app: "portal",
    baseUrl: getPortalBaseUrl,
    authTestId: "portal-auth-required",
    scopeTypes: ["client", "sender"],
    tableTestIdPrefix: "portal-resource-table",
  },
];

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();

function enforceDemoContext(scopeLabel: string, users: DemoUser[]) {
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

async function resolveUserWithCapability(params: {
  app: "console" | "portal";
  users: DemoUser[];
  capability: string;
}) {
  const { app, users, capability } = params;
  for (const user of users) {
    const context = await fetchUserContext({
      app,
      email: user.email,
      password: demoContext.password ?? "",
    });
    const capabilities = Array.isArray(context.me?.capabilities)
      ? context.me?.capabilities
      : [];
    const capabilitySet = resolveCapabilitySet(capabilities);
    if (hasCapability(capabilitySet, capability)) {
      return { user, context };
    }
  }
  return null;
}

async function waitForEvent<T>(
  find: () => T | undefined,
  options?: { timeout?: number }
) {
  await expect.poll(() => find() ?? null, options).not.toBeNull();
  return find();
}

for (const config of appConfigs) {
  test.describe(`${config.label} view error handling`, () => {
    test.skip(
      !demoContext.available && !strict,
      demoContext.reason ?? "Demo accounts missing."
    );

    const scopedUsers = demoContext.users.filter((user) =>
      config.scopeTypes.includes(user.scope_type ?? "")
    );

    test.beforeAll(() => enforceDemoContext(config.label, scopedUsers));

    test(`${config.label} view save error is redacted and logged`, async ({
      page,
    }) => {
      test.setTimeout(600_000);
      const candidate = await resolveUserWithCapability({
        app: config.app,
        users: scopedUsers,
        capability: "settings.request",
      });
      if (!candidate) {
        test.skip(true, `No ${config.label} user with settings.request.`);
        return;
      }

      const { user, context } = candidate;
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
      const events = captureUiEvents(page);
      const requestEvents = captureUiEventRequests(page);
      const redactedToken =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
      let injected = false;
      const errorRoute = async (route: Route) => {
        if (injected) {
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
      await page.route(
        "**/rest/v1/rpc/request_settings_change_v1**",
        errorRoute
      );

      await page.goto(config.baseUrl());
      const authGate = page.locator(`[data-testid="${config.authTestId}"]`);
      if (await authGate.isVisible()) {
        await signInWithPassword(page, user.email, demoContext.password || "");
      }
      await expectSignedIn(page, user.email, user.scope_type);

      await page.goto(`${config.baseUrl()}/resources/${resourceKey}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      const viewControl = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-view-control-views"]`
      );
      if ((await viewControl.count()) === 0) {
        if (strict) {
          throw new Error(`View control missing for ${config.label}.`);
        }
        return;
      }
      await viewControl.first().click();
      const panel = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-views-panel"]`
      );
      if ((await panel.count()) === 0) {
        if (strict) {
          throw new Error(`View panel missing for ${config.label}.`);
        }
        return;
      }
      await expect(panel).toBeVisible();
      const saveToggle = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-view-save-toggle"]`
      );
      if ((await saveToggle.count()) === 0) {
        if (strict) {
          throw new Error(`View save toggle missing for ${config.label}.`);
        }
        return;
      }
      await saveToggle.first().click();
      const saveName = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-view-save-name"]`
      );
      await expect(saveName).toBeVisible();
      const viewName = `E2E View ${Date.now()}`;
      await saveName.fill(viewName);
      const createButton = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-view-save-create"]`
      );
      await createButton.first().click();

      const toast = page.locator(".ui-toast");
      await expect(toast).toContainText("[redacted]");
      await expect(panel).toContainText("[redacted]");

      const errorEvent = await waitForEvent(
        () =>
          events.find(
            (entry) =>
              entry.type === "ui.table.view.save.error" &&
              entry.context === resourceKey
          ),
        { timeout: 10_000 }
      );
      expect(errorEvent?.timestamp).toBeTruthy();
      const requestEvent = await waitForEvent(
        () =>
          requestEvents.find(
            (entry) =>
              entry.type === "ui.table.view.save.error" &&
              entry.context === resourceKey
          ),
        { timeout: 10_000 }
      );
      expect(requestEvent?.timestamp).toBeTruthy();

      await page.unroute(
        "**/rest/v1/rpc/request_settings_change_v1**",
        errorRoute
      );
    });

    test(`${config.label} view delete error is redacted and logged`, async ({
      page,
    }) => {
      test.setTimeout(600_000);
      const candidate = await resolveUserWithCapability({
        app: config.app,
        users: scopedUsers,
        capability: "settings.request",
      });
      if (!candidate) {
        test.skip(true, `No ${config.label} user with settings.request.`);
        return;
      }

      const { user, context } = candidate;
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
      const events = captureUiEvents(page);
      const requestEvents = captureUiEventRequests(page);
      const redactedToken =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
      let injected = false;
      const errorRoute = async (route: Route) => {
        if (injected) {
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
      await page.route(
        "**/rest/v1/rpc/request_settings_change_v1**",
        errorRoute
      );

      await page.goto(config.baseUrl());
      const authGate = page.locator(`[data-testid="${config.authTestId}"]`);
      if (await authGate.isVisible()) {
        await signInWithPassword(page, user.email, demoContext.password || "");
      }
      await expectSignedIn(page, user.email, user.scope_type);

      await page.goto(`${config.baseUrl()}/resources/${resourceKey}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      const viewControl = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-view-control-views"]`
      );
      if ((await viewControl.count()) === 0) {
        if (strict) {
          throw new Error(`View control missing for ${config.label}.`);
        }
        return;
      }
      await viewControl.first().click();
      const panel = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-views-panel"]`
      );
      if ((await panel.count()) === 0) {
        if (strict) {
          throw new Error(`View panel missing for ${config.label}.`);
        }
        return;
      }
      await expect(panel).toBeVisible();
      const deleteToggle = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-view-delete-toggle"]`
      );
      if ((await deleteToggle.count()) === 0) {
        if (strict) {
          throw new Error(`View delete toggle missing for ${config.label}.`);
        }
        return;
      }
      if (await deleteToggle.first().isDisabled()) {
        if (strict) {
          throw new Error(`View delete toggle disabled for ${config.label}.`);
        }
        return;
      }
      await deleteToggle.first().click();
      const confirmDialog = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-view-delete-confirm-dialog"]`
      );
      if ((await confirmDialog.count()) === 0) {
        if (strict) {
          throw new Error(`View delete dialog missing for ${config.label}.`);
        }
        return;
      }
      await expect(confirmDialog).toBeVisible();
      await page
        .locator(
          `[data-testid="${config.tableTestIdPrefix}-view-delete-confirm-submit"]`
        )
        .click();

      const toast = page.locator(".ui-toast");
      await expect(toast).toContainText("[redacted]");
      await expect(panel).toContainText("[redacted]");

      const errorEvent = await waitForEvent(
        () =>
          events.find(
            (entry) =>
              entry.type === "ui.table.view.delete.error" &&
              entry.context === resourceKey
          ),
        { timeout: 10_000 }
      );
      expect(errorEvent?.timestamp).toBeTruthy();
      const requestEvent = await waitForEvent(
        () =>
          requestEvents.find(
            (entry) =>
              entry.type === "ui.table.view.delete.error" &&
              entry.context === resourceKey
          ),
        { timeout: 10_000 }
      );
      expect(requestEvent?.timestamp).toBeTruthy();

      await page.unroute(
        "**/rest/v1/rpc/request_settings_change_v1**",
        errorRoute
      );
    });
  });
}
