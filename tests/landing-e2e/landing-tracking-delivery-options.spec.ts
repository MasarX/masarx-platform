import { expect, test } from "@playwright/test";
import {
  LANDING_TRACKING_ENDPOINT_MOCK,
  mockTrackingEndpoint,
  patchRuntimeConfig,
  routePayload,
} from "./helpers";

const SESSION_KEY = "masarx_tracking_session_v1";

function sessionPayload() {
  return {
    ok: true,
    tracking: {
      shipment: { tracking_number: "TRK-2026-0410", status: "in_transit", service_type: "delivery" },
      timeline: [],
      actions: {},
      live_delivery: null,
    },
  };
}

function optionsPayload() {
  const hours = { timezone: "UTC", opens_at: "09:00", closes_at: "21:00" };
  return {
    ok: true,
    delivery_options: {
      changes_open: true,
      choices: ["home_delivery", "branch_pickup", "safe_place"],
      branches: [
        { id: "branch-a", name: "Branch A", address: { formatted: "1 Example St" }, opening_hours: hours, distance_km: 2.1 },
        { id: "branch-b", name: "Branch B", address: { formatted: "4 Example Rd" }, opening_hours: hours, distance_km: 3.4 },
      ],
      safe_place: { places: ["reception", "neighbour", "other"], consent_copy: null },
    },
  };
}

test.describe("landing tracking delivery options", () => {
  test("sends a branch pickup request from a verified session in EN and AR", async ({ page }) => {
    const requests: unknown[] = [];
    await patchRuntimeConfig(page, {
      trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await page.addInitScript((key) => window.sessionStorage.setItem(key, "sess-options-410"), SESSION_KEY);
    await mockTrackingEndpoint(page, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/session")) {
        await routePayload(sessionPayload())(route);
        return;
      }
      if (url.pathname.endsWith("/options")) {
        await routePayload(optionsPayload())(route);
        return;
      }
      if (url.pathname.endsWith("/request")) {
        requests.push(route.request().postDataJSON());
        await routePayload({ ok: true, outcome: "pending_review" })(route);
        return;
      }
      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });

    for (const [path, lang, legend, branchPickup, branchLabel, submit, pending] of [
      ["/track/?motion=off", "en", "How should we deliver?", /^Collect from a branch/, "Branch, nearest first", "Send request", "Sent for review"],
      ["/ar/track/?motion=off", "ar", "كيف نوصل شحنتك؟", /^الاستلام من فرع/, "الفرع، الأقرب أولاً", "أرسل الطلب", "أُرسل للمراجعة"],
    ] as const) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("lang", lang);
      const card = page.locator("[data-track-option]");
      await expect(card).toBeVisible();
      const group = card.getByRole("radiogroup", { name: legend });
      await expect(group.getByRole("radio")).toHaveCount(3);
      await group.getByRole("radio", { name: branchPickup }).check();
      const branch = card.getByRole("combobox", { name: branchLabel });
      await expect(branch).toBeVisible();
      await branch.selectOption("branch-b");
      await expect(card.locator("[data-track-option-branch-detail] strong")).toHaveText("Branch B");
      await card.getByRole("button", { name: submit }).click();
      const banner = page.locator("[data-track-request-banner]");
      await expect(banner).toBeVisible();
      await expect(banner.locator("[data-track-request-banner-badge]")).toHaveText(pending);
    }

    expect(requests).toEqual(Array(2).fill({
      session_token: "sess-options-410",
      request_type: "delivery_option",
      payload: { option: "branch_pickup", branch_id: "branch-b" },
    }));
  });
});
