import { test, expect, type Route } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext } from "./utils/role-matrix";
import {
  resolveResourceActionTargetWithSample,
  resolveResourceKeysForUser,
} from "./utils/core-resource";
import { assertNavigationPerformance } from "./utils/performance";
import {
  ensureBulkActionVisible,
  resolveBulkActionsTestIdPrefix,
  selectFirstTableRow,
} from "./utils/table-actions";
import { captureFullPage, isCaptureEnabled, resolveEvidencePath } from "./utils/evidence";
import {
  captureUiEvents,
  captureUiEventRequests,
  waitForUiEvent,
} from "./utils/ui-events";
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

const captureEnabled = isCaptureEnabled();
const evidenceGroup = "ui-bulk-action-failure";
const evidencePath = (...segments: string[]) =>
  resolveEvidencePath(evidenceGroup, ...segments);

function sanitizeFilePart(value: string) {
  return value.replace(/[^a-z0-9-_.]+/gi, "-");
}

function enforceDemoContext(scopeLabel: string, users: Array<{ email: string }>) {
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

for (const config of appConfigs) {
  test.describe(`${config.label} bulk action error handling`, () => {
    test.skip(
      !demoContext.available && !strict,
      demoContext.reason ?? "Demo accounts missing."
    );

    const scopedUsers = demoContext.users.filter((user) =>
      config.scopeTypes.includes(user.scope_type ?? "")
    );

    test.beforeAll(() => enforceDemoContext(config.label, scopedUsers));

    test(`${config.label} bulk action failure redacts errors`, async ({
      page,
    }) => {
      test.setTimeout(600_000);
      const baseUrl = config.baseUrl();
      const downloadBasePath = `${baseUrl}/api/resource-download`;
      const events = captureUiEvents(page);
      const requestEvents = captureUiEventRequests(page);
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
      let candidate:
        | {
            user: (typeof scopedUsers)[number];
            context: Awaited<ReturnType<typeof fetchUserContext>>;
            target: { resourceKey: string; actionKey: string };
          }
        | null = null;

      for (const user of candidateUsers) {
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
        if (resourceKeys.length === 0) continue;
        const target = await resolveResourceActionTargetWithSample({
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
        if (target) {
          candidate = { user, context, target };
          break;
        }
      }

      if (!candidate) {
        if (strict) {
          throw new Error(`No rpc actions available for ${config.label}.`);
        }
        return;
      }
      const { user, context, target } = candidate;

      const resource =
        context.readRegistry?.resources?.find(
          (entry) => entry?.key === target.resourceKey
        ) ?? null;
      const commands = context.commandRegistry.filter((command) =>
        matchesResourceCategory(command?.schema_category ?? null, target.resourceKey)
      );
      const actions = resolveResourceBulkActions({
        t: (key) => key,
        resourceKey: target.resourceKey,
        resource,
        commands,
        appKey: config.app,
        appBasePath: baseUrl,
        downloadBasePath,
        userCapabilities: context.me?.capabilities ?? [],
      });
      const action = actions.find((entry) => entry.key === target.actionKey);
      if (!action) {
        if (strict) {
          throw new Error(
            `Action ${target.actionKey} missing for ${target.resourceKey}.`
          );
        }
        return;
      }
      const rpcName = action.execution?.rpc?.trim();
      if (!rpcName) {
        if (strict) {
          throw new Error(`RPC missing for ${action.key}.`);
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
      await assertNavigationPerformance(page);

      const hasSelection = await selectFirstTableRow(page);
      if (!hasSelection) {
        if (strict) {
          throw new Error(`No rows available for ${target.resourceKey}.`);
        }
        return;
      }

      const actionButton = await ensureBulkActionVisible({
        page,
        actionKey: action.key,
        testIdPrefix: config.tableTestIdPrefix,
      });
      if (!actionButton) {
        throw new Error(`Action ${action.key} not visible for ${target.resourceKey}.`);
      }
      if (await actionButton.isDisabled()) {
        if (strict) {
          throw new Error(`Action ${action.key} disabled for ${config.label}.`);
        }
        return;
      }

      const bulkActionsTestIdPrefix = resolveBulkActionsTestIdPrefix(
        config.tableTestIdPrefix
      );
      const redactedToken =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";
      let injected = false;
      const rpcRoute = async (route: Route) => {
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
      await page.route(`**/rest/v1/rpc/${rpcName}`, rpcRoute);

      await actionButton.click();
      const confirmDialog = page.locator(
        `[data-testid="${bulkActionsTestIdPrefix}-confirm-dialog"]`
      );
      await expect(confirmDialog).toBeVisible();
      const fields = Array.isArray(action.execution?.input_schema?.fields)
        ? action.execution.input_schema.fields
        : [];
      for (const field of fields) {
        const key = field.key?.trim() ?? "";
        if (!field.required || !key) continue;
        const input = confirmDialog.locator(
          `[data-testid="${bulkActionsTestIdPrefix}-confirm-field-${key}"]`
        );
        await expect(input).toBeVisible();
        if ((await input.inputValue()).trim()) continue;
        if (field.type === "lookup") {
          await expect(input).toBeEnabled();
          const option = input.locator('option:not([value=""])').first();
          await expect(option).toBeAttached({ timeout: 30_000 });
          const value = await option.getAttribute("value");
          if (!value) throw new Error(`No lookup value available for ${key}.`);
          await input.selectOption(value);
        } else {
          await input.fill("E2E required input");
        }
      }
      await confirmDialog
        .locator(`[data-testid="${bulkActionsTestIdPrefix}-confirm-submit"]`)
        .click();
      await expect.poll(() => injected).toBe(true);

      await expect(page.getByText("[redacted]").first()).toBeVisible();

      const errorEvent = await waitForUiEvent(
        [events, requestEvents],
        (entry) =>
          entry.type === "ui.bulk_action.error" &&
          entry.context === target.resourceKey &&
          entry.name === action.key,
        { timeout: 10_000 }
      );
      expect(errorEvent?.message ?? "").toContain("[redacted]");
      const errorNetworkEvent = await waitForUiEvent(
        requestEvents,
        (entry) =>
          entry.type === "ui.bulk_action.error" &&
          entry.context === target.resourceKey &&
          entry.name === action.key,
        { timeout: 10_000 }
      );
      expect(errorNetworkEvent?.message ?? "").toContain("[redacted]");

      if (captureEnabled) {
        await captureFullPage(
          page,
          evidencePath(
            `${config.label}-${sanitizeFilePart(target.resourceKey)}-${sanitizeFilePart(
              action.key
            )}-failure.png`
          )
        );
      }

      await page.unroute(`**/rest/v1/rpc/${rpcName}`, rpcRoute);
    });
  });
}
