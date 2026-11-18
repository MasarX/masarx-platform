import { expect, type Page } from "@playwright/test";

type ManualReviewResolveAcknowledgement = {
  page: Page;
  outcome: "approved" | "rejected";
  notes?: string;
  testIdPrefix?: string;
};

/**
 * Server-action resolution can be acknowledged either by the transient form
 * success state or by the stable resolved task detail after path revalidation.
 */
export async function expectManualReviewResolveAcknowledged({
  page,
  outcome,
  notes,
  testIdPrefix = "console-manual-review-queue",
}: ManualReviewResolveAcknowledgement) {
  const success = page.locator(`[data-testid="${testIdPrefix}-resolve-success"]`);
  const detail = page.locator(`[data-testid="${testIdPrefix}-detail"]`);

  await expect(async () => {
    if (await success.isVisible().catch(() => false)) {
      return;
    }

    await expect(detail).toBeVisible({ timeout: 1_000 });
    await expect(detail).toContainText("resolved", { timeout: 1_000 });
    await expect(detail).toContainText(outcome, { timeout: 1_000 });
    if (notes) {
      await expect(detail).toContainText(notes, { timeout: 1_000 });
    }
  }).toPass({
    timeout: 30_000,
    intervals: [250, 500, 1_000],
  });
}
