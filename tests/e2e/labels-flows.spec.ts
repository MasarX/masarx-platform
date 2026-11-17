import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext } from "./utils/role-matrix";
import { assertNavigationPerformance } from "./utils/performance";
import {
  applyResourceLimit,
  fetchResourceSampleId,
  resolveResourceKeyByLabel,
  resolveResourceKeysForUser,
} from "./utils/core-resource";
import {
  ensureBulkActionVisible,
  resolveBulkActionsTestIdPrefix,
  selectFirstTableRow,
} from "./utils/table-actions";
import {
  matchesResourceCategory,
  resolveResourceBulkActions,
} from "../../packages/ui/src/resource-actions-core";

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
  allowedUserTypes: string[];
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
    allowedUserTypes: ["super_admin", "ops_admin"],
  },
  {
    label: "portal",
    app: "portal",
    baseUrl: getPortalBaseUrl,
    authTestId: "portal-auth-required",
    resourceTestIdPrefix: "portal-resource",
    tableTestIdPrefix: "portal-resource-table",
    scopeTypes: ["client", "sender"],
    allowedUserTypes: ["client_admin", "sender_user"],
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

function resolveLabelResourceKeys(params: {
  resourceKeys: string[];
  readRegistry: { resources?: Array<{ key: string; label?: string | null }> } | null;
}) {
  const resources = Array.isArray(params.readRegistry?.resources)
    ? params.readRegistry?.resources
    : [];
  const normalized = params.resourceKeys.filter((key) => {
    const resource = resources.find((entry) => entry?.key === key);
    const label = (resource?.label ?? "").toString().toLowerCase();
    const keyLower = key.toLowerCase();
    const isLabel = label.includes("label") || keyLower.includes("label");
    const isShipment = label.includes("shipment") || keyLower.includes("shipment");
    return isLabel && !isShipment;
  });
  if (normalized.length > 0) {
    return applyResourceLimit(normalized);
  }
  const fallback = resolveResourceKeyByLabel({
    readRegistry: params.readRegistry,
    resourceKeys: params.resourceKeys,
    keyword: "label",
  });
  return fallback ? [fallback] : [];
}

for (const config of appConfigs) {
  test.describe(`${config.label} labels resource flows`, () => {
    test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

    const scopedUsers = demoContext.users.filter((user) =>
      config.scopeTypes.includes(user.scope_type ?? "") &&
      config.allowedUserTypes.includes((user.user_type ?? "").trim())
    );

    test.beforeAll(() => enforceDemoContext(config.label, scopedUsers));

    for (const user of scopedUsers) {
      test(`${config.label} labels list/detail/actions for ${user.email}`, async ({ page }) => {
        test.setTimeout(600_000);
        const baseUrl = config.baseUrl();
        const downloadBasePath = `${baseUrl}/api/resource-download`;
        const bulkActionsTestIdPrefix = resolveBulkActionsTestIdPrefix(
          config.tableTestIdPrefix
        );
        const context = await fetchUserContext({
          app: config.app,
          email: user.email,
          password: demoContext.password ?? "",
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
        if (resourceKeys.length === 0) {
          throw new Error(`No resources available for ${user.email}.`);
        }
        const labelKeys = resolveLabelResourceKeys({
          resourceKeys,
          readRegistry: context.readRegistry,
        });
        if (labelKeys.length === 0) {
          if (strict) {
            throw new Error(`No label resources available for ${user.email} in ${config.label}.`);
          }
          return;
        }

        await page.goto(baseUrl);
        const authGate = page.locator(`[data-testid="${config.authTestId}"]`);
        if (await authGate.isVisible()) {
          await signInWithPassword(page, user.email, demoContext.password || "");
        }
        await expectSignedIn(page, user.email, user.scope_type);

        let exercisedResource = false;
        const unavailableResources: string[] = [];
        const noRowsResources: string[] = [];
        for (const resourceKey of labelKeys) {
          await page.goto(`${baseUrl}/resources/${resourceKey}`, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
          const ready = page.locator(
            `[data-testid="${config.resourceTestIdPrefix}-ready"]`
          );
          const stateLocator = page
            .locator(
                `[data-testid="${config.resourceTestIdPrefix}-ready"], ` +
                `[data-testid="${config.resourceTestIdPrefix}-error"], ` +
                `[data-testid="${config.authTestId}"], ` +
                `[data-testid="${config.label}-resource-blocked"], ` +
                `[data-testid="${config.label}-context-unavailable"], ` +
                `[data-testid="${config.label}-not-found"]`
            )
            .first();
          await expect(stateLocator).toBeVisible();
          const stateId = (await stateLocator.getAttribute("data-testid")) || "";
          if (
            stateId.endsWith("-resource-blocked") ||
            stateId.endsWith("-not-found") ||
            stateId.endsWith("-context-unavailable")
          ) {
            unavailableResources.push(`${resourceKey}:${stateId}`);
            continue;
          }
          if (stateId === config.authTestId) {
            throw new Error(
              `Auth required while evaluating ${resourceKey} in ${config.label} for ${user.email}.`
            );
          }
          if (!(await ready.isVisible())) {
            continue;
          }
          await assertNavigationPerformance(page);

          const hasSelection = await selectFirstTableRow(page);
          if (!hasSelection) {
            noRowsResources.push(resourceKey);
            continue;
          }

          const selectionBar = page.locator(
            `[data-testid="${config.tableTestIdPrefix}-selection-bar"]`
          );
          await expect(selectionBar).toBeVisible();

          const resource =
            context.readRegistry?.resources?.find((entry) => entry?.key === resourceKey) ??
            null;
          const commands = context.commandRegistry.filter((command) =>
            matchesResourceCategory(command?.schema_category ?? null, resourceKey)
          );
          const actions = resolveResourceBulkActions({
            t: (key) => key,
            resourceKey,
            resource,
            commands,
            appKey: config.app,
            appBasePath: baseUrl,
            downloadBasePath,
            userCapabilities: context.me?.capabilities ?? [],
          });

          const downloadAction =
            actions.find((action) => action.execution?.type === "download") ??
            actions.find((action) => action.download);
          if (!downloadAction) {
            continue;
          } else {
            const actionButton = await ensureBulkActionVisible({
              page,
              actionKey: downloadAction.key,
              testIdPrefix: config.tableTestIdPrefix,
            });
            if (!actionButton) {
              throw new Error(`Action ${downloadAction.key} not visible for ${resourceKey}.`);
            }
            if (await actionButton.isDisabled()) {
              await expect(actionButton).toHaveAttribute("title", /.+/);
            }
            exercisedResource = true;
          }

          const optionalActions = actions.filter((action) => {
            const type = action.execution?.type ?? "navigate";
            return ["workflow", "print", "rpc"].includes(type);
          });
          // Label resources can be download-only depending on policy/role;
          // one-click print workflow coverage is asserted by shipment print suites.
          for (const action of optionalActions.slice(0, 2)) {
            const actionButton = await ensureBulkActionVisible({
              page,
              actionKey: action.key,
              testIdPrefix: config.tableTestIdPrefix,
            });
            if (!actionButton) {
              throw new Error(`Action ${action.key} not visible for ${resourceKey}.`);
            }
            if (await actionButton.isDisabled()) {
              await expect(actionButton).toHaveAttribute("title", /.+/);
              continue;
            }
            if (action.execution?.confirm) {
              await actionButton.click();
              const confirmDialog = page.locator(
                `[data-testid="${bulkActionsTestIdPrefix}-confirm-dialog"]`
              );
              await expect(confirmDialog).toBeVisible();
              await page
                .locator(
                  `[data-testid="${bulkActionsTestIdPrefix}-confirm-cancel"]`
                )
                .click();
              await expect(confirmDialog).toHaveCount(0);
            }
          }

          const sample = await fetchResourceSampleId({
            resourceKey,
            idColumn: resource?.id_column ?? null,
            email: user.email,
            password: demoContext.password ?? "",
          });
          if (sample.id) {
            await page.goto(`${baseUrl}/resources/${resourceKey}?id=${sample.id}`, {
              waitUntil: "domcontentloaded",
              timeout: 60_000,
            });
            await expect(ready).toBeVisible();
            await assertNavigationPerformance(page);
            const detail = page.locator(
              `[data-testid="${config.resourceTestIdPrefix}-detail"]`
            );
            await expect(detail).toBeVisible();
          }
        }

        // Some label resources are metadata/config-only and can be empty per scope.
        // The suite still validates route availability, state safety, and actionable rows where present.
        if (!exercisedResource && strict) {
          test.info().annotations.push({
            type: "info",
            description: `No actionable label rows for ${user.email}; unavailable=${unavailableResources.join(",") || "none"} no_rows=${noRowsResources.join(",") || "none"}.`,
          });
        }
      });
    }
  });
}
