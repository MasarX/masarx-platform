import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext } from "./utils/role-matrix";
import {
  applyResourceLimit,
  resolveResourceActionTarget,
  resolveResourceKeysForUser,
} from "./utils/core-resource";
import { ensureBulkActionVisible, selectFirstTableRow } from "./utils/table-actions";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();

type AppConfig = {
  label: "console" | "portal";
  app: "console" | "portal";
  baseUrl: () => string;
  authTestId: string;
  resourceTestIdPrefix: string;
  tableTestIdPrefix: string;
  scopeTypes: string[];
};

const appConfigs: AppConfig[] = [
  {
    label: "console",
    app: "console",
    baseUrl: getConsoleBaseUrl,
    authTestId: "console-auth-required",
    resourceTestIdPrefix: "console-resource",
    tableTestIdPrefix: "console-resource-table",
    scopeTypes: ["platform", "tenant"],
  },
  {
    label: "portal",
    app: "portal",
    baseUrl: getPortalBaseUrl,
    authTestId: "portal-auth-required",
    resourceTestIdPrefix: "portal-resource",
    tableTestIdPrefix: "portal-resource-table",
    scopeTypes: ["client", "sender"],
  },
];

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

async function isActionDisabled(action: ReturnType<import("@playwright/test").Page["locator"]>) {
  const disabledAttr = await action.getAttribute("disabled");
  if (disabledAttr !== null) return true;
  const ariaDisabled = await action.getAttribute("aria-disabled");
  if (ariaDisabled === "true") return true;
  const dataDisabled = await action.getAttribute("data-disabled");
  if (dataDisabled === "true") return true;
  return false;
}

for (const config of appConfigs) {
  test.describe(`${config.label} navigate action flows`, () => {
    test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

    const scopedUsers = demoContext.users.filter((user) =>
      config.scopeTypes.includes(user.scope_type ?? "")
    );

    test.beforeAll(() => enforceDemoContext(config.label, scopedUsers));

    for (const user of scopedUsers) {
      test(`${config.label} navigate action presence for ${user.email}`, async ({ page }) => {
        test.setTimeout(600_000);
        const baseUrl = config.baseUrl();
        const downloadBasePath = `${baseUrl}/api/resource-download`;
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

        const target = resolveResourceActionTarget({
          resourceKeys,
          readRegistry: context.readRegistry,
          commandRegistry: context.commandRegistry,
          capabilities: context.me?.capabilities ?? null,
          appBasePath: baseUrl,
          downloadBasePath,
          actionType: "navigate",
        });
        if (!target) {
          if (strict) {
            throw new Error(
              `No navigate actions available for ${user.email} in ${config.label}.`
            );
          }
          return;
        }

        await page.goto(baseUrl);
        const authGate = page.locator(`[data-testid="${config.authTestId}"]`);
        if (await authGate.isVisible()) {
          await signInWithPassword(page, user.email, demoContext.password || "");
        }
        await expectSignedIn(page, user.email, user.scope_type);

        await page.goto(`${baseUrl}/resources/${target.resourceKey}`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        const ready = page.locator(
          `[data-testid="${config.resourceTestIdPrefix}-ready"]`
        );
        await expect(
          page.locator(
            `[data-testid="${config.resourceTestIdPrefix}-ready"], [data-testid="${config.resourceTestIdPrefix}-error"], [data-testid="${config.authTestId}"]`
          )
        ).toBeVisible();
        if (!(await ready.isVisible())) return;

        const hasSelection = await selectFirstTableRow(page);
        if (!hasSelection) {
          if (strict) {
            throw new Error(
              `No rows available for ${target.resourceKey} in ${config.label}.`
            );
          }
          return;
        }

        const action = await ensureBulkActionVisible({
          page,
          actionKey: target.actionKey,
          testIdPrefix: config.tableTestIdPrefix,
        });
        if (!action) {
          throw new Error(
            `Navigate action ${target.actionKey} not visible for ${target.resourceKey} in ${config.label}.`
          );
        }
        await expect(action).toBeVisible();
        const disabled = await isActionDisabled(action);
        if (disabled) {
          await expect(action).toHaveAttribute("title", /.+/);
        }
      });
    }
  });
}
