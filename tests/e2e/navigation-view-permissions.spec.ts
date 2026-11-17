import { test, expect, type Page } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext } from "./utils/role-matrix";
import { applyResourceLimit, resolveResourceKeysForUser } from "./utils/core-resource";
import { hasCapability, resolveCapabilitySet } from "./utils/capabilities";

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
  resourceTestIdPrefix: string;
  scopeTypes: string[];
  tableTestIdPrefix: string;
};

const appConfigs: AppConfig[] = [
  {
    label: "console",
    app: "console",
    baseUrl: getConsoleBaseUrl,
    authTestId: "console-auth-required",
    resourceTestIdPrefix: "console-resource",
    scopeTypes: ["platform", "tenant"],
    tableTestIdPrefix: "console-resource-table",
  },
  {
    label: "portal",
    app: "portal",
    baseUrl: getPortalBaseUrl,
    authTestId: "portal-auth-required",
    resourceTestIdPrefix: "portal-resource",
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

async function resolveUserByCapability(params: {
  app: "console" | "portal";
  users: DemoUser[];
  capability: string;
  wantsCapability: boolean;
}) {
  const { app, users, capability, wantsCapability } = params;
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
    const capabilityAllowed = hasCapability(capabilitySet, capability);
    if (capabilityAllowed === wantsCapability) {
      return { user, context };
    }
  }
  return null;
}

async function openFirstReadyResource(params: {
  page: Page;
  config: AppConfig;
  resourceKeys: string[];
}) {
  const { page, config, resourceKeys } = params;
  const readyState = `${config.resourceTestIdPrefix}-ready`;
  const stateSelector = [
    `[data-testid="${readyState}"]`,
    `[data-testid="${config.resourceTestIdPrefix}-error"]`,
    `[data-testid="${config.resourceTestIdPrefix}-blocked"]`,
    `[data-testid="${config.resourceTestIdPrefix}-not-found"]`,
    `[data-testid="${config.label}-context-unavailable"]`,
    `[data-testid="${config.authTestId}"]`,
  ].join(", ");
  const failures: string[] = [];

  for (const resourceKey of resourceKeys) {
    await page.goto(`${config.baseUrl()}/resources/${resourceKey}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const state = page.locator(stateSelector).first();
    await expect(state).toBeVisible();
    const stateId = (await state.getAttribute("data-testid")) ?? "unknown";
    if (stateId === readyState) {
      return resourceKey;
    }
    failures.push(`${resourceKey}:${stateId}`);
  }

  throw new Error(
    `Resource not available for ${config.label}; tried=${failures.join(",") || "none"}.`
  );
}

for (const config of appConfigs) {
  test.describe(`${config.label} view permissions`, () => {
    test.skip(
      !demoContext.available && !strict,
      demoContext.reason ?? "Demo accounts missing."
    );

    const scopedUsers = demoContext.users.filter((user) =>
      config.scopeTypes.includes(user.scope_type ?? "")
    );
    const fallbackUsers =
      config.label === "portal"
        ? demoContext.users.filter((user) => !config.scopeTypes.includes(user.scope_type ?? ""))
        : [];
    const candidateUsers = [...scopedUsers, ...fallbackUsers].filter(
      (user, index, list) =>
        list.findIndex((entry) => entry.email === user.email) === index
    );

    test.beforeAll(() => enforceDemoContext(config.label, candidateUsers));

    test(`${config.label} view panel disables management without settings.request`, async ({
      page,
    }) => {
      const candidate = await resolveUserByCapability({
        app: config.app,
        users: candidateUsers,
        capability: "settings.request",
        wantsCapability: false,
      });
      if (!candidate) {
        test.skip(true, `No ${config.label} user without settings.request.`);
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

      await page.goto(config.baseUrl());
      const authGate = page.locator(`[data-testid="${config.authTestId}"]`);
      if (await authGate.isVisible()) {
        await signInWithPassword(page, user.email, demoContext.password || "");
      }
      await expectSignedIn(page, user.email, user.scope_type);

      await openFirstReadyResource({ page, config, resourceKeys });

      const viewControl = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-view-control-views"]`
      );
      if ((await viewControl.count()) === 0) return;
      await viewControl.first().click();
      const panel = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-views-panel"]`
      );
      if ((await panel.count()) === 0) return;
      await expect(panel).toBeVisible();
      await expect(panel).toContainText(
        "View management is disabled for your access scope."
      );
      const saveToggle = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-view-save-toggle"]`
      );
      await expect(saveToggle).toHaveCount(0);
    });

    test(`${config.label} view panel shows management controls with settings.request`, async ({
      page,
    }) => {
      const candidate = await resolveUserByCapability({
        app: config.app,
        users: candidateUsers,
        capability: "settings.request",
        wantsCapability: true,
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

      await page.goto(config.baseUrl());
      const authGate = page.locator(`[data-testid="${config.authTestId}"]`);
      if (await authGate.isVisible()) {
        await signInWithPassword(page, user.email, demoContext.password || "");
      }
      await expectSignedIn(page, user.email, user.scope_type);

      await openFirstReadyResource({ page, config, resourceKeys });
      const viewControl = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-view-control-views"]`
      );
      if ((await viewControl.count()) === 0) return;
      await viewControl.first().click();
      const panel = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-views-panel"]`
      );
      if ((await panel.count()) === 0) return;
      await expect(panel).toBeVisible();
      const saveToggle = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-view-save-toggle"]`
      );
      await expect(saveToggle).toBeVisible();
    });
  });
}
