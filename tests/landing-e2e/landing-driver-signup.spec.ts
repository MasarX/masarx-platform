import { test, expect } from "@playwright/test";
import {
  LANDING_DRIVER_STATUS_ENDPOINT_MOCK,
  LANDING_DRIVER_SIGNUP_ENDPOINT_MOCK,
  mockDriverStatusEndpoint,
  mockDriverSignupEndpoint,
  mockTurnstile,
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
      driverSignupEntryKey: "fixture-driver-entry",
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
    expect(response.request().postDataJSON().entry_key).toBe("fixture-driver-entry");
    await captureEvidenceIfRequested(page, "landing-driver-signup.png");
  });

  test("guards driver application submission while the request is in flight", async ({ page }) => {
    let signupCalls = 0;
    let releaseSignup: (() => void) | null = null;
    const signupGate = new Promise<void>((resolve) => {
      releaseSignup = resolve;
    });
    await patchRuntimeConfig(page, {
      driverSignupEntryKey: "fixture-driver-entry",
      driverSignupEndpoint: LANDING_DRIVER_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockDriverSignupEndpoint(page, async (route) => {
      signupCalls += 1;
      await signupGate;
      await routePayload({ ok: true, application_status_token: "token-submit-guard" }, 200)(route);
    });

    await page.goto("/drivers/apply?motion=off");
    await fillDriverForm(page);
    await page.locator("[data-driver-form]").evaluate((form) => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    await expect(page.locator("[data-driver-form]")).not.toHaveAttribute("inert", "");
    await expect(page.locator("[data-driver-status]")).toHaveAttribute("aria-live", "polite");
    await expect(page.locator("[data-driver-status]")).toContainText("Sending");
    await expect(page.locator('[data-driver-form] input[name="full_name"]')).toBeDisabled();
    await expect(page.locator('[data-driver-form] button[type="submit"]')).toBeDisabled();

    releaseSignup?.();
    await expect(page.locator("[data-driver-status]")).toContainText("under review");
    await expect(page.locator('[data-driver-form] input[name="full_name"]')).toBeEnabled();
    await expect(page.locator('[data-driver-form] input[name="full_name"]')).toHaveValue("");
    await expect(page.locator('[data-driver-form] button[type="submit"]')).toBeEnabled();
    await expect(page.locator('[data-driver-status-form] input[name="status_token"]')).toHaveValue(
      "token-submit-guard",
    );
    expect(signupCalls).toBe(1);
  });

  test("renews the submitted driver Turnstile token before a failed-request retry", async ({ page }) => {
    const submittedTokens: string[] = [];
    await patchRuntimeConfig(page, {
      driverSignupEntryKey: "fixture-driver-entry",
      driverSignupEndpoint: LANDING_DRIVER_SIGNUP_ENDPOINT_MOCK,
      turnstileSiteKey: "1x00000000000000000000AA",
    });
    await mockTurnstile(page);
    await mockDriverSignupEndpoint(page, async (route) => {
      submittedTokens.push(String(route.request().postDataJSON().turnstile_token || ""));
      await routePayload(
        submittedTokens.length === 1 ? { ok: false, error: { code: "rate_limited" } } : { ok: true },
        submittedTokens.length === 1 ? 429 : 200,
      )(route);
    });

    await page.goto("/drivers/apply?motion=off");
    await fillDriverForm(page);
    const form = page.locator("[data-driver-form]");
    const turnstileInput = page.locator('[data-driver-turnstile] input[name="cf-turnstile-response"]');
    await expect(turnstileInput).toHaveValue(/^TURNSTILE-TEST-TOKEN-\d+$/);
    const initialToken = await turnstileInput.inputValue();

    await form.locator('button[type="submit"]').click();
    await expect(page.locator("[data-driver-status]")).toContainText("Too many requests");
    await expect(turnstileInput).not.toHaveValue(initialToken);
    await expect(turnstileInput).toHaveValue(/^TURNSTILE-TEST-TOKEN-\d+$/);
    const retryToken = await turnstileInput.inputValue();

    await form.locator('button[type="submit"]').click();
    await expect(page.locator("[data-driver-status]")).toContainText("under review");
    expect(retryToken).not.toBe(initialToken);
    expect(submittedTokens).toEqual([initialToken, retryToken]);
  });

  test("shows deduped confirmation when the driver application already exists", async ({ page }) => {
    await patchRuntimeConfig(page, {
      driverSignupEntryKey: "fixture-driver-entry",
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
      driverSignupEntryKey: "fixture-driver-entry",
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
    const reviewerNote = '<script>not executable</script> Your documents are approved.';
    await mockDriverStatusEndpoint(page, routePayload({ ok: true, status: "approved", review_reason: reviewerNote }, 200));

    await page.goto("/drivers/status/token-abc?motion=off");

    await expect(page.locator('[data-driver-status-form] input[name="status_token"]')).toHaveValue("token-abc");
    await expect(page.locator("[data-driver-status-lookup]")).toContainText("approved");
    await expect(page.locator('[data-driver-review-note]')).toHaveText(`Reviewer note: ${reviewerNote}`);
    await expect(page.locator('[data-driver-review-note] script')).toHaveCount(0);
    await captureEvidenceIfRequested(page, "landing-driver-status.png");
    await page.locator('[data-driver-status-form] input[name="status_token"]').fill('different-token');
    await expect(page.locator('[data-driver-review-note]')).toBeHidden();
  });

  test("guards driver status lookup while the request is in flight", async ({ page }) => {
    let lookupCalls = 0;
    let releaseLookup: (() => void) | null = null;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    await patchRuntimeConfig(page, {
      driverApplicationStatusEndpoint: LANDING_DRIVER_STATUS_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockDriverStatusEndpoint(page, async (route) => {
      lookupCalls += 1;
      await lookupGate;
      await routePayload({ ok: true, status: "approved" }, 200)(route);
    });

    await page.goto("/drivers/apply?motion=off");
    await page.locator('[data-driver-status-form] input[name="status_token"]').fill("token-status-guard");
    await page.locator("[data-driver-status-form]").evaluate((form) => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    await expect(page.locator("[data-driver-status-form]")).not.toHaveAttribute("inert", "");
    await expect(page.locator("[data-driver-status-lookup]")).toHaveAttribute("aria-live", "polite");
    await expect(page.locator("[data-driver-status-lookup]")).toContainText("Checking status");
    await expect(page.locator('[data-driver-status-form] input[name="status_token"]')).toBeDisabled();
    await expect(page.locator('[data-driver-status-form] button[type="submit"]')).toBeDisabled();

    releaseLookup?.();
    await expect(page.locator("[data-driver-status-lookup]")).toContainText("approved");
    await expect(page.locator('[data-driver-status-form] input[name="status_token"]')).toBeEnabled();
    await expect(page.locator('[data-driver-status-form] input[name="status_token"]')).toHaveValue("token-status-guard");
    await expect(page.locator('[data-driver-status-form] button[type="submit"]')).toBeEnabled();
    expect(lookupCalls).toBe(1);
  });

  test("shows requested document readback from the driver status endpoint", async ({ page }) => {
    await patchRuntimeConfig(page, {
      driverApplicationStatusEndpoint: LANDING_DRIVER_STATUS_ENDPOINT_MOCK,
      turnstileSiteKey: "",
    });
    await mockDriverStatusEndpoint(
      page,
      routePayload({
        ok: true,
        status: "pending",
        application_state: "additional_documents_requested",
        requested_documents: ["driver_license", "vehicle_registration"],
        review_reason: "Upload clear front and back photos.",
      }, 200),
    );

    await page.goto("/drivers/apply?motion=off");
    await page.locator('[data-driver-status-form] input[name="status_token"]').fill("token-docs");
    await page.locator("[data-driver-status-form]").locator('button[type="submit"]').click();

    const readback = page.locator("[data-driver-status-lookup]");
    await expect(page.locator('[data-driver-status-form] input[name="status_token"]')).toHaveValue("token-docs");
    await expect(readback).toHaveText("Additional documents requested");
    const documents = page.locator("[data-driver-documents-form]");
    await expect(documents.getByLabel("driver_license")).toBeVisible();
    await expect(documents.getByLabel("vehicle_registration")).toBeVisible();
    await expect(page.locator("[data-driver-review-note]")).toHaveText("Reviewer note: Upload clear front and back photos.");
  });
});

const DOCUMENTS_ENDPOINT = "/__driver-documents";
const DOCUMENT_TOKEN = "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830";
const DOCUMENT_RETRY = "22222222-2222-4222-8222-222222222222";
const documentStatus = {
  ok: true, status: "pending", application_state: "additional_documents_requested",
  requested_documents: ["license"], document_review_revision: 1, reviewed_at: "2026-09-06T00:00:00Z",
};
const documentReceipt = { ok: true, status: "pending", application_state: "documents_resubmitted" };
const licenseFile = { name: "license.json", mimeType: "application/json", buffer: Buffer.from('{"reference":"one"}') };
async function openDocumentReturn(page: import("@playwright/test").Page, locale: string, status: Record<string, unknown> = documentStatus) {
  await patchRuntimeConfig(page, {
    driverApplicationStatusEndpoint: LANDING_DRIVER_STATUS_ENDPOINT_MOCK,
    driverApplicationDocumentsEndpoint: DOCUMENTS_ENDPOINT,
    publicRequestTimeoutMs: 500,
  });
  await mockDriverStatusEndpoint(page, routePayload(status, 200));
  await page.goto((locale === "ar" ? "/ar" : "") + "/drivers/apply?motion=off");
  const statusForm = page.locator("[data-driver-status-form]");
  await statusForm.locator('input[name="status_token"]').fill(DOCUMENT_TOKEN);
  await statusForm.locator('button[type="submit"]').click();
  await expect(page.locator("[data-driver-documents-form]")).toBeVisible();
}
for (const locale of ["en", "ar"]) {
  test.describe("requested-document return " + locale, () => {
    test("same-request complete return uses POST and renders localized submitted-not-approved state", async ({ page }) => {
      const requests: Record<string, unknown>[] = [];
      await page.route("**" + DOCUMENTS_ENDPOINT, async route => {
        expect(route.request().method()).toBe("POST");
        requests.push(route.request().postDataJSON());
        await routePayload(documentReceipt, 200)(route);
      });
      await openDocumentReturn(page, locale);
      const form = page.locator("[data-driver-documents-form]");
      await expect(form).toHaveAttribute("method", "post");
      await expect(form.locator("[data-driver-documents-status]")).toHaveAttribute("aria-live", "polite");
      await form.locator('input[type="file"]').setInputFiles(licenseFile);
      await form.locator('textarea[name="note"]').fill("Replacement requested");
      await form.locator('button[type="submit"]').click();
      await expect(form).toBeHidden();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ token: DOCUMENT_TOKEN, mode: "submit", note: "Replacement requested",
        documents: [{ type: "license", file_name: "license.json" }] });
      await expect(page.locator("[data-driver-status-lookup]")).toContainText(locale === "ar" ? "مراجعة" : "review");
    });
    test("definite rejection allows corrected file, note and type instead of replaying stale payload", async ({ page }) => {
      const requests: any[] = [];
      await page.route("**" + DOCUMENTS_ENDPOINT, async route => {
        requests.push(route.request().postDataJSON());
        await routePayload(requests.length === 1 ? { ok: false, error: { code: "invalid_document_manifest" } } : documentReceipt,
          requests.length === 1 ? 400 : 200)(route);
      });
      await openDocumentReturn(page, locale, { ...documentStatus, requested_documents: [] });
      const form = page.locator("[data-driver-documents-form]");
      await expect(form.locator("label:has(input) input")).toHaveCount(2);
      await form.locator('input[name="document_type"]').fill("old-type");
      await form.locator('input[type="file"]').setInputFiles({ ...licenseFile, name: "old.json" });
      await form.locator('textarea[name="note"]').fill("old note");
      await form.locator('button[type="submit"]').click();
      await expect(form.locator('input[type="file"]')).toBeEnabled();
      await form.locator('input[name="document_type"]').fill("license");
      await form.locator('input[type="file"]').setInputFiles({ ...licenseFile, name: "fixed.json" });
      await form.locator('textarea[name="note"]').fill("corrected note");
      await form.locator('button[type="submit"]').click();
      await expect(form).toBeHidden();
      expect(requests[1]).toMatchObject({ documents: [{ type: "license", file_name: "fixed.json" }], note: "corrected note" });
      expect(requests[1].retry_key).not.toBe(requests[0].retry_key);
    });
    test("unknown response then same-token refresh and not-found retries the original identity and bytes", async ({ page }) => {
      const requests: any[] = [];
      await page.route("**" + DOCUMENTS_ENDPOINT, async route => {
        requests.push(route.request().postDataJSON());
        const n = requests.length;
        await routePayload(n === 1 ? { ok: false, state: "pending" } :
          n === 2 ? { ok: false, state: "not_found" } : documentReceipt, n === 1 ? 202 : n === 2 ? 404 : 200)(route);
      });
      await openDocumentReturn(page, locale);
      const form = page.locator("[data-driver-documents-form]");
      await form.locator('input[type="file"]').setInputFiles(licenseFile);
      await form.locator('button[type="submit"]').click();
      await expect(form.locator('input[type="file"]')).toBeDisabled();
      await page.locator('[data-driver-status-form] button[type="submit"]').click();
      await expect(form.locator('input[type="file"]')).toHaveJSProperty("value", "C:\\fakepath\\license.json");
      await form.locator('button[type="submit"]').click();
      await expect.poll(() => requests.length).toBe(2);
      await form.locator('button[type="submit"]').click();
      await expect(form).toBeHidden();
      expect(requests[1]).toMatchObject({ mode: "readback", retry_key: requests[0].retry_key });
      expect(requests[2]).toEqual(requests[0]);
    });
    test("page-recovered reservation reads receipt without re-uploading and malformed 200 stays pending", async ({ page }) => {
      const requests: any[] = [];
      await page.route("**" + DOCUMENTS_ENDPOINT, async route => {
        requests.push(route.request().postDataJSON());
        await routePayload(requests.length === 1 ? {} : documentReceipt, 200)(route);
      });
      await openDocumentReturn(page, locale, { ...documentStatus, document_return_attempt: { state: "reserved", retry_key: DOCUMENT_RETRY } });
      const form = page.locator("[data-driver-documents-form]");
      await expect(form.locator('input[type="file"]')).toBeDisabled();
      await form.locator('button[type="submit"]').click();
      await expect.poll(() => requests.length).toBe(1);
      await expect(form).toBeVisible();
      await form.locator('button[type="submit"]').click();
      await expect(form).toBeHidden();
      expect(requests.every(p => p.mode === "readback" && p.retry_key === DOCUMENT_RETRY && !p.documents)).toBe(true);
    });
    test("token change during delayed file read cannot bind old files to a new application", async ({ page }) => {
      let requests = 0;
      await page.route("**" + DOCUMENTS_ENDPOINT, async route => { requests++; await routePayload(documentReceipt, 200)(route); });
      await page.addInitScript(() => {
        const original = FileReader.prototype.readAsDataURL;
        FileReader.prototype.readAsDataURL = function(blob) {
          const reader = this;
          (window as any).__releaseDocumentRead = () => original.call(reader, blob);
        };
      });
      await openDocumentReturn(page, locale);
      const form = page.locator("[data-driver-documents-form]");
      await form.locator('input[type="file"]').setInputFiles(licenseFile);
      await form.locator('button[type="submit"]').click();
      await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseDocumentRead)).toBe("function");
      await page.locator('[data-driver-status-form] input[name="status_token"]').evaluate((input: HTMLInputElement) => {
        input.value = "33333333-3333-4333-8333-333333333333";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        (window as any).__releaseDocumentRead();
      });
      await expect(form).toBeHidden();
      expect(requests).toBe(0);
    });
    test("status failure clears stale requested-document controls", async ({ page }) => {
      await openDocumentReturn(page, locale);
      await mockDriverStatusEndpoint(page, routePayload({ status: "pending" }, 200));
      await page.locator('[data-driver-status-form] button[type="submit"]').click();
      await expect(page.locator("[data-driver-documents-form]")).toBeHidden();
      await expect(page.locator("[data-driver-documents-fields] input")).toHaveCount(0);
    });
  });
}

for (const locale of ["en", "ar"]) {
  test("requested-document return " + locale + " explicitly abandons a recovered attempt without waiting forever", async ({ page }) => {
    const requests: any[] = [];
    await page.route("**" + DOCUMENTS_ENDPOINT, async route => {
      const body = route.request().postDataJSON(); requests.push(body);
      await routePayload(body.mode === "abandon" ? { ok: false, state: "aborted", cleanup_state: "pending" } : documentReceipt,
        body.mode === "abandon" ? 409 : 200)(route);
    });
    await openDocumentReturn(page, locale, { ...documentStatus, document_return_attempt: { state: "reserved", retry_key: DOCUMENT_RETRY } });
    const form = page.locator("[data-driver-documents-form]");
    await form.locator("[data-driver-documents-abandon]").click();
    await expect(form.locator('input[type="file"]')).toBeEnabled();
    expect(requests[0]).toMatchObject({ mode: "abandon", retry_key: DOCUMENT_RETRY });
    expect(requests[0].documents).toBeUndefined();
    await form.locator('input[type="file"]').setInputFiles(licenseFile);
    await form.locator('button[type="submit"]').click();
    await expect(form).toBeHidden();
    expect(requests[1].retry_key).not.toBe(DOCUMENT_RETRY);
  });
}

 test("missing configured entry blocks submission without an intake request", async ({page}) => {
  await patchRuntimeConfig(page,{driverSignupEndpoint:LANDING_DRIVER_SIGNUP_ENDPOINT_MOCK,driverSignupEntryKey:"",turnstileSiteKey:""});
  let calls=0; await mockDriverSignupEndpoint(page,async route=>{calls++;await route.fulfill({status:500,body:"unexpected"});});
  await page.goto("/drivers/apply?motion=off"); await fillDriverForm(page);
  await page.locator("[data-driver-form]").locator('button[type="submit"]').click();
  await expect(page.locator("[data-driver-status]")).toHaveClass(/is-error/);
  expect(calls).toBe(0);
});
