import { type Locator, type Route, expect, test } from "@playwright/test";

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
type ContactResponse = (route: Route) => Promise<void>;

async function setContactInputs(form: Locator) {
  await form.locator('input[name="full_name"]').fill("Landing Reviewer");
  await form.locator('input[name="email"]').fill("lhwmilsokgrmgptsihhuoljt@example.invalid");
  await form.locator('input[name="organization_name"]').fill("MasarX");
  await form.locator('input[name="role"]').fill("Ops");
  await form.locator('textarea[name="notes"]').fill("Test lead.");
}

test.describe("landing contact interaction capture", () => {
  test.skip(!captureEnabled, "Set E2E_CAPTURE_UI=1 to enable screenshot capture.");

  test("captures validating, submitting, success, error, and dedupe states", async ({ page }) => {
    await patchRuntimeConfig(page, {
      contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });

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
    await setContactInputs(formLocator);
    await submitButton.click();
    await expect(statusLocator).toContainText("Please enter a valid email.");
    await captureFullPage(page, resolveEvidencePath(evidenceGroup, "landing-contact-validation.png"));

    // Submitting/in-flight state.
    activeContactResponse = routePayloadWithDelay({ ok: true }, 200, 650);
    await goTo();
    await setContactInputs(formLocator);

    const submitResponse = page.waitForResponse((response) =>
      response.url().includes(LANDING_CONTACT_ENDPOINT_MOCK)
    );
    await submitButton.click();
    await expect(statusLocator).toContainText("Sending...");
    await captureFullPage(page, resolveEvidencePath(evidenceGroup, "landing-contact-submitting.png"));
    await submitResponse;

    // Success state.
    activeContactResponse = routePayload({ ok: true }, 200);
    await goTo();
    await setContactInputs(formLocator);
    await submitButton.click();
    await expect(statusLocator).toHaveText("Your request is under review.");
    await captureFullPage(page, resolveEvidencePath(evidenceGroup, "landing-contact-success.png"));

    // Generic error state.
    activeContactResponse = routePayload({ ok: false }, 500);
    await goTo();
    await setContactInputs(formLocator);
    await submitButton.click();
    await expect(statusLocator).toContainText("Something went wrong");
    await captureFullPage(page, resolveEvidencePath(evidenceGroup, "landing-contact-error.png"));

    // Deduped success message.
    activeContactResponse = routePayload({ ok: true, deduped: true }, 200);
    await goTo();
    await setContactInputs(formLocator);
    await submitButton.click();
    await expect(statusLocator).toHaveText(
      "Your request was already received.",
    );
    await captureFullPage(page, resolveEvidencePath(evidenceGroup, "landing-contact-deduped.png"));
  });
});
