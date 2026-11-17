import { expect, test } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getConsoleBasePath } from "./utils/base-paths";
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

test.describe("console onboarding readiness", () => {
  test.skip(
    !demoContext.available && !strict,
    demoContext.reason ?? "Demo accounts missing.",
  );

  test("readiness page renders operator-ready defaults evidence", async ({
    page,
  }, testInfo) => {
    test.slow();
    if (!demoContext.available) {
      throw new Error(demoContext.reason ?? "Demo accounts missing for strict E2E.");
    }

    const reviewer =
      demoContext.users.find((user) => user.email === "sipkxyzyxvgvtksowrxwjgpn@example.invalid") ??
      demoContext.users.find((user) => user.scope_type === "tenant") ??
      null;
    if (!reviewer) {
      throw new Error("No tenant-scoped reviewer demo user available.");
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

    const basePath = getConsoleBasePath();

    await ensureSignedIn({
      page,
      basePath,
      authTestId: "console-auth-required",
      email: reviewer.email,
      password: demoContext.password ?? "",
      scopeType: reviewer.scope_type ?? null,
    });

    await page.goto(`${basePath}/onboarding/readiness`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await expect(
      page.locator('[data-testid="console-onboarding-readiness-ready"]').first(),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="console-onboarding-readiness-scope"]').first(),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="console-onboarding-readiness-scope"]').first(),
    ).toContainText(expected.resolvedScopeType);
    if (expected.resolvedScopeId) {
      await expect(
        page.locator('[data-testid="console-onboarding-readiness-scope"]').first(),
      ).toContainText(expected.resolvedScopeId);
    }
    await expect(
      page.locator('[data-testid="console-onboarding-readiness-read-at"]').first(),
    ).toBeVisible();
    const readAtText = await page
      .locator('[data-testid="console-onboarding-readiness-read-at"]')
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

    const overall = page.locator('[data-testid="console-onboarding-readiness-overall"]').first();
    await expect(overall).toContainText(formatReadinessLabel(readiness.overall_status));
    await expect(overall).toContainText(
      readiness.healthy
        ? "All required onboarding defaults for this scope are currently ready."
        : "The scope still has blocking drift or pending operator work.",
    );

    const cards = page.locator('[data-testid="console-onboarding-readiness-cards"]').first();
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

    const pluginTable = page.locator('[data-testid="console-onboarding-readiness-plugins-table"]').first();
    if (pluginItems.length > 0 && !(await pluginTable.count())) {
      await page
        .locator('[data-testid="console-onboarding-readiness-plugins-section-summary"]')
        .first()
        .click();
    }
    if (pluginItems.length === 0) {
      await expect(
        page.getByText("No baseline plugins are configured for this scope."),
      ).toBeVisible();
    } else {
      await expect(pluginTable).toBeVisible();
      for (const item of pluginItems.slice(0, 3)) {
        const pluginLabel = item.plugin_name || item.plugin_key || "";
        if (pluginLabel) {
          await expect(pluginTable).toContainText(pluginLabel);
        }
        if (item.plugin_key && item.plugin_name && item.plugin_key !== item.plugin_name) {
          await expect(pluginTable).toContainText(item.plugin_key);
        }
        if (item.activation_mode) {
          await expect(pluginTable).toContainText(formatReadinessLabel(item.activation_mode));
        }
        if (item.status) {
          await expect(pluginTable).toContainText(formatReadinessLabel(item.status));
        }
        if (item.effective_version_status) {
          await expect(pluginTable).toContainText(item.effective_version_status);
        }
        if (typeof item.binding_count === "number") {
          await expect(pluginTable).toContainText(String(item.binding_count));
        }
        await expect(pluginTable).toContainText(
          item.pending_task_exists ? "Task open" : "No task",
        );
      }
    }
    await expect(
      page.locator('[data-testid="console-onboarding-readiness-plugins-summary"]')
    ).toHaveCount(0);

    if (blockingFindings.length === 0) {
      await expect(
        page.getByText("No blocking findings were reported for the current scope."),
      ).toBeVisible();
    } else {
      const findings = page.locator('[data-testid="console-onboarding-readiness-findings"]').first();
      await expect(findings).toBeVisible();
      for (const finding of blockingFindings.slice(0, 3)) {
        if (finding.code) {
          await expect(findings).toContainText(finding.code);
        }
        if (finding.message) {
          await expect(findings).toContainText(finding.message);
        }
      }
    }

    await page.screenshot({
      path: testInfo.outputPath("console-onboarding-readiness.png"),
      fullPage: true,
    });
  });
});
