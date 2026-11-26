import { expect, test } from "@playwright/test";
import { captureRouteEvidence } from "./utils/evidence";
import {
  CONSOLE_AUTH_GATE,
  CONSOLE_SIGNED_IN_SHELL,
  strictConsoleSignIn,
} from "./utils/strict-console-sign-in";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("finance viewer can open the Console Dashboard", async ({ context }) => {
  const role = "finance_viewer";
  const route = "/";
  const page = await strictConsoleSignIn(context, role, route);
  const failure = "ROUTE_ASSERTION_FAILED/dashboard";
  const ready = page.getByTestId("console-dashboard-ready");
  const blockingState = page
    .getByTestId(/^(console-(context-unavailable|dashboard-error)|route-error-page)$/)
    .or(page.locator('[role="status"][aria-busy="true"]'))
    .filter({ visible: true });

  try {
    await expect(page.getByTestId(CONSOLE_SIGNED_IN_SHELL), failure).toBeVisible();
    await expect(page.getByTestId(CONSOLE_AUTH_GATE), failure).toHaveCount(0);
    await expect(ready, failure).toBeVisible();
    await expect(blockingState, failure).toHaveCount(0);
  } catch {
    throw new Error(failure);
  }
  await captureRouteEvidence(page, ready, { role, route });
});
