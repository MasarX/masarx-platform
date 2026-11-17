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
import {
  ensureBulkActionVisible,
  resolveBulkActionsTestIdPrefix,
  selectFirstTableRow,
} from "./utils/table-actions";
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

for (const config of appConfigs) {
  test.describe(`${config.label} confirmable action flows`, () => {
    test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

    const scopedUsers = demoContext.users.filter((user) =>
      config.scopeTypes.includes(user.scope_type ?? "")
    );

    test.beforeAll(() => enforceDemoContext(config.label, scopedUsers));

    test(`${config.label} confirms open for at least one role`, async ({ page }) => {
      test.setTimeout(600_000);
      const baseUrl = config.baseUrl();
      const downloadBasePath = `${baseUrl}/api/resource-download`;
      const candidateUsers = (() => {
        const preferred = demoContext.users.filter((user) =>
          config.scopeTypes.includes(user.scope_type ?? "")
        );
        const preferredEmails = new Set(preferred.map((user) => user.email));
        const fallback = demoContext.users.filter(
          (user) => !preferredEmails.has(user.email)
        );
        return [...preferred, ...fallback];
      })();

      let targetUser: (typeof candidateUsers)[number] | null = null;
      let target: { resourceKey: string; actionKey: string } | null = null;

      for (const candidate of candidateUsers) {
        const context = await fetchUserContext({
          app: config.app,
          email: candidate.email,
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
        if (resourceKeys.length === 0) continue;

        const workflowTarget = resolveResourceActionTarget({
          resourceKeys,
          readRegistry: context.readRegistry,
          commandRegistry: context.commandRegistry,
          capabilities: context.me?.capabilities ?? null,
          appBasePath: baseUrl,
          downloadBasePath,
          actionType: "workflow",
          requireConfirm: true,
        });
        const rpcTarget = resolveResourceActionTarget({
          resourceKeys,
          readRegistry: context.readRegistry,
          commandRegistry: context.commandRegistry,
          capabilities: context.me?.capabilities ?? null,
          appBasePath: baseUrl,
          downloadBasePath,
          actionType: "rpc",
          requireConfirm: true,
        });

        const resolvedTarget = workflowTarget ?? rpcTarget ?? null;
        if (!resolvedTarget) continue;
        targetUser = candidate;
        target = resolvedTarget;
        break;
      }

      if (!targetUser || !target) {
        if (strict) {
          throw new Error(
            `No confirmable workflow/rpc actions available in ${config.label}.`
          );
        }
        return;
      }

      await page.goto(baseUrl);
      const authGate = page.locator(`[data-testid="${config.authTestId}"]`);
      if (await authGate.isVisible()) {
        await signInWithPassword(page, targetUser.email, demoContext.password || "");
      }
      await expectSignedIn(page, targetUser.email, targetUser.scope_type);

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
      await assertNavigationPerformance(page);

      const hasSelection = await selectFirstTableRow(page);
      if (!hasSelection) {
        const emptyState = page.locator("tbody [role='status']");
        if ((await emptyState.count()) > 0) {
          await expect(emptyState.first()).toBeVisible();
          return;
        }
        if (strict) {
          throw new Error(`No rows available for ${target.resourceKey} in ${config.label}.`);
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
      if (await action.isDisabled()) {
        if (strict) {
          throw new Error(
            `Action ${target.actionKey} is disabled for ${target.resourceKey} in ${config.label}.`
          );
        }
        return;
      }

      const bulkActionsTestIdPrefix = resolveBulkActionsTestIdPrefix(
        config.tableTestIdPrefix
      );
      await action.click();
      const confirmDialog = page.locator(
        `[data-testid="${bulkActionsTestIdPrefix}-confirm-dialog"]`
      );
      await expect(confirmDialog).toBeVisible();
      await page
        .locator(`[data-testid="${bulkActionsTestIdPrefix}-confirm-cancel"]`)
        .click();
      await expect(confirmDialog).toHaveCount(0);
    });
  });
}
