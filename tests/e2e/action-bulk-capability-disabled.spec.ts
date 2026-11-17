import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext } from "./utils/role-matrix";
import { hasCapability, resolveCapabilitySet } from "./utils/capabilities";
import { matchesResourceCategory } from "../../packages/ui/src/resource-actions-core";
import {
  fetchResourceSampleId,
  resolveResourceKeysForUser,
} from "./utils/core-resource";
import {
  resolveBulkActionsTestIdPrefix,
  selectFirstTableRow,
} from "./utils/table-actions";

type AppConfig = {
  label: "console" | "portal";
  app: "console" | "portal";
  baseUrl: () => string;
  authTestId: string;
  scopeTypes: string[];
  tableTestIdPrefix: string;
  resourceTestIdPrefix: string;
};

const appConfigs: AppConfig[] = [
  {
    label: "console",
    app: "console",
    baseUrl: getConsoleBaseUrl,
    authTestId: "console-auth-required",
    scopeTypes: ["platform", "tenant"],
    tableTestIdPrefix: "console-resource-table",
    resourceTestIdPrefix: "console-resource",
  },
  {
    label: "portal",
    app: "portal",
    baseUrl: getPortalBaseUrl,
    authTestId: "portal-auth-required",
    scopeTypes: ["client", "sender"],
    tableTestIdPrefix: "portal-resource-table",
    resourceTestIdPrefix: "portal-resource",
  },
];

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();

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

async function resolveActionLocator(params: {
  page: import("@playwright/test").Page;
  selectionBar: import("@playwright/test").Locator;
  bulkActionsTestIdPrefix: string;
  actionKey: string;
}) {
  const { page, selectionBar, bulkActionsTestIdPrefix, actionKey } = params;
  let action = selectionBar.locator(`[data-action-key="${actionKey}"]`);
  if ((await action.count()) > 0) {
    return action.first();
  }
  const menuTrigger = page.locator(
    `[data-testid="${bulkActionsTestIdPrefix}-menu"]`
  );
  if ((await menuTrigger.count()) === 0) return null;
  await menuTrigger.first().click();
  action = page.locator(`[data-action-key="${actionKey}"]`);
  if ((await action.count()) === 0) return null;
  return action.first();
}

async function resolveDisabledReason(locator: import("@playwright/test").Locator) {
  const title = await locator.getAttribute("title");
  if (title && title.trim()) return title.trim();
  const text = await locator.textContent();
  return text?.trim() ?? "";
}

function resolveCapabilityDisabledAction(params: {
  resourceKeys: string[];
  readRegistry: import("./utils/role-matrix").ReadRegistry | null;
  commandRegistry: import("./utils/role-matrix").CommandDefinition[];
  capabilities?: string[] | null;
}) {
  const { resourceKeys, readRegistry, commandRegistry, capabilities } = params;
  const capSet = resolveCapabilitySet(capabilities);
  const allowed = new Set(resourceKeys);
  const resources = Array.isArray(readRegistry?.resources)
    ? readRegistry?.resources
    : [];
  for (const resource of resources) {
    const key = resource?.key?.trim() ?? "";
    if (!key || !allowed.has(key)) continue;
    const download = (resource as { download?: { capability?: string | null } })
      .download;
    const downloadCapability = download?.capability?.trim() ?? "";
    if (downloadCapability && !hasCapability(capSet, downloadCapability)) {
      return {
        resourceKey: key,
        actionKey: `${key}.download.labels`,
        capability: downloadCapability,
      };
    }
  }
  for (const command of commandRegistry) {
    const actionKey = command.key?.trim() ?? "";
    const resourceKey =
      resourceKeys.find((key) =>
        matchesResourceCategory(command.schema_category ?? null, key)
      ) ?? "";
    const capability = command.capability?.trim() ?? "";
    if (!actionKey || !resourceKey || !capability) continue;
    if (!allowed.has(resourceKey)) continue;
    if (hasCapability(capSet, capability)) continue;
    return { resourceKey, actionKey, capability };
  }
  return null;
}

for (const config of appConfigs) {
  test.describe(`${config.label} bulk action capability disabled states`, () => {
    test.skip(
      !demoContext.available && !strict,
      demoContext.reason ?? "Demo accounts missing."
    );

    const scopedUsers = demoContext.users.filter((user) =>
      config.scopeTypes.includes(user.scope_type ?? "")
    );

    test.beforeAll(() => enforceDemoContext(config.label, scopedUsers));

    test(`${config.label} bulk actions show missing capability reason`, async ({
      page,
    }) => {
      test.setTimeout(600_000);
      let candidate:
        | {
            user: { email: string; scope_type?: string };
            context: Awaited<ReturnType<typeof fetchUserContext>>;
            target: { resourceKey: string; actionKey: string; capability: string };
          }
        | null = null;

      for (const user of scopedUsers) {
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
        const target = resolveCapabilityDisabledAction({
          resourceKeys,
          readRegistry: context.readRegistry,
          commandRegistry: context.commandRegistry,
          capabilities: context.me?.capabilities ?? null,
        });
        if (target) {
          const idColumn = context.readRegistry?.resources?.find(
            (resource) => resource?.key === target.resourceKey,
          )?.id_column ?? null;
          const sample = await fetchResourceSampleId({
            resourceKey: target.resourceKey,
            idColumn,
            email: user.email,
            password: demoContext.password ?? "",
          });
          if (!sample.id) continue;
          candidate = { user, context, target };
          break;
        }
      }

      if (!candidate) {
        if (strict) {
          throw new Error(`No capability-disabled bulk action found for ${config.label}.`);
        }
        test.skip(true, `No capability-disabled bulk action found for ${config.label}.`);
        return;
      }

      const { user, target } = candidate;
      const bulkActionsTestIdPrefix = resolveBulkActionsTestIdPrefix(
        config.tableTestIdPrefix
      );

      await page.goto(config.baseUrl());
      const authGate = page.locator(`[data-testid="${config.authTestId}"]`);
      if (await authGate.isVisible()) {
        await signInWithPassword(page, user.email, demoContext.password || "");
      }
      await expectSignedIn(page, user.email, user.scope_type);

      await page.goto(`${config.baseUrl()}/resources/${target.resourceKey}`, {
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
      if (!(await ready.isVisible())) {
        if (strict) {
          throw new Error(`Resource not ready for ${config.label}.`);
        }
        return;
      }

      const selectionBar = page.locator(
        `[data-testid="${config.tableTestIdPrefix}-selection-bar"]`
      );
      const hasSelection = await selectFirstTableRow(page);
      if (!hasSelection) {
        if (strict) {
          throw new Error(`No selectable rows found for ${target.resourceKey} in ${config.label}.`);
        }
        return;
      }

      await expect(selectionBar).toBeVisible();
      const action = await resolveActionLocator({
        page,
        selectionBar,
        bulkActionsTestIdPrefix,
        actionKey: target.actionKey,
      });
      if (!action) {
        if (strict) {
          throw new Error(`Action ${target.actionKey} missing for ${config.label}.`);
        }
        return;
      }

      const reason = await resolveDisabledReason(action);
      if (!reason) {
        if (strict) {
          throw new Error(`Disabled reason missing for ${target.actionKey} in ${config.label}.`);
        }
        return;
      }
      expect(reason).toMatch(/requires/i);
      expect(reason).toMatch(new RegExp(target.capability, "i"));
    });
  });
}
