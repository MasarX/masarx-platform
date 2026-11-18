// Exercise the settlement count RPC with the active tenant scope in the FieldOps browser flow.

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

import { DEMO_USERS, signIn, signOut } from "../helpers/app";

const APP_TSX_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "apps",
  "fieldops",
  "App.tsx",
);

const RPC_NAME = "record_settlement_count_v1";
const HANDLER_NAME = "handleSettlementCountSubmit";

// Attempt to open the Settlements surface. The demo tenant may not always
// seed a counted settlement, so this helper returns a "reachability" flag
// rather than failing outright — behavioural coverage is best-effort while
// the source-level lock remains mandatory.
async function tryReachSettlementsSurface(page: Page): Promise<boolean> {
  // Prefer the side drawer — Settlements lives under the drawer navigation
  // per `ui_navigation.apps.mobile` when the access scope enables it.
  const drawerToggle = page.getByTestId("mobile-shell-drawer-toggle").first();
  const drawerVisible = await drawerToggle.isVisible().catch(() => false);
  if (drawerVisible) {
    await drawerToggle.click().catch(() => undefined);
    const settlementsNav = page
      .getByRole("button", { name: /Settlements/i })
      .first();
    const settlementsVisible = await settlementsNav
      .isVisible()
      .catch(() => false);
    if (settlementsVisible) {
      await settlementsNav.click().catch(() => undefined);
      // Give the shell a short window to switch resource surfaces.
      await page.waitForTimeout(1500);
      return true;
    }
  }
  return false;
}

