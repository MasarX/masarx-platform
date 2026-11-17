import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";
import { getConsoleBasePath, getPortalBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import { hasCapability, resolveCapabilitySet } from "./utils/capabilities";
import { fetchUserContext } from "./utils/role-matrix";
import {
  applyResourceLimit,
  resolveResourceKeysForUser,
} from "./utils/core-resource";
import {
  ensureBulkActionVisible,
  resolveBulkActionsTestIdPrefix,
} from "./utils/table-actions";

type AppConfig = {
  label: "console" | "portal";
  app: "console" | "portal";
  baseUrl: () => string;
  basePath: () => string;
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
    basePath: getConsoleBasePath,
    authTestId: "console-auth-required",
    scopeTypes: ["platform", "tenant"],
    tableTestIdPrefix: "console-resource-table",
    resourceTestIdPrefix: "console-resource",
  },
  {
    label: "portal",
    app: "portal",
    baseUrl: getPortalBaseUrl,
    basePath: getPortalBasePath,
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

function resolveDownloadAction(params: {
  resourceKeys: string[];
  readRegistry: import("./utils/role-matrix").ReadRegistry | null;
  capabilities?: string[] | null;
}) {
  const { resourceKeys, readRegistry, capabilities } = params;
  const capabilitySet = resolveCapabilitySet(capabilities);
  const resources = Array.isArray(readRegistry?.resources)
    ? readRegistry?.resources
    : [];
  const allowed = new Set(resourceKeys);
  const match = resources.find((resource) => {
    const key = resource?.key?.trim() ?? "";
    if (!key || !allowed.has(key)) return false;
    const download = (resource as { download?: { capability?: string | null } })
      .download;
    if (!download) return false;
    const capability = download.capability?.trim() ?? "";
    if (capability && !hasCapability(capabilitySet, capability)) return false;
    return true;
  });
  if (!match?.key) return null;
  return { resourceKey: match.key, actionKey: `${match.key}.download.labels` };
}

for (const config of appConfigs) {
  test.describe(`${config.label} bulk action disabled states`, () => {
    test.skip(
      !demoContext.available && !strict,
      demoContext.reason ?? "Demo accounts missing."
    );

    const scopedUsers = demoContext.users.filter((user) =>
      config.scopeTypes.includes(user.scope_type ?? "")
    );

    test.beforeAll(() => enforceDemoContext(config.label, scopedUsers));

    test(`${config.label} bulk actions stay hidden until selection`, async ({
      page,
    }) => {
      test.setTimeout(600_000);
      let candidate:
        | {
            user: DemoUser;
            context: Awaited<ReturnType<typeof fetchUserContext>>;
            actionTarget: { resourceKey: string; actionKey: string };
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
        const resourceKeys = applyResourceLimit(
          resolveResourceKeysForUser({
            sections,
            readRegistry: context.readRegistry,
            commandRegistry: context.commandRegistry,
            capabilities: context.me?.capabilities ?? null,
          })
        );
        if (resourceKeys.length === 0) continue;
        const actionTarget = resolveDownloadAction({
          resourceKeys,
          readRegistry: context.readRegistry,
          capabilities: context.me?.capabilities ?? null,
        });
        if (actionTarget) {
          candidate = { user, context, actionTarget };
          break;
        }
      }

      if (!candidate) {
        if (strict) {
          throw new Error(`No download-capable bulk action found for ${config.label}.`);
        }
        test.skip(true, `No download-capable bulk action found for ${config.label}.`);
        return;
      }

      const { user, context, actionTarget } = candidate;

      await page.goto(config.baseUrl());
      const authGate = page.locator(`[data-testid="${config.authTestId}"]`);
      if (await authGate.isVisible()) {
        await signInWithPassword(page, user.email, demoContext.password || "");
      }
      await expectSignedIn(page, user.email, user.scope_type);

      const bulkActionsTestIdPrefix = resolveBulkActionsTestIdPrefix(
        config.tableTestIdPrefix
      );
      await page.goto(`${config.baseUrl()}/resources/${actionTarget.resourceKey}`, {
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
      await expect(selectionBar).toHaveCount(0);
      const bulkActionsContainer = page.locator(
        `[data-testid="${bulkActionsTestIdPrefix}"]`
      );
      await expect(bulkActionsContainer).toHaveCount(0);

      const actionButton = await ensureBulkActionVisible({
        page,
        actionKey: actionTarget.actionKey,
        testIdPrefix: config.tableTestIdPrefix,
      });
      if (!actionButton) {
        if (strict) {
          throw new Error(`Bulk action not visible for ${config.label}.`);
        }
        return;
      }

      await expect(selectionBar).toBeVisible();
      await expect(bulkActionsContainer).toBeVisible();
      await expect(actionButton).toBeVisible();
    });
  });
}
