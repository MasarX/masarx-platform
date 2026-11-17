import { test, expect } from "@playwright/test";
import {
  LANDING_DRIVER_STATUS_ENDPOINT_MOCK,
  LANDING_DRIVER_SIGNUP_ENDPOINT_MOCK,
  mockDriverStatusEndpoint,
  mockDriverSignupEndpoint,
  patchRuntimeConfig,
  routePayload,
} from "./helpers";
import { captureEvidenceIfRequested } from "../shared/evidence";

async function fillDriverForm(page: import("@playwright/test").Page) {
  const form = page.locator("[data-driver-form]");
  await expect(form).toBeVisible();
  await expect(form.locator('input[name="phone"]')).toBeVisible();
  await form.locator('input[name="full_name"]').fill("Driver Reviewer");
  await form.locator('input[name="email"]').fill("driver@example.com");
  await form.locator('input[name="phone"]').fill("+12025550123");
  await form.locator('input[name="organization_name"]').fill("Driver Ops");
  await form.locator('input[name="city"]').fill("Riyadh");
  await form.locator('select[name="vehicle_type"]').selectOption("car");
  await form.locator('input[name="languages"]').fill("Arabic, English");
  await form.locator('input[name="capabilities"]').fill("cold_chain, fragile");
  await form.locator('textarea[name="experience_summary"]').fill("Five years in Riyadh same-day delivery.");
}

test.describe("landing driver signup", () => {
  test("submits the driver application against the configured intake endpoint", async ({ page }) => {
    await patchRuntimeConfig(page, {
      driverSignupEndpoint: LANDING_DRIVER_SIGNUP_ENDPOINT_MOCK,
      driverApplicationStatusEndpoint: LANDING_DRIVER_STATUS_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockDriverSignupEndpoint(page, routePayload({ ok: true, application_status_token: "token-123" }, 200));
    await mockDriverStatusEndpoint(page, routePayload({ ok: true, status: "pending" }, 200));

    await page.goto("/drivers/apply?motion=off");
    await fillDriverForm(page);

    const responsePromise = page.waitForResponse((response) =>
      response.url().includes(LANDING_DRIVER_SIGNUP_ENDPOINT_MOCK),
    );
    await page.locator("[data-driver-form]").locator('button[type="submit"]').click();
    const response = await responsePromise;

    await expect(page.locator("[data-driver-status]")).toContainText("under review");
    await expect(page.locator('[data-driver-status-form] input[name="status_token"]')).toHaveValue("token-123");
    expect(response.ok()).toBeTruthy();
    await captureEvidenceIfRequested(page, "landing-driver-signup.png");
  });

  test("shows deduped confirmation when the driver application already exists", async ({ page }) => {
    await patchRuntimeConfig(page, {
      driverSignupEndpoint: LANDING_DRIVER_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockDriverSignupEndpoint(page, routePayload({ ok: true, deduped: true }, 200));

    await page.goto("/drivers/apply?motion=off");
    await fillDriverForm(page);
    await page.locator("[data-driver-form]").locator('button[type="submit"]').click();

    await expect(page.locator("[data-driver-status]")).toContainText("already received");
  });

  test("maps backend validation and rate-limit errors for the driver application", async ({ page }) => {
    const cases = [
      {
        code: "invalid_email",
        expected: "Please enter a valid email.",
      },
      {
        code: "rate_limited",
        expected: "Too many requests. Please wait and try again.",
      },
      {
        code: "disabled",
        expected: "Driver applications are temporarily disabled.",
      },
    ];

    await patchRuntimeConfig(page, {
      driverSignupEndpoint: LANDING_DRIVER_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });

    for (const testCase of cases) {
      await page.unroute(`**${LANDING_DRIVER_SIGNUP_ENDPOINT_MOCK}`).catch(() => {});
      await mockDriverSignupEndpoint(
        page,
        routePayload({ ok: false, error: { code: testCase.code } }, 400),
      );

      await page.goto("/drivers/apply?motion=off");
      await fillDriverForm(page);
      await page.locator("[data-driver-form]").locator('button[type="submit"]').click();
      await expect(page.locator("[data-driver-status]")).toContainText(testCase.expected);
    }
  });

  test("checks driver application status with the browser-safe token endpoint", async ({ page }) => {
    await patchRuntimeConfig(page, {
      driverApplicationStatusEndpoint: LANDING_DRIVER_STATUS_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockDriverStatusEndpoint(page, routePayload({ ok: true, status: "approved" }, 200));

    await page.goto("/drivers/status/token-abc?motion=off");

    await expect(page.locator('[data-driver-status-form] input[name="status_token"]')).toHaveValue("token-abc");
    await expect(page.locator("[data-driver-status-lookup]")).toContainText("approved");
    await captureEvidenceIfRequested(page, "landing-driver-status.png");
  });
});
