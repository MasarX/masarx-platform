import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext } from "./utils/role-matrix";
import {
  resolveResourceKeyByLabel,
  resolveResourceKeysForUser,
} from "./utils/core-resource";
import { assertSingleAppShellSidebar } from "./utils/layout-guards";
import { assertNoAppErrorReload } from "./utils/error-guards";
import { assertNavigationPerformance } from "./utils/performance";
import { captureFullPage, isCaptureEnabled, resolveEvidencePath } from "./utils/evidence";
import { hasCapability, resolveCapabilitySet } from "./utils/capabilities";
import { openFirstSingleLineInlineEditor } from "./utils/table-actions";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();
const captureEnabled = isCaptureEnabled();
const evidenceGroup = "ui-resource-inline-edit-single-line";
const evidencePath = (...segments: string[]) =>
  resolveEvidencePath(evidenceGroup, ...segments);

type AppConfig = {
  label: "console" | "portal";
  app: "console" | "portal";
  baseUrl: () => string;
  authTestId: string;
  resourceTestIdPrefix: string;
  preferredScopeType: string;
};

const appConfigs: AppConfig[] = [
  {
    label: "console",
    app: "console",
    baseUrl: getConsoleBaseUrl,
    authTestId: "console-auth-required",
    resourceTestIdPrefix: "console-resource",
    preferredScopeType: "platform",
  },
  {
    label: "portal",
    app: "portal",
    baseUrl: getPortalBaseUrl,
    authTestId: "portal-auth-required",
    resourceTestIdPrefix: "portal-resource",
    preferredScopeType: "client",
  },
];

test.describe("inline edit single-line controls", () => {
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  for (const config of appConfigs) {
    test(`${config.label} uses single-line inline edit controls`, async ({ page }) => {
      test.setTimeout(300_000);

      const user = demoContext.users.find(
        (entry) => entry.scope_type === config.preferredScopeType
      );
      if (!user || !demoContext.password) {
        if (strict) {
          throw new Error(
            `Demo user missing for ${config.label}:${config.preferredScopeType}`
          );
        }
        test.skip(true, `Demo user missing for ${config.label}:${config.preferredScopeType}`);
      }

      const baseUrl = config.baseUrl();
      const context = await fetchUserContext({
        app: config.app,
        email: user.email,
        password: demoContext.password,
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

      const preferredResourceKey =
        resolveResourceKeyByLabel({
          readRegistry: context.readRegistry,
          resourceKeys,
          keyword: "shipments",
        }) ?? null;
      const candidateResourceKeys = [preferredResourceKey, ...resourceKeys].filter(
        (value, index, list): value is string =>
          Boolean(value && value.trim()) && list.indexOf(value) === index
      );

      if (candidateResourceKeys.length === 0) {
        if (strict) {
          throw new Error(`No resources available for ${config.label}:${user.email}`);
        }
        test.skip(true, `No resources available for ${config.label}:${user.email}`);
      }

      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      const authGate = page.locator(`[data-testid="${config.authTestId}"]`);
      if (await authGate.isVisible()) {
        await signInWithPassword(page, user.email, demoContext.password);
      }
      await expectSignedIn(page, user.email, user.scope_type);

      const readyStateId = `${config.resourceTestIdPrefix}-ready`;
      const stateSelector = [
        `[data-testid="${readyStateId}"]`,
        `[data-testid="${config.resourceTestIdPrefix}-error"]`,
        `[data-testid="${config.resourceTestIdPrefix}-blocked"]`,
        `[data-testid="${config.label}-not-found"]`,
        `[data-testid="${config.label}-context-unavailable"]`,
        `[data-testid="${config.authTestId}"]`,
      ].join(", ");

      let captured = false;
      const triedResources: string[] = [];
      const blockedResources: string[] = [];
      for (const resourceKey of candidateResourceKeys) {
        triedResources.push(resourceKey);
        await page.goto(`${baseUrl}/resources/${encodeURIComponent(resourceKey)}`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });

        const state = page.locator(stateSelector).first();
        await expect(state).toBeVisible({ timeout: 30_000 });
        await assertSingleAppShellSidebar(page, config.label);
        await assertNoAppErrorReload(page);
        const stateId = (await state.getAttribute("data-testid")) ?? "unknown";
        if (stateId !== readyStateId) {
          blockedResources.push(`${resourceKey}:${stateId}`);
          continue;
        }
        await assertNavigationPerformance(page);

        const editor = await openFirstSingleLineInlineEditor(page);
        if (editor) {
          await expect(editor.cell.locator("textarea")).toHaveCount(0);
          if (captureEnabled) {
            await captureFullPage(
              page,
              evidencePath(`${config.label}-inline-edit.png`),
            );
          }
          await page.keyboard.press("Escape");
          captured = true;
        } else {
          const editableCells = page.locator(
            '#main-content tbody td[data-editable="true"]:visible',
          );
          if ((await editableCells.count()) === 0) {
            const capabilitySet = resolveCapabilitySet(
              context.me?.capabilities ?? null
            );
            const resource = context.readRegistry?.resources?.find(
              (entry) => entry?.key === resourceKey
            );
            const writeCapability =
              resource?.capability_write ?? resource?.capability_read ?? null;
            if (!hasCapability(capabilitySet, writeCapability)) {
              await expect(editableCells).toHaveCount(0);
              captured = true;
            }
          }
        }

        if (captured) {
          break;
        }
      }

      if (!captured && strict) {
        throw new Error(
          `Inline edit single-line control unavailable in ${config.label} for ${user.email}. tried=${triedResources.join(",")} blocked=${blockedResources.join(",") || "none"}.`
        );
      }
    });
  }
});
