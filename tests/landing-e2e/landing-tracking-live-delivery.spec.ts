import { expect, test } from "@playwright/test";
import {
  LANDING_TRACKING_ENDPOINT_MOCK,
  mockTrackingEndpoint,
  patchRuntimeConfig,
  routePayload,
} from "./helpers";

const SESSION_KEY = "masarx_tracking_session_v1";

function sessionPayload() {
  const now = Date.now();
  return {
    ok: true,
    tracking: {
      shipment: {
        tracking_number: "TRK-2026-0406",
        status: "out_for_delivery",
        service_type: "delivery",
        promised_window_start_at: new Date(now - 3_600_000).toISOString(),
        promised_window_end_at: new Date(now + 3_600_000).toISOString(),
      },
      timeline: [],
      actions: {},
      live_delivery: {
        status: "live",
        eta_window_start_at: new Date(now + 1_200_000).toISOString(),
        eta_window_end_at: new Date(now + 3_000_000).toISOString(),
        stops_ahead: 2,
        updated_at: new Date(now - 120_000).toISOString(),
        area: { south: 24.7, west: 46.67, north: 24.705, east: 46.675 },
      },
    },
  };
}

test.describe("landing tracking live delivery", () => {
  test("shows the approximate courier area from a verified session in EN and AR", async ({ page }) => {
    const sessionBodies: unknown[] = [];
    await patchRuntimeConfig(page, {
      trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await page.addInitScript((key) => window.sessionStorage.setItem(key, "sess-live-406"), SESSION_KEY);
    await mockTrackingEndpoint(page, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/session")) {
        sessionBodies.push(route.request().postDataJSON());
        await routePayload(sessionPayload())(route);
        return;
      }
      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });

    for (const [path, lang, live] of [
      ["/track/?motion=off", "en", "Live"],
      ["/ar/track/?motion=off", "ar", "مباشر"],
    ] as const) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("lang", lang);
      const card = page.locator("[data-track-courier]");
      await expect(card).toBeVisible();
      await expect(card.locator("[data-track-courier-eta] bdi")).not.toBeEmpty();
      await expect(card.locator("[data-track-courier-map-frame] path.track-courier-area")).toBeVisible();
      await expect(card.locator('[role="status"]')).toHaveText(live);
      await expect(card.locator("[data-track-courier-privacy]")).toBeVisible();
      await expect(card.locator("[data-track-courier-notice]")).toBeHidden();
    }

    expect(sessionBodies).toEqual([{ session_token: "sess-live-406" }, { session_token: "sess-live-406" }]);
  });
});
