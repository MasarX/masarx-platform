import { expect, test } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getPortalBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import {
  extractIsoTimestamp,
  fetchOnboardingReadiness,
  formatReadinessLabel,
  readinessCountLabel,
} from "./utils/onboarding-readiness";
import { ensureSignedIn } from "./utils/session";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();

test.describe("portal onboarding readiness", () => {
  test.skip(
    !demoContext.available && !strict,
    demoContext.reason ?? "Demo accounts missing.",
  );

  test("readiness page renders the client-safe subset", async ({
    page,
  }, testInfo) => {
    test.slow();
    if (!demoContext.available) {
      throw new Error(demoContext.reason ?? "Demo accounts missing for strict E2E.");
    }

    const reviewer =
      demoContext.users.find((user) => user.scope_type === "client") ??
      demoContext.users.find((user) => user.scope_type === "sender") ??
      null;
    if (!reviewer) {
      throw new Error("No client or sender demo user available.");
    }

    const expected = await fetchOnboardingReadiness({
      email: reviewer.email,
      password: demoContext.password ?? "",
    });
    const readiness = expected.readiness;
    const settingsDefaults = readiness.settings_defaults ?? null;
    const workflowBindings = readiness.workflow_bindings ?? null;
    const integrationPlugins = readiness.integration_plugins ?? null;
    const pluginItems = Array.isArray(integrationPlugins?.items)
      ? integrationPlugins.items
      : [];
    const blockingFindings = Array.isArray(readiness.blocking_findings)
      ? readiness.blocking_findings
      : [];

    const basePath = getPortalBasePath();

    await ensureSignedIn({
      page,
      basePath,
      authTestId: "portal-auth-required",
      email: reviewer.email,
      password: demoContext.password ?? "",
      scopeType: reviewer.scope_type ?? null,
    });

    await page.goto(`${basePath}/onboarding/readiness`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await expect(
      page.locator('[data-testid="portal-onboarding-readiness-ready"]').first(),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="portal-onboarding-readiness-scope"]').first(),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="portal-onboarding-readiness-scope"]').first(),
    ).toContainText(expected.resolvedScopeType);
    if (expected.resolvedScopeId) {
      await expect(
        page.locator('[data-testid="portal-onboarding-readiness-scope"]').first(),
      ).toContainText(expected.resolvedScopeId);
    }
    await expect(
      page.locator('[data-testid="portal-onboarding-readiness-read-at"]').first(),
    ).toBeVisible();
    const readAtText = await page
      .locator('[data-testid="portal-onboarding-readiness-read-at"]')
      .first()
      .innerText();
    const renderedReadAt = extractIsoTimestamp(readAtText);
    expect(renderedReadAt).toBeTruthy();
    const expectedReadAtMs = readiness.generated_at
      ? new Date(readiness.generated_at).getTime()
      : Number.NaN;
    const renderedReadAtMs = renderedReadAt
      ? new Date(renderedReadAt).getTime()
      : Number.NaN;
    expect(Number.isNaN(renderedReadAtMs)).toBe(false);
    if (!Number.isNaN(expectedReadAtMs)) {
      expect(renderedReadAtMs).toBeGreaterThanOrEqual(expectedReadAtMs);
      expect(renderedReadAtMs - expectedReadAtMs).toBeLessThanOrEqual(60_000);
    }

    const overall = page.locator('[data-testid="portal-onboarding-readiness-overall"]').first();
    await expect(overall).toContainText(formatReadinessLabel(readiness.overall_status));
    await expect(overall).toContainText(
      readiness.healthy
        ? "All required onboarding defaults for this scope are currently ready."
        : "The scope still has blocking drift or pending operator work.",
    );

    const cards = page.locator('[data-testid="portal-onboarding-readiness-cards"]').first();
    await expect(cards).toContainText(
      readinessCountLabel(
        Number(settingsDefaults?.present_count ?? 0),
        Number(settingsDefaults?.required_count ?? 0),
      ),
    );
    await expect(cards).toContainText(
      readinessCountLabel(
        Number(workflowBindings?.present_count ?? 0),
        Number(workflowBindings?.required_count ?? 0),
      ),
    );
    await expect(cards).toContainText(
      readinessCountLabel(
        Number(integrationPlugins?.healthy_count ?? 0) +
          Number(integrationPlugins?.pending_credentials_count ?? 0),
        Number(integrationPlugins?.required_count ?? 0),
      ),
    );
    if (workflowBindings?.baseline_profile) {
      await expect(cards).toContainText(`Baseline profile: ${workflowBindings.baseline_profile}`);
    }
    if (integrationPlugins?.baseline_profile) {
      await expect(cards).toContainText(`Baseline profile: ${integrationPlugins.baseline_profile}`);
    }

    const pluginsSummary = page.locator('[data-testid="portal-onboarding-readiness-plugins-summary"]').first();
    const pluginsSection = page.locator('[data-testid="portal-onboarding-readiness-plugins-section"]').first();
    if (pluginItems.length > 0 && !(await pluginsSummary.count())) {
      await page
        .locator('[data-testid="portal-onboarding-readiness-plugins-section-summary"]')
        .first()
        .click();
    }
    await expect(pluginsSection).toBeVisible();
    if (pluginItems.length === 0) {
      await expect(
        page.getByText("No baseline plugins are configured for this scope."),
      ).toBeVisible();
      await expect(pluginsSummary).toHaveCount(0);
    } else {
      await expect(pluginsSummary).toBeVisible();
      await expect(pluginsSummary).toContainText(
        readinessCountLabel(
          Number(integrationPlugins?.healthy_count ?? 0) +
            Number(integrationPlugins?.pending_credentials_count ?? 0),
          Number(integrationPlugins?.required_count ?? 0),
        ),
      );
      await expect(pluginsSummary).toContainText(
        `Healthy plugins: ${Number(integrationPlugins?.healthy_count ?? 0)}.`,
      );
      await expect(pluginsSummary).toContainText(
        `Pending credential handoffs: ${Number(integrationPlugins?.pending_credentials_count ?? 0)}.`,
      );
      for (const item of pluginItems.slice(0, 2)) {
        const pluginLabel = item.plugin_name || item.plugin_key || "";
        if (pluginLabel) {
          await expect(pluginsSection).not.toContainText(pluginLabel);
        }
      }
    }

    if (blockingFindings.length === 0) {
      await expect(
        page.getByText("No blocking findings were reported for the current scope."),
      ).toBeVisible();
      await expect(
        page.locator('[data-testid="portal-onboarding-readiness-findings-summary"]')
      ).toHaveCount(0);
    } else {
      const findingsSummary = page.locator(
        '[data-testid="portal-onboarding-readiness-findings-summary"]'
      ).first();
      await expect(findingsSummary).toBeVisible();
      await expect(findingsSummary).toContainText(
        `${blockingFindings.length} onboarding readiness blocker(s) remain for this scope.`,
      );
      for (const finding of blockingFindings.slice(0, 2)) {
        if (finding.message) {
          await expect(pluginsSection).not.toContainText(finding.message);
        }
      }
    }

    await expect(
      page.locator('[data-testid="portal-onboarding-readiness-plugins-table"]')
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="portal-onboarding-readiness-findings"]')
    ).toHaveCount(0);

    await page.screenshot({
      path: testInfo.outputPath("portal-onboarding-readiness.png"),
      fullPage: true,
    });
  });
});