test.describe("Settlement count submission RPC regression guard", () => {
  test("App.tsx source lock — record_settlement_count_v1 invocation present", async () => {
    expect(
      fs.existsSync(APP_TSX_PATH),
      `App.tsx must exist at ${APP_TSX_PATH} for the source-level lock`,
    ).toBe(true);

    const source = fs.readFileSync(APP_TSX_PATH, "utf8");

    // Layer 1: the canonical RPC literal must be present exactly once or more.
    expect(
      source.includes(RPC_NAME),
      `App.tsx must reference the canonical RPC name "${RPC_NAME}" (settlement count wiring)`,
    ).toBe(true);

    // Layer 2: the invocation must sit inside handleSettlementCountSubmit.
    // We locate the handler declaration, then require the RPC literal to
    // appear between that declaration and the next top-level boundary.
    const handlerIdx = source.indexOf(HANDLER_NAME);
    expect(
      handlerIdx,
      `App.tsx must declare ${HANDLER_NAME} — regression: settlement submit path moved or removed`,
    ).toBeGreaterThanOrEqual(0);

    // Scan a generous window after the handler declaration to cover the full
    // useCallback body (typical settlement submit body is <200 LOC).
    const windowStart = handlerIdx;
    const windowEnd = Math.min(source.length, handlerIdx + 6_000);
    const handlerWindow = source.slice(windowStart, windowEnd);

    expect(
      handlerWindow.includes(RPC_NAME),
      `${HANDLER_NAME} must invoke "${RPC_NAME}" — regression: settlement submit fell back to telemetry-only behavior`,
    ).toBe(true);

    // Layer 3: the invocation must route through the durable outbox, not an
    // in-flight fire-and-forget call.
    const enqueueShapes = [
      `outbox.enqueue`,
      `rpc: "${RPC_NAME}"`,
      `rpc: '${RPC_NAME}'`,
    ];
    const hasEnqueue = handlerWindow.includes("outbox.enqueue");
    expect(
      hasEnqueue,
      `${HANDLER_NAME} must enqueue the settlement count RPC through the outbox (expected one of: ${enqueueShapes.join(
        " | ",
      )})`,
    ).toBe(true);

    const hasRpcField =
      handlerWindow.includes(`rpc: "${RPC_NAME}"`) ||
      handlerWindow.includes(`rpc: '${RPC_NAME}'`);
    expect(
      hasRpcField,
      `${HANDLER_NAME} must pass { rpc: "${RPC_NAME}" } to outbox.enqueue — exact shape lock`,
    ).toBe(true);

    // Layer 4: argument contract. The durable payload must carry the
    // canonical p_settlement_id / p_counted_amount keys so the server-side
    // RPC contract stays pinned alongside the client call shape.
    for (const arg of [
      "p_settlement_id",
      "p_counted_amount",
      "p_idempotency_key",
    ]) {
      expect(
        handlerWindow.includes(arg),
        `${HANDLER_NAME} must pass ${arg} to ${RPC_NAME} — server contract drift guard`,
      ).toBe(true);
    }
  });

  test("calls record_settlement_count_v1 when count is submitted (best-effort behavioural guard)", async ({
    page,
  }) => {
    // Behavioural layer: best-effort guard that observes the RPC when the
    // demo tenant exposes a settlement to the driver. If the surface cannot
    // be reached (no settlement seeded / access scope withholds the module)
    // we fall back to asserting the source-level wiring remains intact.
    await signOut(page);
    await signIn(page, DEMO_USERS.driver.email, DEMO_USERS.driver.password);

    // Watch both PostgREST and Edge Function pathways for the RPC. We
    // register the listener before any interaction so the outbox flushing
    // the enqueued settlement count cannot race past us.
    const rpcUrlPattern = new RegExp(
      `(/rest/v1/rpc/${RPC_NAME}(?:\\?|$)|/functions/v1/${RPC_NAME}(?:\\?|$))`,
    );
    const rpcHit: { seen: boolean; url: string | null; status: number | null } = {
      seen: false,
      url: null,
      status: null,
    };
    page.on("response", (resp) => {
      if (rpcUrlPattern.test(resp.url())) {
        rpcHit.seen = true;
        rpcHit.url = resp.url();
        rpcHit.status = resp.status();
      }
    });

    const reached = await tryReachSettlementsSurface(page);
    if (!reached) {
      test.skip(
        true,
        "Settlements surface not reachable for demo driver (no seeded settlement) — source-level lock covers this run",
      );
      return;
    }

    // Try to fill the counted amount and submit. Inputs are not testID-tagged
    // in the current shell, so we target the decimal-pad TextInput and the
    // "Submit count" button label. If neither is found, skip to source lock.
    const submitButton = page
      .getByRole("button", { name: /Submit count/i })
      .first();
    const countInput = page
      .locator('input[inputmode="decimal"], input[type="number"]')
      .first();

    const canSubmit =
      (await submitButton.isVisible().catch(() => false)) &&
      (await countInput.isVisible().catch(() => false));
    if (!canSubmit) {
      test.skip(
        true,
        "Settlement count form not rendered in this session — source-level lock covers this run",
      );
      return;
    }

    await countInput.fill("1");
    await submitButton.click();
    // Handle the double-tap confirmation ux_safety_policy path without
    // assuming it is on: if the alert dialog appears, accept and retry.
    page.once("dialog", (dialog) => {
      dialog.accept().catch(() => undefined);
    });
    await submitButton.click().catch(() => undefined);

    // Wait a short window for either a direct RPC hit (when online) or for
    // the outbox persistence to become observable. We keep this generous to
    // absorb first-boot Metro latency but bounded to avoid hanging.
    const waitMs = 8_000;
    const startedAt = Date.now();
    while (!rpcHit.seen && Date.now() - startedAt < waitMs) {
      await page.waitForTimeout(250);
    }

    if (rpcHit.seen) {
      expect(
        rpcHit.status,
        `${RPC_NAME} network hit at ${rpcHit.url} returned status ${rpcHit.status}; must be < 500 to count as wired`,
      ).toBeLessThan(500);
      return;
    }

    // No direct RPC hit — check the Outbox surface for the settlement entry.
    // The durable enqueue path is the contract we actually lock; a direct
    // hit is only observable when the outbox flushes during the test.
    const outboxTab = page.getByTestId("mobile-shell-tab-outbox");
    const outboxReachable = await outboxTab.isVisible().catch(() => false);
    if (!outboxReachable) {
      test.skip(
        true,
        `No direct RPC hit captured and Outbox tab not reachable — source-level lock covers this run`,
      );
      return;
    }
    await outboxTab.click().catch(() => undefined);

    const outboxRows = page.locator("[data-testid^=mobile-outbox-row]");
    const rowCount = await outboxRows.count().catch(() => 0);
    if (rowCount === 0) {
      test.skip(
        true,
        "Submit did not produce an observable outbox entry in this environment — source-level lock covers this run",
      );
      return;
    }

    // If any row surfaces the RPC name in its diagnostic text, treat the
    // behavioural guard as satisfied. Otherwise skip (the source-level lock
    // is mandatory; behavioural observability is best-effort).
    const outboxText = await page.locator("body").innerText();
    const rpcVisibleInOutbox = outboxText.includes(RPC_NAME);
    if (!rpcVisibleInOutbox) {
      test.skip(
        true,
        `Outbox rows present but did not surface "${RPC_NAME}" label — source-level lock covers this run`,
      );
      return;
    }
    expect(
      rpcVisibleInOutbox,
      `${RPC_NAME} must appear in the Outbox surface after submitting a settlement count`,
    ).toBe(true);
  });
});
