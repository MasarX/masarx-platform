import { expect, test, type Page } from "@playwright/test";
import { LANDING_TRACKING_ENDPOINT_MOCK, mockTrackingEndpoint, patchRuntimeConfig, routePayload } from "./helpers";

// The expanded tracking map is a modal dialog (#495, WCAG 2.4.3): Tab and Shift+Tab stay
// inside it, and Escape closes it from any control and returns focus to the trigger.
const trackingPayload = {
  ok: true,
  session_token: "sess-map-dialog",
  tracking: {
    shipment: {
      tracking_number: "TRK-2026-0495",
      status: "in_transit",
      service_type: "delivery",
      created_at: "2026-03-06T08:00:00.000Z",
      promised_delivery_date: "2026-03-07",
    },
    recipient: { name: "R******", phone: "******123" },
    address: { city: "Riyadh", district: "Al Olaya", short_national_address: "******1234" },
    timeline: [],
    actions: {
      reschedule: { enabled: false, available_dates: [] },
      location_change: { enabled: true, requires_map_pin: true, requires_short_national_address: true },
    },
  },
};

async function openResults(page: Page) {
  await patchRuntimeConfig(page, { trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK, turnstileSiteKey: "" });
  await mockTrackingEndpoint(page, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/lookup")) {
      await routePayload({ ok: true, step: "verify", verification: { phone_digits: 3 } })(route);
      return;
    }
    if (url.pathname.endsWith("/verify")) {
      await routePayload(trackingPayload)(route);
      return;
    }
    await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
  });
  await page.goto("/track/?motion=off");
  await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0495");
  await page.locator('[data-track-lookup-form] button[type="submit"]').click();
  await page.locator('[data-track-verify-form] input[name="phone_last3"]').fill("123");
  await page.locator('[data-track-verify-form] button[type="submit"]').click();
  await expect(page.locator('[data-track-stage="results"]')).toBeVisible();
}

async function openDialogWithKeyboard(page: Page) {
  await page.locator("[data-track-map-expand]").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-track-map-overlay]")).toBeVisible();
  await expect(page.locator("[data-track-map-picker-expanded]")).toBeFocused();
}

function focusInsideDialog(page: Page) {
  return page.evaluate(() => {
    const overlay = document.querySelector("[data-track-map-overlay]");
    return Boolean(overlay && document.activeElement && overlay.contains(document.activeElement));
  });
}

test.describe("tracking map dialog keyboard", () => {
  test("Tab and Shift+Tab keep focus inside the open dialog", async ({ page }) => {
    await openResults(page);
    await openDialogWithKeyboard(page);

    const tabStops = await page
      .locator("[data-track-map-overlay]")
      .evaluate((el) => el.querySelectorAll("a[href], button, [tabindex]").length);
    for (const key of ["Tab", "Shift+Tab"]) {
      for (let i = 0; i < tabStops + 3; i += 1) {
        await page.keyboard.press(key);
        expect(await focusInsideDialog(page), `${key} press ${i + 1} left the dialog`).toBe(true);
      }
    }
  });

  for (const control of ["[data-track-map-close]", "[data-track-map-center]", "[data-track-map-picker-expanded]"]) {
    test(`Escape from ${control} closes the dialog and returns focus to the trigger`, async ({ page }) => {
      await openResults(page);
      await openDialogWithKeyboard(page);
      await page.locator(`[data-track-map-overlay] ${control}`).focus();
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-track-map-overlay]")).toBeHidden();
      await expect(page.locator("[data-track-map-expand]")).toBeFocused();
    });
  }
});
