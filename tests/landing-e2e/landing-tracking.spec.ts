import { expect, test } from "@playwright/test";
import {
  LANDING_TRACKING_ENDPOINT_MOCK,
  mockTrackingEndpoint,
  patchRuntimeConfig,
  routePayload,
} from "./helpers";

const trackingPayload = {
  ok: true,
  tracking: {
    shipment: {
      tracking_number: "TRK-2026-0001",
      client_reference_number: "ORD-10088",
      carrier_reference_number: "CR-77421",
      status: "in_transit",
      service_type: "delivery",
      created_at: "2026-03-06T08:00:00.000Z",
      promised_delivery_date: "2026-03-07",
      promised_window_start_at: "2026-03-07T08:00:00.000Z",
      promised_window_end_at: "2026-03-07T17:00:00.000Z",
    },
    recipient: {
      name: "J******",
      phone: "******123",
      email: "j***@e******.com",
    },
    address: {
      city: "Riyadh",
      district: "Al Olaya",
      short_national_address: "******1234",
    },
    timeline: [
      {
        action_type: "status_change",
        action_category: "operational",
        status: "in_transit",
        timestamp: "2026-03-06T09:15:00.000Z",
        summary: "in_transit",
      },
      {
        action_type: "promise_assigned",
        action_category: "operational",
        status: "scheduled",
        timestamp: "2026-03-06T08:45:00.000Z",
        summary: "scheduled",
      },
    ],
    actions: {
      reschedule: {
        enabled: true,
        available_dates: ["2026-03-08", "2026-03-09"],
      },
      location_change: {
        enabled: true,
        requires_map_pin: true,
        requires_short_national_address: true,
      },
    },
  },
};

const secondTrackingPayload = {
  ok: true,
  tracking: {
    shipment: {
      tracking_number: "TRK-2026-0002",
      client_reference_number: "ORD-20021",
      carrier_reference_number: "CR-99114",
      status: "pending",
      service_type: "delivery",
      created_at: "2026-03-07T10:00:00.000Z",
      promised_delivery_date: "2026-03-10",
      promised_window_start_at: "2026-03-10T08:00:00.000Z",
      promised_window_end_at: "2026-03-10T17:00:00.000Z",
    },
    recipient: {
      name: "S******",
      phone: "******456",
      email: "s***@e******.com",
    },
    address: {
      city: "Jeddah",
      district: "Al Zahra",
      short_national_address: "******4321",
    },
    timeline: [
      {
        action_type: "status_change",
        action_category: "operational",
        status: "pending",
        timestamp: "2026-03-07T11:15:00.000Z",
        summary: "pending",
      },
    ],
    actions: {
      reschedule: {
        enabled: true,
        available_dates: ["2026-03-11"],
      },
      location_change: {
        enabled: true,
        requires_map_pin: true,
        requires_short_national_address: true,
      },
    },
  },
};

