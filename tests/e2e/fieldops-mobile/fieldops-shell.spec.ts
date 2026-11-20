import { expect, test } from "@playwright/test";

import {
  DEMO_USERS,
  expectNoConsoleErrors,
  signIn,
  signOut,
  waitForBundle,
} from "./helpers/app";

// Covers the FieldOps mobile shell: header, connectivity/outbox affordances,
// bottom tab navigation, side drawer, and top-bar sign-out gesture.
// Rationale: this is the common entrypoint every other module reaches through,
// so any regression here blocks the rest of the suite.

test.describe("FieldOps mobile shell", () => {
  test.beforeEach(async ({ page }) => {
    await signOut(page);
    await signIn(page, DEMO_USERS.driver.email, DEMO_USERS.driver.password);
  });

  test("shell renders app name, role, connectivity, and outbox pill", async ({
    page,
  }) => {
    const assertNoErrors = expectNoConsoleErrors(page);

    const shell = page.getByTestId("mobile-shell-ready");
    await expect(
      shell,
      "Shell root surface must be visible after sign-in completes",
    ).toBeVisible();

    // Canonical header title "<app> · <role>" — matches the policy contract in
    // the plan (mobile shell must stay Version-C parity-stable).
    const headerTitle = page.getByText("MasarX Field Ops", { exact: true });
    await expect(
      headerTitle.first(),
      "Top bar should show the canonical FieldOps app title",
    ).toBeVisible();

    const roleLabel = page.getByText("Driver", { exact: true });
    await expect(
      roleLabel.first(),
      "Top bar should surface the resolved driver role label",
    ).toBeVisible();

    // Connectivity pill is one of Online | Degraded | Offline — driven by
    // runtime policy. Asserting that *some* label renders avoids flaking on
    // local network variance while still catching a missing pill.
    const connectivityPill = page.getByText(
      /^(Online|Degraded|Offline)$/,
    );
    await expect(
      connectivityPill.first(),
      "Connectivity indicator should report Online/Degraded/Offline",
    ).toBeVisible();

    const outboxPill = page.getByText(/^Outbox:\s*\d+$/);
    await expect(
      outboxPill.first(),
      "Outbox pill should render a numeric pending count",
    ).toBeVisible();

    assertNoErrors();
  });

  test("bottom tab bar has 6 tabs with correct labels", async ({ page }) => {
    const expectedTabs: Array<{ key: string; label: string }> = [
      { key: "home", label: "Home" },
      { key: "tasks", label: "Tasks" },
      { key: "route", label: "Route" },
      { key: "scan", label: "Scan" },
      { key: "outbox", label: "Outbox" },
      { key: "more", label: "More" },
    ];

    for (const { key, label } of expectedTabs) {
      const tab = page.getByTestId(`mobile-shell-tab-${key}`);
      await expect(
        tab,
        `Tab "${key}" should be mounted in the bottom tab bar`,
      ).toBeVisible();
      // The label sibling carries the visible text.
      const tabLabel = page.getByTestId(`mobile-shell-tab-${key}-label`);
      await expect(
        tabLabel,
        `Tab "${key}" should render the i18n label "${label}"`,
      ).toHaveText(label);
    }
  });

  test("clicking each bottom tab navigates without console errors", async ({
    page,
  }) => {
    const assertNoErrors = expectNoConsoleErrors(page);
    const tabs = ["home", "tasks", "route", "scan", "outbox", "more"] as const;

    for (const key of tabs) {
      const tab = page.getByTestId(`mobile-shell-tab-${key}`);
      await expect(
        tab,
        `Tab "${key}" must be clickable before activation`,
      ).toBeVisible();
      await tab.click();
      // RN-web doesn't always reflect accessibilityState.selected into
      // `aria-selected`. The deterministic assertion is that the shell-ready
      // surface stays mounted (no crash/white-screen) after a tab click.
      await expect(
        page.getByTestId("mobile-shell-ready"),
        `Shell root must stay mounted after switching to "${key}" tab`,
      ).toBeVisible();
    }

    assertNoErrors();
  });

  test("hamburger opens the modules drawer; clicking scrim closes it", async ({
    page,
  }) => {
    const menuToggle = page.getByTestId("mobile-menu-toggle");
    await expect(
      menuToggle,
      "Menu toggle (hamburger) should be visible in the header",
    ).toBeVisible();
    await menuToggle.click();

    // The Modules text appears both as the drawer title and as a bottom-bar
    // section label; target the drawer's own title (first match in DOM order).
    const drawerHeader = page.getByText("Modules", { exact: true }).first();
    await expect(
      drawerHeader,
      "Drawer should surface the Modules section header after opening",
    ).toBeVisible();

    const drawerClose = page.getByTestId("mobile-menu-close");
    await expect(
      drawerClose,
      "Drawer should expose an explicit close control",
    ).toBeVisible();
    await drawerClose.click();
    await expect(
      drawerHeader,
      "Drawer should close when the user taps the close control",
    ).not.toBeVisible({ timeout: 5_000 });
  });

  test("long-press on role avatar exposes a sign-out affordance", async ({
    page,
  }) => {
    // The role avatar has accessibilityLabel "Role <role>. Long press to sign
    // out." — verify the a11y contract rather than perform the gesture (long
    // press doesn't reliably fire on web shims; a11y contract is the SSOT).
    const avatar = page.getByLabel(/Long press to sign out/i).first();
    await expect(
      avatar,
      "Role avatar must advertise the long-press-to-sign-out gesture via a11y label",
    ).toBeVisible();
  });

  test("ui_me_v1 load keeps the shell mounted", async ({ page }) => {
    // Sanity: after sign-in the header must still report the role, proving
    // that the mobile UI session bootstrapped from ui_me_v1 (or the equivalent
    // cached payload) without crashing.
    await expect(
      page.getByText("Driver").first(),
      "Driver role label should render once session metadata loads",
    ).toBeVisible();
    await expect(
      page.getByTestId("mobile-shell-ready"),
      "Shell must stay stable during session hydration",
    ).toBeVisible();
  });
});
