import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getConsoleBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import { ensureSignedIn } from "./utils/session";

type FixtureSummary = {
  support_cases: {
    timing_change: {
      id: string;
      change_summary: string;
    };
    applied_location_change: {
      id: string;
      change_summary: string;
    };
    pending_review_primary: {
      id: string;
      change_summary: string;
    };
    pending_review_secondary: {
      id: string;
      change_summary: string;
    };
  };
};

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();
const fixturePath = path.resolve(
  process.cwd(),
  "tmp",
  "customer-shipment-change-review-fixtures.json",
);

function provisionFixtures(): FixtureSummary {
  const result = spawnSync(
    process.execPath,
    ["scripts/qa/provision-customer-shipment-change-review-fixtures.js"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ENV_FILE: process.env.ENV_FILE || "config/env/.env.local",
      },
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() ||
        result.stdout?.trim() ||
        "failed to provision customer shipment change review fixtures",
    );
  }

  if (!fs.existsSync(fixturePath)) {
    throw new Error(`fixture summary missing: ${fixturePath}`);
  }

  return JSON.parse(fs.readFileSync(fixturePath, "utf8")) as FixtureSummary;
}

function normalizeTexts(values: string[]) {
  return values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean);
}

test.describe("console customer shipment changes", () => {
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
      demoContext.users.find((user) => user.email === "lpnoiwlvqmryinlkzgwwiosw@example.invalid") ??
      demoContext.users.find((user) => user.email === "sipkxyzyxvgvtksowrxwjgpn@example.invalid") ??
      demoContext.users.find((user) => user.scope_type === "platform") ??
      demoContext.users.find((user) => user.scope_type === "tenant") ??
      null;
    if (!opsUser) {
      throw new Error("No console reviewer demo user available.");
    }

    const fixtures = provisionFixtures();
    const basePath = getConsoleBasePath();

    await ensureSignedIn({
      page,
      basePath,
      authTestId: "console-auth-required",
      email: opsUser.email,
      password: demoContext.password ?? "",
      scopeType: opsUser.scope_type ?? null,
    });

    await page.goto(`${basePath}/operations/customer-shipment-changes`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await expect(
      page.locator('[data-testid="console-customer-shipment-changes-ready"]').first(),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Customer shipment changes" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Public tracking requests" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Needs review", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Applied", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Rejected", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "All", exact: true })).toBeVisible();
    await expect(page.locator("tbody")).toContainText(
      fixtures.support_cases.applied_location_change.change_summary,
    );

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
      path: testInfo.outputPath("customer-shipment-changes-list-needs-review.png"),
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
      page.locator('[data-testid="console-customer-shipment-changes-review-approve"]'),
    ).toBeEnabled();

    await page.locator('[data-testid="console-customer-shipment-changes-review-reason"]').fill(
      "Approved in Playwright E2E.",
    );
    await page.locator('[data-testid="console-customer-shipment-changes-review-approve"]').click();
    await expect(
      page.locator('[data-testid="console-customer-shipment-changes-review-success"]'),
    ).toContainText("Shipment change approved and applied.");
    await expect(
      page.locator('[data-testid="console-customer-shipment-changes-review-blocked"]'),
    ).toContainText("already resolved");
    await expect(page.getByText("Current / Applied")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("customer-shipment-changes-detail-applied.png"),
      fullPage: true,
    });

    await page.goto(
      `${basePath}/operations/customer-shipment-changes?id=${fixtures.support_cases.pending_review_secondary.id}`,
      {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      },
    );
    await page.locator('[data-testid="console-customer-shipment-changes-review-reason"]').fill(
      "Rejected in Playwright E2E.",
    );
    await page.locator('[data-testid="console-customer-shipment-changes-review-reject"]').click();
    await expect(
      page.locator('[data-testid="console-customer-shipment-changes-review-success"]'),
    ).toContainText("Shipment change rejected.");
    await expect(page.getByText("Rejected").first()).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("customer-shipment-changes-detail-rejected.png"),
      fullPage: true,
    });

    await page.goto(
      `${basePath}/operations/customer-shipment-changes?id=${fixtures.support_cases.timing_change.id}`,
      {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      },
    );
    await expect(page.getByText(/Last apply error/i)).toContainText("invalid_window");

    await page.goto(`${basePath}/operations/public-tracking-requests`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const reviewTableBody = page.locator("tbody").first();
    await expect(
      page.locator('[data-testid="console-public-tracking-requests-ready"]').first(),
    ).toBeVisible();
    await expect(reviewTableBody).toContainText("pending_review");

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
