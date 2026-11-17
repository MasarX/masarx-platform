import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext } from "./utils/role-matrix";
import {
  resolveConfirmableActions,
  resolveResourceKeysForUser,
  fetchResourceSampleId,
} from "./utils/core-resource";
import {
  resolveBulkActionsTestIdPrefix,
  ensureBulkActionVisible,
} from "./utils/table-actions";
import { assertNavigationPerformance } from "./utils/performance";
import { captureUiEventRequests, captureUiEvents, waitForUiEvent } from "./utils/ui-events";
import { hasCapability, resolveCapabilitySet } from "./utils/capabilities";
import { matchesResourceCategory } from "../../packages/ui/src/resource-actions-core";

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
      throw new Error(`Demo accounts missing for ${scopeLabel}: ${demoContext.reason}`);
    }
    return;
  }
  if (users.length === 0 && strict) {
    throw new Error(`No demo users available for ${scopeLabel}.`);
  }
}

for (const config of appConfigs) {
  test.describe(`${config.label} detail action confirm flows`, () => {
    test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

    const scopedUsers = demoContext.users.filter((user) =>
      config.scopeTypes.includes(user.scope_type ?? "")
    );

    test.beforeAll(() => enforceDemoContext(config.label, scopedUsers));

    test(`${config.label} detail confirm emits telemetry`, async ({ page }) => {
      const user = scopedUsers[0];
      test.skip(!user, `No ${config.label} demo user available.`);
      const baseUrl = config.baseUrl();
      const events = captureUiEvents(page);
      const requestEvents = captureUiEventRequests(page);

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

      let targetResourceKey: string | null = null;
      let targetActionKey: string | null = null;
      let targetSampleId: string | null = null;
      let emptyAllowedCandidate: { resourceKey: string; actionKey: string } | null = null;
      for (const resourceKey of resourceKeys) {
        const actionKey = resolveConfirmableActions({
          resourceKey,
          commandRegistry: context.commandRegistry,
          capabilities: context.me?.capabilities ?? null,
        })[0];
        if (!actionKey) continue;
        emptyAllowedCandidate ??= { resourceKey, actionKey };
        const resourceEntry =
          context.readRegistry?.resources?.find((entry) => entry?.key === resourceKey) ?? null;
        const sample = await fetchResourceSampleId({
          resourceKey,
          idColumn: resourceEntry?.id_column ?? null,
          email: user.email,
          password: demoContext.password ?? "",
        });
        if (!sample.id) continue;
        targetResourceKey = resourceKey;
        targetActionKey = actionKey;
        targetSampleId = sample.id;
        break;
      }

      let expectConfirmTelemetry = Boolean(targetSampleId);
      if (!targetResourceKey || !targetActionKey) {
        const capabilitySet = resolveCapabilitySet(context.me?.capabilities ?? null);
        const blockedCandidate = resourceKeys.flatMap((resourceKey) =>
          context.commandRegistry
            .filter((command) =>
              matchesResourceCategory(command?.schema_category ?? null, resourceKey)
            )
            .filter((command) => Boolean(command?.execution?.confirm))
            .filter((command) => {
              const capability = command?.capability?.trim() ?? "";
              return Boolean(capability) && !hasCapability(capabilitySet, capability);
            })
            .map((command) => ({
              resourceKey,
              actionKey: command?.key?.trim() ?? "",
            }))
            .filter((entry) => Boolean(entry.actionKey))
        )[0] ?? null;
        const fallback = emptyAllowedCandidate ?? blockedCandidate;
        if (!fallback) {
          if (strict) {
            throw new Error(`No confirmable actions found for ${config.label}.`);
          }
          test.skip(true, `No confirmable actions available for ${config.label}.`);
          return;
        }
        targetResourceKey = fallback.resourceKey;
        targetActionKey = fallback.actionKey;
        expectConfirmTelemetry = false;
      }

      const hasSample = Boolean(targetSampleId);

      await page.goto(baseUrl);
      const authGate = page.locator(`[data-testid="${config.authTestId}"]`);
      if (await authGate.isVisible()) {
        await signInWithPassword(page, user.email, demoContext.password || "");
      }
      await expectSignedIn(page, user.email, user.scope_type);

      if (!hasSample) {
        const tableTestIdPrefix = `${config.resourceTestIdPrefix}-table`;
        await page.goto(`${baseUrl}/resources/${targetResourceKey}`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await expect(
          page.locator(
            `[data-testid="${config.resourceTestIdPrefix}-ready"], [data-testid="${config.resourceTestIdPrefix}-error"], [data-testid="${config.authTestId}"]`
          )
        ).toBeVisible();

        const listActionButton = await ensureBulkActionVisible({
          page,
          actionKey: targetActionKey,
          testIdPrefix: tableTestIdPrefix,
        });
        if (!listActionButton) {
          if (strict) {
            throw new Error(
              `List action ${targetActionKey} not visible for ${targetResourceKey}.`
            );
          }
          return;
        }
        await expect(listActionButton).toHaveAttribute("title", /.+/);
        await expect(listActionButton).toBeDisabled();
        return;
      }

      await page.goto(
        `${baseUrl}/resources/${targetResourceKey}?id=${encodeURIComponent(targetSampleId!)}`,
        { waitUntil: "domcontentloaded", timeout: 60_000 }
      );
      await expect(
        page.locator(
          `[data-testid="${config.resourceTestIdPrefix}-ready"], [data-testid="${config.resourceTestIdPrefix}-error"], [data-testid="${config.authTestId}"]`
        )
      ).toBeVisible();
      await assertNavigationPerformance(page);

      const detail = page.locator(
        `[data-testid="${config.resourceTestIdPrefix}-detail"]`
      );
      await expect(detail).toBeVisible();

      const detailActionsPrefix = `${config.resourceTestIdPrefix}-detail-actions`;
      const actionButton = await ensureBulkActionVisible({
        page,
        actionKey: targetActionKey,
        testIdPrefix: detailActionsPrefix,
      });
      if (!actionButton) {
        if (strict) {
          throw new Error(
            `Detail action ${targetActionKey} not visible for ${targetResourceKey}.`
          );
        }
        return;
      }

      if (expectConfirmTelemetry) {
        await expect(actionButton).toBeEnabled();
      }
      if (await actionButton.isDisabled()) {
        await expect(actionButton).toHaveAttribute("title", /.+/);
        if (strict && expectConfirmTelemetry) {
          throw new Error(
            `Detail action ${targetActionKey} disabled for ${targetResourceKey}.`
          );
        }
        return;
      }

      await actionButton.click();
      const bulkActionsTestIdPrefix = resolveBulkActionsTestIdPrefix(
        detailActionsPrefix
      );
      const confirmDialog = page.locator(
        `[data-testid="${bulkActionsTestIdPrefix}-confirm-dialog"]`
      );
      if (!expectConfirmTelemetry) {
        await expect(confirmDialog).toHaveCount(0);
        return;
      }
      await expect(confirmDialog).toBeVisible();

      await waitForUiEvent(
        [events, requestEvents],
        (entry) =>
          entry.type === "ui.bulk_action.confirm.open" &&
          entry.context === targetResourceKey &&
          entry.name === targetActionKey
      );
      await waitForUiEvent(
        requestEvents,
        (entry) =>
          entry.type === "ui.bulk_action.confirm.open" &&
          entry.context === targetResourceKey &&
          entry.name === targetActionKey
      );

      await page
        .locator(`[data-testid="${bulkActionsTestIdPrefix}-confirm-cancel"]`)
        .click();
      await expect(confirmDialog).toHaveCount(0);

      await waitForUiEvent(
        [events, requestEvents],
        (entry) =>
          entry.type === "ui.bulk_action.confirm.cancel" &&
          entry.context === targetResourceKey &&
          entry.name === targetActionKey
      );
      await waitForUiEvent(
        requestEvents,
        (entry) =>
          entry.type === "ui.bulk_action.confirm.cancel" &&
          entry.context === targetResourceKey &&
          entry.name === targetActionKey
      );
    });
  });
}
