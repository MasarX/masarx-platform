import { test, expect, type Locator } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext } from "./utils/role-matrix";
import {
  applyResourceLimit,
  fetchResourceSampleRow,
  resolveConfirmableActions,
  resolveItemFieldValue,
  resolveResourceKeysForUser,
} from "./utils/core-resource";
import {
  applyAndClearFirstFilter,
  applyAndClearFirstGroup,
  applyAndClearFirstSort,
  ensureBulkActionVisible,
  resolveBulkActionsTestIdPrefix,
  selectFirstTableRow,
} from "./utils/table-actions";
import {
  captureUiEvents,
  captureUiEventRequests,
  captureViewSaveDiagnostics,
  waitForUiEvent,
} from "./utils/ui-events";

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
  preferredScopeTypes: string[];
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
    preferredScopeTypes: ["tenant", "platform"],
  },
  {
    label: "portal",
    app: "portal",
    baseUrl: getPortalBaseUrl,
    authTestId: "portal-auth-required",
    resourceTestIdPrefix: "portal-resource",
    tableTestIdPrefix: "portal-resource-table",
    scopeTypes: ["client", "sender"],
    preferredScopeTypes: ["client", "sender"],
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

async function tryClick(locator: Locator, options?: { timeout?: number }) {
  if ((await locator.count()) === 0) return false;
  const timeout = options?.timeout ?? 5_000;
  try {
    await locator.first().waitFor({ state: "visible", timeout });
    await locator.first().click({ timeout });
    return true;
  } catch {
    return false;
  }
}


for (const config of appConfigs) {
  test.describe(`${config.label} logging table events`, () => {
    test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

    const scopedUsers = demoContext.users.filter((user) =>
      config.scopeTypes.includes(user.scope_type ?? "")
    );

    test.beforeAll(() => enforceDemoContext(config.label, scopedUsers));

    const user =
      config.preferredScopeTypes
        .map((scopeType) =>
          scopedUsers.find((candidate) => candidate.scope_type === scopeType)
        )
        .find(Boolean) ?? scopedUsers[0];
    if (!user) return;

    test(`${config.label} filter apply logs ui event`, async ({ page }) => {
      test.setTimeout(600_000);
      const baseUrl = config.baseUrl();
      const events = captureUiEvents(page);
      const requestEvents = captureUiEventRequests(page);
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
      let filterTarget: {
        resourceKey: string;
        filterKey: string;
        filterValue: string;
      } | null = null;
      for (const resourceKey of resourceKeys) {
        const resourceEntry =
          context.readRegistry?.resources?.find((entry) => entry?.key === resourceKey) ?? null;
        const filters = Array.isArray(resourceEntry?.filters)
          ? resourceEntry.filters.filter((filter) => filter?.key && filter?.column)
          : [];
        if (filters.length === 0) continue;
        const sample = await fetchResourceSampleRow({
          resourceKey,
          email: user.email,
          password: demoContext.password ?? "",
        });
        if (!sample.item) continue;
        const orderedFilters = [
          ...filters.filter((filter) => (filter.op ?? "eq") === "eq"),
          ...filters.filter((filter) => (filter.op ?? "eq") !== "eq"),
        ];
        for (const filter of orderedFilters) {
          const filterKey = filter.key?.trim() ?? "";
          const filterColumn = filter.column?.trim() ?? "";
          if (!filterKey || !filterColumn) continue;
          const filterValue = resolveItemFieldValue(sample.item, [filterColumn, filterKey]);
          if (filterValue === null) continue;
          filterTarget = { resourceKey, filterKey, filterValue };
          break;
        }
        if (filterTarget) break;
      }
      if (!filterTarget) {
        throw new Error(`No filterable resource sample available for ${user.email}.`);
      }
      const { resourceKey, filterKey, filterValue } = filterTarget;

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
      await expect(
        page.locator(
          `[data-testid="${config.resourceTestIdPrefix}-ready"], [data-testid="${config.resourceTestIdPrefix}-error"], [data-testid="${config.authTestId}"]`
        )
      ).toBeVisible();
      await expect(ready, `${config.label} resource ${resourceKey} must be ready for filter logging`).toBeVisible();

      const filterControl = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-view-control-filters"]`
      );
      if ((await filterControl.count()) === 0) {
        if (strict) {
          throw new Error(`Filter panel missing for ${config.label}.`);
        }
        return;
      }

      const filterOpened = await tryClick(filterControl);
      if (!filterOpened) {
        if (strict) {
          throw new Error(`Filter panel not available for ${config.label}.`);
        }
        return;
      }
      const panelEvent = await waitForUiEvent(
          [events, requestEvents],
            (entry) =>
              entry.type === "ui.table.panel.toggle" &&
              entry.context === resourceKey &&
              entry.name === "filters" &&
              entry.message === "open",
        { timeout: 5_000 }
      );
      expect(panelEvent?.timestamp).toBeTruthy();
      const applied = await applyAndClearFirstFilter({
        page,
        testIdPrefix: config.tableTestIdPrefix,
        filterKey,
        filterValue,
      });
      await tryClick(filterControl);
      if (!applied) {
        if (strict) {
          throw new Error(
            `Filter apply failed for ${config.label}: resourceKey=${resourceKey}; filterKey=${filterKey}; samplePresent=${Boolean(filterValue)}.`
          );
        }
        return;
      }

      const searchInput = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-table-search"]`
      );
      if ((await searchInput.count()) > 0) {
        await searchInput.fill(`e2e-${Date.now()}`);
        const searchClear = page.locator(
          `[data-testid="${config.tableTestIdPrefix}-table-search-clear"]`
        );
        if ((await searchClear.count()) > 0) {
          const searchCleared = await tryClick(searchClear);
          if (!searchCleared) {
            if (strict) {
              throw new Error(`Search clear not available for ${config.label}.`);
            }
            return;
          }
          const searchEvent = await waitForUiEvent(
              [events, requestEvents],
                (entry) =>
                  entry.type === "ui.table.search.clear" &&
                  entry.context === resourceKey,
            { timeout: 5_000 }
          );
          expect(searchEvent?.timestamp).toBeTruthy();
          const searchNetworkEvent = await waitForUiEvent(
              requestEvents,
                (entry) =>
                  entry.type === "ui.table.search.clear" &&
                  entry.context === resourceKey,
            { timeout: 5_000 }
          );
          expect(searchNetworkEvent?.timestamp).toBeTruthy();
        }
      }

      const event = await waitForUiEvent(
          [events, requestEvents],
            (entry) =>
              entry.type === "ui.table.filter.apply" &&
              entry.context === resourceKey,
        { timeout: 5_000 }
      );

      expect(event?.timestamp).toBeTruthy();
      const networkEvent = await waitForUiEvent(
          requestEvents,
            (entry) =>
              entry.type === "ui.table.filter.apply" &&
              entry.context === resourceKey,
        { timeout: 5_000 }
      );
      expect(networkEvent?.timestamp).toBeTruthy();
      const metaSettingsId =
        event?.meta && typeof event.meta === "object"
          ? (event.meta as Record<string, unknown>).settingsResolutionId
          : null;
      if (typeof metaSettingsId === "string" && metaSettingsId) {
        expect(event?.digest).toBe(metaSettingsId);
      }

      const sortControl = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-view-control-sort"]`
      );
      if ((await sortControl.count()) > 0) {
        if (!(await tryClick(sortControl))) {
          if (strict) {
            throw new Error(`Sort panel not available for ${config.label}.`);
          }
          return;
        }
        const sortApplied = await applyAndClearFirstSort({
          page,
          testIdPrefix: config.tableTestIdPrefix,
        });
        await tryClick(sortControl);
        if (sortApplied) {
          const sortEvent = await waitForUiEvent(
              [events, requestEvents],
                (entry) =>
                  entry.type === "ui.table.sort.add" &&
                  entry.context === resourceKey,
            { timeout: 5_000 }
          );
          expect(sortEvent?.timestamp).toBeTruthy();
        }
      }

      const groupControl = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-view-control-group"]`
      );
      if ((await groupControl.count()) > 0) {
        if (!(await tryClick(groupControl))) {
          if (strict) {
            throw new Error(`Group panel not available for ${config.label}.`);
          }
          return;
        }
        const groupApplied = await applyAndClearFirstGroup({
          page,
          testIdPrefix: config.tableTestIdPrefix,
        });
        await tryClick(groupControl);
        if (groupApplied) {
          const groupEvent = await waitForUiEvent(
              [events, requestEvents],
                (entry) =>
                  entry.type === "ui.table.group.add" &&
                  entry.context === resourceKey,
            { timeout: 5_000 }
          );
          expect(groupEvent?.timestamp).toBeTruthy();
          const collapseAll = page.locator(
            `[data-testid="${config.tableTestIdPrefix}-group-collapse-all"]`
          );
          if (
            (await collapseAll.count()) > 0 &&
            !(await collapseAll.first().isDisabled())
          ) {
            const collapseEvent = await waitForUiEvent(
                [events, requestEvents],
                  (entry) =>
                    entry.type === "ui.table.group.collapse_all" &&
                    entry.context === resourceKey,
              { timeout: 5_000 }
            );
            expect(collapseEvent?.timestamp).toBeTruthy();
            const collapseNetworkEvent = await waitForUiEvent(
                requestEvents,
                  (entry) =>
                    entry.type === "ui.table.group.collapse_all" &&
                    entry.context === resourceKey,
              { timeout: 5_000 }
            );
            expect(collapseNetworkEvent?.timestamp).toBeTruthy();
          }
          const expandAll = page.locator(
            `[data-testid="${config.tableTestIdPrefix}-group-expand-all"]`
          );
          if (
            (await expandAll.count()) > 0 &&
            !(await expandAll.first().isDisabled())
          ) {
            const expandEvent = await waitForUiEvent(
                [events, requestEvents],
                  (entry) =>
                    entry.type === "ui.table.group.expand_all" &&
                    entry.context === resourceKey,
              { timeout: 5_000 }
            );
            expect(expandEvent?.timestamp).toBeTruthy();
            const expandNetworkEvent = await waitForUiEvent(
                requestEvents,
                  (entry) =>
                    entry.type === "ui.table.group.expand_all" &&
                    entry.context === resourceKey,
              { timeout: 5_000 }
            );
            expect(expandNetworkEvent?.timestamp).toBeTruthy();
          }
        }
      }

      const confirmableActions = resolveConfirmableActions({
        resourceKey,
        commandRegistry: context.commandRegistry,
        capabilities: context.me?.capabilities ?? null,
      });
      if (confirmableActions.length > 0) {
        const hasSelection = await selectFirstTableRow(page);
        if (hasSelection) {
          const actionKey = confirmableActions[0];
          const action = await ensureBulkActionVisible({
            page,
            actionKey,
            testIdPrefix: config.tableTestIdPrefix,
          });
          if (action && !(await action.isDisabled())) {
            await action.click();
            const confirmDialog = page.locator(
              `[data-testid="${bulkActionsTestIdPrefix}-confirm-dialog"]`
            );
            if ((await confirmDialog.count()) > 0) {
              await expect(confirmDialog).toBeVisible();
              const confirmEvent = await waitForUiEvent(
                  [events, requestEvents],
                    (entry) =>
                      entry.type === "ui.bulk_action.confirm.open" &&
                      entry.context === resourceKey,
                { timeout: 5_000 }
              );
              expect(confirmEvent?.timestamp).toBeTruthy();
              const confirmNetworkEvent = await waitForUiEvent(
                  requestEvents,
                    (entry) =>
                      entry.type === "ui.bulk_action.confirm.open" &&
                      entry.context === resourceKey,
                { timeout: 5_000 }
              );
              expect(confirmNetworkEvent?.timestamp).toBeTruthy();
              await page
                .locator(
                  `[data-testid="${bulkActionsTestIdPrefix}-confirm-cancel"]`
                )
                .click();
              await expect(confirmDialog).toHaveCount(0);
              const cancelEvent = await waitForUiEvent(
                  [events, requestEvents],
                    (entry) =>
                      entry.type === "ui.bulk_action.confirm.cancel" &&
                      entry.context === resourceKey,
                { timeout: 5_000 }
              );
              expect(cancelEvent?.timestamp).toBeTruthy();
              const cancelNetworkEvent = await waitForUiEvent(
                  requestEvents,
                    (entry) =>
                      entry.type === "ui.bulk_action.confirm.cancel" &&
                      entry.context === resourceKey,
                { timeout: 5_000 }
              );
              expect(cancelNetworkEvent?.timestamp).toBeTruthy();
            }
          }
          const clearSelection = page.locator(
            `[data-testid="${config.tableTestIdPrefix}-selection-clear"]`
          );
          if ((await clearSelection.count()) > 0 && !(await clearSelection.first().isDisabled())) {
            await clearSelection.first().click();
            const selectionEvent = await waitForUiEvent(
                [events, requestEvents],
                  (entry) =>
                    entry.type === "ui.table.selection.clear" &&
                    entry.context === resourceKey,
              { timeout: 5_000 }
            );
            expect(selectionEvent?.timestamp).toBeTruthy();
            const selectionNetworkEvent = await waitForUiEvent(
                requestEvents,
                  (entry) =>
                    entry.type === "ui.table.selection.clear" &&
                    entry.context === resourceKey,
              { timeout: 5_000 }
            );
            expect(selectionNetworkEvent?.timestamp).toBeTruthy();
          }
        }
      }

      const viewControl = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-view-control-views"]`
      );
      if ((await viewControl.count()) > 0) {
        if (!(await tryClick(viewControl))) {
          if (strict) {
            throw new Error(`View panel not available for ${config.label}.`);
          }
          return;
        }
        const saveToggle = page.locator(
          `[data-testid="${config.tableTestIdPrefix}-view-save-toggle"]`
        );
        if ((await saveToggle.count()) > 0 && !(await saveToggle.first().isDisabled())) {
          await tryClick(saveToggle);
          const saveName = page.locator(
            `[data-testid="${config.tableTestIdPrefix}-view-save-name"]`
          );
          if ((await saveName.count()) > 0) {
            await saveName.fill(`E2E View ${Date.now()}`);
          }
          const saveCreate = page.locator(
            `[data-testid="${config.tableTestIdPrefix}-view-save-create"]`
          );
          if (
            (await saveCreate.count()) > 0 &&
            !(await saveCreate.first().isDisabled())
          ) {
            const saveDiagnostics = captureViewSaveDiagnostics(
              page, events, requestEvents, resourceKey
            );
            try {
              const saveTriggered = await tryClick(saveCreate);
              if (saveTriggered) {
                try {
                  const viewSaveEvent = await waitForUiEvent(
                    [events, requestEvents],
                    (entry) =>
                      entry.type === "ui.table.view.save" &&
                      entry.context === resourceKey,
                    { timeout: 5_000 }
                  );
                  expect(viewSaveEvent?.timestamp).toBeTruthy();
                  const viewSaveNetworkEvent = await waitForUiEvent(
                    requestEvents,
                    (entry) =>
                      entry.type === "ui.table.view.save" &&
                      entry.context === resourceKey,
                    { timeout: 5_000 }
                  );
                  expect(viewSaveNetworkEvent?.timestamp).toBeTruthy();
                } catch (error) {
                  saveDiagnostics.fail(error);
                }
              } else if (strict) {
                throw new Error(`View save not available for ${config.label}.`);
              }
            } finally {
              saveDiagnostics.stop();
            }
          }
        }
        await tryClick(viewControl);
      }

      const viewMenu = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-view-menu"]`
      );
      if ((await viewMenu.count()) > 0 && !(await viewMenu.first().isDisabled())) {
        if (!(await tryClick(viewMenu))) {
          if (strict) {
            throw new Error(`View menu not available for ${config.label}.`);
          }
          return;
        }
        const renameItem = page.locator(
          `[data-testid="${config.tableTestIdPrefix}-view-menu-rename"]`
        );
        if ((await renameItem.count()) > 0) {
          const renamed = await tryClick(renameItem);
          if (renamed) {
            const menuEvent = await waitForUiEvent(
                [events, requestEvents],
                  (entry) =>
                    entry.type === "ui.table.view.menu.action" &&
                    entry.context === resourceKey &&
                    entry.name === "rename",
              { timeout: 5_000 }
            );
            expect(menuEvent?.timestamp).toBeTruthy();
            const menuNetworkEvent = await waitForUiEvent(
                requestEvents,
                  (entry) =>
                    entry.type === "ui.table.view.menu.action" &&
                    entry.context === resourceKey &&
                    entry.name === "rename",
              { timeout: 5_000 }
            );
            expect(menuNetworkEvent?.timestamp).toBeTruthy();
          } else if (strict) {
            throw new Error(`View menu rename not available for ${config.label}.`);
          }
        }
      }
    });
  });
}
