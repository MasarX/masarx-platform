import { expect, test, type Locator } from "@playwright/test";

import {
  DEMO_USERS,
  expectMinTapTarget,
  signIn,
  signOut,
} from "./helpers/app";

// Accessibility spot checks. We target the WCAG 2.1 AA tap-target guideline
// (44x44 CSS px) and the accessible-name contract across primary CTAs.

test.describe("FieldOps mobile accessibility", () => {
  test.beforeEach(async ({ page }) => {
    await signOut(page);
    await signIn(page, DEMO_USERS.driver.email, DEMO_USERS.driver.password);
  });

  test("every primary bottom tab meets the 44x44 tap-target guideline", async ({
    page,
  }) => {
    const tabKeys = ["home", "tasks", "route", "scan", "outbox", "more"] as const;
    for (const key of tabKeys) {
      const tab = page.getByTestId(`mobile-shell-tab-${key}`);
      await expect(
        tab,
        `Tab "${key}" must be mounted before measuring tap target`,
      ).toBeVisible();
      await expectMinTapTarget(tab, 44, `bottom tab "${key}"`);
    }
  });

  test("header menu toggle meets the 44x44 tap-target guideline", async ({
    page,
  }) => {
    // Previously fixmed because the hamburger rendered at 36x36 on web
    // (violated WCAG 2.5.5). Raised to 44x44 on 2026-04-23 alongside the
    // drawerClose and role-avatar controls.
    const menuToggle = page.getByTestId("mobile-menu-toggle");
    await expect(
      menuToggle,
      "Hamburger menu toggle should render in the header",
    ).toBeVisible();
    await expectMinTapTarget(menuToggle, 44, "header hamburger toggle");
  });

  test("every tab surfaces an accessible name", async ({ page }) => {
    const tabs = page.getByRole("tab");
    const count = await tabs.count();
    expect(count, "Bottom tab bar should expose at least 6 role=tab nodes").toBeGreaterThanOrEqual(6);
    for (let index = 0; index < count; index += 1) {
      const tab = tabs.nth(index);
      const name = await tab.getAttribute("aria-label");
      const text = (await tab.textContent())?.trim() || "";
      expect(
        (name && name.trim().length > 0) || text.length > 0,
        `Tab #${index} must expose either an aria-label or visible text`,
      ).toBe(true);
    }
  });

  test("role avatar carries a descriptive accessibility label", async ({
    page,
  }) => {
    // The role avatar must advertise the role label plus the sign-out gesture.
    const avatar: Locator = page.getByLabel(/Role .+\.\s+Long press to sign out\./i).first();
    await expect(
      avatar,
      "Role avatar must expose a descriptive aria-label for screen readers",
    ).toBeVisible();
  });
});
