import { expect, test, type Page } from "@playwright/test";
import { LANDING_TRACKING_ENDPOINT_MOCK, mockTrackingEndpoint, patchRuntimeConfig, routePayload } from "./helpers";

// The inline map's zoom controls stay visible when focused in both directions (#546, WCAG 2.4.11).
// Leaflet corners are physical while the map toggle sits at inline-end, so RTL must not stack them.
const trackingPayload = {
  ok: true,
  session_token: "sess-map-rtl",
  tracking: {
    shipment: {
      tracking_number: "TRK-2026-0546",
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

async function openResults(page: Page, path: string) {
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
  await page.goto(`${path}?motion=off`);
  await page.locator('[data-track-lookup-form] input[name="reference"]').filter({ visible: true }).fill("TRK-2026-0546");
  await page.locator('[data-track-lookup-form] button[type="submit"]').click();
  await page.locator('[data-track-verify-form] input[name="phone_last3"]').fill("123");
  await page.locator('[data-track-verify-form] button[type="submit"]').click();
  await expect(page.locator('[data-track-stage="results"]')).toBeVisible();
}

// Visible when the focused element is the top hit at one of five sample points of its on-screen box.
// The result also names the focused element, its box and each hit, so a failure shows what covers it.
function focusedVisibility(page: Page) {
  return page.evaluate(() => {
    const name = (n: Element | null) => (n ? `${n.tagName.toLowerCase()}.${[...n.classList].join(".")}` : "none");
    const el = document.activeElement as HTMLElement;
    const r = el.getBoundingClientRect();
    const left = Math.max(r.left, 0);
    const top = Math.max(r.top, 0);
    const width = Math.min(r.right, innerWidth) - left;
    const height = Math.min(r.bottom, innerHeight) - top;
    const hits = width > 0 && height > 0
      ? [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]
        .map(([fx, fy]) => document.elementFromPoint(left + width * fx, top + height * fy))
      : [];
    return {
      visible: hits.some((hit) => !!hit && (hit === el || el.contains(hit))),
      focused: name(el),
      box: [r.left, r.top, r.width, r.height].map(Math.round),
      viewport: [innerWidth, innerHeight],
      scroll: [scrollX, scrollY].map(Math.round),
      hits: hits.map(name),
    };
  });
}

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];

for (const path of ["/track/", "/ar/track/"]) {
  for (const viewport of VIEWPORTS) {
    test(`inline map zoom controls are not covered on focus: ${path} @${viewport.width}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openResults(page, path);
      const picker = page.locator("[data-track-map-picker]");
      for (const control of [".leaflet-control-zoom-in", ".leaflet-control-zoom-out"]) {
        // Focus without preventScroll, as keyboard focus does; the root scroller scrolls smoothly, so wait until
        // the control is fully on screen before the hit test checks that nothing (map toggle, header) covers it.
        await picker.locator(control).focus();
        await expect(picker.locator(control), `${control} is not scrolled into view on focus`).toBeInViewport({ ratio: 1 });
        const result = await focusedVisibility(page);
        expect(result.visible, `${control} is hidden when focused: ${JSON.stringify(result)}`).toBe(true);
      }
    });
  }
}