test.describe("landing tracking", () => {
  test("home page exposes track shipment links in header and footer", async ({ page }) => {
    await page.goto("/?motion=off");

    await expect(page.getByRole("link", { name: "Track shipment" }).first()).toHaveAttribute("href", "/track/");
    await expect(page.getByRole("link", { name: "Track shipment" }).last()).toHaveAttribute("href", "/track/");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?motion=off");

    await expect(page.locator(".header-actions").getByRole("link", { name: "Track shipment" })).toBeVisible();
    await expect(page.locator(".header-actions").getByRole("link", { name: "Track shipment" })).toHaveAttribute("href", "/track/");
  });

  test("renders /track and switches language to /ar/track", async ({ page }) => {
    await page.goto("/track/?motion=off");

    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveClass(/js/);
    await expect(page.locator('#nav-primary').getByRole("link", { name: "Track shipment" })).toHaveAttribute("aria-current", "true");

    await page.locator("[data-lang-toggle]").click();

    await expect(page).toHaveURL(/\/ar\/track\/(\?.*)?$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  });

  test("keeps request navigation visible before lookup and switches to request forms after verification", async ({ page }) => {
    let requestCalls = 0;
    await patchRuntimeConfig(page, {
      trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTrackingEndpoint(page, async (route) => {
      const body = route.request().postDataJSON();
      const url = new URL(route.request().url());

      if (url.pathname.endsWith("/lookup")) {
        await routePayload({ ok: true, step: "verify", verification: { phone_digits: 3 } })(route);
        return;
      }

      if (url.pathname.endsWith("/verify")) {
        expect(body.reference).toBe("TRK-2026-0001");
        expect(body.phone_last3).toBe("123");
        await routePayload({ ...trackingPayload, session_token: "sess-demo-nav" })(route);
        return;
      }

      if (url.pathname.endsWith("/request")) {
        requestCalls += 1;
        await routePayload({ ok: false, error: { code: "invalid_request" } }, 400)(route);
        return;
      }

      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });

    await page.goto("/track/?motion=off");

    const requestNav = page.locator("#nav-primary").getByRole("link", { name: "Lookup requests" });
    await expect(requestNav).toHaveAttribute("href", "#lookup");
    await requestNav.click();
    await expect(page).toHaveURL(/#lookup$/);
    await expect(page.locator('[data-track-stage="lookup"]')).toBeVisible();
    await expect(page.locator("#actions")).toBeHidden();
    expect(requestCalls).toBe(0);

    await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0001");
    await page.locator('[data-track-lookup-form] button[type="submit"]').click();
    await page.locator('[data-track-verify-form] input[name="phone_last3"]').fill("123");
    await page.locator('[data-track-verify-form] button[type="submit"]').click();

    await expect(page.locator('[data-track-stage="results"]')).toBeVisible();
    const verifiedRequestNav = page.locator("#nav-primary").getByRole("link", { name: "Requests" });
    await expect(verifiedRequestNav).toHaveAttribute("href", "#actions");
    await verifiedRequestNav.click();
    await expect(page).toHaveURL(/#actions$/);
    await expect(page.locator("#actions")).toBeVisible();
    await expect(page.locator("#actions").getByRole("heading", { name: "Request help from operations" })).toBeVisible();
    expect(requestCalls).toBe(0);
  });

  test("lookup, verify, rehydrate, and submit requests against mocked tracking endpoint", async ({ page }) => {
    let requestCalls = 0;
    await patchRuntimeConfig(page, {
      trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTrackingEndpoint(page, async (route) => {
      const body = route.request().postDataJSON();
      const url = new URL(route.request().url());

      if (url.pathname.endsWith("/lookup")) {
        await routePayload({ ok: true, step: "verify", verification: { phone_digits: 3 } })(route);
        return;
      }

      if (url.pathname.endsWith("/verify")) {
        expect(body.reference).toBe("TRK-2026-0001");
        expect(body.phone_last3).toBe("123");
        await routePayload({ ...trackingPayload, session_token: "sess-demo-123" })(route);
        return;
      }

      if (url.pathname.endsWith("/session")) {
        expect(body.session_token).toBe("sess-demo-123");
        await routePayload(trackingPayload)(route);
        return;
      }

      if (url.pathname.endsWith("/request")) {
        requestCalls += 1;
        expect(body.session_token).toBe("sess-demo-123");
        if (body.request_type === "location_change") {
          expect(body.payload?.map_pin?.lat).toEqual(expect.any(Number));
          expect(body.payload?.map_pin?.lng).toEqual(expect.any(Number));
          expect(body.payload?.landmark).toBe("Near the red tower");
          expect(body.payload?.drop_point).toBe("Reception, gate, loading bay");
          await routePayload({
            ok: true,
            submitted: true,
            outcome: "pending_review",
            support_case_id: "11111111-1111-1111-1111-111111111111",
            tracking: trackingPayload.tracking,
          })(route);
          return;
        }
        await routePayload({
          ok: true,
          submitted: true,
          outcome: "applied",
          support_case_id: "11111111-1111-1111-1111-111111111111",
          tracking: {
            ...trackingPayload.tracking,
            shipment: {
              ...trackingPayload.tracking.shipment,
              promised_delivery_date: "2026-03-08",
              promised_window_start_at: "2026-03-08T08:00:00.000Z",
              promised_window_end_at: "2026-03-08T17:00:00.000Z",
            },
            actions: {
              ...trackingPayload.tracking.actions,
              reschedule: {
                ...trackingPayload.tracking.actions.reschedule,
                available_dates: ["2026-03-09"],
              },
            },
          },
        })(route);
        return;
      }

      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });

    await page.goto("/track/?motion=off");

    await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0001");
    await page.locator('[data-track-lookup-form] button[type="submit"]').click();

    await expect(page.locator('[data-track-stage="verify"]')).toBeVisible();

    await page.locator('[data-track-verify-form] input[name="phone_last3"]').fill("123");
    await page.locator('[data-track-verify-form] button[type="submit"]').click();

    await expect(page.locator('[data-track-stage="results"]')).toBeVisible();
    await expect(page.locator('[data-track-shipment-reference]')).toContainText("ORD-10088");
    await expect(page.locator('[data-track-recipient-phone]')).toContainText("123");
    await expect(page.locator('[data-track-shipment-status]')).toContainText("In transit");
    await expect(page.locator('[data-track-timeline]')).toContainText("In transit");

    await page.reload();
    await expect(page.locator('[data-track-stage="results"]')).toBeVisible();
    await expect(page.locator('[data-track-shipment-tracking]')).toContainText("TRK-2026-0001");

    await page.locator('[data-track-date-select]').selectOption("2026-03-08");
    await page.locator('[data-track-reschedule-form] button[type="submit"]').click();
    await expect(page.locator('[data-track-reschedule-status]')).toContainText("Change applied");
    await expect(page.locator('[data-track-request-banner-badge]')).toContainText("Applied");
    await expect(page.locator('[data-track-request-banner-text]')).toContainText("updated right away");
    await expect(page.locator('[data-track-shipment-promise]')).toContainText("2026");

    await expect(page.locator('[data-track-map-clear]').first()).toBeDisabled();
    await page.locator('[data-track-map-center]').first().click();
    await expect(page.locator('[data-track-map-value]')).toContainText("Pin:");
    await expect(page.locator('[data-track-map-clear]').first()).toBeEnabled();
    await page.locator('[data-track-map-clear]').first().click();
    await expect(page.locator('[data-track-map-value]')).toContainText("Place a pin");

    await page.locator('[data-track-map-expand]').click();
    await expect(page.locator('[data-track-map-overlay]')).toBeVisible();
    const picker = page.locator('[data-track-map-picker-expanded]');
    const box = await picker.boundingBox();
    if (!box) throw new Error("Expected expanded map picker bounding box");
    await page.mouse.click(box.x + box.width * 0.72, box.y + box.height * 0.34);
    await expect(page.locator('[data-track-map-value]')).toContainText(/Pin:\s+-?\d+\.\d+,\s+-?\d+\.\d+/);
    await expect(page.locator('[data-track-map-status]')).toContainText("Confirm location");
    await page.locator('[data-track-map-confirm]').last().click();
    await expect(page.locator('[data-track-map-overlay]')).toBeHidden();
    await expect(page.locator('[data-track-map-status]')).toContainText("Location confirmed");

    await page.locator('[data-track-location-form] input[name="short_national_address"]').fill("RAHA1234");
    await page.locator('[data-track-location-form] button[type="submit"]').click();
    const validationMessage = await page
      .locator('[data-track-location-form] textarea[name="address_text"]')
      .evaluate((el) => (el instanceof HTMLTextAreaElement ? el.validationMessage : ""));
    expect(validationMessage).not.toHaveLength(0);
    expect(requestCalls).toBe(1);

    await page.locator('[data-track-location-form] textarea[name="address_text"]').fill("Tower 4, gate B, service road");
    await page.locator('[data-track-location-form] input[name="landmark"]').fill("Near the red tower");
    await page.locator('[data-track-location-form] textarea[name="drop_point"]').fill("Reception, gate, loading bay");
    await page.locator('[data-track-location-form] button[type="submit"]').click();
    await expect(page.locator('[data-track-location-status]')).toContainText("sent for review");
    await expect(page.locator('[data-track-request-banner-badge]')).toContainText("Sent for review");
    await expect(page.locator('[data-track-request-banner-text]')).toContainText("queued for operator review");
    expect(requestCalls).toBe(2);
  });

  test("uses hidden turnstile response input as a token fallback", async ({ page }) => {
    await patchRuntimeConfig(page, {
      trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK,
      turnstileSiteKey: "test-turnstile-site-key",
    });
    await page.route("https://challenges.cloudflare.com/turnstile/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: "window.turnstile = { render(){ return 'widget-demo'; }, reset(){}, remove(){} };",
      });
    });
    await mockTrackingEndpoint(page, async (route) => {
      const body = route.request().postDataJSON();
      const url = new URL(route.request().url());

      expect(body.turnstile_token).toBe("TURNSTILE-EXAMPLE_PASSWORD");

      if (url.pathname.endsWith("/lookup")) {
        await routePayload({ ok: true, step: "verify", verification: { phone_digits: 3 } })(route);
        return;
      }

      if (url.pathname.endsWith("/verify")) {
        await routePayload({ ...trackingPayload, session_token: "sess-demo-fallback" })(route);
        return;
      }

      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });

    await page.goto("/track/?motion=off");
    await page.locator("[data-turnstile]").evaluate((el) => {
      el.innerHTML = '<input type="hidden" name="cf-turnstile-response" value="TURNSTILE-EXAMPLE_PASSWORD">';
    });

    await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0001");
    await page.locator('[data-track-lookup-form] button[type="submit"]').click();
    await expect(page.locator('[data-track-stage="verify"]')).toBeVisible();

    await page.locator("[data-turnstile]").evaluate((el) => {
      el.innerHTML = '<input type="hidden" name="cf-turnstile-response" value="TURNSTILE-EXAMPLE_PASSWORD">';
    });
    await page.locator('[data-track-verify-form] input[name="phone_last3"]').fill("123");
    await page.locator('[data-track-verify-form] button[type="submit"]').click();

    await expect(page.locator('[data-track-stage="results"]')).toBeVisible();
    await expect(page.locator('[data-track-shipment-tracking]')).toContainText("TRK-2026-0001");
  });

  test("submits verified-session requests even when a fresh turnstile token is not present", async ({ page }) => {
    await patchRuntimeConfig(page, {
      trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK,
      turnstileSiteKey: "test-turnstile-site-key",
    });
    await page.route("https://challenges.cloudflare.com/turnstile/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: "window.turnstile = { render(){ return 'widget-demo'; }, reset(){}, remove(){} };",
      });
    });
    await mockTrackingEndpoint(page, async (route) => {
      const body = route.request().postDataJSON();
      const url = new URL(route.request().url());

      if (url.pathname.endsWith("/lookup")) {
        expect(body.turnstile_token).toBe("TURNSTILE-EXAMPLE_PASSWORD");
        await routePayload({ ok: true, step: "verify", verification: { phone_digits: 3 } })(route);
        return;
      }

      if (url.pathname.endsWith("/verify")) {
        expect(body.turnstile_token).toBe("TURNSTILE-EXAMPLE_PASSWORD");
        await routePayload({ ...trackingPayload, session_token: "sess-demo-request" })(route);
        return;
      }

      if (url.pathname.endsWith("/request")) {
        expect(body.session_token).toBe("sess-demo-request");
        expect(body.turnstile_token ?? "").toBe("");
        expect(body.payload?.map_pin?.lat).toEqual(expect.any(Number));
        expect(body.payload?.map_pin?.lng).toEqual(expect.any(Number));
        expect(body.payload?.landmark).toBe("Near the red tower");
        expect(body.payload?.drop_point).toBe("Reception, gate, loading bay");
        await routePayload({
          ok: true,
          submitted: true,
          outcome: "pending_review",
          support_case_id: "11111111-1111-1111-1111-111111111111",
        })(route);
        return;
      }

      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });

    await page.goto("/track/?motion=off");
    await page.locator("[data-turnstile]").evaluate((el) => {
      el.innerHTML = '<input type="hidden" name="cf-turnstile-response" value="TURNSTILE-EXAMPLE_PASSWORD">';
    });

    await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0001");
    await page.locator('[data-track-lookup-form] button[type="submit"]').click();
    await expect(page.locator('[data-track-stage="verify"]')).toBeVisible();

    await page.locator("[data-turnstile]").evaluate((el) => {
      el.innerHTML = '<input type="hidden" name="cf-turnstile-response" value="TURNSTILE-EXAMPLE_PASSWORD">';
    });
    await page.locator('[data-track-verify-form] input[name="phone_last3"]').fill("123");
    await page.locator('[data-track-verify-form] button[type="submit"]').click();
    await expect(page.locator('[data-track-stage="results"]')).toBeVisible();

    await page.locator("[data-turnstile]").evaluate((el) => {
      el.innerHTML = "";
    });
    await page.locator('[data-track-map-center]').first().click();
    await expect(page.locator('[data-track-map-status]')).toContainText("Confirm location");
    await page.locator('[data-track-map-confirm]').first().click();
    await page.locator('[data-track-location-form] textarea[name="address_text"]').fill("Tower 4, gate B, service road");
    await page.locator('[data-track-location-form] input[name="short_national_address"]').fill("RAHA1234");
    await page.locator('[data-track-location-form] input[name="landmark"]').fill("Near the red tower");
    await page.locator('[data-track-location-form] textarea[name="drop_point"]').fill("Reception, gate, loading bay");
    await page.locator('[data-track-location-form] button[type="submit"]').click();

    await expect(page.locator('[data-track-location-status]')).toContainText("operations team");
  });

  test("requires explicit map confirmation before sending a location-change request", async ({ page }) => {
    let locationRequestCalls = 0;

    await patchRuntimeConfig(page, {
      trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTrackingEndpoint(page, async (route) => {
      const body = route.request().postDataJSON();
      const url = new URL(route.request().url());

      if (url.pathname.endsWith("/lookup")) {
        await routePayload({ ok: true, step: "verify", verification: { phone_digits: 3 } })(route);
        return;
      }

      if (url.pathname.endsWith("/verify")) {
        await routePayload({ ...trackingPayload, session_token: "sess-demo-confirm" })(route);
        return;
      }

      if (url.pathname.endsWith("/request")) {
        locationRequestCalls += 1;
        expect(body.request_type).toBe("location_change");
        expect(body.payload?.landmark).toBe("Near the red tower");
        expect(body.payload?.drop_point).toBe("Reception, gate, loading bay");
        await routePayload({
          ok: true,
          submitted: true,
          outcome: "pending_review",
          support_case_id: "11111111-1111-1111-1111-111111111111",
        })(route);
        return;
      }

      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });

    await page.goto("/track/?motion=off");
    await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0001");
    await page.locator('[data-track-lookup-form] button[type="submit"]').click();
    await expect(page.locator('[data-track-stage="verify"]')).toBeVisible();
    await page.locator('[data-track-verify-form] input[name="phone_last3"]').fill("123");
    await page.locator('[data-track-verify-form] button[type="submit"]').click();

    await expect(page.locator('[data-track-stage="results"]')).toBeVisible();
    await page.locator('[data-track-map-center]').first().click();
    await page.locator('[data-track-location-form] textarea[name="address_text"]').fill("Tower 4, gate B, service road");
    await page.locator('[data-track-location-form] input[name="short_national_address"]').fill("RAHA1234");
    await page.locator('[data-track-location-form] input[name="landmark"]').fill("Near the red tower");
    await page.locator('[data-track-location-form] textarea[name="drop_point"]').fill("Reception, gate, loading bay");
    await page.locator('[data-track-location-form] button[type="submit"]').click();

    await expect(page.locator('[data-track-map-status]')).toContainText("Confirm location");
    await expect(page.locator('[data-track-map-confirm]').first()).toBeFocused();
    expect(locationRequestCalls).toBe(0);

    await page.locator('[data-track-map-confirm]').first().click();
    await expect(page.locator('[data-track-map-status]')).toContainText("Location confirmed");
    await page.locator('[data-track-location-form] button[type="submit"]').click();

    await expect(page.locator('[data-track-location-status]')).toContainText("operations team");
    expect(locationRequestCalls).toBe(1);
  });

  test("renders a rejected request outcome without clearing the customer input", async ({ page }) => {
    await patchRuntimeConfig(page, {
      trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTrackingEndpoint(page, async (route) => {
      const body = route.request().postDataJSON();
      const url = new URL(route.request().url());

      if (url.pathname.endsWith("/lookup")) {
        await routePayload({ ok: true, step: "verify", verification: { phone_digits: 3 } })(route);
        return;
      }

      if (url.pathname.endsWith("/verify")) {
        await routePayload({ ...trackingPayload, session_token: "sess-demo-rejected" })(route);
        return;
      }

      if (url.pathname.endsWith("/request")) {
        expect(body.request_type).toBe("reschedule_date");
        await routePayload({
          ok: true,
          submitted: true,
          outcome: "rejected",
          support_case_id: "11111111-1111-1111-1111-111111111111",
          tracking: trackingPayload.tracking,
        })(route);
        return;
      }

      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });

    await page.goto("/track/?motion=off");
    await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0001");
    await page.locator('[data-track-lookup-form] button[type="submit"]').click();
    await page.locator('[data-track-verify-form] input[name="phone_last3"]').fill("123");
    await page.locator('[data-track-verify-form] button[type="submit"]').click();

    await page.locator('[data-track-date-select]').selectOption("2026-03-08");
    await page.locator('[data-track-reschedule-form] textarea[name="notes"]').fill("Need a different day");
    await page.locator('[data-track-reschedule-form] button[type="submit"]').click();

    await expect(page.locator('[data-track-reschedule-status]')).toContainText("Request was rejected");
    await expect(page.locator('[data-track-request-banner-badge]')).toContainText("Rejected");
    await expect(page.locator('[data-track-request-banner-text]')).toContainText("Adjust the details");
    await expect(page.locator('[data-track-date-select]')).toHaveValue("2026-03-08");
    await expect(page.locator('[data-track-reschedule-form] textarea[name="notes"]')).toHaveValue("Need a different day");
  });

  test("lets the user reset and track another shipment after opening results", async ({ page }) => {
    await patchRuntimeConfig(page, {
      trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTrackingEndpoint(page, async (route) => {
      const body = route.request().postDataJSON();
      const url = new URL(route.request().url());

      if (url.pathname.endsWith("/lookup")) {
        await routePayload({ ok: true, step: "verify", verification: { phone_digits: 3 } })(route);
        return;
      }

      if (url.pathname.endsWith("/verify")) {
        if (body.reference === "TRK-2026-0001") {
          expect(body.phone_last3).toBe("123");
          await routePayload({ ...trackingPayload, session_token: "sess-demo-first" })(route);
          return;
        }

        if (body.reference === "TRK-2026-0002") {
          expect(body.phone_last3).toBe("456");
          await routePayload({ ...secondTrackingPayload, session_token: "sess-demo-second" })(route);
          return;
        }
      }

      if (url.pathname.endsWith("/session")) {
        if (body.session_token === "sess-demo-first") {
          await routePayload(trackingPayload)(route);
          return;
        }
        if (body.session_token === "sess-demo-second") {
          await routePayload(secondTrackingPayload)(route);
          return;
        }
      }

      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });

    await page.goto("/track/?motion=off");
    await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0001");
    await page.locator('[data-track-lookup-form] button[type="submit"]').click();
    await page.locator('[data-track-verify-form] input[name="phone_last3"]').fill("123");
    await page.locator('[data-track-verify-form] button[type="submit"]').click();

    await expect(page.locator('[data-track-stage="results"]')).toBeVisible();
    await expect(page.locator('[data-track-shipment-reference]')).toContainText("ORD-10088");

    await page.locator('[data-track-reset]').last().click();

    await expect(page.locator('[data-track-stage="lookup"]')).toBeVisible();
    await expect(page.locator('[data-track-stage="results"]')).toBeHidden();
    await expect(page.locator('[data-track-lookup-form] input[name="reference"]')).toHaveValue("");

    await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0002");
    await page.locator('[data-track-lookup-form] button[type="submit"]').click();
    await page.locator('[data-track-verify-form] input[name="phone_last3"]').fill("456");
    await page.locator('[data-track-verify-form] button[type="submit"]').click();

    await expect(page.locator('[data-track-stage="results"]')).toBeVisible();
    await expect(page.locator('[data-track-shipment-reference]')).toContainText("ORD-20021");
    await expect(page.locator('[data-track-shipment-status]')).toContainText("Pending");
  });

  test("uses browser geolocation to place a real lat/lng pin", async ({ page, browserName, baseURL }) => {
    test.skip(browserName === "webkit", "Local geolocation permission is flaky in WebKit for this suite.");
    await patchRuntimeConfig(page, {
      trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    const geolocationOrigin = new URL(baseURL || "http://127.0.0.1:3333").origin;
    await page.context().grantPermissions(["geolocation"], { origin: geolocationOrigin });
    await page.context().setGeolocation({ latitude: 24.7136, longitude: 46.6753 });
    await mockTrackingEndpoint(page, async (route) => {
      const body = route.request().postDataJSON();
      const url = new URL(route.request().url());

      if (url.pathname.endsWith("/lookup")) {
        await routePayload({ ok: true, step: "verify", verification: { phone_digits: 3 } })(route);
        return;
      }

      if (url.pathname.endsWith("/verify")) {
        await routePayload({ ...trackingPayload, session_token: "sess-demo-geo" })(route);
        return;
      }

      if (url.pathname.endsWith("/request")) {
        expect(body.payload?.map_pin?.lat).toBeCloseTo(24.7136, 3);
        expect(body.payload?.map_pin?.lng).toBeCloseTo(46.6753, 3);
        await routePayload({
          ok: true,
          submitted: true,
          support_case_id: "11111111-1111-1111-1111-111111111111",
        })(route);
        return;
      }

      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });

    await page.goto("/track/?motion=off");
    await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0001");
    await page.locator('[data-track-lookup-form] button[type="submit"]').click();
    await page.locator('[data-track-verify-form] input[name="phone_last3"]').fill("123");
    await page.locator('[data-track-verify-form] button[type="submit"]').click();

    await expect(page.locator('[data-track-stage="results"]')).toBeVisible();
    await page.locator('[data-track-map-locate]').first().click();
    await expect(page.locator('[data-track-map-status]')).toContainText("confirm");
    await expect(page.locator('[data-track-map-value]')).toContainText(/24\.713|46\.675/);
    await page.locator('[data-track-map-confirm]').first().click();
    await expect(page.locator('[data-track-map-status]')).toContainText("Location confirmed");

    await page.locator('[data-track-location-form] textarea[name="address_text"]').fill("Tower 4, gate B, service road");
    await page.locator('[data-track-location-form] input[name="short_national_address"]').fill("RAHA1234");
    await page.locator('[data-track-location-form] button[type="submit"]').click();

    await expect(page.locator('[data-track-location-status]')).toContainText("operations team");
  });

  test("clears an invalid stored session and returns the user to lookup with guidance", async ({ page }) => {
    await patchRuntimeConfig(page, {
      trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTrackingEndpoint(page, async (route) => {
      const body = route.request().postDataJSON();
      const url = new URL(route.request().url());

      if (url.pathname.endsWith("/session")) {
        expect(body.session_token).toBe("sess-invalid-demo");
        await routePayload({ ok: false, error: { code: "invalid_session" } }, 401)(route);
        return;
      }

      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });
    await page.addInitScript(() => {
      window.sessionStorage.setItem("masarx_tracking_session_v1", "sess-invalid-demo");
    });

    await page.goto("/track/?motion=off");

    await expect(page.locator('[data-track-stage="lookup"]')).toBeVisible();
    await expect(page.locator('[data-track-stage="results"]')).toBeHidden();
    await expect(page.locator('[data-track-lookup-status]')).toContainText("tracking session expired");
    await expect(page.locator('[data-track-lookup-form] input[name="reference"]')).toBeFocused();
  });

  test("disables reschedule requests when the backend exposes no available dates", async ({ page }) => {
    await patchRuntimeConfig(page, {
      trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTrackingEndpoint(page, async (route) => {
      const body = route.request().postDataJSON();
      const url = new URL(route.request().url());

      if (url.pathname.endsWith("/lookup")) {
        await routePayload({ ok: true, step: "verify", verification: { phone_digits: 3 } })(route);
        return;
      }

      if (url.pathname.endsWith("/verify")) {
        expect(body.reference).toBe("TRK-2026-0001");
        expect(body.phone_last3).toBe("123");
        await routePayload({
          ...trackingPayload,
          session_token: "sess-demo-nodates",
          tracking: {
            ...trackingPayload.tracking,
            actions: {
              ...trackingPayload.tracking.actions,
              reschedule: {
                enabled: true,
                available_dates: [],
              },
            },
          },
        })(route);
        return;
      }

      if (url.pathname.endsWith("/session")) {
        await routePayload({
          ...trackingPayload,
          tracking: {
            ...trackingPayload.tracking,
            actions: {
              ...trackingPayload.tracking.actions,
              reschedule: {
                enabled: true,
                available_dates: [],
              },
            },
          },
        })(route);
        return;
      }

      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });

    await page.goto("/track/?motion=off");
    await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0001");
    await page.locator('[data-track-lookup-form] button[type="submit"]').click();
    await page.locator('[data-track-verify-form] input[name="phone_last3"]').fill("123");
    await page.locator('[data-track-verify-form] button[type="submit"]').click();

    await expect(page.locator('[data-track-stage="results"]')).toBeVisible();
    await expect(page.locator('[data-track-date-select]')).toBeDisabled();
    await expect(page.locator('[data-track-reschedule-form] textarea[name="notes"]')).toBeDisabled();
    await expect(page.locator('[data-track-reschedule-form] button[type="submit"]')).toBeDisabled();
    await expect(page.locator('[data-track-reschedule-status]')).toContainText("No alternative dates");
  });

  test("keeps the lookup action inside the first mobile viewport", async ({ page }) => {
    await patchRuntimeConfig(page, {
      turnstileSiteKey: "1x00000000000000000000AA",
    });
    await page.route("https://challenges.cloudflare.com/turnstile/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: `
          window.turnstile = {
            render(host, options) {
              host.innerHTML = '<div style="height:72px;border-radius:16px;border:1px solid rgba(6,29,77,0.12);background:rgba(255,255,255,0.92);display:flex;align-items:center;justify-content:center;font:600 14px/1 sans-serif;">Turnstile</div><input type="hidden" name="cf-turnstile-response" value="TURNSTILE-MOBILE-TOKEN">';
              if (options && typeof options.callback === "function") options.callback("TURNSTILE-MOBILE-TOKEN");
              return "widget-mobile";
            },
            reset() {},
            remove() {},
          };
        `,
      });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/track/?motion=off");

    const button = page.locator('[data-track-lookup-form] button[type="submit"]');
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    if (!box) throw new Error("Expected lookup submit button bounding box");
    expect(box.y + box.height).toBeLessThanOrEqual(844);
  });
});
