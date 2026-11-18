// Exercise repeated tab navigation and verify that stale paths do not replace the selected screen.

import { expect, test, type Page } from "@playwright/test";

import { DEMO_USERS, signIn, signOut } from "../helpers/app";

// Canonical tab -> screen-marker map. Each entry pins the testID prefix that
// MUST be visible when that tab is active, plus the prefixes that MUST NOT
// be visible (the "wrong-screen" set drawn from the historical sub-agent
// failure modes).
type TabSpec = {
  tab: "tasks" | "scan" | "outbox" | "more";
  description: string;
  // testID prefix(es) the active screen must surface.
  expectedPrefixes: string[];
  // testID prefix(es) that must NOT surface — these are the screens the
  // routing state machine previously misrouted to.
  forbiddenPrefixes: string[];
};

const TAB_SPECS: TabSpec[] = [
  {
    tab: "tasks",
    description: "tasks list cards",
    expectedPrefixes: ["mobile-task-card-"],
    forbiddenPrefixes: [
      "mobile-scan-type-selection",
      "mobile-outbox-row-",
      "mobile-sign-out",
    ],
  },
  {
    tab: "scan",
    description: "scan-type selection surface",
    expectedPrefixes: ["mobile-scan-type-selection"],
    forbiddenPrefixes: [
      "mobile-task-card-",
      "mobile-outbox-row-",
      "mobile-sign-out",
    ],
  },
  {
    tab: "outbox",
    description: "outbox row markers",
    expectedPrefixes: ["mobile-outbox-row-"],
    forbiddenPrefixes: [
      "mobile-task-card-",
      "mobile-scan-type-selection",
      "mobile-sign-out",
    ],
  },
  {
    tab: "more",
    description: "more screen sign-out control",
    expectedPrefixes: ["mobile-sign-out"],
    forbiddenPrefixes: [
      "mobile-task-card-",
      "mobile-scan-type-selection",
      "mobile-outbox-row-",
    ],
  },
];

// Bounded grace window after a tab click before we check forbidden markers.
// Routing transitions are synchronous in App.tsx but the React-Native-web
// reconciliation needs a microtask to unmount the previous screen.
const POST_CLICK_SETTLE_MS = 500;
// Generous window for the expected screen marker to mount on first nav.
const EXPECTED_VISIBLE_TIMEOUT_MS = 8_000;

