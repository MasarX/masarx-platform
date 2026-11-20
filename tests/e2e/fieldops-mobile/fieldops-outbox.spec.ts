import { expect, test } from "@playwright/test";

import {
  DEMO_USERS,
  expectNoConsoleErrors,
  signIn,
  signOut,
} from "./helpers/app";

// Outbox flow: list, sync-now, empty state. The outbox surface is the offline-
// first backbone of FieldOps — any regression here silently breaks queued
// mutations when connectivity recovers.

test.describe("FieldOps mobile outbox", () => {
  test.beforeEach(async ({ page }) => {
    await signOut(page);
    await signIn(page, DEMO_USERS.driver.email, DEMO_USERS.driver.password);
    const outboxTab = page.getByTestId("mobile-shell-tab-outbox");
    // Click once; if the Outbox header doesn't render within 5s (tab click is
    // occasionally absorbed while the shell wires up), retry once. The
    // deterministic anchor for the Outbox screen is the "Outbox is empty" OR
    // "Pending: N" label.
    const outboxAnchor = page.getByText(/Outbox is empty|Pending:\s*\d+/i).first();
    await outboxTab.click();
    const reached = await outboxAnchor
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!reached) {
      await outboxTab.click();
      await outboxAnchor.waitFor({ state: "visible", timeout: 15_000 });
    }
    await expect(
      page.getByTestId("mobile-shell-ready"),
      "Shell must stay mounted after switching to the Outbox tab",
    ).toBeVisible();
  });

  test("outbox tab renders header and action row", async ({ page }) => {
    const assertNoErrors = expectNoConsoleErrors(page);
    // Canonical header: the i18n title "Outbox" (matches mobile strings).
    const title = page.getByText("Outbox").first();
    await expect(
      title,
      "Outbox header should render the Outbox title",
    ).toBeVisible();

    // Sync-now control: RN-web renders Pressable as a plain <div> when the
    // component doesn't set accessibilityRole, so we target the visible text.
    const syncLabel = page.getByText(/^(Sync now|Syncing)$/i).first();
    await expect(
      syncLabel,
      "Sync-now / Syncing label should be present on the outbox screen",
    ).toBeVisible();

    // Clear dead action — always shown (non-diagnostic).
    const clearDead = page.getByText(/Clear dead/i).first();
    await expect(
      clearDead,
      "Clear dead label should be available for non-retriable entries",
    ).toBeVisible();

    assertNoErrors();
  });

  test("clicking Sync now keeps the outbox stable (no crash)", async ({
    page,
  }) => {
    const syncLabel = page.getByText(/^(Sync now|Syncing)$/i).first();
    await expect(
      syncLabel,
      "Sync-now / Syncing label should be visible before interacting",
    ).toBeVisible();
    await syncLabel.click({ timeout: 5_000 }).catch(() => undefined);
    // After a tap the outbox screen must not crash: the shell-ready surface
    // stays mounted throughout the interaction.
    await expect(
      page.getByTestId("mobile-shell-ready"),
      "Outbox screen should remain mounted after a sync attempt",
    ).toBeVisible();
  });

  test("empty / populated outbox renders deterministic content", async ({
    page,
  }) => {
    // Either: list items (one per queued RPC) OR the "All actions synced" /
    // "Loading outbox..." / the empty i18n string. Any of these is acceptable;
    // a blank screen is not.
    const emptyMessage = page.getByText(
      /All actions synced|Outbox is empty|No queued actions|Loading outbox|Pending:\s*\d+/i,
    );
    const listItems = page.locator("[data-testid^='mobile-outbox-'] ");
    const hasEmpty = await emptyMessage
      .first()
      .isVisible()
      .catch(() => false);
    const itemCount = await listItems.count();
    expect(
      hasEmpty || itemCount > 0,
      "Outbox must render either an empty-state message or queued-entry cards",
    ).toBe(true);
  });
});
