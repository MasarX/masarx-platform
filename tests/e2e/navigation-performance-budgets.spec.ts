import { test, expect, type Locator } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./utils/base-urls";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext } from "./utils/role-matrix";
import { applyResourceLimit, resolveResourceKeysForUser } from "./utils/core-resource";
import {
  assertNavigationPerformance,
  assertWebVitals,
  installWebVitalsObserver,
} from "./utils/performance";

type AppConfig = {
  label: "console" | "portal";
  app: "console" | "portal";
  baseUrl: () => string;
  authTestId: string;
  scopeTypes: string[];
  resourceTestIdPrefix: string;
};

const appConfigs: AppConfig[] = [
  {
    label: "console",
    app: "console",
    baseUrl: getConsoleBaseUrl,
    authTestId: "console-auth-required",
    scopeTypes: ["platform", "tenant"],
    resourceTestIdPrefix: "console-resource",
  },
  {
    label: "portal",
    app: "portal",
    baseUrl: getPortalBaseUrl,
    authTestId: "portal-auth-required",
    scopeTypes: ["client", "sender"],
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

async function expectAnyLocatorVisible(locator: Locator) {
  await expect
    .poll(async () => {
      const count = await locator.count();
      for (let index = 0; index < count; index += 1) {
        if (await locator.nth(index).isVisible()) return true;
      }
      return false;
    })
    .toBe(true);
}

for (const config of appConfigs) {
  test.describe(`${config.label} performance budgets`, () => {
    test.skip(
      !demoContext.available && !strict,
      demoContext.reason ?? "Demo accounts missing."
    );

    const scopedUsers = demoContext.users.filter((user) =>
      config.scopeTypes.includes(user.scope_type ?? "")
    );

    test.beforeAll(() => enforceDemoContext(config.label, scopedUsers));

    const user = scopedUsers[0];
    if (!user) return;

    test(`${config.label} key pages meet perf budgets`, async ({ page }) => {
      test.setTimeout(600_000);
      const baseUrl = config.baseUrl();
      await page.goto(baseUrl);
      const authGate = page.locator(`[data-testid="${config.authTestId}"]`);
      if (await authGate.isVisible()) {
        await signInWithPassword(page, user.email, demoContext.password || "");
      }
      await expectSignedIn(page, user.email, user.scope_type);

      const targets = [
        {
          label: "dashboard",
          href: baseUrl,
          selector: [
            `[data-testid="${config.label}-dashboard-ready"]`,
            `[data-testid="${config.label}-dashboard-error"]`,
            `[data-testid="${config.authTestId}"]`,
          ].join(", "),
        },
        {
          label: "settings request",
          href: `${baseUrl}/settings/request`,
          selector: [
            `[data-testid="${config.label}-settings-request-form"]`,
            `[data-testid="${config.label}-settings-request-blocked"]`,
            `[data-testid="${config.label}-settings-request-error"]`,
            `[data-testid="${config.authTestId}"]`,
          ].join(", "),
        },
        {
          label: "access policy request",
          href: `${baseUrl}/access-policy/request`,
          selector: [
            `[data-testid="${config.label}-access-policy-request-form"]`,
            `[data-testid="${config.label}-access-policy-request-blocked"]`,
            `[data-testid="${config.label}-access-policy-request-error"]`,
            `[data-testid="${config.authTestId}"]`,
          ].join(", "),
        },
      ];
      const extraTargets =
        config.label === "console"
          ? [
              {
                label: "commands",
                href: `${baseUrl}/commands`,
                selector: [
                  `[data-testid="console-commands-ready"]`,
                  `[data-testid="console-commands-error"]`,
                  `[data-testid="${config.authTestId}"]`,
                ].join(", "),
              },
              {
                label: "workflows queue",
                href: `${baseUrl}/workflows/queue`,
                selector: [
                  `[data-testid="console-manual-review-queue-ready"]`,
                  `[data-testid="console-manual-review-queue-error"]`,
                  `[data-testid="${config.authTestId}"]`,
                ].join(", "),
              },
              {
                label: "workflows tasks",
                href: `${baseUrl}/workflows/tasks`,
                selector: [
                  `[data-testid="console-manual-review-tasks-ready"]`,
                  `[data-testid="console-manual-review-tasks-error"]`,
                  `[data-testid="${config.authTestId}"]`,
                ].join(", "),
              },
              {
                label: "operations routes",
                href: `${baseUrl}/operations/routes`,
                selector: [
                  `[data-testid="console-route-operations-ready"]`,
                  `[data-testid="console-route-operations-error"]`,
                  `[data-testid="${config.authTestId}"]`,
                ].join(", "),
              },
              {
                label: "operations exceptions",
                href: `${baseUrl}/operations/exceptions`,
                selector: [
                  `[data-testid="console-exception-inbox-ready"]`,
                  `[data-testid="console-exception-inbox-error"]`,
                  `[data-testid="${config.authTestId}"]`,
                ].join(", "),
              },
              {
                label: "observability domain events",
                href: `${baseUrl}/observability/domain-events`,
                selector: [
                  `[data-testid="console-domain-events-ready"]`,
                  `[data-testid="console-domain-events-error"]`,
                  `[data-testid="${config.authTestId}"]`,
                ].join(", "),
              },
            ]
          : [
              {
                label: "commands",
                href: `${baseUrl}/commands`,
                selector: [
                  `[data-testid="portal-commands-ready"]`,
                  `[data-testid="portal-commands-error"]`,
                  `[data-testid="${config.authTestId}"]`,
                ].join(", "),
              },
              {
                label: "tracking",
                href: `${baseUrl}/tracking`,
                selector: [
                  `[data-testid="portal-tracking-form"]`,
                  `[data-testid="portal-tracking-error"]`,
                  `[data-testid="${config.authTestId}"]`,
                ].join(", "),
              },
              {
                label: "help",
                href: `${baseUrl}/help`,
                selector: [
                  `[data-testid="portal-help-ready"]`,
                  `[data-testid="${config.authTestId}"]`,
                ].join(", "),
              },
              {
                label: "workflows queue",
                href: `${baseUrl}/workflows/queue`,
                selector: [
                  `[data-testid="portal-manual-review-queue-ready"]`,
                  `[data-testid="portal-manual-review-queue-blocked"]`,
                  `[data-testid="portal-manual-review-queue-error"]`,
                  `[data-testid="${config.authTestId}"]`,
                ].join(", "),
              },
              {
                label: "workflows tasks",
                href: `${baseUrl}/workflows/tasks`,
                selector: [
                  `[data-testid="portal-manual-review-tasks-ready"]`,
                  `[data-testid="portal-manual-review-tasks-blocked"]`,
                  `[data-testid="portal-manual-review-tasks-error"]`,
                  `[data-testid="${config.authTestId}"]`,
                ].join(", "),
              },
              {
                label: "operations routes",
                href: `${baseUrl}/operations/routes`,
                selector: [
                  `[data-testid="portal-route-operations-ready"]`,
                  `[data-testid="portal-route-operations-error"]`,
                  `[data-testid="${config.authTestId}"]`,
                ].join(", "),
              },
              {
                label: "operations exceptions",
                href: `${baseUrl}/operations/exceptions`,
                selector: [
                  `[data-testid="portal-exception-inbox-ready"]`,
                  `[data-testid="portal-exception-inbox-error"]`,
                  `[data-testid="${config.authTestId}"]`,
                ].join(", "),
              },
            ];

      for (const target of [...targets, ...extraTargets]) {
        await installWebVitalsObserver(page);
        await page.goto(target.href, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await expectAnyLocatorVisible(page.locator(target.selector));
        await assertNavigationPerformance(page);
        await assertWebVitals(page);
      }
    });

    test(`${config.label} resource navigation meets perf budgets`, async ({ page }) => {
      test.setTimeout(600_000);
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
      const resourceKey = resourceKeys[0];

      await page.goto(config.baseUrl());
      const authGate = page.locator(`[data-testid="${config.authTestId}"]`);
      if (await authGate.isVisible()) {
        await signInWithPassword(page, user.email, demoContext.password || "");
      }
      await expectSignedIn(page, user.email, user.scope_type);

      await installWebVitalsObserver(page);
      await page.goto(`${config.baseUrl()}/resources/${resourceKey}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await expectAnyLocatorVisible(
        page.locator(
          `[data-testid="${config.resourceTestIdPrefix}-ready"], [data-testid="${config.resourceTestIdPrefix}-error"], [data-testid="${config.authTestId}"]`
        )
      );

      await assertNavigationPerformance(page);
      await assertWebVitals(page);
    });
  });
}
