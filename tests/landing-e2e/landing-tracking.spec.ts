import { expect, test } from "@playwright/test";
import {
  LANDING_TRACKING_ENDPOINT_MOCK,
  mockTrackingEndpoint,
  mockTurnstile,
  patchRuntimeConfig,
  routePayload,
  routePayloadWithDelay,
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

  test("guards lookup submission while the tracking request is in flight", async ({ page }) => {
    let lookupCalls = 0;
    await patchRuntimeConfig(page, {
      trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTrackingEndpoint(page, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/lookup")) {
        lookupCalls += 1;
        await routePayloadWithDelay({ ok: true, step: "verify", verification: { phone_digits: 3 } }, 200, 200)(route);
        return;
      }
      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });

    await page.goto("/track/?motion=off");
    await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0001");
    await page.locator("[data-track-lookup-form]").evaluate((form) => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    await expect(page.locator('[data-track-lookup-form] button[type="submit"]')).toBeDisabled();
    await expect(page.locator('[data-track-stage="verify"]')).toBeVisible();
    await expect(page.locator('[data-track-lookup-form] button[type="submit"]')).toBeEnabled();
    expect(lookupCalls).toBe(1);
  });

  test("guards verification submission while the tracking request is in flight", async ({ page }) => {
    let verifyCalls = 0;
    await patchRuntimeConfig(page, {
      trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTrackingEndpoint(page, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/lookup")) {
        await routePayload({ ok: true, step: "verify", verification: { phone_digits: 3 } })(route);
        return;
      }
      if (url.pathname.endsWith("/verify")) {
        verifyCalls += 1;
        await routePayloadWithDelay({ ...trackingPayload, session_token: "sess-demo-verify-guard" }, 200, 200)(route);
        return;
      }
      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });

    await page.goto("/track/?motion=off");
    await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0001");
    await page.locator('[data-track-lookup-form] button[type="submit"]').click();
    await expect(page.locator('[data-track-stage="verify"]')).toBeVisible();
    await page.locator('[data-track-verify-form] input[name="phone_last3"]').fill("123");
    await page.locator("[data-track-verify-form]").evaluate((form) => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    await expect(page.locator('[data-track-verify-form] button[type="submit"]')).toBeDisabled();
    await expect(page.locator('[data-track-stage="results"]')).toBeVisible();
    await expect(page.locator('[data-track-verify-form] button[type="submit"]')).toBeEnabled();
    expect(verifyCalls).toBe(1);
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
    const verifyForm = page.locator('[data-track-verify-form]');
    expect(await verifyForm.evaluate((form: HTMLFormElement) => form.checkValidity())).toBe(true);
    const [verifyResponse] = await Promise.all([
      page.waitForResponse((response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `${LANDING_TRACKING_ENDPOINT_MOCK}/verify`,
      { timeout: 10_000 }),
      verifyForm.locator('button[type="submit"]').click(),
    ]);
    expect(verifyResponse.status()).toBe(200);
    expect(await verifyResponse.json()).toMatchObject({
      ok: true,
      session_token: "sess-demo-123",
    });

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

  test("guards verified-session request submission while the mutation is in flight", async ({ page }) => {
    let mutationCalls = 0;
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
        await routePayload({ ...trackingPayload, session_token: "sess-demo-mutation-guard" })(route);
        return;
      }
      if (url.pathname.endsWith("/request")) {
        mutationCalls += 1;
        expect(body.session_token).toBe("sess-demo-mutation-guard");
        expect(body.request_type).toBe("reschedule_date");
        await routePayloadWithDelay(
          {
            ok: true,
            submitted: true,
            outcome: "applied",
            support_case_id: "11111111-1111-1111-1111-111111111111",
            tracking: trackingPayload.tracking,
          },
          200,
          200,
        )(route);
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
    await page.locator("[data-track-date-select]").selectOption("2026-03-08");
    await page.locator("[data-track-reschedule-form]").evaluate((form) => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    await expect(page.locator('[data-track-reschedule-form] button[type="submit"]')).toBeDisabled();
    await expect(page.locator("[data-track-reschedule-status]")).toContainText("Change applied");
    await expect(page.locator('[data-track-reschedule-form] button[type="submit"]')).toBeEnabled();
    expect(mutationCalls).toBe(1);
  });

  test("guards location-change submission while the mutation is in flight", async ({ page }) => {
    let mutationCalls = 0;
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
        await routePayload({ ...trackingPayload, session_token: "sess-demo-location-guard" })(route);
        return;
      }
      if (url.pathname.endsWith("/request")) {
        mutationCalls += 1;
        expect(body.session_token).toBe("sess-demo-location-guard");
        expect(body.request_type).toBe("location_change");
        expect(body.payload?.map_pin?.lat).toEqual(expect.any(Number));
        expect(body.payload?.map_pin?.lng).toEqual(expect.any(Number));
        await routePayloadWithDelay(
          {
            ok: true,
            submitted: true,
            outcome: "pending_review",
            support_case_id: "11111111-1111-1111-1111-111111111111",
          },
          200,
          200,
        )(route);
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
    await expect(page.locator('[data-track-map-status]')).toContainText("Confirm location");
    await page.locator('[data-track-map-confirm]').first().click();
    await page.locator('[data-track-location-form] textarea[name="address_text"]').fill(
      "Tower 4, gate B, service road",
    );
    await page.locator('[data-track-location-form] input[name="short_national_address"]').fill("RAHA1234");

    await page.locator("[data-track-location-form]").evaluate((form) => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    await expect(page.locator('[data-track-location-form] button[type="submit"]')).toBeDisabled();
    await expect(page.locator('[data-track-location-status]')).toContainText("sent for review");
    await expect(page.locator('[data-track-location-form] button[type="submit"]')).toBeEnabled();
    expect(mutationCalls).toBe(1);
  });

  test("aborts a timed-out tracking lookup and allows a clean retry", async ({ page }) => {
    let lookupCalls = 0;
    let releaseTimedOutRoute: (() => void) | null = null;
    await page.clock.install();
    await patchRuntimeConfig(page, {
      trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK,
      turnstileSiteKey: "",
      publicRequestTimeoutMs: 1_000,
    });
    await mockTrackingEndpoint(page, async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/lookup")) {
        await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
        return;
      }

      lookupCalls += 1;
      if (lookupCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseTimedOutRoute = resolve;
        });
        try {
          await route.abort("timedout");
        } catch {
          // The browser-side AbortController may already have closed the route.
        }
        return;
      }

      await routePayload({ ok: true, step: "verify", verification: { phone_digits: 3 } })(route);
    });

    await page.goto("/track/?motion=off");
    const lookupForm = page.locator("[data-track-lookup-form]");
    await lookupForm.locator('input[name="reference"]').fill("TRK-2026-0001");
    await lookupForm.locator('button[type="submit"]').click();
    await expect(lookupForm.locator('button[type="submit"]')).toBeDisabled();
    await expect.poll(() => Boolean(releaseTimedOutRoute)).toBe(true);

    await page.clock.fastForward(1_000);
    await expect(page.locator("[data-track-lookup-status]")).toContainText("Something went wrong");
    await expect(lookupForm.locator('button[type="submit"]')).toBeEnabled();
    expect(lookupCalls).toBe(1);

    releaseTimedOutRoute?.();
    await lookupForm.locator('button[type="submit"]').click();
    await expect(page.locator('[data-track-stage="verify"]')).toBeVisible();
    expect(lookupCalls).toBe(2);
  });

  test("renews the submitted lookup Turnstile token before a failed-request retry", async ({ page }) => {
    const lookupTokens: string[] = [];
    await patchRuntimeConfig(page, {
      trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK,
      turnstileSiteKey: "1x00000000000000000000AA",
    });
    await mockTurnstile(page);
    await mockTrackingEndpoint(page, async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/lookup")) {
        await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
        return;
      }
      lookupTokens.push(String(route.request().postDataJSON().turnstile_token || ""));
      await routePayload(
        lookupTokens.length === 1
          ? { ok: false, error: { code: "rate_limited" } }
          : { ok: true, step: "verify", verification: { phone_digits: 3 } },
        lookupTokens.length === 1 ? 429 : 200,
      )(route);
    });

    await page.goto("/track/?motion=off");
    const form = page.locator("[data-track-lookup-form]");
    await form.locator('input[name="reference"]').fill("TRK-2026-0001");
    const turnstileInput = page.locator('[data-turnstile] input[name="cf-turnstile-response"]');
    await expect(turnstileInput).toHaveValue(/^TURNSTILE-TEST-TOKEN-\d+$/);
    const initialToken = await turnstileInput.inputValue();

    await form.locator('button[type="submit"]').click();
    await expect(page.locator("[data-track-lookup-status]")).toContainText(
      "Too many attempts. Wait a little, then try again.",
    );
    await expect(turnstileInput).not.toHaveValue(initialToken);
    await expect(turnstileInput).toHaveValue(/^TURNSTILE-TEST-TOKEN-\d+$/);
    const retryToken = await turnstileInput.inputValue();

    await form.locator('button[type="submit"]').click();
    await expect(page.locator('[data-track-stage="verify"]')).toBeVisible();
    expect(retryToken).not.toBe(initialToken);
    expect(lookupTokens).toEqual([initialToken, retryToken]);
  });

  test("renews the submitted verify Turnstile token before a failed-request retry", async ({ page }) => {
    const verifyTokens: string[] = [];
    await patchRuntimeConfig(page, {
      trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK,
      turnstileSiteKey: "1x00000000000000000000AA",
    });
    await mockTurnstile(page);
    await mockTrackingEndpoint(page, async (route) => {
      const body = route.request().postDataJSON();
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/lookup")) {
        await routePayload({ ok: true, step: "verify", verification: { phone_digits: 3 } })(route);
        return;
      }
      if (url.pathname.endsWith("/verify")) {
        verifyTokens.push(String(body.turnstile_token || ""));
        await routePayload(
          verifyTokens.length === 1
            ? { ok: false, error: { code: "verification_failed" } }
            : { ...trackingPayload, session_token: "sess-turnstile-retry" },
          verifyTokens.length === 1 ? 401 : 200,
        )(route);
        return;
      }
      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });

    await page.goto("/track/?motion=off");
    await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0001");
    await page.locator('[data-track-lookup-form] button[type="submit"]').click();
    await expect(page.locator('[data-track-stage="verify"]')).toBeVisible();
    const turnstileInput = page.locator('[data-turnstile] input[name="cf-turnstile-response"]');
    await expect(turnstileInput).toHaveValue(/^TURNSTILE-TEST-TOKEN-\d+$/);
    const initialVerifyToken = await turnstileInput.inputValue();

    const verifyForm = page.locator("[data-track-verify-form]");
    await verifyForm.locator('input[name="phone_last3"]').fill("123");
    await verifyForm.locator('button[type="submit"]').click();
    await expect(page.locator("[data-track-verify-status]")).toContainText(
      "Verification failed. Check the reference and the last 3 mobile digits, then try again.",
    );
    await expect(turnstileInput).not.toHaveValue(initialVerifyToken);
    await expect(turnstileInput).toHaveValue(/^TURNSTILE-TEST-TOKEN-\d+$/);
    const retryVerifyToken = await turnstileInput.inputValue();

    await verifyForm.locator('button[type="submit"]').click();
    await expect(page.locator('[data-track-stage="results"]')).toBeVisible();
    expect(retryVerifyToken).not.toBe(initialVerifyToken);
    expect(verifyTokens).toEqual([initialVerifyToken, retryVerifyToken]);
  });

  test("ignores a delayed lookup completion after newer reference input", async ({ page }) => {
    let firstLookupStarted = false;
    let releaseFirstLookup: (() => void) | null = null;
    const firstLookupGate = new Promise<void>((resolve) => {
      releaseFirstLookup = resolve;
    });

    await patchRuntimeConfig(page, {
      trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockTrackingEndpoint(page, async (route) => {
      const body = route.request().postDataJSON();
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/lookup")) {
        if (body.reference === "TRK-2026-0001") {
          firstLookupStarted = true;
          await firstLookupGate;
          try {
            await routePayload({ ok: true, step: "verify", verification: { phone_digits: 3 } })(route);
          } catch {
            // The newer input aborts this superseded browser request.
          }
          return;
        }
        expect(body.reference).toBe("TRK-2026-0002");
        await routePayload({ ok: true, step: "verify", verification: { phone_digits: 3 } })(route);
        return;
      }
      if (url.pathname.endsWith("/verify")) {
        expect(body.reference).toBe("TRK-2026-0002");
        await routePayload({ ...secondTrackingPayload, session_token: "sess-new-reference" })(route);
        return;
      }
      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });

    await page.goto("/track/?motion=off");
    const lookupForm = page.locator("[data-track-lookup-form]");
    const referenceInput = lookupForm.locator('input[name="reference"]');
    await referenceInput.fill("TRK-2026-0001");
    await lookupForm.locator('button[type="submit"]').click();
    await expect.poll(() => firstLookupStarted).toBe(true);
    await expect(page.locator("[data-track-lookup-status]")).toContainText("Working on your request");

    await referenceInput.fill("TRK-2026-0002");
    await expect(page.locator("[data-track-lookup-status]")).toBeEmpty();
    await expect(lookupForm.locator('button[type="submit"]')).toBeEnabled();
    await lookupForm.locator('button[type="submit"]').click();
    await expect(page.locator('[data-track-stage="verify"]')).toBeVisible();

    releaseFirstLookup?.();
    await page.locator('[data-track-verify-form] input[name="phone_last3"]').fill("456");
    await page.locator('[data-track-verify-form] button[type="submit"]').click();
    await expect(page.locator('[data-track-shipment-tracking]')).toHaveText("TRK-2026-0002");
  });

  test("ignores a delayed verify completion after newer verification input", async ({ page }) => {
    let firstVerifyStarted = false;
    let releaseFirstVerify: (() => void) | null = null;
    let secondVerifyStarted = false;
    let releaseSecondVerify: (() => void) | null = null;
    const firstVerifyGate = new Promise<void>((resolve) => {
      releaseFirstVerify = resolve;
    });
    const secondVerifyGate = new Promise<void>((resolve) => {
      releaseSecondVerify = resolve;
    });

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
        if (body.phone_last3 === "123") {
          firstVerifyStarted = true;
          await firstVerifyGate;
          try {
            await routePayload({ ...trackingPayload, session_token: "sess-stale-verify" })(route);
          } catch {
            // The newer input aborts this superseded browser request.
          }
          return;
        }
        expect(body.phone_last3).toBe("456");
        secondVerifyStarted = true;
        await secondVerifyGate;
        await routePayload({ ...secondTrackingPayload, session_token: "sess-current-verify" })(route);
        return;
      }
      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });

    await page.goto("/track/?motion=off");
    await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0002");
    await page.locator('[data-track-lookup-form] button[type="submit"]').click();
    const verifyForm = page.locator("[data-track-verify-form]");
    const digitsInput = verifyForm.locator('input[name="phone_last3"]');
    await digitsInput.fill("123");
    await verifyForm.locator('button[type="submit"]').click();
    await expect.poll(() => firstVerifyStarted).toBe(true);
    await expect(page.locator("[data-track-verify-status]")).toContainText("Working on your request");

    await digitsInput.fill("456");
    await expect(page.locator("[data-track-verify-status]")).toBeEmpty();
    await expect(verifyForm.locator('button[type="submit"]')).toBeEnabled();
    await verifyForm.locator('button[type="submit"]').click();
    await expect.poll(() => secondVerifyStarted).toBe(true);
    await expect(page.locator("[data-track-verify-status]")).toContainText("Working on your request");

    releaseFirstVerify?.();
    await expect(page.locator("[data-track-verify-status]")).toContainText("Working on your request");
    releaseSecondVerify?.();
    await expect(page.locator('[data-track-shipment-tracking]')).toHaveText("TRK-2026-0002");
    await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem("masarx_tracking_session_v1"))).toBe(
      "sess-current-verify",
    );
    await expect(page.locator('[data-track-shipment-tracking]')).toHaveText("TRK-2026-0002");
  });

  test("serializes tracking mutations while a reschedule request is in flight", async ({ page }) => {
    let rescheduleStarted = false;
    let releaseReschedule: (() => void) | null = null;
    let locationCalls = 0;
    const rescheduleGate = new Promise<void>((resolve) => {
      releaseReschedule = resolve;
    });

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
        await routePayload({ ...trackingPayload, session_token: "sess-mutation-order" })(route);
        return;
      }
      if (url.pathname.endsWith("/request") && body.request_type === "reschedule_date") {
        rescheduleStarted = true;
        await rescheduleGate;
        await routePayload({
          ok: true,
          outcome: "applied",
          tracking: trackingPayload.tracking,
        })(route);
        return;
      }
      if (url.pathname.endsWith("/request") && body.request_type === "location_change") {
        locationCalls += 1;
        await routePayload({ ok: false, error: { code: "invalid_request" } }, 409)(route);
        return;
      }
      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });

    await page.goto("/track/?motion=off");
    await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0001");
    await page.locator('[data-track-lookup-form] button[type="submit"]').click();
    await page.locator('[data-track-verify-form] input[name="phone_last3"]').fill("123");
    await page.locator('[data-track-verify-form] button[type="submit"]').click();
    await page.locator("[data-track-date-select]").selectOption("2026-03-08");
    await page.locator('[data-track-reschedule-form] button[type="submit"]').click();
    await expect.poll(() => rescheduleStarted).toBe(true);
    await expect(page.locator("[data-track-reschedule-status]")).toContainText("Working on your request");
    await expect(page.locator("[data-track-reschedule-status]")).toHaveAttribute("aria-live", "polite");
    await expect(page.locator("[data-track-reschedule-form]")).not.toHaveAttribute("inert", "");
    await expect(page.locator("[data-track-location-form]")).not.toHaveAttribute("inert", "");
    await expect(page.locator('[data-track-reschedule-form] select[name="requested_date"]')).toBeDisabled();
    await expect(page.locator('[data-track-reschedule-form] textarea[name="notes"]')).toBeDisabled();
    await expect(page.locator('[data-track-location-form] textarea[name="address_text"]')).toBeDisabled();

    await expect(page.locator("[data-lang-toggle]")).toBeDisabled();
    await page.locator("[data-lang-toggle]").evaluate((button) => {
      button.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
    });
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator('[data-track-reschedule-form] select[name="requested_date"]')).toBeDisabled();
    await expect(page.locator('[data-track-reschedule-form] textarea[name="notes"]')).toBeDisabled();
    await expect(page.locator('[data-track-reschedule-form] button[type="submit"]')).toBeDisabled();
    await expect(page.locator('[data-track-location-form] textarea[name="address_text"]')).toBeDisabled();
    await expect(page.locator("[data-track-reschedule-status]")).toHaveAttribute("aria-live", "polite");
    await expect(page.locator("[data-track-reschedule-status]")).not.toBeEmpty();

    await page.locator("[data-track-location-form]").evaluate((form) => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await expect(page.locator("[data-track-reschedule-status]")).toContainText("Working on your request");
    await expect(page.locator('[data-track-reschedule-form] button[type="submit"]')).toBeDisabled();
    await expect(page.locator('[data-track-location-form] button[type="submit"]')).toBeDisabled();
    expect(locationCalls).toBe(0);

    releaseReschedule?.();
    await expect(page.locator("[data-track-reschedule-status]")).toContainText("Change applied");
    await expect(page.locator('[data-track-reschedule-form] select[name="requested_date"]')).toBeEnabled();
    await expect(page.locator('[data-track-location-form] textarea[name="address_text"]')).toBeEnabled();
    await expect(page.locator("[data-lang-toggle]")).toBeEnabled();
    expect(locationCalls).toBe(0);
  });

  test("keeps lookup active when Back invalidates a delayed verification", async ({ page }) => {
    let verifyStarted = false;
    let releaseVerify: (() => void) | null = null;
    const verifyGate = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
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
        if (body.phone_last3 === "456") {
          await routePayload({ ...secondTrackingPayload, session_token: "sess-current-after-back" })(route);
          return;
        }
        verifyStarted = true;
        await verifyGate;
        try {
          await routePayload({ ...trackingPayload, session_token: "sess-superseded-by-back" })(route);
        } catch {
          // Back aborts this superseded browser request.
        }
        return;
      }
      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });

    await page.goto("/track/?motion=off");
    await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0001");
    await page.locator('[data-track-lookup-form] button[type="submit"]').click();
    await page.locator('[data-track-verify-form] input[name="phone_last3"]').fill("123");
    await page.locator('[data-track-verify-form] button[type="submit"]').click();
    await expect.poll(() => verifyStarted).toBe(true);
    await expect(page.locator("[data-track-verify-status]")).toContainText("Working on your request");

    await page.locator("[data-track-back]").click();
    await expect(page.locator('[data-track-stage="lookup"]')).toBeVisible();
    await expect(page.locator("[data-track-verify-status]")).toBeEmpty();
    await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0002");
    await page.locator('[data-track-lookup-form] button[type="submit"]').click();
    await page.locator('[data-track-verify-form] input[name="phone_last3"]').fill("456");
    await page.locator('[data-track-verify-form] button[type="submit"]').click();
    await expect(page.locator('[data-track-shipment-tracking]')).toHaveText("TRK-2026-0002");
    await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem("masarx_tracking_session_v1"))).toBe(
      "sess-current-after-back",
    );

    releaseVerify?.();
    await expect(page.locator('[data-track-shipment-tracking]')).toHaveText("TRK-2026-0002");
    await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem("masarx_tracking_session_v1"))).toBe(
      "sess-current-after-back",
    );
  });

  test("keeps reset blocked until an active mutation settles", async ({ page }) => {
    let mutationStarted = false;
    let releaseMutation: (() => void) | null = null;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
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
        await routePayload(
          body.reference === "TRK-2026-0002"
            ? { ...secondTrackingPayload, session_token: "sess-current-after-reset" }
            : { ...trackingPayload, session_token: "sess-reset" },
        )(route);
        return;
      }
      if (url.pathname.endsWith("/request")) {
        expect(body.request_type).toBe("reschedule_date");
        mutationStarted = true;
        await mutationGate;
        await routePayload({ ok: true, outcome: "applied", tracking: trackingPayload.tracking })(route);
        return;
      }
      await routePayload({ ok: false, error: { code: "not_found" } }, 404)(route);
    });

    await page.goto("/track/?motion=off");
    await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0001");
    await page.locator('[data-track-lookup-form] button[type="submit"]').click();
    await page.locator('[data-track-verify-form] input[name="phone_last3"]').fill("123");
    await page.locator('[data-track-verify-form] button[type="submit"]').click();
    await page.locator("[data-track-date-select]").selectOption("2026-03-08");
    await page.locator('[data-track-reschedule-form] button[type="submit"]').click();
    await expect.poll(() => mutationStarted).toBe(true);
    await expect(page.locator("[data-track-reschedule-status]")).toContainText("Working on your request");

    await page.locator("[data-track-reset]").last().click();
    await expect(page.locator('[data-track-stage="results"]')).toBeVisible();
    await expect(page.locator("[data-track-reschedule-status]")).toContainText("Working on your request");

    releaseMutation?.();
    await expect(page.locator("[data-track-reschedule-status]")).toContainText("Change applied");

    await page.locator("[data-track-reset]").last().click();
    await expect(page.locator('[data-track-stage="lookup"]')).toBeVisible();
    await page.locator('[data-track-lookup-form] input[name="reference"]').fill("TRK-2026-0002");
    await page.locator('[data-track-lookup-form] button[type="submit"]').click();
    await page.locator('[data-track-verify-form] input[name="phone_last3"]').fill("456");
    await page.locator('[data-track-verify-form] button[type="submit"]').click();
    await expect(page.locator('[data-track-shipment-tracking]')).toHaveText("TRK-2026-0002");
    await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem("masarx_tracking_session_v1"))).toBe(
      "sess-current-after-reset",
    );

  });

  test("keeps reschedule disabled when the mutation readback removes availability", async ({ page }) => {
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
        await routePayload({ ...trackingPayload, session_token: "sess-demo-policy-restore" })(route);
        return;
      }
      if (url.pathname.endsWith("/request")) {
        expect(body.request_type).toBe("reschedule_date");
        await routePayloadWithDelay(
          {
            ok: true,
            submitted: true,
            outcome: "applied",
            support_case_id: "11111111-1111-1111-1111-111111111111",
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
          },
          200,
          200,
        )(route);
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

    const rescheduleForm = page.locator("[data-track-reschedule-form]");
    await rescheduleForm.locator('select[name="requested_date"]').selectOption("2026-03-08");
    await rescheduleForm.locator('button[type="submit"]').click();

    await expect(page.locator("[data-track-reschedule-status]")).toContainText("Change applied");
    await expect(rescheduleForm.locator('select[name="requested_date"]')).toBeDisabled();
    await expect(rescheduleForm.locator('textarea[name="notes"]')).toBeDisabled();
    await expect(rescheduleForm.locator('button[type="submit"]')).toBeDisabled();
  });

  test("uses hidden turnstile response input as a token fallback", async ({ page }) => {
    await patchRuntimeConfig(page, {
      trackingEndpoint: LANDING_TRACKING_ENDPOINT_MOCK,
      turnstileSiteKey: "1x00000000000000000000AA",
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

      // The challenge token fallback covers /lookup and /verify; later calls use session_token (#410).
      if (url.pathname.endsWith("/lookup")) {
        expect(body.turnstile_token).toBe("TURNSTILE-EXAMPLE_PASSWORD");
        await routePayload({ ok: true, step: "verify", verification: { phone_digits: 3 } })(route);
        return;
      }

      if (url.pathname.endsWith("/verify")) {
        expect(body.turnstile_token).toBe("TURNSTILE-EXAMPLE_PASSWORD");
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
      turnstileSiteKey: "1x00000000000000000000AA",
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
    await expect(page.locator('[data-track-stage="verify"]')).toBeVisible();
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
    await expect(page.locator('[data-track-stage="verify"]')).toBeVisible();
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
