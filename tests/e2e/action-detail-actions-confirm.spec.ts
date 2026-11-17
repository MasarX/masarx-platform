import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext } from "./utils/role-matrix";
import {
  applyResourceLimit,
  resolveConfirmableActions,
  resolveResourceKeysForUser,
  fetchResourceSampleId,
} from "./utils/core-resource";
import {
  resolveBulkActionsTestIdPrefix,
  ensureBulkActionVisible,
} from "./utils/table-actions";
import { assertNavigationPerformance } from "./utils/performance";
import { captureUiEventRequests, captureUiEvents } from "./utils/ui-events";
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

      let targetResourceKey: string | null = null;
      let targetActionKey: string | null = null;
      for (const resourceKey of resourceKeys) {
        const confirmable = resolveConfirmableActions({
          resourceKey,
          commandRegistry: context.commandRegistry,
          capabilities: context.me?.capabilities ?? null,
        });
        if (confirmable.length > 0) {
          targetResourceKey = resourceKey;
          targetActionKey = confirmable[0] ?? null;
          break;
        }
      }

      let expectConfirmTelemetry = Boolean(targetResourceKey && targetActionKey);
      if (!targetResourceKey || !targetActionKey) {
        const capabilitySet = resolveCapabilitySet(context.me?.capabilities ?? null);
        const blockedCandidates = resourceKeys.flatMap((resourceKey) => {
          const confirmable = context.commandRegistry
            .filter((command) =>
              matchesResourceCategory(command?.schema_category ?? null, resourceKey)
            )
            .filter((command) => Boolean(command?.execution?.confirm))
            .filter((command) => {
              const capability = command?.capability?.trim() ?? "";
              if (!capability) return false;
              return !hasCapability(capabilitySet, capability);
            })
            .map((command) => ({
              resourceKey,
              actionKey: command?.key?.trim() ?? "",
            }))
            .filter((entry) => Boolean(entry.actionKey));
          return confirmable;
        });

        const fallback = blockedCandidates[0] ?? null;
        if (!fallback?.resourceKey || !fallback.actionKey) {
          if (strict) {
            throw new Error(`No confirmable actions found for ${config.label}.`);
          }
          return;
        }
        targetResourceKey = fallback.resourceKey;
        targetActionKey = fallback.actionKey;
        expectConfirmTelemetry = false;
      }

      const resourceEntry =
        context.readRegistry?.resources?.find(
          (entry) => entry?.key === targetResourceKey
        ) ?? null;
      const sample = await fetchResourceSampleId({
        resourceKey: targetResourceKey,
        idColumn: resourceEntry?.id_column ?? null,
        email: user.email,
        password: demoContext.password ?? "",
      });
      const hasSample = Boolean(sample.id);
      if (!sample.id) {
        if (strict && expectConfirmTelemetry) {
          throw new Error(`No sample data for ${targetResourceKey}.`);
        }
      }

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
        `${baseUrl}/resources/${targetResourceKey}?id=${encodeURIComponent(sample.id)}`,
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

      await expect
        .poll(
          () =>
            Boolean(
              events.find(
                (entry) =>
                  entry.type === "ui.bulk_action.confirm.open" &&
                  entry.context === targetResourceKey &&
                  entry.name === targetActionKey
              )
            ),
          { timeout: 5_000 }
        )
        .toBeTruthy();
      await expect
        .poll(
          () =>
            Boolean(
              requestEvents.find(
                (entry) =>
                  entry.type === "ui.bulk_action.confirm.open" &&
                  entry.context === targetResourceKey &&
                  entry.name === targetActionKey
              )
            ),
          { timeout: 5_000 }
        )
        .toBeTruthy();

      await page
        .locator(`[data-testid="${bulkActionsTestIdPrefix}-confirm-cancel"]`)
        .click();
      await expect(confirmDialog).toHaveCount(0);

      await expect
        .poll(
          () =>
            Boolean(
              events.find(
                (entry) =>
                  entry.type === "ui.bulk_action.confirm.cancel" &&
                  entry.context === targetResourceKey &&
                  entry.name === targetActionKey
              )
            ),
          { timeout: 5_000 }
        )
        .toBeTruthy();
      await expect
        .poll(
          () =>
            Boolean(
              requestEvents.find(
                (entry) =>
                  entry.type === "ui.bulk_action.confirm.cancel" &&
                  entry.context === targetResourceKey &&
                  entry.name === targetActionKey
              )
            ),
          { timeout: 5_000 }
        )
        .toBeTruthy();
    });
  });
}
