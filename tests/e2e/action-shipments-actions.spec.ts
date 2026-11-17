import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext } from "./utils/role-matrix";
import { assertNavigationPerformance } from "./utils/performance";
import { assertNoAppErrorReload } from "./utils/error-guards";
import { assertSingleAppShellSidebar } from "./utils/layout-guards";
import { captureRuntimeErrors, expectNoRuntimeErrors } from "./utils/runtime-errors";
import {
  applyResourceLimit,
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

for (const config of appConfigs) {
  test.describe(`${config.label} shipments bulk actions`, () => {
    test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

    const scopedUsers = demoContext.users.filter((user) =>
      config.scopeTypes.includes(user.scope_type ?? "") &&
      config.allowedUserTypes.includes((user.user_type ?? "").trim())
    );

    test.beforeAll(() => enforceDemoContext(config.label, scopedUsers));

    for (const user of scopedUsers) {
      test(`${config.label} shipments actions for ${user.email}`, async ({ page }) => {
        test.setTimeout(600_000);
        const capture = captureRuntimeErrors(page);

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

        const requiredActionKeys = [
          "shipments.edit",
          "shipments.delete",
          "shipments.print_labels",
          "shipments.update_geocode",
        ];

        const shipmentsKey =
          resolveResourceKeyByLabel({
            readRegistry: context.readRegistry,
            resourceKeys,
            keyword: "shipments",
          }) ??
          resourceKeys.find((resourceKey) => {
            const commandsForResource = context.commandRegistry.filter((command) =>
              matchesResourceCategory(command?.schema_category ?? null, resourceKey)
            );
            const commandKeys = new Set(
              commandsForResource
                .map((command) => command?.key ?? "")
                .filter((key) => Boolean(key && key.trim()))
            );
            return requiredActionKeys.every((key) => commandKeys.has(key));
          });

        if (!shipmentsKey) {
          const hasWildcard =
            Array.isArray(context.me?.capabilities) &&
            context.me?.capabilities.includes("*");
          if (hasWildcard || strict) {
            throw new Error(
              `Shipments resource not available for ${user.email} in ${config.label}.`
            );
          }
          test.skip(
            true,
            `Shipments resource not available for ${user.email} in ${config.label}.`
          );
        }

        const resource =
          context.readRegistry?.resources?.find((entry) => entry?.key === shipmentsKey) ??
          null;
        const commands = context.commandRegistry.filter((command) =>
          matchesResourceCategory(command?.schema_category ?? null, shipmentsKey)
        );
        const actions = resolveResourceBulkActions({
          t: (key) => key,
          resourceKey: shipmentsKey,
          resource,
          commands,
          appKey: config.app,
          appBasePath: baseUrl,
          downloadBasePath,
          userCapabilities: context.me?.capabilities ?? [],
        });
        const actionableRequiredActionKeys = requiredActionKeys.filter((key) => {
          const action = actions.find((entry) => entry.key === key);
          return Boolean(action && !action.disabledReason);
        });

        await page.goto(baseUrl);
        const authGate = page.locator(`[data-testid="${config.authTestId}"]`);
        if (await authGate.isVisible()) {
          await signInWithPassword(page, user.email, demoContext.password || "");
        }
        await expectSignedIn(page, user.email, user.scope_type);

        await page.goto(`${baseUrl}/resources/${shipmentsKey}`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        const readyStateId = `${config.resourceTestIdPrefix}-ready`;
        const stateSelector = [
          `[data-testid="${readyStateId}"]`,
          `[data-testid="${config.resourceTestIdPrefix}-error"]`,
          `[data-testid="${config.resourceTestIdPrefix}-blocked"]`,
          `[data-testid="${config.label}-not-found"]`,
          `[data-testid="${config.label}-context-unavailable"]`,
          `[data-testid="${config.authTestId}"]`,
        ].join(", ");
        const state = page.locator(stateSelector).first();
        await expect(
          page.locator(stateSelector)
        ).toBeVisible({ timeout: 30_000 });
        await assertSingleAppShellSidebar(page, config.label);
        await assertNoAppErrorReload(page);
        const stateId = (await state.getAttribute("data-testid")) ?? "unknown";
        if (stateId !== readyStateId) {
          throw new Error(
            `Route missing from navigation or resource not available for ${shipmentsKey} in ${config.label} (${user.email}); state=${stateId}.`
          );
        }
        await expect(page.locator(`[data-testid="${readyStateId}"]`)).toBeVisible();
        await assertNavigationPerformance(page);

        if (actionableRequiredActionKeys.length === 0) {
          await expectNoRuntimeErrors(capture);
          return;
        }

        const hasSelection = await selectFirstTableRow(page);
        if (!hasSelection) {
          if (strict) {
            throw new Error(`No rows available for ${shipmentsKey} in ${config.label}.`);
          }
          test.skip(
            true,
            `No rows available for ${shipmentsKey} in ${config.label}.`
          );
        }
        const selectionBar = page.locator(
          `[data-testid="${config.tableTestIdPrefix}-selection-bar"]`
        );
        await expect(selectionBar).toBeVisible();
        await expect(selectionBar).toContainText("Selected 1");
        const rowCheckboxes = page.locator("tbody input[type='checkbox']");
        let selectionCount = 1;
        if ((await rowCheckboxes.count()) > 1) {
          try {
            await rowCheckboxes.nth(1).check({ force: true });
            await expect(rowCheckboxes.nth(1)).toBeChecked();
            await expect(selectionBar).toContainText("Selected 2");
            selectionCount = 2;
          } catch {
            selectionCount = 1;
          }
        }
        const bulkActionsTestIdPrefix = resolveBulkActionsTestIdPrefix(
          config.tableTestIdPrefix
        );

        const isSelectionOutOfRange = (
          action: typeof actions[number],
          count: number
        ) => {
          const parseCount = (value: unknown) => {
            if (typeof value === "number" && Number.isFinite(value)) return value;
            if (typeof value === "string") {
              const trimmed = value.trim();
              if (!trimmed) return null;
              const parsed = Number.parseInt(trimmed, 10);
              return Number.isFinite(parsed) ? parsed : null;
            }
            return null;
          };
          const mode = action.selection?.mode ?? null;
          const min =
            parseCount(action.selection?.min_count) ??
            (mode === "none" || mode === "any" ? 0 : 1);
          const max =
            parseCount(action.selection?.max_count) ??
            (mode === "single" ? 1 : undefined);
          if (count < min) return true;
          if (typeof max === "number" && count > max) return true;
          return false;
        };

        for (const actionKey of actionableRequiredActionKeys) {
          const commandExists = commands.some(
            (command) => command?.key === actionKey
          );
          if (!commandExists) {
            if (strict) {
              throw new Error(
                `Command ${actionKey} missing for ${shipmentsKey} in ${config.label}.`
              );
            }
            continue;
          }
          const action = actions.find((entry) => entry.key === actionKey);
          if (!action) {
            if (strict) {
              throw new Error(
                `Action ${actionKey} missing for ${shipmentsKey} in ${config.label}.`
              );
            }
            continue;
          }
          if (action.key === "shipments.print_labels") {
            const params =
              action.execution?.params &&
              typeof action.execution.params === "object"
                ? (action.execution.params as Record<string, unknown>)
                : null;
            const outputPaths = Array.isArray(params?.output_url_paths)
              ? params.output_url_paths
              : [];
            if (params?.auto_download !== true) {
              throw new Error(
                `shipments.print_labels auto_download contract missing for ${shipmentsKey} in ${config.label}.`
              );
            }
            if (outputPaths.length === 0) {
              throw new Error(
                `shipments.print_labels output_url_paths contract missing for ${shipmentsKey} in ${config.label}.`
              );
            }
            if (params?.fallback_mode !== "none") {
              throw new Error(
                `shipments.print_labels fallback_mode must be none for ${shipmentsKey} in ${config.label}.`
              );
            }
            if (!Array.isArray(params?.poll_schedule_ms) || params.poll_schedule_ms.length === 0) {
              throw new Error(
                `shipments.print_labels poll_schedule_ms contract missing for ${shipmentsKey} in ${config.label}.`
              );
            }
            if (
              typeof params?.target_download_ms !== "number" &&
              typeof params?.target_download_ms !== "string"
            ) {
              throw new Error(
                `shipments.print_labels target_download_ms contract missing for ${shipmentsKey} in ${config.label}.`
              );
            }
          }
          const actionButton = await ensureBulkActionVisible({
            page,
            actionKey: action.key,
            testIdPrefix: config.tableTestIdPrefix,
          });
          if (!actionButton) {
            throw new Error(
              `Action ${action.key} not visible for ${shipmentsKey} in ${config.label}.`
            );
          }
          const expectedDisabled =
            Boolean(action.disabledReason) ||
            isSelectionOutOfRange(action, selectionCount);
          if (expectedDisabled) {
            await expect(actionButton).toBeDisabled();
            await expect(actionButton).toHaveAttribute("title", /.+/);
            continue;
          }
          await expect(actionButton).toBeEnabled();
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
            continue;
          }
          const actionType = action.execution?.type ?? "navigate";
          if (actionType === "navigate") {
            if (!action.href) {
              throw new Error(
                `Action ${action.key} missing href for ${shipmentsKey} in ${config.label}.`
              );
            }
          } else if (
            actionType === "rpc" ||
            actionType === "workflow" ||
            actionType === "print"
          ) {
            if (!action.execution?.rpc) {
              throw new Error(
                `Action ${action.key} missing rpc for ${shipmentsKey} in ${config.label}.`
              );
            }
          }
        }

        const updateKeys = Array.from(
          new Set(
            commands
              .filter((command) => {
                const key = command?.key ?? "";
                const label = command?.label ?? "";
                return /update/i.test(key) || /update/i.test(label);
              })
              .map((command) => command?.key ?? "")
              .filter((key) => Boolean(key && key.trim()))
          )
        ).filter((key) => !requiredActionKeys.includes(key));

        for (const actionKey of updateKeys.slice(0, 3)) {
          const action = actions.find((entry) => entry.key === actionKey) ?? null;
          if (!action) {
            if (strict) {
              throw new Error(
                `Update action ${actionKey} missing for ${shipmentsKey} in ${config.label}.`
              );
            }
            continue;
          }
          const actionButton = await ensureBulkActionVisible({
            page,
            actionKey: action.key,
            testIdPrefix: config.tableTestIdPrefix,
          });
          if (!actionButton) {
            throw new Error(
              `Action ${action.key} not visible for ${shipmentsKey} in ${config.label}.`
            );
          }
          const expectedDisabled =
            Boolean(action.disabledReason) ||
            isSelectionOutOfRange(action, selectionCount);
          if (expectedDisabled) {
            await expect(actionButton).toBeDisabled();
            await expect(actionButton).toHaveAttribute("title", /.+/);
            continue;
          }
          await expect(actionButton).toBeEnabled();
        }

        capture.dispose();
        await expectNoRuntimeErrors(capture, {
          label: `${config.label}:${user.email}:shipments`,
        });
      });
    }
  });
}
