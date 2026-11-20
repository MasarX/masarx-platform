import { expect, test } from "@playwright/test";
import {
  LANDING_CONTACT_ENDPOINT_MOCK,
  LANDING_CONTACT_ROUTE,
  patchRuntimeConfig,
  readSelectOptions,
} from "./helpers";

test("shows friendly monthly-volume options and submits the canonical selected value", async ({ page }) => {
  await patchRuntimeConfig(page, {
    contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK,
    turnstileSiteKey: "",
  });

  await page.route(LANDING_CONTACT_ROUTE, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.goto("/?motion=off");

  const volumeOptions = await readSelectOptions(page, '[data-contact-form] select[name="volume"]');
  expect(volumeOptions).toEqual([
    { value: "", label: "Select monthly volume", disabled: true },
    { value: "0-10k", label: "0-10k deliveries", disabled: false },
    { value: "10k-60k", label: "10k-60k deliveries", disabled: false },
    { value: "60k+", label: "60k+ deliveries", disabled: false },
  ]);

  const contactForm = page.locator("[data-contact-form]");
  await contactForm.getByLabel("Full name").fill("Landing Reviewer");
  await contactForm.getByLabel("Work email").fill("lhwmilsokgrmgptsihhuoljt@example.invalid");
  await contactForm.getByLabel("Company", { exact: true }).fill("MasarX");
  await contactForm.getByLabel("Monthly deliveries").selectOption("10k-60k");

  const requestPromise = page.waitForRequest((request) =>
    request.method() === "POST" && request.url().includes(LANDING_CONTACT_ENDPOINT_MOCK),
  );

  await contactForm.getByRole("button", { name: "Submit request" }).click();

  const request = await requestPromise;
  const requestBody = request.postDataJSON() as {
    volume?: string;
    marketing?: { monthly_volume?: string };
  };

  await expect(page.locator("[data-contact-status]")).toContainText("under review");
  expect(requestBody.volume).toBe("10k-60k");
  expect(requestBody.marketing?.monthly_volume).toBe("10k-60k");
});
