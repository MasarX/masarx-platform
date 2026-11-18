import { expect, test } from "@playwright/test";
import { provisionCustomerShipmentChangeReviewFixtures } from "./utils/customer-shipment-change-review";
import { loadDemoContext } from "./utils/demo-accounts";
import { getPortalBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import { ensureSignedIn } from "./utils/session";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();
function normalizeTexts(values: string[]) {
  return values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean);
}

test.describe("portal customer shipment changes", () => {
  test.skip(
    !demoContext.available && !strict,
    demoContext.reason ?? "Demo accounts missing.",
  );

  test("review workspace shows diffs and resolves customer shipment changes", async ({
    page,
  }, testInfo) => {
    test.slow();
    if (!demoContext.available) {
      throw new Error(demoContext.reason ?? "Demo accounts missing for strict E2E.");
    }

    const opsUser =
      demoContext.users.find((user) => user.scope_type === "tenant") ??
      null;
    if (!opsUser) {
      throw new Error("No tenant-scoped ops reviewer demo user available.");
    }

    const fixtures = provisionCustomerShipmentChangeReviewFixtures();
    const basePath = getPortalBasePath();

    await ensureSignedIn({
      page,
      basePath,
      authTestId: "portal-auth-required",
      email: opsUser.email,
      password: demoContext.password ?? "",
      scopeType: opsUser.scope_type ?? null,
    });

    await page.goto(`${basePath}/operations/customer-shipment-changes`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await expect(
      page.locator('[data-testid="portal-customer-shipment-changes-ready"]').first(),
    ).toBeVisible();
    const navigation = page.getByTestId("navigation-list").first();
    const customerChangesLink = navigation.getByTestId("navigation-item-portal-customer-shipment-changes").getByRole("link");
    await expect(customerChangesLink).toBeVisible();
    await expect(customerChangesLink).toHaveAttribute("href", `${basePath}/operations/customer-shipment-changes`);
    const publicTrackingLink = navigation.getByTestId("navigation-item-portal-public-tracking-requests").getByRole("link");
    await expect(publicTrackingLink).toBeVisible();
    await expect(publicTrackingLink).toHaveAttribute("href", `${basePath}/operations/public-tracking-requests`);
    await expect(page.getByRole("link", { name: "Needs review", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Applied", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Rejected", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "All", exact: true })).toBeVisible();
    await expect(page.locator("tbody")).toContainText(
      fixtures.support_cases.applied_location_change.change_summary,
    );
    await expect(page.locator("tbody")).toContainText("pending_review");

    const headers = normalizeTexts(await page.locator("thead th").allTextContents());
    expect(headers).toEqual([
      "Tracking number",
      "Shipment status",
      "Change type",
      "Outcome",
      "Changed fields",
      "Requester channel",
      "Before -> requested",
      "Requested at",
      "Status reason",
    ]);
    await page.screenshot({
      path: testInfo.outputPath("portal-customer-shipment-changes-list-needs-review.png"),
      fullPage: true,
    });

    await page.goto(
      `${basePath}/operations/customer-shipment-changes?id=${fixtures.support_cases.pending_review_primary.id}`,
      {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      },
    );
    await expect(page.getByText("Change review")).toBeVisible();
    await expect(page.getByText("Before").first()).toBeVisible();
    await expect(page.getByText("Requested").first()).toBeVisible();
    await expect(page.getByText("Current").first()).toBeVisible();
    await expect(
      page.locator('[data-testid="portal-customer-shipment-changes-review-approve"]'),
    ).toBeEnabled();

    await page.locator('[data-testid="portal-customer-shipment-changes-review-reason"]').fill(
      "Approved in portal Playwright E2E.",
    );
    await page.locator('[data-testid="portal-customer-shipment-changes-review-approve"]').click();
    await expect(
      page.locator('[data-testid="portal-customer-shipment-changes-review-success"]'),
    ).toContainText("Shipment change approved and applied.");
    await expect(
      page.locator('[data-testid="portal-customer-shipment-changes-review-blocked"]'),
    ).toContainText("already resolved");
    await expect(
      page.locator('[data-testid$="-review-success"]'),
    ).toContainText("Backend readback:");
    await page.screenshot({
      path: testInfo.outputPath("portal-customer-shipment-changes-detail-applied.png"),
      fullPage: true,
    });

    await page.goto(
      `${basePath}/operations/customer-shipment-changes?id=${fixtures.support_cases.pending_review_secondary.id}`,
      {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      },
    );
    await page.locator('[data-testid="portal-customer-shipment-changes-review-reason"]').fill(
      "Rejected in portal Playwright E2E.",
    );
    await page.locator('[data-testid="portal-customer-shipment-changes-review-reject"]').click();
    await expect(
      page.locator('[data-testid="portal-customer-shipment-changes-review-success"]'),
    ).toContainText("Shipment change rejected.");
    await expect(page.getByText("Rejected").first()).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("portal-customer-shipment-changes-detail-rejected.png"),
      fullPage: true,
    });

    await page.goto(
      `${basePath}/operations/customer-shipment-changes?id=${fixtures.support_cases.timing_change.id}`,
      {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      },
    );
    await expect(page.getByText("Current / Applied")).toBeVisible();
    await expect(
      page.getByText(fixtures.support_cases.timing_change.change_summary).first(),
    ).toBeVisible();
    await expect(page.getByText(/Last apply error/i)).toHaveCount(0);

    await page.goto(`${basePath}/operations/public-tracking-requests`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const reviewTableBody = page.locator("tbody").first();
    await expect(
      page.locator('[data-testid="portal-public-tracking-requests-ready"]').first(),
    ).toBeVisible();
    await expect(reviewTableBody).not.toContainText(
      fixtures.support_cases.pending_review_primary.change_summary,
    );
    await expect(reviewTableBody).not.toContainText(
      fixtures.support_cases.pending_review_secondary.change_summary,
    );

    await page.getByRole("link", { name: "Applied" }).click();
    await expect(reviewTableBody).toContainText(
      fixtures.support_cases.pending_review_primary.change_summary,
    );

    await page.getByRole("link", { name: "Rejected" }).click();
    await expect(reviewTableBody).toContainText(
      fixtures.support_cases.pending_review_secondary.change_summary,
    );
  });
});
