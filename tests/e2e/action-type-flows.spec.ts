import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext } from "./utils/role-matrix";
import {
  resolveResourceActionTargetWithSample,
  resolveActionTypeResourceKeysForUser,
} from "./utils/core-resource";
import { ensureBulkActionVisible, selectFirstTableRow } from "./utils/table-actions";
import { assertNavigationPerformance } from "./utils/performance";

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

async function isActionDisabled(
  action: ReturnType<import("@playwright/test").Page["locator"]>
) {
  const disabledAttr = await action.getAttribute("disabled");
  if (disabledAttr !== null) return true;
  const ariaDisabled = await action.getAttribute("aria-disabled");
  if (ariaDisabled === "true") return true;
  const dataDisabled = await action.getAttribute("data-disabled");
  if (dataDisabled === "true") return true;
  return false;
}

for (const config of appConfigs) {
  test.describe(`${config.label} action type flows`, () => {
    test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

    const scopedUsers = demoContext.users.filter((user) =>
      config.scopeTypes.includes(user.scope_type ?? "")
    );

    test.beforeAll(() => enforceDemoContext(config.label, scopedUsers));

    for (const user of scopedUsers) {
      test(`${config.label} action types for ${user.email}`, async ({ page }) => {
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
        const resourceKeys = resolveActionTypeResourceKeysForUser({
          sections,
          readRegistry: context.readRegistry,
          commandRegistry: context.commandRegistry,
          capabilities: context.me?.capabilities ?? null,
        });
        if (resourceKeys.length === 0) {
          throw new Error(`No resources available for ${user.email}.`);
        }

        const printTarget = await resolveResourceActionTargetWithSample({
          resourceKeys,
          readRegistry: context.readRegistry,
          commandRegistry: context.commandRegistry,
          capabilities: context.me?.capabilities ?? null,
          appBasePath: baseUrl,
          downloadBasePath,
          actionType: "print",
          email: user.email,
          password: demoContext.password ?? "",
        });
        const downloadTarget = await resolveResourceActionTargetWithSample({
          resourceKeys,
          readRegistry: context.readRegistry,
          commandRegistry: context.commandRegistry,
          capabilities: context.me?.capabilities ?? null,
          appBasePath: baseUrl,
          downloadBasePath,
          actionType: "download",
          email: user.email,
          password: demoContext.password ?? "",
        });
        const workflowTarget = await resolveResourceActionTargetWithSample({
          resourceKeys,
          readRegistry: context.readRegistry,
          commandRegistry: context.commandRegistry,
          capabilities: context.me?.capabilities ?? null,
          appBasePath: baseUrl,
          downloadBasePath,
          actionType: "workflow",
          email: user.email,
          password: demoContext.password ?? "",
        });
        const workflowBindingTarget = await resolveResourceActionTargetWithSample({
          resourceKeys,
          readRegistry: context.readRegistry,
          commandRegistry: context.commandRegistry,
          capabilities: context.me?.capabilities ?? null,
          appBasePath: baseUrl,
          downloadBasePath,
          actionType: "workflow_binding",
          email: user.email,
          password: demoContext.password ?? "",
        });
        const rpcTarget = await resolveResourceActionTargetWithSample({
          resourceKeys,
          readRegistry: context.readRegistry,
          commandRegistry: context.commandRegistry,
          capabilities: context.me?.capabilities ?? null,
          appBasePath: baseUrl,
          downloadBasePath,
          actionType: "rpc",
          email: user.email,
          password: demoContext.password ?? "",
        });

        await page.goto(baseUrl);
        const authGate = page.locator(`[data-testid="${config.authTestId}"]`);
        if (await authGate.isVisible()) {
          await signInWithPassword(page, user.email, demoContext.password || "");
        }
        await expectSignedIn(page, user.email, user.scope_type);

        const targets = [
          { label: "print", target: printTarget },
          { label: "download", target: downloadTarget },
          { label: "workflow", target: workflowTarget },
          { label: "workflow binding", target: workflowBindingTarget },
          { label: "rpc", target: rpcTarget },
        ];

        if (!targets.some(({ target }) => target)) {
          expect(["driver"]).toContain(context.me?.user?.user_type);
          return;
        }

        for (const { label, target } of targets) {
          if (!target) continue;

          await test.step(`${label} actions for ${target.resourceKey}`, async () => {
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
            await expect(ready).toBeVisible();
            await assertNavigationPerformance(page);

            const hasSelection = await selectFirstTableRow(page);
            if (!hasSelection) {
              if (strict) {
                throw new Error(
                  `No rows available for ${target.resourceKey} in ${config.label}.`
                );
              }
              return;
            }

            const selectionBar = page.locator(
              `[data-testid="${config.tableTestIdPrefix}-selection-bar"]`
            );
            await expect(selectionBar).toBeVisible();

            const action = await ensureBulkActionVisible({
              page,
              actionKey: target.actionKey,
              testIdPrefix: config.tableTestIdPrefix,
            });
            if (!action) {
              throw new Error(
                `Action ${target.actionKey} not visible for ${target.resourceKey} in ${config.label}.`
              );
            }
            const disabled = await isActionDisabled(action);
            if (disabled) {
              await expect(action).toHaveAttribute("title", /.+/);
            }
            await page.keyboard.press("Escape");
          });
        }
      });
    }
  });
}
