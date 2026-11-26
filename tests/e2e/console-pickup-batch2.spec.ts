import { expect, test } from "@playwright/test";
import { captureRouteEvidence } from "./utils/evidence";
import {
  CONSOLE_AUTH_GATE,
  CONSOLE_SIGNED_IN_SHELL,
  strictConsoleSignIn,
} from "./utils/strict-console-sign-in";

test.use({ trace: "off", screenshot: "off", video: "off" });

const dispatch = {
  key: "dispatch",
  route: "/operations/routes",
  prefix: "console-route-operations",
};

const pickups = [
  { key: "pickup-waves", route: "/operations/pickups/waves", prefix: "console-pickup-waves" },
  { key: "pickup-requests", route: "/operations/pickups/requests", prefix: "console-pickup-requests" },
];

test("dispatcher can open the route workspace and review pickup ledgers", async ({ context }) => {
  const role = "dispatcher";
  const page = await strictConsoleSignIn(context, role, dispatch.route);
  const origin = new URL(page.url()).origin;

  for (const { key, route, prefix } of [dispatch, ...pickups]) {
    const pickup = key !== dispatch.key;
    const failure = "ROUTE_ASSERTION_FAILED/" + key;
    const ready = page.getByTestId(prefix + "-ready");
    const assertedLocator = pickup ? ready.getByRole("heading", { level: 1 }) : ready;
    const blockingState = page
      .getByTestId(/^(console-context-unavailable|route-error-page)$/)
      .or(page.getByTestId(prefix + "-error"))
      .or(page.locator('[role="status"][aria-busy="true"]'))
      .filter({ visible: true });

    try {
      if (pickup) await page.goto(new URL(route, origin).href, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId(CONSOLE_SIGNED_IN_SHELL), failure).toBeVisible();
      await expect(page.getByTestId(CONSOLE_AUTH_GATE), failure).toHaveCount(0);
      await expect(ready, failure).toBeVisible();
      await expect(blockingState, failure).toHaveCount(0);
      if (pickup) {
        await expect(ready.getByTestId(prefix + "-lookup-error"), failure).toBeHidden();
        await expect(ready.getByTestId(prefix + "-blocked"), failure).toBeVisible();
        await expect(ready.getByTestId(prefix + "-create-submit"), failure).toHaveCount(0);
        await expect(ready.getByRole("article").first(), failure).toBeVisible();
        await expect(assertedLocator, failure).toBeVisible();
      }
    } catch {
      throw new Error(failure);
    }

    await captureRouteEvidence(page, assertedLocator, {
      role,
      route,
      ...(pickup ? { ledgerState: "rows" as const } : {}),
    });
  }
});
