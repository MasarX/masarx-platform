import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext } from "./utils/role-matrix";
import {
  collectAccessibleResourceKeys,
  resolveExpectedActionStats,
} from "./utils/action-matrix";
import { runWithRuntimeErrors } from "./utils/runtime-errors";

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

async function parseCount(locator: import("@playwright/test").Locator) {
  const text = (await locator.textContent()) ?? "";
  const match = text.match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

test.describe("console action stats matrix", () => {
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  const consoleUsers = demoContext.users.filter((user) =>
    ["platform", "tenant"].includes(user.scope_type ?? "")
  );

  test.beforeAll(() => enforceDemoContext("console", consoleUsers));

  for (const user of consoleUsers) {
    test(`console action stats align for ${user.email}`, async ({ page }) => {
      test.setTimeout(600_000);
      await runWithRuntimeErrors(
        page,
        { label: `console action matrix ${user.email}` },
        async () => {
          const consoleBasePath = getConsoleBasePath();
          const context = await fetchUserContext({
            app: "console",
            email: user.email,
            password: demoContext.password ?? "",
          });

          const sections = Array.isArray(context.navigation.sections)
            ? context.navigation.sections
            : [];
          const navResourceKeys = collectAccessibleResourceKeys({
            sections,
            capabilities: context.me?.capabilities ?? null,
          });
          const enforceReadyForResources = navResourceKeys.length > 0;
          let resourceKeys = navResourceKeys;
          if (resourceKeys.length === 0) {
            const fallback = Array.isArray(context.readRegistry?.resources)
              ? context.readRegistry?.resources
                  .map((entry) => entry?.key?.trim() ?? "")
                  .filter(Boolean)
              : [];
            if (fallback.length === 0) {
              throw new Error(`No resources available for ${user.email}.`);
            }
            resourceKeys = Array.from(new Set(fallback));
          }

          await page.goto(consoleBasePath || "/");
          const authGate = page.locator('[data-testid="console-auth-required"]');
          const contextUnavailable = page.locator(
            '[data-testid="console-context-unavailable"]'
          );
          if (await contextUnavailable.isVisible()) {
            throw new Error(`Console UI context unavailable for ${user.email}`);
          }
          if (await authGate.isVisible()) {
            await signInWithPassword(page, user.email, demoContext.password || "");
          }
          if (await contextUnavailable.isVisible()) {
            throw new Error(`Console UI context unavailable for ${user.email}`);
          }
          await expectSignedIn(page, user.email, user.scope_type);

          for (const resourceKey of resourceKeys) {
            await test.step(resourceKey, async () => {
              await page.goto(`${consoleBasePath}/resources/${resourceKey}`, {
                waitUntil: "domcontentloaded",
                timeout: 60_000,
              });
              const ready = page.locator('[data-testid="console-resource-ready"]');
              const state = page
                .locator(
                  '[data-testid="console-resource-ready"], [data-testid="console-resource-error"], [data-testid="console-resource-blocked"], [data-testid="console-auth-required"], [data-testid="console-context-unavailable"], [data-testid="console-not-found"]'
                )
                .first();
              await expect(
                page.locator(
                  '[data-testid="console-resource-ready"], [data-testid="console-resource-error"], [data-testid="console-resource-blocked"], [data-testid="console-auth-required"], [data-testid="console-context-unavailable"], [data-testid="console-not-found"]'
                )
              ).toBeVisible();
              if (!(await ready.isVisible())) {
                if (enforceReadyForResources) {
                  const stateId = await state.getAttribute("data-testid");
                  throw new Error(
                    `Expected console resource ${resourceKey} to be ready for ${user.email}, got ${stateId ?? "unknown"}`
                  );
                }
                return;
              }

              const stats = resolveExpectedActionStats({
                resourceKey,
                readRegistry: context.readRegistry,
                commandRegistry: context.commandRegistry,
                capabilities: context.me?.capabilities ?? null,
              });

              const configuredBadge = page.locator(
                '[data-testid="console-resource-actions-configured"]'
              );
              const availableBadge = page.locator(
                '[data-testid="console-resource-actions-available"]'
              );
              const blockedBadge = page.locator(
                '[data-testid="console-resource-actions-blocked"]'
              );
              const emptyLabel = page.locator(
                '[data-testid="console-resource-actions-empty"]'
              );

              if (stats.total === 0) {
                await expect(emptyLabel).toBeVisible();
                await expect(configuredBadge).toHaveCount(0);
                await expect(availableBadge).toHaveCount(0);
                await expect(blockedBadge).toHaveCount(0);
                return;
              }

              await expect(emptyLabel).toHaveCount(0);
              await expect(configuredBadge).toBeVisible();
              await expect(availableBadge).toBeVisible();

              const configured = await parseCount(configuredBadge);
              const available = await parseCount(availableBadge);

              expect(configured).toBe(stats.total);
              expect(available).toBe(stats.allowed);

              if (stats.blocked > 0) {
                await expect(blockedBadge).toBeVisible();
                const blocked = await parseCount(blockedBadge);
                expect(blocked).toBe(stats.blocked);
              } else {
                await expect(blockedBadge).toHaveCount(0);
              }
            });
          }
        }
      );
    });
  }
});
