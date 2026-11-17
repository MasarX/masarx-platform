import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getPortalBasePath } from "./utils/base-paths";
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

async function verifyManualReviewPage(params: {
  page: import("@playwright/test").Page;
  basePath: string;
  routePath: string;
  testIdPrefix: string;
  authTestId: string;
  user: { email: string; scope_type?: string | null };
}) {
  const { page, basePath, routePath, testIdPrefix, authTestId, user } = params;
  await page.goto(`${basePath}/${routePath}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await expect(
    page.locator(
      `[data-testid="${testIdPrefix}-ready"], [data-testid="${testIdPrefix}-error"], [data-testid="${testIdPrefix}-blocked"], [data-testid="${authTestId}"]`
    )
  ).toBeVisible();
  await assertNavigationPerformance(page);

  const context = await fetchUserContext({
    app: "portal",
    email: user.email,
    password: demoContext.password ?? "",
  });
  const capabilitySet = resolveCapabilitySet(
    Array.isArray(context.me?.capabilities) ? context.me?.capabilities : []
  );
  const canRead = hasCapability(capabilitySet, "manual_review.read");
  if (!canRead) {
    await expect(page.locator(`[data-testid="${testIdPrefix}-blocked"]`)).toBeVisible();
    return;
  }
  const resourceEntry = Array.isArray(context.readRegistry?.resources)
    ? context.readRegistry?.resources.find(
        (entry) => entry?.key === manualReviewResourceKey
      )
    : null;

  if (!resourceEntry) {
    return;
  }

  const sample = await fetchResourceSampleId({
    resourceKey: manualReviewResourceKey,
    idColumn: resourceEntry.id_column ?? null,
    email: user.email,
    password: demoContext.password ?? "",
  });
  if (!sample.id) {
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
      `[data-testid="${testIdPrefix}-ready"], [data-testid="${testIdPrefix}-error"], [data-testid="${testIdPrefix}-blocked"], [data-testid="${authTestId}"]`
    )
  ).toBeVisible();
  await assertNavigationPerformance(page);

  const detail = page.locator(`[data-testid="${testIdPrefix}-detail"]`);
  await expect(detail).toBeVisible();

  const resolveForm = page.locator(
    `[data-testid="${testIdPrefix}-resolve-form"]`
  );
  if ((await resolveForm.count()) === 0) {
    return;
  }

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

test.describe("portal manual review flows", () => {
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  const portalUsers = demoContext.users.filter((user) =>
    ["client", "sender"].includes(user.scope_type ?? "")
  );

  test.beforeAll(() => enforceDemoContext("portal", portalUsers));

  test("manual review routes honor capability policy", async ({ page }) => {
    let user = portalUsers[0] ?? null;
    for (const candidate of portalUsers) {
      const context = await fetchUserContext({
        app: "portal",
        email: candidate.email,
        password: demoContext.password ?? "",
      });
      const capabilitySet = resolveCapabilitySet(
        Array.isArray(context.me?.capabilities) ? context.me.capabilities : []
      );
      if (hasCapability(capabilitySet, "manual_review.read")) {
        user = candidate;
        break;
      }
    }
    if (!user) {
      test.skip(true, "No portal demo user available.");
      return;
    }
    const basePath = getPortalBasePath();

    await ensureSignedIn({
      page,
      basePath,
      authTestId: "portal-auth-required",
      email: user.email,
      password: demoContext.password ?? "",
      scopeType: user.scope_type ?? null,
    });

    await verifyManualReviewPage({
      page,
      basePath,
      routePath: "workflows/queue",
      testIdPrefix: "portal-manual-review-queue",
      authTestId: "portal-auth-required",
      user,
    });

    await verifyManualReviewPage({
      page,
      basePath,
      routePath: "workflows/tasks",
      testIdPrefix: "portal-manual-review-tasks",
      authTestId: "portal-auth-required",
      user,
    });
  });
});
