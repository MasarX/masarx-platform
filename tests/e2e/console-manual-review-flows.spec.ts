import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getConsoleBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import { ensureSignedIn } from "./utils/session";
import { fetchUserContext } from "./utils/role-matrix";
import { fetchResourceSampleId } from "./utils/core-resource";
import { assertNavigationPerformance } from "./utils/performance";
import { hasCapability, resolveCapabilitySet } from "./utils/capabilities";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();
const manualReviewResourceKey = "manual_review_tasks";

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

async function verifyManualReviewPage(params: {
  page: import("@playwright/test").Page;
  basePath: string;
  routePath: string;
  testIdPrefix: string;
  user: { email: string; scope_type?: string | null };
}) {
  const { page, basePath, routePath, testIdPrefix, user } = params;
  await page.goto(`${basePath}/${routePath}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await expect(
    page.locator(
      `[data-testid="${testIdPrefix}-ready"], [data-testid="${testIdPrefix}-error"], [data-testid="console-auth-required"]`
    )
  ).toBeVisible();
  await assertNavigationPerformance(page);

  const context = await fetchUserContext({
    app: "console",
    email: user.email,
    password: demoContext.password ?? "",
  });
  const resourceEntry = Array.isArray(context.readRegistry?.resources)
    ? context.readRegistry?.resources.find(
        (entry) => entry?.key === manualReviewResourceKey
      )
    : null;

  if (!resourceEntry) {
    if (strict) {
      throw new Error("Manual review resource not registered.");
    }
    return;
  }

  const sample = await fetchResourceSampleId({
    resourceKey: manualReviewResourceKey,
    idColumn: resourceEntry.id_column ?? null,
    email: user.email,
    password: demoContext.password ?? "",
  });
  if (!sample.id) {
    if (strict && sample.total !== 0) {
      throw new Error(
        `Manual review tasks missing sample row despite total=${sample.total}.`
      );
    }

    const emptyState = page.locator('table tbody [role="status"]');
    await expect(emptyState.first()).toBeVisible();
    return;
  }

  await page.goto(
    `${basePath}/${routePath}?id=${encodeURIComponent(sample.id)}`,
    {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    }
  );
  await expect(
    page.locator(
      `[data-testid="${testIdPrefix}-ready"], [data-testid="${testIdPrefix}-error"], [data-testid="console-auth-required"]`
    )
  ).toBeVisible();
  await assertNavigationPerformance(page);

  const detail = page.locator(`[data-testid="${testIdPrefix}-detail"]`);
  await expect(detail).toBeVisible();

  const resolveForm = page.locator(
    `[data-testid="${testIdPrefix}-resolve-form"]`
  );
  if ((await resolveForm.count()) === 0) {
    if (strict) {
      throw new Error("Manual review resolve form missing.");
    }
    return;
  }

  const capabilitySet = resolveCapabilitySet(
    Array.isArray(context.me?.capabilities) ? context.me?.capabilities : []
  );
  const canResolve = hasCapability(capabilitySet, "manual_review.resolve");
  const submit = page.locator(
    `[data-testid="${testIdPrefix}-resolve-submit"]`
  );
  const blocked = page.locator(
    `[data-testid="${testIdPrefix}-resolve-blocked"]`
  );

  if (canResolve) {
    await expect(submit).toBeVisible();
    await expect(submit).toBeEnabled();
    await expect(blocked).toHaveCount(0);
  } else {
    await expect(submit).toBeVisible();
    await expect(submit).toBeDisabled();
    await expect(blocked).toBeVisible();
  }
}

test.describe("console manual review flows", () => {
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  const consoleUsers = demoContext.users.filter((user) =>
    ["platform", "tenant"].includes(user.scope_type ?? "")
  );

  test.beforeAll(() => enforceDemoContext("console", consoleUsers));

  test("manual review queue and tasks detail flows", async ({ page }) => {
    const user = consoleUsers[0];
    test.skip(!user, "No console demo user available.");
    const basePath = getConsoleBasePath();

    await ensureSignedIn({
      page,
      basePath,
      authTestId: "console-auth-required",
      email: user.email,
      password: demoContext.password ?? "",
      scopeType: user.scope_type ?? null,
    });

    await verifyManualReviewPage({
      page,
      basePath,
      routePath: "workflows/queue",
      testIdPrefix: "console-manual-review-queue",
      user,
    });

    await verifyManualReviewPage({
      page,
      basePath,
      routePath: "workflows/tasks",
      testIdPrefix: "console-manual-review-tasks",
      user,
    });
  });
});
