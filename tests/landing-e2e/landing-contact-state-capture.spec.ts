import { type Route, expect, test } from "@playwright/test";

import {
  captureFullPage,
  isCaptureEnabled,
  resolveEvidencePath,
} from "../e2e/utils/evidence";
import {
  LANDING_CONTACT_ENDPOINT_MOCK,
  LANDING_CONTACT_ROUTE,
  patchRuntimeConfig,
  routePayload,
  routePayloadWithDelay,
} from "./helpers";

const captureEnabled = isCaptureEnabled();
const evidenceGroup = "landing-contact-interaction-states";
const evidencePath = (...segments: string[]) => resolveEvidencePath(evidenceGroup, ...segments);

type ContactResponse = (route: Route) => Promise<void>;

async function setContactInputs(page) {
  await page.locator('input[name="email"]').fill("lhwmilsokgrmgptsihhuoljt@example.invalid");
  await page.locator('input[name="company"]').fill("MasarX");
  await page.locator('input[name="role"]').fill("Ops");
  await page.locator('textarea[name="notes"]').fill("Test lead.");
}

test.describe("landing contact interaction capture", () => {
  test.skip(!captureEnabled, "Set E2E_CAPTURE_UI=1 to enable screenshot capture.");

  test("captures validating, submitting, success, error, and dedupe states", async ({ page }) => {
    await patchRuntimeConfig(page, { contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK });

    let activeContactResponse: ContactResponse = routePayload({ ok: true });

    await page.route(LANDING_CONTACT_ROUTE, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }

      await activeContactResponse(route);
    });

    const formLocator = page.locator("[data-contact-form]");
    const submitButton = formLocator.locator('button[type="submit"]');
    const statusLocator = page.locator("[data-contact-status]");

    const goTo = async () => {
      await page.goto("/?motion=off");
    };

    // Validating/mapped client error state.
    activeContactResponse = routePayload({ ok: false, error: { code: "invalid_email" } }, 400);
    await goTo();
    await setContactInputs(page);
    await submitButton.click();
    await expect(statusLocator).toContainText("Please enter a valid email.");
    await captureFullPage(page, evidencePath("landing-contact-validation.png"));

    // Submitting/in-flight state.
    activeContactResponse = routePayloadWithDelay({ ok: true }, 200, 650);
    await goTo();
    await setContactInputs(page);

    const submitResponse = page.waitForResponse((response) =>
      response.url().includes(LANDING_CONTACT_ENDPOINT_MOCK)
    );
    await submitButton.click();
    await expect(statusLocator).toContainText("Sending...");
    await captureFullPage(page, evidencePath("landing-contact-submitting.png"));
    await submitResponse;

    // Success state.
    activeContactResponse = routePayload({ ok: true }, 200);
    await goTo();
    await setContactInputs(page);
    await submitButton.click();
    await expect(statusLocator).toContainText("Thanks");
    await captureFullPage(page, evidencePath("landing-contact-success.png"));

    // Generic error state.
    activeContactResponse = routePayload({ ok: false }, 500);
    await goTo();
    await setContactInputs(page);
    await submitButton.click();
    await expect(statusLocator).toContainText("Something went wrong");
    await captureFullPage(page, evidencePath("landing-contact-error.png"));

    // Deduped success message.
    activeContactResponse = routePayload({ ok: true, deduped: true }, 200);
    await goTo();
    await setContactInputs(page);
    await submitButton.click();
    await expect(statusLocator).toContainText("Already received");
    await captureFullPage(page, evidencePath("landing-contact-deduped.png"));
  });
});