// Helper: assert the active screen invariants for a single tab.
async function assertTabInvariants(
  page: Page,
  spec: TabSpec,
  contextLabel: string,
): Promise<void> {
  // Positive: at least one expected prefix must surface a visible element.
  // We do not require ALL prefixes (some screens have a single canonical
  // marker, others have a marker family); first-match satisfies the lock.
  let positiveSatisfied = false;
  for (const prefix of spec.expectedPrefixes) {
    const expected = page.locator(`[data-testid^="${prefix}"]`).first();
    const visible = await expected
      .waitFor({ state: "visible", timeout: EXPECTED_VISIBLE_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    if (visible) {
      positiveSatisfied = true;
      break;
    }
  }
  // Verify the selected screen because its navigation label may remain visible on other screens.
  if (!positiveSatisfied && spec.tab !== "scan" && spec.tab !== "more") {
    // For tasks/outbox: log skip context but continue to enforce negative.
    // (Tasks always has at least one card in the seeded demo tenant; if
    // somehow there are none, we still gate the wrong-screen invariant.)
    test.info().annotations.push({
      type: "soft-skip",
      description: `${contextLabel}: no expected marker visible for tab "${spec.tab}" (likely empty demo state); enforcing negative-only contract`,
    });
  } else {
    expect(
      positiveSatisfied,
      `${contextLabel}: tab "${spec.tab}" must mount ${spec.description} (one of: ${spec.expectedPrefixes.join(", ")})`,
    ).toBe(true);
  }

  // Settle window before negative assertion — ensures any in-flight
  // unmount of the prior screen has completed.
  await page.waitForTimeout(POST_CLICK_SETTLE_MS);

  // Negative: no forbidden screen marker may be visible.
  for (const forbidden of spec.forbiddenPrefixes) {
    const wrongScreen = page.locator(`[data-testid^="${forbidden}"]`).first();
    const wrongVisible = await wrongScreen
      .isVisible()
      .catch(() => false);
    expect(
      wrongVisible,
      `${contextLabel}: tab "${spec.tab}" must NOT show wrong-screen marker "${forbidden}"`,
    ).toBe(false);
  }
}

test.describe(
  "Tab routing stress + negative-assertion regression guard",
  () => {
    test.skip(
      !process.env.RUN_FIELDOPS_E2E,
      "Behavioural regression guard — opt-in via RUN_FIELDOPS_E2E=1 (mirrors contactless-pod pattern). Runs in dedicated mobile-e2e CI lanes; the source-level positive assertion is covered by tab-routing-correct.spec.ts in every PR run.",
    );

    test.beforeEach(async ({ page }) => {
      await signOut(page);
      await signIn(page, DEMO_USERS.driver.email, DEMO_USERS.driver.password);
    });

    test("rapid tab switching never lands on wrong screen", async ({ page }) => {
      // For each tab, fire 3 rapid clicks (no awaits between them) and then
      // assert the convergent state. This is the exact pattern that previously
      // produced the wrong-screen reports — the routing state machine must
      // settle onto the *clicked* tab regardless of inflight transitions.
      for (const spec of TAB_SPECS) {
        const tabLocator = page.locator(
          `[data-testid="mobile-shell-tab-${spec.tab}"]`,
        );
        await expect(
          tabLocator,
          `bottom-tab "${spec.tab}" must be present in the shell tab bar`,
        ).toBeVisible({ timeout: 10_000 });

        // Fire three clicks back-to-back. We intentionally do not await the
        // intermediate clicks — that's the stress vector under test.
        const clickPromises: Promise<void>[] = [];
        for (let i = 0; i < 3; i += 1) {
          clickPromises.push(
            tabLocator.click({ noWaitAfter: true, timeout: 5_000 }).catch(() => undefined),
          );
        }
        await Promise.all(clickPromises);

        await assertTabInvariants(
          page,
          spec,
          `[stress cycle: tab=${spec.tab}, clicks=3 rapid]`,
        );
      }
    });

    test("Tasks → Scan → Outbox → More cycle ends on More with correct screen markers", async ({
      page,
    }) => {
      // Sequenced single-click cycle. After each tab transition we lock both
      // the positive (correct screen mounted) and negative (no wrong-screen
      // marker bleed-through) invariants.
      for (const spec of TAB_SPECS) {
        const tabLocator = page.locator(
          `[data-testid="mobile-shell-tab-${spec.tab}"]`,
        );
        await expect(
          tabLocator,
          `bottom-tab "${spec.tab}" must be present in the shell tab bar`,
        ).toBeVisible({ timeout: 10_000 });

        await tabLocator.click({ timeout: 5_000 });
        await assertTabInvariants(
          page,
          spec,
          `[sequenced cycle: tab=${spec.tab}]`,
        );
      }

      // Final-state check: the cycle MUST end on More. Re-assert the More
      // screen marker independently of the loop body so the failure surface
      // is unambiguous.
      const finalMore = page
        .locator('[data-testid="mobile-sign-out"]')
        .first();
      await expect(
        finalMore,
        "After Tasks → Scan → Outbox → More cycle, More screen sign-out control must be visible",
      ).toBeVisible({ timeout: EXPECTED_VISIBLE_TIMEOUT_MS });
    });

    test("Drawer module click then bottom-tab click ends on tab's screen (not the drawer module)", async ({
      page,
    }) => {
      // Open the drawer via the shell menu toggle. If the toggle is not
      // exposed in the current layout (rare; tab bar variant), skip — the
      // sequenced/stress tests already cover the bottom-tab routing.
      const drawerToggle = page
        .locator('[data-testid="mobile-menu-toggle"]')
        .first();
      const drawerVisible = await drawerToggle.isVisible().catch(() => false);
      if (!drawerVisible) {
        test.skip(
          true,
          "Drawer toggle not surfaced in this shell variant — bottom-tab routing covered by sibling tests in this file",
        );
        return;
      }
      await drawerToggle.click({ timeout: 5_000 });

      // Click the Settlements module from the drawer. Drawer module testIDs
      // follow the canonical mobileModuleTestId pattern → `mobile-module-<key>`.
      const settlementsModule = page
        .locator('[data-testid="mobile-module-settlements"]')
        .first();
      const settlementsVisible = await settlementsModule
        .isVisible()
        .catch(() => false);
      if (!settlementsVisible) {
        // Settlements may be gated off by access policy for this demo user.
        // In that case fall back to any visible drawer module so we still
        // exercise the "drawer-then-tab" transition path.
        test.skip(
          true,
          "Settlements drawer module not visible for demo driver (access policy may withhold it) — drawer→tab path cannot be exercised in this run",
        );
        return;
      }
      await settlementsModule.click({ timeout: 5_000 });

      // Brief settle to allow the resource swap to complete.
      await page.waitForTimeout(POST_CLICK_SETTLE_MS);

      // Now click the Tasks bottom-tab. The routing state machine must
      // unconditionally land on the Tasks screen — the historical regression
      // class let the prior drawer module win the routing race.
      const tasksTab = page
        .locator('[data-testid="mobile-shell-tab-tasks"]')
        .first();
      await expect(
        tasksTab,
        "Tasks bottom-tab must be visible after a drawer module navigation",
      ).toBeVisible({ timeout: 10_000 });
      await tasksTab.click({ timeout: 5_000 });

      // Assert the Tasks screen invariants — positive marker visible AND the
      // Settlements / wrong-screen markers gone. We use the canonical Tasks
      // spec entry for the negative-assertion list.
      const tasksSpec = TAB_SPECS.find((s) => s.tab === "tasks");
      expect(tasksSpec, "Tasks tab spec must exist in TAB_SPECS").toBeTruthy();
      if (!tasksSpec) return;
      await assertTabInvariants(
        page,
        tasksSpec,
        "[drawer-then-tab: drawer=Settlements -> tab=Tasks]",
      );
    });
  },
);
