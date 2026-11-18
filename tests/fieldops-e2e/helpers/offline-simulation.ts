import { expect, type Page, type Route } from "@playwright/test";

const OFFLINE_ROUTE_PATTERN = "**/*";
const offlineRouteHandlers = new WeakMap<
  Page,
  (route: Route) => Promise<void>
>();

async function setContextOffline(page: Page, offline: boolean) {
  await page.context().setOffline(offline);
}

async function dispatchConnectivityEvent(
  page: Page,
  eventName: "offline" | "online",
) {
  await page
    .evaluate((name) => {
      window.dispatchEvent(new Event(name));
    }, eventName)
    .catch(() => undefined);
}

async function waitForNavigatorOnlineState(
  page: Page,
  expected: boolean,
) {
  await expect
    .poll(
      () =>
        page
          .evaluate(() => navigator.onLine)
          .catch(() => !expected),
      {
        timeout: 10_000,
        message: `Expected navigator.onLine to become ${expected}`,
      },
    )
    .toBe(expected);
}

async function waitForFieldOpsConnectivityState(
  page: Page,
  expected: "offline" | "online",
) {
  if (expected === "offline") {
    await expect(page.getByText(/^Offline mode$/i).first()).toBeVisible({
      timeout: 10_000,
    });
    return;
  }

  await expect
    .poll(
      () =>
        page
          .evaluate(() => document.body?.textContent?.includes("Offline mode") ?? false)
          .catch(() => true),
      {
        timeout: 10_000,
        message: "Expected the FieldOps shell to leave offline mode",
      },
    )
    .toBe(false);
}

export async function goOffline(page: Page): Promise<void> {
  if (!offlineRouteHandlers.has(page)) {
    const handler = async (route: Route) => {
      await route.abort("internetdisconnected").catch(async () => {
        await route.abort();
      });
    };
    offlineRouteHandlers.set(page, handler);
    await page.context().route(OFFLINE_ROUTE_PATTERN, handler);
  }

  await setContextOffline(page, true);
  await dispatchConnectivityEvent(page, "offline");
  await waitForNavigatorOnlineState(page, false);
  await waitForFieldOpsConnectivityState(page, "offline");
}

export async function goOnline(page: Page): Promise<void> {
  const handler = offlineRouteHandlers.get(page);
  if (handler) {
    await page.context().unroute(OFFLINE_ROUTE_PATTERN, handler);
    offlineRouteHandlers.delete(page);
  }

  await setContextOffline(page, false);
  await dispatchConnectivityEvent(page, "online");
  await waitForNavigatorOnlineState(page, true);
  await waitForFieldOpsConnectivityState(page, "online");
}

export async function readOutboxCount(page: Page): Promise<number> {
  const text = String(
    (await page
      .getByText(/^Outbox:\s*\d+$/i)
      .first()
      .textContent()) ?? "",
  );
  const match = text.match(/Outbox:\s*(\d+)/i);
  if (!match) {
    throw new Error(
      `[fieldops-offline] Unable to parse outbox count from "${text}"`,
    );
  }
  return Number(match[1]);
}

export async function waitForOutboxDrain(
  page: Page,
  options?: { timeoutMs?: number },
): Promise<void> {
  await expect
    .poll(() => readOutboxCount(page), {
      timeout: options?.timeoutMs ?? 15_000,
      message: "Expected the FieldOps outbox to drain",
    })
    .toBe(0);
}
